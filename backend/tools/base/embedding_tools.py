"""
Embedding 工具模块 - 推理型知识库

基于 LangChain/DeepAgent 框架，实现业界顶级的推理型知识库：
1. 动态资源管理 - 配置驱动、运行时注册、任务驱动选择
2. 知识图谱 - 实体识别、关系抽取、多跳推理、知识融合
3. 文档结构映射 - DocMap 导航、章节定位、上下文理解
4. 语义检索增强 - 查询扩展、Rerank、知识图谱增强

核心理念：从"搜索型"转向"推理型"知识库
- 不只是语义匹配，而是理解文档结构和实体关系
- 支持多跳推理，发现隐含的知识关联
- 持续学习，知识图谱不断积累和优化

✅ v2.0 更新：使用分层存储管理器
- L0: 热数据层（内存 LRU Cache）
- L1: 温数据层（SQLite 元数据）
- L2: 冷数据层（FAISS 文件存储）
"""

import os
import sys
import json
import hashlib
import gc
import logging
import threading
import traceback
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeoutError
from typing import Optional, List, Dict, Any, Callable, Set, Tuple
from pathlib import Path
from datetime import datetime, timedelta
from dataclasses import dataclass, field
from enum import Enum
from abc import ABC, abstractmethod

logger = logging.getLogger(__name__)

# ============================================================
# 导入存储管理器（精简版 - 只负责向量索引持久化）
# ============================================================
try:
    from .storage_manager import (
        get_metadata_store,
        get_index_manager,
        IndexMetadataStore,
        VectorIndexManager,
        IndexedDocument,
        should_index_file,
        load_indexignore,
        VECTOR_STORE_PATH as STORAGE_VECTOR_PATH,
    )
    _HAS_STORAGE_MANAGER = True
except ImportError as e:
    _HAS_STORAGE_MANAGER = False
    logger.warning("storage_manager 模块未加载: %s", e)

# ============================================================
# 配置 - 使用统一路径模块（Claude 风格：单一数据源）
# ============================================================
from .paths import (
    KB_PATH, WORKSPACE_PATH, MEMORY_PATH, VECTOR_STORE_PATH,
    CONTEXT_PATH, RESOURCES_CONFIG_PATH, get_project_root,
)

def _resolve_embedding_model() -> str:
    env_model = os.getenv("EMBEDDING_MODEL", "").strip()
    if env_model:
        return env_model
    try:
        cfg_path = get_project_root() / "backend" / "config" / "models.json"
        if cfg_path.exists():
            data = json.loads(cfg_path.read_text(encoding="utf-8"))
            explicit = str(data.get("embedding_model", "") or "").strip()
            if explicit:
                return explicit
            for m in data.get("models", []) or []:
                emb = str((m.get("embedding") or {}).get("model", "") or "").strip()
                if emb:
                    return emb
    except Exception:
        pass
    return "text-embedding-3-small"


EMBEDDING_MODEL = _resolve_embedding_model()
EMBEDDING_BASE_URL = os.getenv("EMBEDDING_BASE_URL", "http://localhost:1234/v1")

# 转为字符串（兼容旧代码）
KB_PATH = str(KB_PATH)
WORKSPACE_PATH = str(WORKSPACE_PATH)
MEMORY_PATH = str(MEMORY_PATH)
VECTOR_STORE_PATH = str(VECTOR_STORE_PATH)

# ============================================================
# 内存优化配置
# ============================================================
# 查询后是否释放向量库内存（用于是否做本体提取等）
VECTORSTORE_RELEASE_AFTER_QUERY = os.getenv("VECTORSTORE_RELEASE_AFTER_QUERY", "true").lower() == "true"
# 以下预留，当前实现已为懒加载
VECTORSTORE_LAZY_LOAD = os.getenv("VECTORSTORE_LAZY_LOAD", "true").lower() == "true"
EMBEDDING_LAZY_LOAD = os.getenv("EMBEDDING_LAZY_LOAD", "true").lower() == "true"
# 最大文档块数（限制内存使用）
MAX_DOCUMENT_CHUNKS = int(os.getenv("MAX_DOCUMENT_CHUNKS", "2000"))
# 单个文件最大大小（KB）- 放宽以支持 PDF/DOCX
MAX_FILE_SIZE_KB = int(os.getenv("MAX_FILE_SIZE_KB", "5000"))
# 允许的文件扩展名（与 storage_manager 对齐；有 storage 时以 should_index_file 为准）
KB_FILE_EXTENSIONS = [e.strip() for e in os.getenv("KB_FILE_EXTENSIONS", ".md,.txt,.pdf,.docx,.xlsx").split(",") if e.strip()]

# ============================================================
# Rerank 配置（可选，LM Studio / 独立 rerank 服务）
# ============================================================
RERANK_ENABLED = os.getenv("RERANK_ENABLED", "false").lower() == "true"
RERANK_BASE_URL = os.getenv("RERANK_BASE_URL", "").strip() or os.getenv("EMBEDDING_BASE_URL", "http://localhost:1234/v1")
RERANK_MODEL = os.getenv("RERANK_MODEL", "")
RERANK_TOP_N = int(os.getenv("RERANK_TOP_N", "12"))
RERANK_TIMEOUT = float(os.getenv("RERANK_TIMEOUT", "30"))
# rerank 运行模式：local（默认，系统内 CPU）/ lm_api / auto
RERANK_RUNTIME = os.getenv("RERANK_RUNTIME", "local").strip().lower()
RERANK_LOCAL_MODEL = os.getenv("RERANK_LOCAL_MODEL", "BAAI/bge-reranker-v2-m3").strip()
RERANK_LOCAL_MAX_LENGTH = int(os.getenv("RERANK_LOCAL_MAX_LENGTH", "512"))
RERANK_LOCAL_THREADS = int(os.getenv("RERANK_LOCAL_THREADS", "4"))
# 检索总超时（秒）：单次 search_knowledge 上限，0 表示不启用；超时返回降级文案，避免长时间挂起
KNOWLEDGE_RETRIEVAL_TIMEOUT_SEC = max(0, int(os.getenv("KNOWLEDGE_RETRIEVAL_TIMEOUT_SEC", "0") or "0"))


def _get_capability_model_runtime(usage: str) -> Optional[Dict[str, str]]:
    """
    从 ModelManager 获取内部能力模型的 runtime 配置。
    返回 {"id": str, "base_url": str}，获取失败返回 None。
    """
    try:
        from backend.engine.agent.model_manager import get_model_manager

        manager = get_model_manager()
        model = manager.get_embedding_model() if usage == "embedding" else manager.get_rerank_model()
        if not model:
            return None
        if not getattr(model, "enabled", False):
            return None
        # provider 就绪校验在 ModelManager 内部已包含于选择逻辑
        base_url = str(getattr(model, "runtime_url", None) or getattr(model, "url", "")).rstrip("/")
        if not base_url:
            return None
        return {"id": str(model.id), "base_url": base_url}
    except Exception:
        return None

# ============================================================
# 全局实例管理（生产级内存优化）
# ============================================================
# 
# 内存管理策略：
# 1. Embedding 模型：全局单例（轻量级，约 100MB）
# 2. 向量存储：懒加载，使用后释放（FAISS 文件存储）
# 3. 资源管理器：全局单例（轻量级配置对象）
# 4. 知识图谱：全局单例（JSON 文件存储）
#
# ✅ 向量存储不常驻内存：
# - FAISS 索引存储在文件中（index.faiss + index.pkl）
# - 每次查询时加载，查询完成后释放
# - 利用操作系统文件缓存提升性能
# ============================================================

_embeddings = None
_embeddings_lock = threading.Lock()
_resource_manager: Optional["ResourceManager"] = None
_resource_manager_lock = threading.Lock()
_failure_recovery = None
# UnifiedRetriever 实例缓存（按 domains+task_type），避免每次 search_knowledge 都 load_documents
_hybrid_retriever_cache: Dict[Tuple, Any] = {}
_hybrid_retriever_cache_lock = threading.Lock()
# ✅ 移除全局 _retriever_tool，改为懒加载（Claude 风格）
# 向量存储只在需要时加载，使用后可以释放，避免常驻内存


# ============================================================
# 向量存储 LRU 缓存（效率优化：避免重复加载 FAISS 索引）
# ============================================================
import time as _time

class VectorStoreCache:
    """
    向量存储 LRU 缓存
    
    优化目标：避免每次查询都重新加载 FAISS 索引
    - 缓存最近使用的向量存储实例
    - 支持 TTL 过期机制
    - 线程安全
    """
    def __init__(self, max_size: int = 2, ttl_seconds: int = 300):
        self._cache: Dict[str, Tuple[Any, float]] = {}  # key -> (vectorstore, timestamp)
        self._lock = threading.Lock()
        self.max_size = max_size
        self.ttl = ttl_seconds
        self._hit_count = 0
        self._miss_count = 0
    
    def get_or_load(self, cache_key: str, loader: Callable) -> Any:
        """
        获取缓存的向量存储，如果不存在则加载
        
        Args:
            cache_key: 缓存键（如 "default" 或 "domain:bidding"）
            loader: 加载函数，无参数，返回向量存储实例
        
        Returns:
            向量存储实例
        """
        now = _time.time()
        with self._lock:
            if cache_key in self._cache:
                vs, ts = self._cache[cache_key]
                if now - ts < self.ttl:
                    self._cache[cache_key] = (vs, now)
                    self._hit_count += 1
                    return vs
                del self._cache[cache_key]
            self._miss_count += 1
        # 锁外执行 IO，避免持锁期间阻塞其他请求
        vs = loader()
        if vs is None:
            return None
        with self._lock:
            if cache_key in self._cache:
                return self._cache[cache_key][0]
            if len(self._cache) >= self.max_size:
                oldest_key = min(self._cache.items(), key=lambda x: x[1][1])[0]
                del self._cache[oldest_key]
            self._cache[cache_key] = (vs, now)
            return vs
    
    def invalidate(self, cache_key: str = None):
        """
        使缓存失效
        
        Args:
            cache_key: 指定键，None 则清空所有
        """
        with self._lock:
            if cache_key is None:
                self._cache.clear()
            elif cache_key in self._cache:
                del self._cache[cache_key]
    
    def get_stats(self) -> Dict:
        """获取缓存统计"""
        with self._lock:
            total = self._hit_count + self._miss_count
            hit_rate = self._hit_count / total if total > 0 else 0
            return {
                "size": len(self._cache),
                "max_size": self.max_size,
                "ttl_seconds": self.ttl,
                "hit_count": self._hit_count,
                "miss_count": self._miss_count,
                "hit_rate": f"{hit_rate:.1%}",
            }

# 全局向量存储缓存实例
_vectorstore_cache = VectorStoreCache(
    max_size=int(os.getenv("VECTORSTORE_CACHE_SIZE", "2")),
    ttl_seconds=int(os.getenv("VECTORSTORE_CACHE_TTL", "300"))
)


def get_vectorstore_cache_stats() -> Dict:
    """获取向量存储缓存统计"""
    return _vectorstore_cache.get_stats()


def invalidate_vectorstore_cache(cache_key: Optional[str] = None):
    """使向量存储缓存失效；cache_key 为 None 时清空全部。"""
    _vectorstore_cache.invalidate(cache_key)


# 导入知识图谱模块
try:
    from .knowledge_graph import (
        KnowledgeGraph, DocumentMap, EntityRelationExtractor,
        get_knowledge_graph, get_document_map, get_extractor,
        EntityType, RelationType,
    )
    _HAS_KNOWLEDGE_GRAPH = True
except ImportError:
    _HAS_KNOWLEDGE_GRAPH = False
    logger.warning("knowledge_graph 模块未加载，部分推理功能不可用")

# 导入资源调度器（模型互斥、工具并行）
try:
    from backend.engine.core.resource_scheduler import get_scheduler, with_embedding_resource
    _HAS_SCHEDULER = True
except ImportError:
    _HAS_SCHEDULER = False
    logger.warning("resource_scheduler 模块未加载，使用默认调度")


# ============================================================
# 1. 动态资源管理器 (ResourceManager)
# 参考: LangChain Retriever 模式 + Cursor 的动态资源发现
# ============================================================
class ResourceType(Enum):
    """资源类型"""
    MEMORY = "memory"           # 记忆文件
    SKILL = "skill"             # 技能定义
    GUIDE = "guide"             # 操作指南
    QUALIFICATION = "qualification"  # 资质证书
    CASE = "case"               # 成功案例
    PRODUCT = "product"         # 产品规格
    USER_FILE = "user_file"     # 用户文件
    ONTOLOGY = "ontology"       # 本体知识


@dataclass
class ResourceSource:
    """资源源定义 - 支持动态注册"""
    name: str                          # 唯一标识
    path: Path                         # 文件路径
    pattern: str                       # glob 模式
    resource_type: ResourceType        # 资源类型
    priority: float = 0.5              # 优先级 0-1
    file_types: List[str] = field(default_factory=lambda: [".md"])
    tags: List[str] = field(default_factory=list)
    domains: List[str] = field(default_factory=list)
    task_types: List[str] = field(default_factory=list)
    enabled: bool = True
    last_indexed: Optional[datetime] = None
    metadata_schema: Dict[str, str] = field(default_factory=dict)
    description: str = ""              # 资源描述
    exclude_patterns: List[str] = field(default_factory=list)  # 排除模式
    
    def to_dict(self) -> Dict:
        return {
            "name": self.name,
            "path": str(self.path),
            "pattern": self.pattern,
            "resource_type": self.resource_type.value,
            "priority": self.priority,
            "file_types": self.file_types,
            "tags": self.tags,
            "domains": self.domains,
            "task_types": self.task_types,
            "enabled": self.enabled,
            "description": self.description,
            "exclude_patterns": self.exclude_patterns,
        }
    
    def should_exclude(self, file_path: Path) -> bool:
        """检查文件是否应该被排除。
        
        支持模式：
        - **/02_operations/**：排除路径中包含 02_operations 目录的文件
        - **/SKILL.md：排除文件名为 SKILL.md 的文件
        - 其他：fnmatch 匹配完整路径
        """
        import fnmatch
        path_str = str(file_path)
        path_parts = file_path.parts
        path_name = file_path.name
        for pattern in self.exclude_patterns:
            # **/SEGMENT/** -> 排除路径中包含 SEGMENT 目录的文件
            if pattern.startswith("**/") and pattern.endswith("/**"):
                segment = pattern[3:-3]
                if segment in path_parts:
                    return True
            # **/NAME -> 排除文件名为 NAME 的文件
            elif pattern.startswith("**/") and "/**" not in pattern:
                name = pattern[3:]
                if path_name == name:
                    return True
            else:
                if fnmatch.fnmatch(path_str, pattern):
                    return True
        return False


class ResourceManager:
    """
    动态资源管理器 - 业界顶级实现
    
    特性：
    - 配置驱动：支持 YAML/JSON 配置文件
    - 运行时注册：动态添加/移除资源
    - 任务驱动选择：根据任务类型和领域过滤
    - 文档映射：docmap 快速定位内容
    - 工作流映射：workflows 指导执行顺序
    """
    
    def __init__(self, config_path: Optional[str] = None):
        """
        ResourceManager - 通用资源管理器（Claude 风格：配置驱动）
        
        职责边界：
        - ResourceManager：管理通用资源（guides、cases、memory、user_files）
        - SkillRegistry：专门管理 Skills（符合 Agent Skills 标准，独立实现）
        
        配置优先级：resources.json > 最小回退默认值
        """
        self._sources: Dict[str, ResourceSource] = {}
        self._config_path = config_path
        self._event_handlers: List[Callable] = []
        self._docmap: Dict[str, Any] = {}      # 文档结构映射
        self._workflows: Dict[str, Any] = {}   # 工作流映射
        
        # Claude 风格：优先使用配置文件，最小回退
        if config_path and Path(config_path).exists():
            self._load_config(config_path)
        else:
            # 最小回退：只添加必要的默认源（memory + user_uploads）
            # Skills 由 SkillRegistry 管理，不在此重复
            self._init_minimal_defaults()
    
    def _init_minimal_defaults(self):
        """最小回退默认值（Claude 风格：不重复 resources.json 的配置）
        
        只添加最基本的资源源，完整配置应在 resources.json 中定义。
        Skills 由 SkillRegistry 专门管理，不在此添加。
        """
        kb_path = Path(KB_PATH)
        workspace = Path(WORKSPACE_PATH)
        
        # 最小默认：只有 memory 和 user_uploads
        defaults = [
            ResourceSource(
                name="memory",
                path=workspace / ".context",
                pattern="**/*.md",
                resource_type=ResourceType.MEMORY,
                priority=1.0,
                tags=["preference", "experience"],
                task_types=["all"],
            ),
            ResourceSource(
                name="user_uploads",
                path=workspace / "uploads",
                pattern="**/*.md",
                resource_type=ResourceType.USER_FILE,
                priority=0.9,
                task_types=["all"],
            ),
        ]
        
        for source in defaults:
            self._sources[source.name] = source
        
        logger.warning("ResourceManager 使用最小默认配置（建议配置 resources.json）")
    
    def _load_config(self, config_path: str):
        """从配置文件加载资源、文档映射和工作流"""
        with open(config_path, 'r', encoding='utf-8') as f:
            if config_path.endswith('.yaml') or config_path.endswith('.yml'):
                import yaml
                config = yaml.safe_load(f)
            else:
                config = json.load(f)
        
        # 配置所在目录为基准（resources.json 在 knowledge_base/ 下，路径相对该目录）
        config_dir = Path(config_path).resolve().parent
        # 加载资源源
        for name, res_config in config.get('resources', {}).items():
            res_config['resource_type'] = ResourceType(res_config.get('resource_type', 'user_file'))
            raw_path = res_config['path']
            p = Path(raw_path)
            res_config['path'] = (config_dir / p).resolve() if not p.is_absolute() else p
            self._sources[name] = ResourceSource(name=name, **res_config)
        
        # 加载文档映射 (docmap)
        self._docmap = config.get('docmap', {})
        
        # 加载工作流映射 (workflows)
        self._workflows = config.get('workflows', {})
    
    def register(self, source: ResourceSource) -> None:
        """动态注册新资源源"""
        self._sources[source.name] = source
        self._emit_event("resource_registered", source)
        logger.info("资源已注册: %s (%s)", source.name, source.resource_type.value)
    
    def unregister(self, name: str) -> bool:
        """注销资源源"""
        if name in self._sources:
            source = self._sources.pop(name)
            self._emit_event("resource_unregistered", source)
            return True
        return False
    
    def discover_resources(self, base_path: Path) -> List[ResourceSource]:
        """
        自动发现资源 - 扫描目录结构
        
        查找包含 metadata.json 的目录并自动注册
        """
        discovered = []
        
        if not base_path.exists():
            return discovered
        
        for metadata_file in base_path.rglob("metadata.json"):
            try:
                with open(metadata_file, 'r', encoding='utf-8') as f:
                    meta = json.load(f)
                
                source = ResourceSource(
                    name=meta.get('name', metadata_file.parent.name),
                    path=metadata_file.parent,
                    pattern=meta.get('pattern', '**/*.md'),
                    resource_type=ResourceType(meta.get('type', 'user_file')),
                    priority=meta.get('priority', 0.5),
                    tags=meta.get('tags', []),
                    domains=meta.get('domains', []),
                    task_types=meta.get('task_types', []),
                )
                
                discovered.append(source)
                self.register(source)
                
            except Exception as e:
                print(f"⚠️ 无法加载 {metadata_file}: {e}")
        
        return discovered
    
    def get_sources(
        self,
        resource_types: Optional[List[ResourceType]] = None,
        domains: Optional[List[str]] = None,
        task_type: Optional[str] = None,
        tags: Optional[List[str]] = None,
        min_priority: float = 0.0,
        user_context: Optional[Dict] = None,
    ) -> List[ResourceSource]:
        """
        根据任务需求动态获取资源源
        
        Args:
            resource_types: 过滤资源类型
            domains: 过滤领域
            task_type: 任务类型
            tags: 标签过滤
            min_priority: 最小优先级
            user_context: 用户上下文（用于权限过滤）
        """
        result = []
        
        for source in self._sources.values():
            if not source.enabled:
                continue
            if source.priority < min_priority:
                continue
            if resource_types and source.resource_type not in resource_types:
                continue
            if domains and source.domains and not any(d in source.domains for d in domains):
                continue
            if task_type and source.task_types and task_type not in source.task_types and "all" not in source.task_types:
                continue
            if tags and source.tags and not any(t in source.tags for t in tags):
                continue
            
            # 权限检查
            if user_context and not self._check_access(source, user_context):
                continue
            
            result.append(source)
        
        # 按优先级排序
        result.sort(key=lambda x: x.priority, reverse=True)
        return result
    
    def _check_access(self, source: ResourceSource, user_context: Dict) -> bool:
        """检查用户访问权限"""
        user_role = user_context.get("role", "viewer")
        role_levels = {"admin": 3, "editor": 2, "viewer": 1}
        
        # 高优先级资源需要更高权限
        required_level = 1 if source.priority < 0.8 else 2
        return role_levels.get(user_role, 0) >= required_level
    
    def _emit_event(self, event_type: str, source: ResourceSource):
        """触发事件"""
        for handler in self._event_handlers:
            try:
                handler(event_type, source)
            except Exception:
                pass
    
    def on_event(self, handler: Callable):
        """注册事件处理器"""
        self._event_handlers.append(handler)
    
    def list_all(self) -> Dict[str, Dict]:
        """列出所有资源源"""
        return {name: s.to_dict() for name, s in self._sources.items()}
    
    def get_docmap(self, domain: Optional[str] = None) -> Dict:
        """
        获取文档映射
        
        Args:
            domain: 领域名称（bidding/contracts/reports），None 返回全部
        
        Returns:
            文档结构映射，包含 skill、guide、sections 等路径信息
        """
        if domain:
            return self._docmap.get(domain, {})
        return self._docmap
    
    # 注意：Workflow 相关方法已移除
    # 业界顶级做法：Workflow 嵌入 prompt/skill，LLM 直接执行工具
    
    def get_resource_path(self, domain: str, section: str) -> Optional[str]:
        """
        根据领域和章节获取资源路径
        
        Args:
            domain: 领域名称
            section: 章节名称（basics/operations/templates/cases/company/products）
        
        Returns:
            资源路径
        """
        domain_map = self._docmap.get(domain, {})
        sections = domain_map.get('sections', {})
        section_info = sections.get(section, {})
        return section_info.get('path')
    
    def save_config(self, config_path: str):
        """保存配置到文件"""
        config = {
            "resources": {name: s.to_dict() for name, s in self._sources.items()},
            "docmap": self._docmap,
            "workflows": self._workflows,
        }
        with open(config_path, 'w', encoding='utf-8') as f:
            json.dump(config, f, ensure_ascii=False, indent=2)


def get_resource_manager() -> ResourceManager:
    """获取资源管理器单例（使用统一路径配置，双检锁保证线程安全）"""
    global _resource_manager
    if _resource_manager is None:
        with _resource_manager_lock:
            if _resource_manager is None:
                config_path = RESOURCES_CONFIG_PATH
                _resource_manager = ResourceManager(
                    config_path=str(config_path) if config_path.exists() else None
                )
                if config_path.exists():
                    print(f"✅ 资源配置已加载: {config_path}")
                else:
                    print(f"⚠️ 使用最小默认配置 (建议创建 {config_path})")
    return _resource_manager


# ============================================================
# 2. 失败重试学习机制 (FailureRecoveryManager)
# 参考: LangSmith 追踪 + Devin 的自我反思机制
# ============================================================
class ExecutionStatus(Enum):
    """执行状态"""
    SUCCESS = "success"
    FAILED = "failed"
    PARTIAL = "partial"
    RETRY = "retry"


@dataclass
class ExecutionContext:
    """执行上下文 - 完整记录执行信息"""
    task_id: str
    status: ExecutionStatus
    query: str
    retrieved_docs: List[str]
    error: Optional[str] = None
    error_type: Optional[str] = None
    suggestions: List[str] = field(default_factory=list)
    retry_count: int = 0
    timestamp: datetime = field(default_factory=datetime.now)
    context_window: Dict[str, Any] = field(default_factory=dict)
    feedback: Optional[str] = None
    
    def to_dict(self) -> Dict:
        return {
            "task_id": self.task_id,
            "status": self.status.value,
            "query": self.query,
            "retrieved_docs": self.retrieved_docs,
            "error": self.error,
            "error_type": self.error_type,
            "suggestions": self.suggestions,
            "retry_count": self.retry_count,
            "timestamp": self.timestamp.isoformat(),
            "context_window": self.context_window,
        }


class FailureRecoveryManager:
    """
    失败恢复和学习管理器 - 业界顶级实现
    
    特性：
    - 执行追踪：完整记录每次执行的上下文
    - 错误分析：自动分类错误类型
    - 自适应重试：根据历史失败调整策略
    - 经验积累：持久化失败案例用于学习
    - 质量评估：评估检索结果质量
    """
    
    def __init__(self, storage_path: Optional[str] = None):
        self.storage_path = Path(storage_path or MEMORY_PATH) / "failures"
        self.storage_path.mkdir(parents=True, exist_ok=True)
        
        self._contexts: Dict[str, ExecutionContext] = {}
        self._retry_strategies = {
            "retrieval_failure": self._strategy_expand_search,
            "insufficient_context": self._strategy_add_context,
            "semantic_mismatch": self._strategy_query_expansion,
            "timeout": self._strategy_reduce_scope,
            "format_error": self._strategy_clarify_format,
            "unknown": self._strategy_default,
        }
        
        self._load_history()
    
    def _load_history(self):
        """加载历史失败记录"""
        for file_path in self.storage_path.glob("*.json"):
            try:
                with open(file_path, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                    data['status'] = ExecutionStatus(data['status'])
                    data['timestamp'] = datetime.fromisoformat(data['timestamp'])
                    self._contexts[file_path.stem] = ExecutionContext(**data)
            except Exception:
                pass
    
    def record(self, ctx: ExecutionContext) -> str:
        """记录执行上下文"""
        context_id = hashlib.md5(
            f"{ctx.task_id}_{ctx.query}_{ctx.timestamp.timestamp()}".encode()
        ).hexdigest()[:12]
        
        self._contexts[context_id] = ctx
        
        # 如果失败，分析并生成建议
        if ctx.status == ExecutionStatus.FAILED:
            ctx.error_type = self._classify_error(ctx.error)
            ctx.suggestions = self._generate_suggestions(ctx)
            self._persist(context_id, ctx)
        
        return context_id
    
    def _classify_error(self, error: Optional[str]) -> str:
        """分类错误类型"""
        if not error:
            return "unknown"
        
        error_lower = error.lower()
        
        if any(kw in error_lower for kw in ["no relevant", "not found", "empty"]):
            return "retrieval_failure"
        elif any(kw in error_lower for kw in ["insufficient", "missing context"]):
            return "insufficient_context"
        elif any(kw in error_lower for kw in ["ambiguous", "mismatch", "irrelevant"]):
            return "semantic_mismatch"
        elif any(kw in error_lower for kw in ["timeout", "too long"]):
            return "timeout"
        elif any(kw in error_lower for kw in ["format", "parse", "invalid"]):
            return "format_error"
        else:
            return "unknown"
    
    def _generate_suggestions(self, ctx: ExecutionContext) -> List[str]:
        """生成恢复建议"""
        suggestions = []
        error_type = ctx.error_type or "unknown"
        
        if error_type == "retrieval_failure":
            suggestions.extend(["expand_search_scope", "lower_threshold", "add_more_sources"])
        elif error_type == "insufficient_context":
            suggestions.extend(["add_context", "include_related_docs", "expand_query"])
        elif error_type == "semantic_mismatch":
            suggestions.extend(["query_expansion", "multi_query", "use_ontology"])
        elif error_type == "timeout":
            suggestions.extend(["reduce_chunk_size", "limit_sources", "simplify_query"])
        elif error_type == "format_error":
            suggestions.extend(["clarify_format", "add_examples", "validate_output"])
        else:
            suggestions.extend(["retry_with_context", "use_different_approach"])
        
        return suggestions
    
    def get_similar_failures(
        self,
        query: str,
        error_type: Optional[str] = None,
        limit: int = 3,
    ) -> List[ExecutionContext]:
        """查找相似的历史失败"""
        from difflib import SequenceMatcher
        
        candidates = []
        for ctx in self._contexts.values():
            if ctx.status != ExecutionStatus.FAILED:
                continue
            if error_type and ctx.error_type != error_type:
                continue
            
            similarity = SequenceMatcher(None, query.lower(), ctx.query.lower()).ratio()
            if similarity > 0.3:
                candidates.append((similarity, ctx))
        
        candidates.sort(key=lambda x: x[0], reverse=True)
        return [ctx for _, ctx in candidates[:limit]]
    
    def should_retry(self, ctx: ExecutionContext, max_retries: int = 3) -> bool:
        """判断是否应该重试"""
        return (
            ctx.status == ExecutionStatus.FAILED and
            ctx.retry_count < max_retries and
            ctx.error_type != "format_error"  # 格式错误不重试
        )
    
    def prepare_retry(self, ctx: ExecutionContext) -> Dict[str, Any]:
        """
        准备重试参数
        
        根据错误类型和历史失败，生成改进的执行参数
        """
        error_type = ctx.error_type or "unknown"
        strategy = self._retry_strategies.get(error_type, self._strategy_default)
        
        # 获取相似失败的经验
        similar_failures = self.get_similar_failures(ctx.query, error_type)
        
        return strategy(ctx, similar_failures)
    
    def _strategy_expand_search(self, ctx: ExecutionContext, similar: List) -> Dict:
        """扩展搜索范围策略"""
        return {
            "query": ctx.query,
            "expand_sources": True,
            "lower_threshold": 0.3,
            "include_all_types": True,
            "retry_count": ctx.retry_count + 1,
            "context": {
                "original_error": ctx.error,
                "strategy": "expand_search",
            }
        }
    
    def _strategy_add_context(self, ctx: ExecutionContext, similar: List) -> Dict:
        """添加上下文策略"""
        # 从相似失败中提取有用的上下文
        additional_context = []
        for s in similar:
            if s.context_window.get("useful_docs"):
                additional_context.extend(s.context_window["useful_docs"])
        
        return {
            "query": f"{ctx.query}\n\n[Additional Context Required]",
            "include_related": True,
            "additional_docs": additional_context[:3],
            "retry_count": ctx.retry_count + 1,
        }
    
    def _strategy_query_expansion(self, ctx: ExecutionContext, similar: List) -> Dict:
        """查询扩展策略 - Multi-Query"""
        expanded_queries = [
            ctx.query,
            f"What are the key concepts in: {ctx.query}?",
            f"Alternative perspectives on: {ctx.query}",
        ]
        
        return {
            "queries": expanded_queries,
            "use_multi_query": True,
            "use_ontology": True,
            "retry_count": ctx.retry_count + 1,
        }
    
    def _strategy_reduce_scope(self, ctx: ExecutionContext, similar: List) -> Dict:
        """缩小范围策略"""
        return {
            "query": ctx.query,
            "max_docs": 3,
            "chunk_size": 500,
            "timeout_increase": True,
            "retry_count": ctx.retry_count + 1,
        }
    
    def _strategy_clarify_format(self, ctx: ExecutionContext, similar: List) -> Dict:
        """明确格式策略"""
        return {
            "query": ctx.query,
            "add_format_examples": True,
            "validate_output": True,
            "retry_count": ctx.retry_count + 1,
        }
    
    def _strategy_default(self, ctx: ExecutionContext, similar: List) -> Dict:
        """默认策略"""
        return {
            "query": f"[RETRY] {ctx.query}",
            "include_error_context": True,
            "error_info": ctx.error,
            "retry_count": ctx.retry_count + 1,
        }
    
    def record_lesson(self, ctx: ExecutionContext, success: bool) -> None:
        """记录经验教训到 lessons.md"""
        lessons_path = Path(WORKSPACE_PATH) / ".context" / "lessons.md"
        lessons_path.parent.mkdir(parents=True, exist_ok=True)
        
        lesson = f"""
## {datetime.now().strftime('%Y-%m-%d %H:%M')}

- **任务**: {ctx.query[:100]}
- **结果**: {'✅ 成功' if success else '❌ 失败'}
- **重试次数**: {ctx.retry_count}
"""
        if ctx.error_type:
            lesson += f"- **错误类型**: {ctx.error_type}\n"
        if ctx.suggestions:
            lesson += f"- **改进建议**: {', '.join(ctx.suggestions[:3])}\n"
        
        with open(lessons_path, "a", encoding="utf-8") as f:
            f.write(lesson + "\n")
    
    def _persist(self, context_id: str, ctx: ExecutionContext):
        """持久化失败记录"""
        file_path = self.storage_path / f"{context_id}.json"
        with open(file_path, 'w', encoding='utf-8') as f:
            json.dump(ctx.to_dict(), f, ensure_ascii=False, indent=2)
    
    def get_learning_report(self, days: int = 7) -> Dict:
        """获取学习报告"""
        cutoff = datetime.now() - timedelta(days=days)
        
        recent = [c for c in self._contexts.values() if c.timestamp >= cutoff]
        failures = [c for c in recent if c.status == ExecutionStatus.FAILED]
        
        error_stats = {}
        for c in failures:
            error_stats[c.error_type] = error_stats.get(c.error_type, 0) + 1
        
        return {
            "period_days": days,
            "total_executions": len(recent),
            "total_failures": len(failures),
            "failure_rate": len(failures) / len(recent) if recent else 0,
            "error_distribution": error_stats,
            "top_suggestions": self._get_top_suggestions(failures),
        }
    
    def _get_top_suggestions(self, failures: List[ExecutionContext]) -> List[str]:
        """获取最常见的改进建议"""
        suggestion_counts = {}
        for f in failures:
            for s in f.suggestions:
                suggestion_counts[s] = suggestion_counts.get(s, 0) + 1
        
        sorted_suggestions = sorted(suggestion_counts.items(), key=lambda x: x[1], reverse=True)
        return [s for s, _ in sorted_suggestions[:5]]


def get_failure_recovery() -> FailureRecoveryManager:
    """获取失败恢复管理器单例"""
    global _failure_recovery
    if _failure_recovery is None:
        _failure_recovery = FailureRecoveryManager()
    return _failure_recovery


# ============================================================
# 3. 知识图谱集成（使用 knowledge_graph.py）
# ============================================================
# 注意：完整的知识图谱实现在 knowledge_graph.py 中
# 这里提供兼容性包装和便捷函数

def extract_entities_from_text(text: str, source: str = "") -> List[Dict]:
    """
    从文本中提取实体（便捷函数）
    
    使用 knowledge_graph.py 中的 EntityRelationExtractor
    """
    if not _HAS_KNOWLEDGE_GRAPH:
        return []
    
    extractor = get_extractor()
    entities = extractor.extract_entities(text, source=source)
    return [e.to_dict() for e in entities]


def extract_relations_from_text(text: str, source: str = "") -> List[Dict]:
    """
    从文本中提取关系（便捷函数）
    """
    if not _HAS_KNOWLEDGE_GRAPH:
        return []
    
    extractor = get_extractor()
    kg = get_knowledge_graph()
    
    # 先提取实体
    entities = extractor.extract_entities(text, source=source)
    
    # 再提取关系
    relations = extractor.extract_relations(text, entities, source=source)
    
    # 保存知识图谱
    kg.save()
    
    return [r.to_dict() for r in relations]


def query_knowledge_graph(query: str) -> Dict:
    """
    查询知识图谱（便捷函数）
    
    返回扩展的查询和相关上下文
    """
    if not _HAS_KNOWLEDGE_GRAPH:
        return {"original_query": query, "expanded_query": query}
    
    kg = get_knowledge_graph()
    return kg.expand_query(query)


def get_knowledge_graph_stats() -> Dict:
    """获取知识图谱统计"""
    if not _HAS_KNOWLEDGE_GRAPH:
        return {"error": "knowledge_graph module not available"}
    
    kg = get_knowledge_graph()
    return kg.get_stats()


# ============================================================
# 4. Embedding 和检索工具（生产级优化）
# ============================================================
# 
# 性能优化策略：
# 1. 连接池复用：减少 HTTP 连接开销
# 2. 批量处理：多文档同时嵌入
# 3. 缓存：相同文本不重复计算
# 4. 超时控制：避免长时间阻塞
# ============================================================

_embedding_httpx_client = None
_embedding_httpx_client_lock = threading.Lock()
_rerank_httpx_client = None
_rerank_httpx_client_lock = threading.Lock()
_local_reranker = None
_local_reranker_error: Optional[str] = None
_local_reranker_lock = threading.Lock()


def _get_local_reranker():
    """
    懒加载本地 CPU reranker（CrossEncoder）。
    加载失败会缓存错误，避免每次重复初始化。
    """
    global _local_reranker, _local_reranker_error
    with _local_reranker_lock:
        if _local_reranker is not None:
            return _local_reranker, None
        if _local_reranker_error is not None:
            return None, _local_reranker_error
        try:
            import torch
            from sentence_transformers import CrossEncoder

            if RERANK_LOCAL_THREADS > 0:
                torch.set_num_threads(RERANK_LOCAL_THREADS)
            _local_reranker = CrossEncoder(
                RERANK_LOCAL_MODEL,
                device="cpu",
                max_length=RERANK_LOCAL_MAX_LENGTH,
            )
            return _local_reranker, None
        except Exception as e:
            _local_reranker_error = f"local_reranker_init_error: {e}"
            return None, _local_reranker_error


def _rerank_docs_local(query: str, docs: list, top_k: int = 12) -> Tuple[Optional[List], Dict[str, Any]]:
    """使用本地 CPU CrossEncoder 进行重排。"""
    if not docs:
        return None, {"status": "disabled", "reason": "empty_docs"}
    start_ts = _time.time()
    reranker, err = _get_local_reranker()
    if reranker is None:
        return None, {
            "status": "degraded",
            "reason": err or "local_reranker_unavailable",
            "model": RERANK_LOCAL_MODEL,
            "elapsed_ms": int((_time.time() - start_ts) * 1000),
        }
    try:
        pairs = [(query, d.page_content[:4000]) for d in docs]
        scores = reranker.predict(pairs)
        if scores is None:
            return None, {
                "status": "degraded",
                "reason": "local_reranker_empty_scores",
                "model": RERANK_LOCAL_MODEL,
                "elapsed_ms": int((_time.time() - start_ts) * 1000),
            }
        ranked = sorted(
            list(enumerate([float(s) for s in scores])),
            key=lambda x: -x[1],
        )
        ordered = [docs[i] for i, _ in ranked[: min(top_k, len(docs))]]
        return ordered, {
            "status": "enabled",
            "reason": "local_cpu_rerank",
            "model": RERANK_LOCAL_MODEL,
            "count": len(ordered),
            "elapsed_ms": int((_time.time() - start_ts) * 1000),
        }
    except Exception as e:
        return None, {
            "status": "degraded",
            "reason": f"local_rerank_error: {e}",
            "model": RERANK_LOCAL_MODEL,
            "elapsed_ms": int((_time.time() - start_ts) * 1000),
        }

def _get_embedding_httpx_client():
    """获取 Embedding 专用的 httpx 客户端（线程安全懒加载）"""
    global _embedding_httpx_client
    with _embedding_httpx_client_lock:
        if _embedding_httpx_client is not None:
            return _embedding_httpx_client
        import httpx
        _embedding_httpx_client = httpx.Client(
            timeout=httpx.Timeout(
                connect=5.0,
                read=60.0,   # Embedding 可能需要较长时间
                write=10.0,
                pool=5.0,
            ),
            limits=httpx.Limits(
                max_keepalive_connections=5,
                max_connections=10,
                keepalive_expiry=30.0,
            ),
        )
        return _embedding_httpx_client


def _get_rerank_httpx_client():
    """获取 Rerank API 专用的 httpx 客户端（线程安全懒加载，复用连接池）"""
    global _rerank_httpx_client
    with _rerank_httpx_client_lock:
        if _rerank_httpx_client is not None:
            return _rerank_httpx_client
        import httpx
        _rerank_httpx_client = httpx.Client(
            timeout=httpx.Timeout(connect=5.0, read=float(RERANK_TIMEOUT), write=10.0, pool=5.0),
            limits=httpx.Limits(max_keepalive_connections=5, max_connections=10, keepalive_expiry=30.0),
        )
        return _rerank_httpx_client


def get_embeddings(model: Optional[str] = None, base_url: Optional[str] = None, force_create: bool = False):
    """获取 Embedding 模型（内存优化版）
    
    ✅ 内存优化特性：
    - 懒加载：只在需要时创建
    - 连接池复用
    - 超时控制（可配置）
    - 错误重试（可配置）
    - 支持强制释放后重新创建
    
    Args:
        model: 模型名称
        base_url: API 地址
        force_create: 强制重新创建（用于释放后重新加载）
    """
    global _embeddings
    
    if not model or not base_url:
        runtime = _get_capability_model_runtime("embedding")
        if runtime:
            model = model or runtime["id"]
            base_url = base_url or runtime["base_url"]
    model = model or EMBEDDING_MODEL
    base_url = base_url or EMBEDDING_BASE_URL

    with _embeddings_lock:
        if force_create and _embeddings is not None:
            _embeddings = None
        if _embeddings is not None:
            if hasattr(_embeddings, "model") and _embeddings.model != model:
                _embeddings = None
        if _embeddings is not None:
            return _embeddings
        try:
            from langchain_openai import OpenAIEmbeddings

            # 从 Config 获取可配置参数
            try:
                from backend.engine.agent.deep_agent import Config
                chunk_size = Config.EMBEDDING_CHUNK_SIZE
                max_retries = Config.EMBEDDING_MAX_RETRIES
                timeout = Config.EMBEDDING_TIMEOUT
            except ImportError:
                chunk_size = 1000
                max_retries = 2
                timeout = 60.0

            _embeddings = OpenAIEmbeddings(
                model=model,
                base_url=base_url,
                api_key="not-needed",
                check_embedding_ctx_length=False,
                chunk_size=chunk_size,
                max_retries=max_retries,
                request_timeout=timeout,
            )
            print(f"✅ Embedding 模型已加载: {model}", file=sys.stderr, flush=True)
        except Exception as e:
            print(f"⚠️ Embedding 加载失败: {e}", file=sys.stderr, flush=True)
            _embeddings = None
        return _embeddings


def release_embeddings():
    """释放 Embedding 模型内存（可选）。
    
    供将来按请求释放用；进程关闭请用 cleanup_embedding_resources。
    """
    global _embeddings
    
    if _embeddings is not None:
        _embeddings = None
        gc.collect()  # 强制垃圾回收
        logger.info("Embedding 模型已释放")


def cleanup_embedding_resources():
    """清理 Embedding 资源（优雅关闭）"""
    global _embeddings, _embedding_httpx_client, _rerank_httpx_client

    if _embedding_httpx_client is not None:
        try:
            _embedding_httpx_client.close()
        except Exception:
            pass
        _embedding_httpx_client = None
    if _rerank_httpx_client is not None:
        try:
            _rerank_httpx_client.close()
        except Exception:
            pass
        _rerank_httpx_client = None

    _embeddings = None
    invalidate_vectorstore_cache()
    gc.collect()  # 强制垃圾回收


def _split_by_sections(content: str, max_length: int = 1500) -> List[str]:
    """按章节分割文档（保留用于兼容或 KB_USE_RECURSIVE_SPLITTER=false 时）。使用 list+join 避免 O(n²) 字符串拼接。"""
    sections: List[str] = []
    parts: List[str] = []

    def flush_current() -> None:
        nonlocal parts
        if not parts:
            return
        current = "\n".join(parts).strip()
        parts = []
        if not current:
            return
        if len(current) <= max_length:
            sections.append(current)
        else:
            for i in range(0, len(current), max_length):
                chunk = current[i : i + max_length].strip()
                if chunk:
                    sections.append(chunk)

    for line in content.split("\n"):
        if line.startswith("## ") and parts:
            flush_current()
            parts = [line]
        else:
            parts.append(line)

    if parts:
        flush_current()
    return sections


# LangChain 生态对齐：使用 RecursiveCharacterTextSplitter 作为默认分块方式
KB_USE_RECURSIVE_SPLITTER = os.getenv("KB_USE_RECURSIVE_SPLITTER", "true").lower() == "true"
KB_CHUNK_SIZE = int(os.getenv("KB_CHUNK_SIZE", "800"))
KB_CHUNK_OVERLAP = int(os.getenv("KB_CHUNK_OVERLAP", "200"))


def _content_offset_to_line_range(content: str, start: int, end: int) -> Tuple[int, int]:
    """将内容中的字符区间 [start, end) 转换为 1-based 行号 (line_start, line_end)。"""
    if start >= len(content) or end > len(content):
        return 1, 1
    line_start = content[:start].count("\n") + 1
    line_end = content[:end].count("\n") + 1
    return line_start, line_end


def _enrich_chunks_with_line_numbers(content: str, chunks: List) -> None:
    """
    为已分块的 Document 列表就地添加 line_start / line_end 到 metadata（精确 citation）。
    按顺序在 content 中定位每个 chunk 的 page_content，计算行号区间。
    """
    search_start = 0
    for ch in chunks:
        text = ch.page_content
        pos = content.find(text, search_start)
        if pos == -1:
            # 回退：尝试从开头找（处理重叠导致的重复）
            pos = content.find(text, 0)
        if pos != -1:
            line_start, line_end = _content_offset_to_line_range(content, pos, pos + len(text))
            ch.metadata["line_start"] = line_start
            ch.metadata["line_end"] = line_end
            ch.metadata["citation"] = {
                "file": ch.metadata.get("source", ""),
                "line_start": line_start,
                "line_end": line_end,
            }
            search_start = pos + len(text)
        else:
            ch.metadata["line_start"] = 1
            ch.metadata["line_end"] = 1
            ch.metadata["citation"] = {
                "file": ch.metadata.get("source", ""),
                "line_start": 1,
                "line_end": 1,
            }


def _split_with_langchain(content: str, metadata_base: Dict[str, Any]) -> List:
    """
    使用 LangChain RecursiveCharacterTextSplitter 分块（与 LangChain 知识库方案对齐）。
    
    分隔符优先按标题与段落，保证语义完整。
    分块后为每个 chunk 填充 line_start / line_end / citation（精确溯源）。
    """
    from langchain_core.documents import Document
    from langchain_text_splitters import RecursiveCharacterTextSplitter
    splitter = RecursiveCharacterTextSplitter(
        chunk_size=KB_CHUNK_SIZE,
        chunk_overlap=KB_CHUNK_OVERLAP,
        length_function=len,
        separators=["\n## ", "\n### ", "\n\n", "\n", " "],
    )
    doc = Document(page_content=content, metadata=dict(metadata_base))
    chunks = splitter.split_documents([doc])
    _enrich_chunks_with_line_numbers(content, chunks)
    return chunks


def load_documents(
    resource_types: Optional[List[ResourceType]] = None,
    domains: Optional[List[str]] = None,
    task_type: Optional[str] = None,
    extract_ontology: bool = False,
    max_chunks: Optional[int] = None,
) -> List:
    """
    根据任务需求动态加载文档（内存优化版）
    
    ✅ 优化改进（Claude 风格）：
    - 复用 storage_manager：should_index_file（扩展名/排除/大小）、load_indexignore（.indexignore）
    - 复用 UnifiedDocumentLoader 支持多格式（.md, .txt, .pdf, .docx, .xlsx）
    - 限制最大文档块数，支持本体提取和知识积累
    - 文件 hash 用已加载内容计算（供增量索引），与 storage_manager.compute_file_hash（按路径算文件 hash）场景不同，此处不调用
    
    Args:
        max_chunks: 最大文档块数，默认使用 MAX_DOCUMENT_CHUNKS 配置
    """
    from langchain_core.documents import Document
    
    # 尝试导入 UnifiedDocumentLoader
    try:
        from ..internal.document_loader import UnifiedDocumentLoader
        _has_unified_loader = True
    except ImportError:
        _has_unified_loader = False
    
    max_chunks = max_chunks or MAX_DOCUMENT_CHUNKS
    max_file_size = MAX_FILE_SIZE_KB * 1024  # 转换为字节
    
    manager = get_resource_manager()
    sources = manager.get_sources(
        resource_types=resource_types,
        domains=domains,
        task_type=task_type,
    )
    
    # 禁用本体提取以节省内存（可选）
    ontology_extractor = None
    if extract_ontology and not VECTORSTORE_RELEASE_AFTER_QUERY:
        ontology_extractor = get_extractor() if _HAS_KNOWLEDGE_GRAPH else None
    
    documents = []
    skipped_files = 0
    
    # 全局 .indexignore（与 storage_manager 一致，避免重复实现）
    index_ignore_patterns = load_indexignore(Path(KB_PATH)) if _HAS_STORAGE_MANAGER else set()
    
    # 支持的文件扩展名（KB_FILE_EXTENSIONS + UnifiedDocumentLoader 格式）
    supported_exts = {e if e.startswith(".") else f".{e}" for e in KB_FILE_EXTENSIONS} or {".md", ".txt"}
    if _has_unified_loader:
        supported_exts.update(UnifiedDocumentLoader.SUPPORTED_FORMATS)
    
    for source in sources:
        if not source.path.exists():
            continue
        
        # 检查资源源是否有支持的文件类型
        source_exts = set(source.file_types) if source.file_types else {".md", ".txt"}
        valid_exts = source_exts & supported_exts
        if not valid_exts:
            continue
        
        # pathlib.glob 不支持大括号展开（如 **/*.{md,pdf,docx,xlsx}），按扩展名展开
        if "{" in source.pattern and "}" in source.pattern and valid_exts:
            patterns = ["**/*" + ext for ext in valid_exts]
        else:
            patterns = [source.pattern]
        
        stopped = False
        for pattern in patterns:
            if stopped:
                break
            for file_path in source.path.glob(pattern):
                if file_path.name == "README.md":
                    continue
                
                # 检查排除模式（资源源配置）
                if source.should_exclude(file_path):
                    continue
                
                # 全局 .indexignore（与 storage_manager 一致；as_posix 保证跨平台匹配）
                if _HAS_STORAGE_MANAGER and index_ignore_patterns:
                    try:
                        rel = file_path.relative_to(Path(KB_PATH)).as_posix()
                        if any(rel == p or rel.startswith(p + "/") for p in index_ignore_patterns):
                            continue
                    except ValueError:
                        pass
                
                # 全局扩展名/排除/大小（复用 storage_manager，避免重复实现）
                if _HAS_STORAGE_MANAGER:
                    if not should_index_file(file_path):
                        skipped_files += 1
                        continue
                else:
                    ext = file_path.suffix.lower()
                    if ext not in supported_exts:
                        continue
                    try:
                        if file_path.stat().st_size > max_file_size:
                            skipped_files += 1
                            continue
                    except OSError:
                        continue
                
                ext = file_path.suffix.lower()
                
                # 检查是否达到最大块数
                if len(documents) >= max_chunks:
                    print(f"⚠️ 达到最大文档块数限制 ({max_chunks})，停止加载", file=sys.stderr, flush=True)
                    stopped = True
                    break
                    
                try:
                    # 根据文件类型选择加载方式（LangChain 对齐：DirectoryLoader 风格按格式加载 + RecursiveCharacterTextSplitter）
                    if ext in {".md", ".txt"}:
                        content = file_path.read_text(encoding="utf-8")
                        metadata_base = {
                            "source": str(file_path),
                            "source_name": source.name,
                            "resource_type": source.resource_type.value,
                            "priority": source.priority,
                            "domains": source.domains,
                            "tags": source.tags,
                            "file_name": file_path.name,
                            "file_type": ext,
                        }
                        if KB_USE_RECURSIVE_SPLITTER:
                            chunk_docs = _split_with_langchain(content, metadata_base)
                            sections = [d.page_content for d in chunk_docs]
                            pre_chunks = chunk_docs  # 已有 metadata
                        else:
                            sections = _split_by_sections(content)
                            pre_chunks = None
                    elif _has_unified_loader and ext in UnifiedDocumentLoader.SUPPORTED_FORMATS:
                        loaded_docs = UnifiedDocumentLoader.load(str(file_path))
                        sections = [doc.page_content for doc in loaded_docs]
                        pre_chunks = None
                    else:
                        continue
                    
                    # 本体提取（可选，仅对文本内容）
                    entities = []
                    relations = []
                    if ontology_extractor and ext in {".md", ".txt"}:
                        full_content = "\n".join(sections)
                        entities = ontology_extractor.extract_entities_simple(
                            full_content, source=str(file_path)
                        )
                        relations = ontology_extractor.extract_relations_simple(
                            full_content, entities, source=str(file_path)
                        )
                        ontology_extractor.accumulate(
                            entities, relations, source=str(file_path)
                        )
                    
                    file_hash = hashlib.md5("\n".join(sections).encode()).hexdigest()
                    extra_meta = {
                        "file_hash": file_hash,
                        "entity_count": len(entities),
                        "relation_count": len(relations),
                        "indexed_at": datetime.now().isoformat(),
                    }
                    search_offset = 0
                    for i, section in enumerate(sections):
                        if not section.strip():
                            continue
                        if len(documents) >= max_chunks:
                            stopped = True
                            break
                        if pre_chunks is not None and i < len(pre_chunks):
                            doc = pre_chunks[i]
                            doc.metadata.update(extra_meta)
                            doc.metadata["chunk_index"] = i
                            documents.append(doc)
                        else:
                            line_start, line_end = 1, 1
                            if ext in {".md", ".txt"} and content:
                                pos = content.find(section, search_offset)
                                if pos == -1:
                                    pos = content.find(section, 0)
                                if pos != -1:
                                    line_start, line_end = _content_offset_to_line_range(
                                        content, pos, pos + len(section)
                                    )
                                    search_offset = pos + len(section)
                            meta = {
                                "source": str(file_path),
                                "source_name": source.name,
                                "resource_type": source.resource_type.value,
                                "priority": source.priority,
                                "domains": source.domains,
                                "tags": source.tags,
                                "chunk_index": i,
                                "file_name": file_path.name,
                                "file_type": ext,
                                "line_start": line_start,
                                "line_end": line_end,
                                "citation": {
                                    "file": str(file_path),
                                    "line_start": line_start,
                                    "line_end": line_end,
                                },
                                **extra_meta,
                            }
                            documents.append(Document(page_content=section, metadata=meta))
                except Exception as e:
                    print(f"⚠️ 跳过文件 {file_path}: {e}", file=sys.stderr, flush=True)
                if stopped:
                    break
            if stopped:
                break
        
        # 外层循环也检查块数限制
        if len(documents) >= max_chunks:
            break
    
    if skipped_files > 0:
        print(f"⚠️ 跳过 {skipped_files} 个过大文件 (>{MAX_FILE_SIZE_KB}KB)", file=sys.stderr, flush=True)
    
    print(f"✅ 加载文档: {len(documents)} 块 (sources: {len(sources)}, max: {max_chunks})", file=sys.stderr, flush=True)
    return documents


def _rerank_docs_via_api(query: str, docs: list, top_k: int = 12) -> Tuple[Optional[List], Dict[str, Any]]:
    """
    调用外部 Rerank API（LM Studio / 独立服务）对检索结果重排。
    
    约定：POST {RERANK_BASE_URL}/rerank，body 含 query、documents、top_n；
    响应含 results: [{index, relevance_score}] 或 data: [{index, score}]。
    失败或未配置时返回 (None, meta)，由调用方回退到 KG 启发式排序。
    """
    if os.getenv("RERANK_FORCE_DISABLE", "false").lower() == "true":
        return None, {"status": "disabled", "reason": "rerank_force_disable"}
    if not docs:
        return None, {"status": "disabled", "reason": "empty_docs"}
    start_ts = _time.time()

    runtime_mode = RERANK_RUNTIME if RERANK_RUNTIME in {"local", "lm_api", "auto"} else "local"
    if runtime_mode in {"local", "auto"}:
        local_ranked, local_meta = _rerank_docs_local(query=query, docs=docs, top_k=top_k)
        if local_ranked is not None:
            return local_ranked, local_meta
        if runtime_mode == "local":
            return None, local_meta

    runtime = _get_capability_model_runtime("rerank")
    if runtime:
        base = runtime["base_url"]
        model_name = runtime["id"]
        enabled = True
    else:
        enabled = bool(RERANK_ENABLED)
        base = RERANK_BASE_URL.rstrip("/")
        model_name = RERANK_MODEL or ""
    if not enabled:
        return None, {"status": "disabled", "reason": "rerank_not_configured"}

    url = f"{base}/rerank" if "/rerank" not in base else base
    payload = {
        "query": query,
        "documents": [d.page_content[:4000] for d in docs],
        "top_n": min(top_k, len(docs)),
    }
    if model_name:
        payload["model"] = model_name
    try:
        client = _get_rerank_httpx_client()
        r = client.post(url, json=payload)
        r.raise_for_status()
        data = r.json()
    except Exception as e:
        if os.getenv("RERANK_DEBUG"):
            print(f"⚠️ Rerank API 调用失败，回退 KG 排序: {e}", file=sys.stderr, flush=True)
        return None, {
            "status": "degraded",
            "reason": f"rerank_api_error: {e}",
            "model": model_name,
            "base_url": base,
            "elapsed_ms": int((_time.time() - start_ts) * 1000),
        }
    results = data.get("results") or data.get("data") or []
    if not results:
        return None, {
            "status": "degraded",
            "reason": "rerank_empty_result",
            "model": model_name,
            "base_url": base,
            "elapsed_ms": int((_time.time() - start_ts) * 1000),
        }
    index_to_score = {}
    for item in results:
        idx = item.get("index", item.get("i", -1))
        score = item.get("relevance_score", item.get("score", 0))
        if 0 <= idx < len(docs):
            index_to_score[idx] = score
    if not index_to_score:
        return None, {
            "status": "degraded",
            "reason": "rerank_invalid_indices",
            "model": model_name,
            "base_url": base,
            "elapsed_ms": int((_time.time() - start_ts) * 1000),
        }
    ordered = sorted(index_to_score.items(), key=lambda x: -x[1])
    return (
        [docs[i] for i, _ in ordered],
        {
            "status": "enabled",
            "reason": "rerank_api",
            "model": model_name,
            "base_url": base,
            "count": len(ordered),
            "elapsed_ms": int((_time.time() - start_ts) * 1000),
        },
    )


def _get_vectorstore_path() -> Path:
    """向量存储目录（单一来源，供加载/重建复用）"""
    if _HAS_STORAGE_MANAGER:
        return Path(STORAGE_VECTOR_PATH)
    return Path(VECTOR_STORE_PATH) / "unified"


def _load_vectorstore_internal(domains: Optional[List[str]] = None, task_type: Optional[str] = None):
    """
    内部函数：实际加载向量存储
    
    使用 storage_manager 的 VectorIndexManager 管理索引。
    如果索引不存在，自动创建。
    
    Returns:
        FAISS vectorstore 实例
    """
    embeddings = get_embeddings()
    if embeddings is None:
        return None
    
    try:
        from langchain_community.vectorstores import FAISS
    except ImportError as e:
        logger.info(
            "FAISS 未安装（可选依赖）。安装 pip install .[local-embedding] 启用本地向量索引；当前仅使用 HTTP 嵌入与 BM25。%s",
            e,
        )
        return None

    try:
        store_path = _get_vectorstore_path()

        # 检查索引是否存在
        if not (store_path / "index.faiss").exists():
            print(f"📦 创建新向量索引: {store_path}", file=sys.stderr, flush=True)
            
            # 加载文档并创建索引
            documents = load_documents(domains=domains, task_type=task_type, extract_ontology=True)
            if not documents:
                print("⚠️ 没有文档可索引", file=sys.stderr, flush=True)
                return None
            
            # 使用 VectorIndexManager 创建索引
            if _HAS_STORAGE_MANAGER:
                index_manager = get_index_manager()
                count = index_manager.add_documents(documents, embeddings, create_new=True)
                print(f"✅ 向量索引已创建: {count} 个文档", file=sys.stderr, flush=True)
            else:
                vectorstore = FAISS.from_documents(documents, embeddings)
                store_path.mkdir(parents=True, exist_ok=True)
                vectorstore.save_local(str(store_path))
                print(f"✅ 向量索引已创建: {len(documents)} 个文档", file=sys.stderr, flush=True)
                return vectorstore
        
        # 加载索引
        vectorstore = FAISS.load_local(
            str(store_path),
            embeddings,
            allow_dangerous_deserialization=True
        )
        
        return vectorstore

    except Exception as e:
        print(f"⚠️ 向量存储加载失败: {e}", file=sys.stderr, flush=True)
        traceback.print_exc()
        return None


def _load_vectorstore_lazy(domains: Optional[List[str]] = None, task_type: Optional[str] = None):
    """
    懒加载向量存储（带 LRU 缓存）
    
    优化：使用全局缓存避免重复加载 FAISS 索引
    - 缓存命中时直接返回，避免磁盘 I/O
    - 缓存未命中时加载并缓存
    - 支持 TTL 过期机制
    
    Returns:
        FAISS vectorstore 实例（可能是缓存的）
    """
    # 构建缓存键
    cache_key = f"vs:{domains or 'all'}:{task_type or 'default'}"
    
    # 使用缓存加载
    return _vectorstore_cache.get_or_load(
        cache_key,
        lambda: _load_vectorstore_internal(domains, task_type)
    )


def get_vectorstore_stats() -> Dict:
    """获取向量存储统计信息（不加载到内存）"""
    # 使用存储管理器
    if _HAS_STORAGE_MANAGER:
        try:
            index_manager = get_index_manager()
            return index_manager.get_stats()
        except Exception as e:
            print(f"⚠️ 获取统计信息失败: {e}")
    
    # 回退到旧逻辑
    store_path = _get_vectorstore_path()
    result = {
        "path": str(store_path),
        "exists": False,
        "size_mb": 0,
    }
    if not store_path.exists():
        return result
    
    index_file = store_path / "index.faiss"
    result["exists"] = index_file.exists()
    
    if index_file.exists():
        result["size_mb"] = round(index_file.stat().st_size / 1024 / 1024, 2)
    
    return result


def get_knowledge_retriever_tool(
    domains: Optional[List[str]] = None,
    task_type: Optional[str] = None,
):
    """
    获取推理型知识检索工具（Claude 风格：懒加载实现）
    
    业界顶级做法（GraphRAG 模式）：
    1. 知识图谱增强查询（实体关联、多跳推理）
    2. DocMap 文档结构导航
    3. 语义检索 + Rerank
    4. 上下文定位和证据链
    
    ✅ 内存优化：
    - 向量存储懒加载：只在工具被调用时才加载
    - 使用后自动释放：工具函数内部管理生命周期
    - 避免全局缓存：每次调用都重新加载（FAISS 文件系统缓存足够快）
    """
    embeddings = get_embeddings()
    if embeddings is None:
        return None
    
    try:
        from langchain_core.tools import tool
        
        resource_manager = get_resource_manager()
        meta_store = IndexMetadataStore() if _HAS_STORAGE_MANAGER else None
        
        # KG 懒加载：不在注册时加载，避免启动阻塞；首次 search_knowledge 时再加载
        
        def _score_docs_with_kg(query: str, docs: list, top_k: int = 8, kg: Any = None) -> list:
            """
            知识图谱增强的排序（非独立 Rerank 模型）。
            
            Qwen3-Embedding 不内置 Rerank；Qwen3-Reranker 为独立模型需单独部署。
            此处为轻量启发式：关键词 + KG 扩展词 + 位置 + 资源优先级，不依赖额外模型。
            """
            query_terms = set(query.lower().split())
            
            # 获取知识图谱扩展
            kg_expansion = {}
            if kg:
                expansion = kg.expand_query(query)
                kg_expansion = {
                    "terms": set(expansion.get("expanded_terms", [])),
                    "entities": {e["name"].lower() for e in expansion.get("matched_entities", [])},
                    "context": expansion.get("context", []),
                }
            
            scored_docs = []
            for doc in docs:
                content_lower = doc.page_content.lower()
                
                # 1. 关键词匹配分数
                keyword_score = sum(1 for term in query_terms if term in content_lower)
                
                # 2. 知识图谱扩展词匹配
                kg_score = 0
                if kg_expansion:
                    for term in kg_expansion.get("terms", []):
                        if term.lower() in content_lower:
                            kg_score += 0.5
                    for entity in kg_expansion.get("entities", []):
                        if entity in content_lower:
                            kg_score += 1.0
                
                # 3. 位置分数
                position_score = 0
                for term in query_terms:
                    pos = content_lower.find(term)
                    if pos != -1:
                        position_score += 1 / (1 + pos / 100)
                
                # 4. 资源优先级
                priority = doc.metadata.get("priority", 0.5)
                
                # 综合分数（知识图谱权重更高）
                total_score = (
                    keyword_score * 0.25 + 
                    kg_score * 0.35 +  # 知识图谱增强
                    position_score * 0.15 + 
                    priority * 0.25
                )
                scored_docs.append((doc, total_score))
            
            scored_docs.sort(key=lambda x: x[1], reverse=True)
            return [doc for doc, _ in scored_docs[:top_k]]
        
        @tool
        def search_knowledge(query: str, top_k: int = 20) -> str:
            """领域内容检索 - 检索模板、案例、规则、数据等领域内容。
            
            索引内容：knowledge_base/global/domain 下的领域内容（模板、案例、规则、数据）。
            支持格式：.md, .pdf, .docx, .xlsx（按需索引）。
            自动增强：知识图谱扩展查询；可选 Rerank 精排（默认本地 CPU，可切换 LM API），不可用时回退 KG 启发式排序。
            
            When to use:
            - 需要从知识库找模板、案例、规则、数据等结构化领域内容时。
            - 用户问题涉及投标、合同、评分等已入库领域时。
            
            Avoid when:
            - 方法论/工作流程：用 list_skills、get_skill_info 或 read_file 读 SKILL.md。
            - 已知文件路径：直接用 read_file 读取 knowledge_base/global/domain/ 下文件。
            
            Parameters:
            - query: 搜索查询，建议用具体关键词（如"投标模板"、"合同案例"、"评分规则"）。
            - top_k: 返回条数，默认 20，范围 5–30。
            
            Returns:
            相关文档片段（按相关性排序）；无结果时返回回退建议。结果含 source_id/excerpt，引用时须注明来源。
            
            Examples:
            - search_knowledge(query="投标资格审查条款", top_k=10)
            - search_knowledge(query="评分规则 权重", top_k=15)
            """
            # 查询缓存：相同 query 直接返回缓存结果，减少向量检索
            cache_scope = (
                f"top_k={int(top_k)}|"
                f"domains={','.join(sorted(domains or []))}|"
                f"task_type={task_type or ''}"
            )
            if meta_store:
                try:
                    cached = meta_store.get_cached_query(
                        query,
                        return_full_data=True,
                        cache_key_suffix=cache_scope,
                    )
                    if cached and isinstance(cached, list) and len(cached) > 0:
                        item = cached[0]
                        if isinstance(item, dict) and "text" in item:
                            cache_ts = item.get("_cached_at")
                            if cache_ts is None:
                                return item["text"]
                            if _time.time() - cache_ts < 300:  # 5 分钟有效
                                return item["text"]
                            # 过期则继续走检索
                except Exception:
                    pass
            
            # ✅ 懒加载向量存储（Claude 风格：按需加载）
            vectorstore = _load_vectorstore_lazy(domains=domains, task_type=task_type)
            if vectorstore is None:
                return (
                    "向量存储不可用（可能尚未建索引）。"
                    "建议：用 read_file 直接读取 knowledge_base/global/domain/ 下的内容文件。"
                )
            
            retriever = None
            is_hybrid_retriever = False
            k = min(max(top_k, 5), 30)  # 限制 5~30
            # 可选：使用 LangChain 混合检索（BM25 + 向量，见 tools/internal/retriever.py）
            use_hybrid = os.getenv("USE_HYBRID_RETRIEVER", "true").lower() == "true"
            if use_hybrid:
                try:
                    from ..internal.retriever import UnifiedRetriever
                    cache_key = (tuple(sorted(domains)), task_type)
                    with _hybrid_retriever_cache_lock:
                        if cache_key in _hybrid_retriever_cache:
                            retriever = _hybrid_retriever_cache[cache_key]
                            is_hybrid_retriever = True
                    if retriever is None:
                        hybrid_docs = load_documents(domains=domains, task_type=task_type, max_chunks=500)
                        if hybrid_docs:
                            new_retriever = UnifiedRetriever(vectorstore, documents=hybrid_docs, k=k)
                            with _hybrid_retriever_cache_lock:
                                _hybrid_retriever_cache.setdefault(cache_key, new_retriever)
                                retriever = _hybrid_retriever_cache[cache_key]
                            is_hybrid_retriever = True
                except Exception as e:
                    logger.debug("UnifiedRetriever 不可用，回退向量检索: %s", e)
            if retriever is None:
                retriever = vectorstore.as_retriever(search_kwargs={"k": k})
            _ret = [None]

            def _run_retrieval():
                try:
                    results_parts = []
                    
                    # KG 懒加载 + 失败不拖垮检索：首次使用时加载，失败则仅跳过扩展与多跳
                    kg = None
                    docmap = None
                    if _HAS_KNOWLEDGE_GRAPH:
                        try:
                            kg = get_knowledge_graph()
                            docmap = get_document_map()
                        except Exception as e:
                            logger.warning("KG 加载失败，跳过扩展与多跳: %s", e)
                    
                    # 1. 知识图谱查询扩展（失败时仍用原 query 做向量检索）
                    enriched_query = query
                    kg_context = ""
                    if kg:
                        try:
                            expansion = kg.expand_query(query)
                            if expansion.get("expanded_terms"):
                                enriched_query = expansion["expanded_query"]
                                
                                # 构建知识图谱上下文（标注来源供调用方区分）
                                if expansion.get("matched_entities") or expansion.get("context"):
                                    kg_lines = ["**[知识图谱上下文]**（来源: knowledge_graph | trust_level: L4）"]
                                    
                                    # 匹配的实体
                                    matched = expansion.get("matched_entities", [])[:3]
                                    for entity in matched:
                                        kg_lines.append(f"- {entity.get('name', '')} ({entity.get('type', '')})")
                                    
                                    # 相关关系（expand_query 已有）
                                    for ctx in expansion.get("context", [])[:5]:
                                        kg_lines.append(f"- {ctx}")
                                    
                                    # P2: 多跳路径与规则推理（系统化接入检索链）
                                    use_multihop = os.getenv("KG_USE_MULTIHOP_IN_RETRIEVAL", "true").lower() == "true"
                                    if use_multihop and matched:
                                        try:
                                            multihop_depth = 2
                                            try:
                                                d = os.getenv("KG_MULTIHOP_MAX_DEPTH", "2")
                                                if d.isdigit() and int(d) >= 1:
                                                    multihop_depth = int(d)
                                            except Exception:
                                                pass
                                            # 对前两个匹配实体做多跳路径（若存在路径则加入上下文）
                                            if len(matched) >= 2:
                                                eid1, eid2 = matched[0].get("id"), matched[1].get("id")
                                                if eid1 and eid2:
                                                    paths = kg.find_path(eid1, eid2, max_depth=multihop_depth)
                                                    for path in paths[:2]:
                                                        if path:
                                                            path_str = " → ".join(
                                                                f"{p[0].name}-[{p[1].predicate.value}]->{p[2].name}"
                                                                for p in path
                                                            )
                                                            kg_lines.append(f"- [多跳] {path_str}")
                                            # 对首个匹配实体做规则推理
                                            eid0 = matched[0].get("id") if matched else None
                                            if eid0:
                                                inferred = kg.infer_relations(eid0)
                                                for inf in inferred[:3]:
                                                    kg_lines.append(
                                                        f"- [推理] {inf.get('subject', '')} → {inf.get('predicate', '')} → {inf.get('object', '')}"
                                                    )
                                        except Exception as _e:
                                            logger.debug("KG multihop/infer in retrieval: %s", _e)
                                    
                                    kg_context = "\n".join(kg_lines)
                        except Exception as e:
                            logger.warning("expand_query 失败，跳过 KG 扩展: %s", e)
                            enriched_query = query
                            kg_context = ""
                    
                    # 2. 语义检索（UnifiedRetriever 用 retrieve，LangChain 用 invoke）
                    if is_hybrid_retriever:
                        docs = retriever.retrieve(enriched_query, k=k)
                    else:
                        docs = retriever.invoke(enriched_query)
                    
                    if not docs:
                        # 尝试知识图谱推理
                        if kg:
                            entities = kg.find_entities(name=query)
                            if entities:
                                inferred = []
                                for entity in entities[:3]:
                                    inferred.extend(kg.infer_relations(entity.id))
                                
                                if inferred:
                                    inference_lines = ["**[知识图谱推理结果]**"]
                                    for inf in inferred[:5]:
                                        inference_lines.append(
                                            f"- {inf['subject']} → {inf['predicate']} → {inf['object']} "
                                            f"(置信度: {inf['confidence']:.2f})"
                                        )
                                    _ret[0] = "\n".join(inference_lines)
                                    return
                        
                        fallback = (
                            "未找到相关内容。建议："
                            "1) 用 read_file 直接读取 knowledge_base/global/domain/{domain}/ 下的内容文件；"
                            "2) 换更具体的关键词再试（如「投标模板」「合同案例」「评分规则」）。"
                        )
                        _ret[0] = fallback
                        return
                
                    # 3. 重排序：使用与检索一致的查询（enriched_query），避免 KG 扩展词检索到的文档被原 query 重排压低
                    docs_reranked, rerank_meta = _rerank_docs_via_api(enriched_query, docs, top_k=min(RERANK_TOP_N, k))
                    if docs_reranked is None:
                        docs_reranked = _score_docs_with_kg(enriched_query, docs, top_k=min(12, k), kg=kg)
                        if rerank_meta.get("status") != "disabled":
                            rerank_meta = {
                                **rerank_meta,
                                "status": "degraded",
                                "fallback": "kg_heuristic",
                            }

                    rerank_badge = "已禁用"
                    rerank_elapsed_ms = rerank_meta.get("elapsed_ms")
                    if rerank_meta.get("status") == "enabled":
                        rerank_badge = f"已启用({rerank_meta.get('model', 'rerank')})"
                    elif rerank_meta.get("status") == "degraded":
                        rerank_badge = f"已降级({rerank_meta.get('reason', 'unknown')})"
                    if isinstance(rerank_elapsed_ms, int) and rerank_elapsed_ms > 0:
                        rerank_badge = f"{rerank_badge} {rerank_elapsed_ms}ms"
                    
                    # 4. 添加知识图谱上下文
                    if kg_context:
                        results_parts.append(kg_context)
                        results_parts.append("")

                    retrieval_stage = "hybrid" if is_hybrid_retriever else "vector"
                    results_parts.append(
                        f"**[检索链路]** 召回: {retrieval_stage} · 重排: {rerank_badge} · default_trust_level: L4"
                    )
                    results_parts.append("")
                    logger.info(
                        "[search_knowledge] retrieval=%s rerank_status=%s rerank_reason=%s rerank_model=%s",
                        retrieval_stage,
                        rerank_meta.get("status"),
                        rerank_meta.get("reason"),
                        rerank_meta.get("model"),
                    )
                    
                    # 5. 格式化检索结果（标注来源: vector_search / knowledge_graph）
                    # P2 可追溯：每条预留 source_url / evidence / confidence，便于治理与审计
                    results_parts.append("**[检索结果]**")
                    for i, doc in enumerate(docs_reranked, 1):
                        meta = doc.metadata
                        source_type = meta.get("resource_type", "unknown")
                        file_name = meta.get("file_name", "unknown")
                        source_url = meta.get("source") or meta.get("file_path") or meta.get("source_path") or ""
                        confidence = meta.get("score") if isinstance(meta.get("score"), (int, float)) else None
                        
                        # DocMap 上下文定位
                        doc_location = ""
                        if docmap:
                            sections = docmap.find_sections(query)
                            for section, score in sections[:1]:
                                if score > 1.0:
                                    doc_location = f" [章节: {section.title}]"
                        
                        # 获取静态 DocMap 上下文
                        static_context = ""
                        for domain in meta.get("domains", []):
                            domain_docmap = resource_manager.get_docmap(domain)
                            if domain_docmap:
                                sections = domain_docmap.get("sections", {})
                                for section_name, section_info in sections.items():
                                    if isinstance(section_info, dict):
                                        if section_info.get("path", "") in str(meta.get("source", "")):
                                            static_context = f" [{section_name}]"
                                            break
                        
                        location_info = doc_location or static_context
                        # JIT 验证：citation 与当前文件一致则 trust_level 保持，否则标注已变更
                        jit_note = ""
                        citation = meta.get("citation")
                        if citation and isinstance(citation, dict):
                            try:
                                from backend.memory.jit_verifier import verify_citation
                                from backend.tools.base.paths import get_workspace_root
                                ws = str(get_workspace_root())
                                if not verify_citation(citation, doc.page_content, workspace_path=ws):
                                    jit_note = " [内容已变更，请以当前文件为准]"
                            except Exception:
                                pass
                        evidence_snippet = (doc.page_content or "")[:800]
                        trace_note = f" | source_url: {source_url}" if source_url else ""
                        if confidence is not None:
                            trace_note = f"{trace_note} | confidence: {confidence:.2f}" if trace_note else f" | confidence: {confidence:.2f}"
                        results_parts.append(
                            f"\n[{i}] （来源: vector_search | trust_level: L4）({source_type}{location_info}) {file_name}{jit_note}{trace_note}\n{evidence_snippet}"
                        )
                    
                    out_text = "\n".join(results_parts)
                    if meta_store:
                        try:
                            meta_store.cache_query(
                                query,
                                result_ids=[],
                                result_data=[{"text": out_text}],
                                cache_key_suffix=cache_scope,
                            )
                        except Exception:
                            pass
                    _ret[0] = out_text
                    return
                except Exception as e:
                    logger.warning("[search_knowledge] 检索异常，返回回退文案: %s", e, exc_info=True)
                    err_str = str(e).lower()
                    if "502" in err_str or "bad gateway" in err_str:
                        _ret[0] = (
                            "知识检索暂时不可用（向量/Embedding 服务 502）。"
                            "请检查 Embedding 服务是否启动或网络是否正常；"
                            "或使用 read_file 直接读取 knowledge_base/ 下内容。"
                        )
                    else:
                        _ret[0] = (
                            "知识检索暂时不可用。建议："
                            "1) 用 read_file 直接读取 knowledge_base/global/domain/{domain}/ 下的内容文件；"
                            "2) 换更具体的关键词稍后再试。"
                        )
                    return
                finally:
                    # 不在闭包内 del retriever，否则 Python 会将 retriever 视为局部变量导致 UnboundLocalError；线程结束后闭包释放即可
                    pass

            timeout_sec = KNOWLEDGE_RETRIEVAL_TIMEOUT_SEC
            if timeout_sec > 0:
                with ThreadPoolExecutor(max_workers=1) as ex:
                    fut = ex.submit(_run_retrieval)
                    try:
                        fut.result(timeout=timeout_sec)
                    except FuturesTimeoutError:
                        logger.warning("[search_knowledge] 检索超时 (%ds)", timeout_sec)
                        return "检索超时，请稍后重试或使用 read_file 直接查看 knowledge_base/ 下内容。"
            else:
                _run_retrieval()
            return _ret[0] if _ret[0] is not None else "知识检索暂时不可用。建议：用 read_file 直接读取 knowledge_base/ 下内容。"
        
        return search_knowledge
        
    except Exception as e:
        logger.warning("Retriever tool failed: %s", e)
        traceback.print_exc()
        return None


def rebuild_index(
    domains: Optional[List[str]] = None,
    task_type: Optional[str] = None,
    extract_ontology: bool = True,
    force: bool = False,
) -> bool:
    """
    重建向量索引
    
    Args:
        force: 是否强制完全重建（删除现有索引）
    """
    embeddings = get_embeddings()
    if embeddings is None:
        return False
    
    try:
        # 加载文档
        documents = load_documents(
            domains=domains, 
            task_type=task_type,
            extract_ontology=extract_ontology,
        )
        if not documents:
            logger.warning("没有文档可索引")
            return False
        
        # 使用存储管理器
        if _HAS_STORAGE_MANAGER:
            index_manager = get_index_manager()
            
            if force:
                logger.info("强制重建索引...")
                index_manager.delete_index()
            else:
                # 增量模式：从元数据中移除已删除的文档（磁盘上已不存在的 path）
                current_sources = {doc.metadata.get("source", "") for doc in documents if doc.metadata.get("source")}
                for indexed_path in index_manager.metadata_store.get_all_indexed_paths():
                    if indexed_path and indexed_path not in current_sources:
                        index_manager.metadata_store.delete_indexed_doc(indexed_path)
                        logger.debug("增量索引：已移除已删除文档的元数据 path=%s", indexed_path)
            
            count = index_manager.add_documents(documents, embeddings, create_new=force)
            logger.info("索引重建完成: %s 个文档", count)
            invalidate_vectorstore_cache()
            if _HAS_STORAGE_MANAGER:
                try:
                    get_metadata_store().clear_query_cache()
                except Exception as qe:
                    logger.warning("清空查询缓存失败: %s", qe)
            return count > 0
        
        # 回退到旧逻辑
        from langchain_community.vectorstores import FAISS
        
        store_path = _get_vectorstore_path()
        vectorstore = FAISS.from_documents(documents, embeddings)
        store_path.mkdir(parents=True, exist_ok=True)
        vectorstore.save_local(str(store_path))
        
        logger.info("索引重建完成: %s 个文档", len(documents))
        invalidate_vectorstore_cache()
        if _HAS_STORAGE_MANAGER:
            try:
                get_metadata_store().clear_query_cache()
            except Exception as qe:
                logger.warning("清空查询缓存失败: %s", qe)
        return True
        
    except Exception as e:
        logger.warning("索引重建失败: %s", e)
        traceback.print_exc()
        return False


# ============================================================
# 导出
# ============================================================
__all__ = [
    # Embedding
    "get_embeddings",
    "get_knowledge_retriever_tool",
    "rebuild_index",
    "load_documents",
    "get_vectorstore_stats",
    "get_vectorstore_cache_stats",
    "invalidate_vectorstore_cache",
    # 资源管理
    "ResourceType",
    "ResourceSource",
    "ResourceManager", 
    "get_resource_manager",
    
    # 失败重试
    "ExecutionStatus",
    "ExecutionContext",
    "FailureRecoveryManager",
    "get_failure_recovery",
    
    # 知识图谱（便捷函数）
    "extract_entities_from_text",
    "extract_relations_from_text",
    "query_knowledge_graph",
    "get_knowledge_graph_stats",
]

# 如果存储管理器可用，导出其类型
if _HAS_STORAGE_MANAGER:
    __all__.extend([
        "get_metadata_store",
        "get_index_manager",
        "IndexMetadataStore",
        "VectorIndexManager",
    ])

# 如果知识图谱模块可用，也导出其类型
if _HAS_KNOWLEDGE_GRAPH:
    __all__.extend([
        "KnowledgeGraph",
        "DocumentMap",
        "EntityRelationExtractor",
        "get_knowledge_graph",
        "get_document_map",
        "get_extractor",
        "EntityType",
        "RelationType",
    ])
