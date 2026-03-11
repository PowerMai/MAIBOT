"""
自我学习系统 - Learning Layer

职责：从任务执行中学习模式，提升 Agent 能力
- 推理路径（ReasoningPath）：记录成功的推理链
- 成功/失败模式：学习任务执行模式
- 置信度衰减：自动清理过期知识

与 Memory 的区别：
- Memory（由 langmem 实现）：跨会话存储用户偏好、上下文
- Learning（本模块）：从任务中学习，优化 Agent 行为

学习数据与工作区/租户的绑定约定：见 docs/learning_scope.md。当前为单进程单工作区或前端保证当前工作区唯一；workspace_domain 用于知识分段，不替代物理隔离。

可选 KG 衔接：learn_from_success/learn_from_failure 支持 task_type、workspace_domain（从 configurable 传入）；
成功/失败模式按 task_type_workspace_domain_... 分段存储，便于 retrieve_context 按场景过滤与知识图谱按领域扩展。

参考：
- LLMGraphTransformer: langchain_experimental.graph_transformers
- KAG (Knowledge Augmented Generation): OpenSPG/KAG
"""

import asyncio
import hashlib
import json
import os
import threading
import uuid
from typing import Optional, Dict, Any, List, Callable, TypedDict
from datetime import datetime, timedelta
from pathlib import Path
from dataclasses import dataclass, field
from enum import Enum

# LangGraph Store（官方持久化）
try:
    from langgraph.store.base import BaseStore
    from langgraph.store.memory import InMemoryStore
    _HAS_STORE = True
except ImportError:
    _HAS_STORE = False
    BaseStore = None
    InMemoryStore = None

# LLMGraphTransformer（官方知识图谱构建）
try:
    from langchain_experimental.graph_transformers import LLMGraphTransformer
    from langchain_core.documents import Document
    _HAS_TRANSFORMER = True
except ImportError:
    _HAS_TRANSFORMER = False
    LLMGraphTransformer = None
    Document = None

# 本地知识图谱模块
try:
    from .knowledge_graph import (
        KnowledgeGraph, EntityRelationExtractor,
        get_knowledge_graph, get_extractor,
        EntityType, RelationType, Entity, Relation,
    )
    _HAS_KG = True
except ImportError:
    _HAS_KG = False

# langmem 反思执行器（用于后台执行经验提取）
try:
    from langmem import create_memory_store_manager, ReflectionExecutor
    _HAS_LANGMEM_REFLECTION = True
except Exception:
    create_memory_store_manager = None
    ReflectionExecutor = None
    _HAS_LANGMEM_REFLECTION = False


# ============================================================
# 学习数据目录（统一使用 paths.LEARNING_PATH，随工作区切换）
# ============================================================
def _get_learning_dir_static() -> Path:
    """获取学习数据目录（使用统一路径模块，与工作区一致）"""
    try:
        from backend.tools.base.paths import LEARNING_PATH
        LEARNING_PATH.mkdir(parents=True, exist_ok=True)
        return LEARNING_PATH
    except Exception:
        # 回退：backend/tmp/.memory/learning（兼容未设置工作区或 paths 不可用）
        fallback = Path(__file__).parent.parent.parent / "tmp" / ".memory" / "learning"
        fallback.mkdir(parents=True, exist_ok=True)
        return fallback


# ============================================================
# 1. 学习配置（可调优参数）
# ============================================================
@dataclass
class LearningConfig:
    """学习配置 - 控制学习行为和效率"""
    
    # 触发阈值
    min_complexity_for_learning: int = 3  # 最小步骤数才触发深度学习
    min_confidence_for_storage: float = 0.5  # 最小置信度才存入图谱
    
    # 置信度调整
    success_confidence_boost: float = 0.05  # 成功时增加
    failure_confidence_penalty: float = 0.1  # 失败时降低
    decay_rate_per_day: float = 0.01  # 每天衰减率
    
    # 知识剪枝
    min_confidence_threshold: float = 0.1  # 低于此值的知识被剪枝
    max_entities_per_type: int = 1000  # 每类实体最大数量
    
    # 异步处理
    async_learning: bool = True  # 是否异步学习
    batch_size: int = 10  # 批量处理大小
    
    # 学习数据存储（文件持久化，Memory 由 langmem 管理）
    # 注意：Learning 数据与 Memory 数据分开存储


# ============================================================
# 注意：Memory 相关功能已迁移到 memory_tools.py（使用 langmem）
# 本模块专注于 Learning（学习）功能
# ============================================================


# ============================================================
# 2. 学习状态（LangGraph State 兼容）
# ============================================================
class LearningState(TypedDict, total=False):
    """学习状态 - 可集成到 LangGraph StateGraph"""
    task_id: str
    task_type: str
    intermediate_steps: List[Dict]  # 执行轨迹
    final_result: Dict
    entities_extracted: List[Dict]
    relations_extracted: List[Dict]
    learning_complete: bool
    kg_updates: List[Dict]


def _stable_hash(s: str) -> str:
    """确定性字符串摘要，用于 path_id 等持久化标识（避免 hash() 受 PYTHONHASHSEED 影响）。"""
    return hashlib.sha256(s.encode("utf-8")).hexdigest()[:16]


# ============================================================
# 3. 推理路径存储（不仅是实体）
# ============================================================
@dataclass
class ReasoningPath:
    """推理路径 - 记录成功的推理链"""
    path_id: str
    task_type: str
    input_pattern: str  # 输入模式（抽象化）
    steps: List[Dict]  # 推理步骤
    output_pattern: str  # 输出模式
    success_count: int = 1
    failure_count: int = 0
    confidence: float = 1.0
    created_at: datetime = field(default_factory=datetime.now)
    last_used: datetime = field(default_factory=datetime.now)
    
    def to_dict(self) -> Dict:
        return {
            "path_id": self.path_id,
            "task_type": self.task_type,
            "input_pattern": self.input_pattern,
            "steps": self.steps,
            "output_pattern": self.output_pattern,
            "success_count": self.success_count,
            "failure_count": self.failure_count,
            "confidence": self.confidence,
            "created_at": self.created_at.isoformat(),
            "last_used": self.last_used.isoformat(),
        }
    
    @classmethod
    def from_dict(cls, data: Dict) -> "ReasoningPath":
        """从 dict 反序列化；缺字段用默认值，避免不可信数据导致 KeyError。"""
        path_id = str(data.get("path_id") or "").strip() or f"unknown_{uuid.uuid4().hex[:8]}"
        task_type = str(data.get("task_type") or "general").strip()
        input_pattern = str(data.get("input_pattern") or "").strip()
        steps = data.get("steps")
        if not isinstance(steps, list):
            steps = []
        output_pattern = str(data.get("output_pattern") or "").strip()
        created_at = datetime.now()
        if data.get("created_at"):
            try:
                created_at = datetime.fromisoformat(str(data["created_at"]))
            except (ValueError, TypeError):
                pass
        last_used = datetime.now()
        if data.get("last_used"):
            try:
                last_used = datetime.fromisoformat(str(data["last_used"]))
            except (ValueError, TypeError):
                pass
        return cls(
            path_id=path_id,
            task_type=task_type,
            input_pattern=input_pattern,
            steps=steps,
            output_pattern=output_pattern,
            success_count=int(data.get("success_count", 1) or 1),
            failure_count=int(data.get("failure_count", 0) or 0),
            confidence=float(data.get("confidence", 1.0) or 1.0),
            created_at=created_at,
            last_used=last_used,
        )


@dataclass
class FailureLesson:
    """失败经验：用于避免重复踩坑。"""

    lesson_id: str
    task_type: str
    error_pattern: str
    root_cause: str
    what_worked: str
    what_didnt_work: List[str]
    applicable_context: str
    confidence: float = 0.6
    created_at: datetime = field(default_factory=datetime.now)
    last_updated: datetime = field(default_factory=datetime.now)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "lesson_id": self.lesson_id,
            "task_type": self.task_type,
            "error_pattern": self.error_pattern,
            "root_cause": self.root_cause,
            "what_worked": self.what_worked,
            "what_didnt_work": self.what_didnt_work,
            "applicable_context": self.applicable_context,
            "confidence": self.confidence,
            "created_at": self.created_at.isoformat(),
            "last_updated": self.last_updated.isoformat(),
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "FailureLesson":
        """从 dict 反序列化；日期字段解析失败时回退 now，避免不可信数据 ValueError。"""
        created_at = datetime.now()
        if data.get("created_at"):
            try:
                created_at = datetime.fromisoformat(str(data["created_at"]))
            except (ValueError, TypeError):
                pass
        last_updated = datetime.now()
        if data.get("last_updated"):
            try:
                last_updated = datetime.fromisoformat(str(data["last_updated"]))
            except (ValueError, TypeError):
                pass
        return cls(
            lesson_id=str(data.get("lesson_id") or str(uuid.uuid4())),
            task_type=str(data.get("task_type") or "general"),
            error_pattern=str(data.get("error_pattern") or "unknown"),
            root_cause=str(data.get("root_cause") or "未知根因"),
            what_worked=str(data.get("what_worked") or "待验证"),
            what_didnt_work=list(data.get("what_didnt_work") or []),
            applicable_context=str(data.get("applicable_context") or "general"),
            confidence=float(data.get("confidence", 0.6) or 0.6),
            created_at=created_at,
            last_updated=last_updated,
        )


# ============================================================
# 4. 自我学习管理器（LangGraph 兼容）
# ============================================================
class SelfLearningManager:
    """
    自我学习管理器 - Learning Layer
    
    核心特性：
    1. 推理路径存储 - 记录成功的推理链
    2. 成功/失败模式 - 学习任务执行模式
    3. 置信度衰减 - 自动清理过期知识
    4. LLMGraphTransformer 集成 - 官方知识图谱构建
    5. 异步学习 - 不阻塞主流程
    
    注意：Memory 功能已迁移到 memory_tools.py（使用 langmem）
    """
    
    def __init__(
        self,
        config: Optional[LearningConfig] = None,
        knowledge_graph: Optional[KnowledgeGraph] = None,
        llm: Optional[Any] = None,  # 用于 LLMGraphTransformer
    ):
        self.config = config or LearningConfig()
        self.kg = knowledge_graph or (get_knowledge_graph() if _HAS_KG else None)
        self._extractor = get_extractor() if _HAS_KG else None
        self._llm = llm
        
        # LLMGraphTransformer（官方知识图谱构建工具）
        self._graph_transformer = None
        if _HAS_TRANSFORMER and llm:
            try:
                self._graph_transformer = LLMGraphTransformer(
                    llm=llm,
                    allowed_nodes=[
                        "Organization", "Project", "Requirement", 
                        "Qualification", "Product", "ScoringItem",
                        "DisqualificationClause", "Date", "Money"
                    ],
                    allowed_relationships=[
                        "requires", "provides", "satisfies",
                        "deadline_is", "amount_is", "weight_is",
                        "leads_to", "depends_on"
                    ],
                )
                print("✅ LLMGraphTransformer 已初始化")
            except Exception as e:
                print(f"⚠️ LLMGraphTransformer 初始化失败: {e}")
        
        # 推理路径缓存
        self._reasoning_paths: Dict[str, ReasoningPath] = {}
        
        # 成功/失败模式（内存缓存，定期同步到 Store）
        self._success_patterns: Dict[str, int] = {}
        self._failure_patterns: Dict[str, int] = {}
        self._failure_lessons: Dict[str, FailureLesson] = {}
        # 幂等：已学习过的 task_id，避免图路径与看板路径重复写入（见 docs/learning_trigger_contract.md）
        self._learned_task_ids_set: set = set()
        self._learned_task_ids_list: List[str] = []
        self._max_learned_task_ids = 5000
        
        # 学习队列（异步处理）
        self._learning_queue: List[Dict] = []
        
        # 从文件加载持久化状态
        self._load_from_file()
    
    # ============================================================
    # 文件持久化（备份机制，确保数据不丢失）
    # ============================================================
    def _get_learning_dir(self) -> Path:
        """获取学习数据目录（与 paths.LEARNING_PATH 一致，随 set_workspace_root 切换）"""
        return _get_learning_dir_static()
    
    def _load_from_file(self):
        """从文件加载学习状态（备份机制）"""
        try:
            learning_dir = self._get_learning_dir()
            
            # 加载成功模式（防御：文件格式异常时保持 dict）
            success_file = learning_dir / "success_patterns.json"
            if success_file.exists():
                raw = json.loads(success_file.read_text(encoding="utf-8"))
                self._success_patterns = raw if isinstance(raw, dict) else {}
            
            # 加载失败模式（防御：同上）
            failure_file = learning_dir / "failure_patterns.json"
            if failure_file.exists():
                raw = json.loads(failure_file.read_text(encoding="utf-8"))
                self._failure_patterns = raw if isinstance(raw, dict) else {}
            
            # 加载推理路径（防御：仅当为 list 且每项为 dict 时解析，单条异常不拖垮整体）
            paths_file = learning_dir / "reasoning_paths.json"
            if paths_file.exists():
                paths_data = json.loads(paths_file.read_text(encoding="utf-8"))
                if isinstance(paths_data, list):
                    for path_data in paths_data:
                        if not isinstance(path_data, dict):
                            continue
                        try:
                            path = ReasoningPath.from_dict(path_data)
                            self._reasoning_paths[path.path_id] = path
                        except (KeyError, TypeError, ValueError):
                            continue

            # 加载失败教训（单条异常不拖垮整体）
            lessons_file = learning_dir / "failure_lessons.json"
            if lessons_file.exists():
                lessons_data = json.loads(lessons_file.read_text(encoding="utf-8"))
                if isinstance(lessons_data, list):
                    for lesson_data in lessons_data:
                        if not isinstance(lesson_data, dict):
                            continue
                        try:
                            lesson = FailureLesson.from_dict(lesson_data)
                            self._failure_lessons[lesson.lesson_id] = lesson
                        except (KeyError, TypeError, ValueError):
                            continue
            
            if self._success_patterns or self._reasoning_paths:
                print(f"✅ 学习状态已从文件加载: {len(self._success_patterns)} 成功模式, {len(self._reasoning_paths)} 推理路径")
        except Exception as e:
            print(f"⚠️ 从文件加载学习状态失败: {e}")
    
    def _atomic_write(self, file_path: Path, data: str):
        """原子性文件写入（防止数据损坏）
        
        使用临时文件 + os.replace 确保写入的原子性：
        1. 写入临时文件 (.tmp)
        2. 使用 os.replace 原子性替换目标文件
        
        这样即使进程崩溃或断电，也不会损坏原有数据。
        """
        import os
        import tempfile
        
        # 创建临时文件（与目标文件同目录，确保在同一文件系统）
        tmp_fd, tmp_path = tempfile.mkstemp(
            suffix='.tmp',
            dir=file_path.parent,
            prefix=file_path.stem + '_'
        )
        wrote = False
        fd_open = True
        try:
            # 写入临时文件
            with os.fdopen(tmp_fd, 'w', encoding='utf-8') as f:
                fd_open = False
                f.write(data)
                f.flush()
                os.fsync(f.fileno())  # 确保数据写入磁盘
            
            # 原子性替换目标文件
            os.replace(tmp_path, file_path)
            wrote = True
        except Exception:
            # 清理临时文件
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            raise
        finally:
            if fd_open:
                try:
                    os.close(tmp_fd)
                except OSError:
                    pass
            # 兜底清理：即使上面异常分支未覆盖，也不保留临时文件。
            if not wrote:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass
    
    def _save_learned_task_ids(self) -> None:
        """持久化已学习 task_id 列表（幂等用）。"""
        try:
            learning_dir = self._get_learning_dir()
            ids_file = learning_dir / "learned_task_ids.json"
            data = {"task_ids": self._learned_task_ids_list, "max_entries": self._max_learned_task_ids}
            self._atomic_write(ids_file, json.dumps(data, ensure_ascii=False))
        except Exception:
            pass
    
    def _register_learned_task_id(self, task_id: str) -> None:
        """登记 task_id 为已学习并持久化（FIFO 淘汰）。"""
        if not task_id or task_id in self._learned_task_ids_set:
            return
        self._learned_task_ids_set.add(task_id)
        self._learned_task_ids_list.append(task_id)
        while len(self._learned_task_ids_list) > self._max_learned_task_ids:
            old = self._learned_task_ids_list.pop(0)
            self._learned_task_ids_set.discard(old)
        self._save_learned_task_ids()
    
    def _save_to_file(self):
        """保存学习状态到文件（备份机制，原子性写入）"""
        try:
            learning_dir = self._get_learning_dir()
            
            # 保存成功模式（原子性写入）
            success_file = learning_dir / "success_patterns.json"
            self._atomic_write(
                success_file,
                json.dumps(self._success_patterns, ensure_ascii=False, indent=2)
            )
            
            # 保存失败模式（原子性写入）
            failure_file = learning_dir / "failure_patterns.json"
            self._atomic_write(
                failure_file,
                json.dumps(self._failure_patterns, ensure_ascii=False, indent=2)
            )
            
            # 保存推理路径（原子性写入）
            paths_file = learning_dir / "reasoning_paths.json"
            paths_data = [p.to_dict() for p in self._reasoning_paths.values()]
            self._atomic_write(
                paths_file,
                json.dumps(paths_data, ensure_ascii=False, indent=2)
            )

            # 保存失败教训（原子性写入）
            lessons_file = learning_dir / "failure_lessons.json"
            lessons_data = [p.to_dict() for p in self._failure_lessons.values()]
            self._atomic_write(
                lessons_file,
                json.dumps(lessons_data, ensure_ascii=False, indent=2)
            )
            
        except Exception as e:
            print(f"⚠️ 保存学习状态到文件失败: {e}")
    
    # ============================================================
    # 注意：Store 相关方法已移除
    # Memory 功能由 langmem 管理（memory_tools.py）
    # Learning 数据使用文件持久化（_save_to_file/_load_from_file）
    # ============================================================
    
    def save(self):
        """保存学习状态（文件持久化）"""
        self._save_to_file()
    
    # ============================================================
    # LLMGraphTransformer 集成（官方知识图谱构建）
    # ============================================================
    def extract_with_llm(self, text: str, source: str = "") -> Dict[str, Any]:
        """
        使用 LLMGraphTransformer 提取实体和关系
        
        这是 LangChain 官方推荐的知识图谱构建方法。
        比规则提取更准确，但需要 LLM 调用。
        
        Args:
            text: 要提取的文本
            source: 来源标识
        
        Returns:
            提取结果（实体、关系、图文档）
        """
        result = {
            "entities": [],
            "relations": [],
            "graph_documents": [],
            "method": "rule_based",
        }
        
        # 优先使用 LLMGraphTransformer
        if self._graph_transformer and _HAS_TRANSFORMER:
            try:
                # 创建 Document
                doc = Document(page_content=text, metadata={"source": source})
                
                # 使用 LLMGraphTransformer 提取
                graph_docs = self._graph_transformer.convert_to_graph_documents([doc])
                
                if graph_docs:
                    result["method"] = "llm_transformer"
                    result["graph_documents"] = [
                        {
                            "nodes": [{"id": n.id, "type": n.type} for n in gd.nodes],
                            "relationships": [
                                {"source": r.source.id, "target": r.target.id, "type": r.type}
                                for r in gd.relationships
                            ],
                        }
                        for gd in graph_docs
                    ]
                    
                    # 同步到本地知识图谱
                    if self.kg:
                        for gd in graph_docs:
                            for node in gd.nodes:
                                entity = Entity(
                                    id=f"{node.type}_{node.id}",
                                    name=node.id,
                                    type=EntityType[node.type.upper()] if hasattr(EntityType, node.type.upper()) else EntityType.OTHER,
                                    source=source,
                                )
                                self.kg.add_entity(entity)
                                result["entities"].append(entity.to_dict())
                            
                            for rel in gd.relationships:
                                relation = Relation(
                                    subject=rel.source.id,
                                    predicate=rel.type,
                                    object=rel.target.id,
                                    source=source,
                                )
                                self.kg.add_relation(relation)
                                result["relations"].append(relation.to_dict())
                        
                        self.kg.save()
                    
                    return result
            except Exception as e:
                print(f"⚠️ LLMGraphTransformer 提取失败，回退到规则提取: {e}")
        
        # 回退到规则提取
        if self._extractor:
            entities = self._extractor.extract_entities(text, source=source)
            relations = self._extractor.extract_relations(text, entities, source=source)
            
            result["entities"] = [e.to_dict() for e in entities]
            result["relations"] = [r.to_dict() for r in relations]
            
            if self.kg:
                self.kg.save()
        
        return result
    
    # ============================================================
    # 异步学习节点（LangGraph Node）
    # ============================================================
    async def learning_node(self, state: LearningState) -> LearningState:
        """
        LangGraph 学习节点 - 任务完成后异步执行
        
        可以作为 StateGraph 的一个节点使用：
        workflow.add_node("learner", learning_manager.learning_node)
        """
        task_id = state.get("task_id", "")
        task_type = state.get("task_type", "unknown")
        steps = state.get("intermediate_steps", [])
        result = state.get("final_result", {})
        
        # 判断是否值得学习
        if len(steps) < self.config.min_complexity_for_learning:
            return {**state, "learning_complete": True, "kg_updates": []}
        
        kg_updates = []
        
        # 1. 提取实体和关系
        if self._extractor:
            # 从步骤中提取（仅处理 dict，避免不可信数据导致 AttributeError）
            for step in steps:
                if not isinstance(step, dict):
                    continue
                text = str(step.get("output", ""))
                if len(text) > 50:  # 只处理有意义的输出
                    entities = self._extractor.extract_entities(text, source=f"step_{task_id}")
                    kg_updates.extend([{"type": "entity", "data": e.to_dict()} for e in entities])
        
        # 2. 记录推理路径
        is_success = result.get("status") == "success"
        if is_success:
            path = self._create_reasoning_path(task_type, steps, result)
            if path:
                self._reasoning_paths[path.path_id] = path
                kg_updates.append({"type": "reasoning_path", "data": path.to_dict()})
        
        # 3. 更新成功/失败模式
        pattern_key = f"{task_type}_{len(steps)}"
        if is_success:
            self._success_patterns[pattern_key] = self._success_patterns.get(pattern_key, 0) + 1
        else:
            self._failure_patterns[pattern_key] = self._failure_patterns.get(pattern_key, 0) + 1
        
        # 4. 保存到 Store（异步）
        if self.config.async_learning:
            asyncio.create_task(self._async_save())
        else:
            self.save()
            if self.kg:
                self.kg.save()
        
        return {
            **state,
            "learning_complete": True,
            "kg_updates": kg_updates,
        }
    
    async def _async_save(self):
        """异步保存"""
        await asyncio.sleep(0.1)  # 让出控制权
        self.save()
        if self.kg:
            self.kg.save()
    
    def _create_reasoning_path(
        self,
        task_type: str,
        steps: List[Dict],
        result: Dict,
    ) -> Optional[ReasoningPath]:
        """从执行轨迹创建推理路径"""
        if not steps:
            return None
        
        # 抽象化输入模式
        first_step = steps[0]
        input_pattern = self._abstract_pattern(str(first_step.get("input", "")))
        
        # 抽象化输出模式
        output_pattern = self._abstract_pattern(str(result.get("output", "")))
        
        # 创建路径 ID（确定性摘要，避免 PYTHONHASHSEED 导致跨进程不一致）
        path_id = f"{task_type}_{_stable_hash(input_pattern)}_{_stable_hash(output_pattern)}"
        
        # 检查是否已存在
        if path_id in self._reasoning_paths:
            existing = self._reasoning_paths[path_id]
            existing.success_count += 1
            existing.last_used = datetime.now()
            existing.confidence = min(existing.confidence + 0.05, 0.99)
            return existing
        
        # 创建新路径（仅保留 dict 步骤，避免不可信数据导致 AttributeError）
        steps_safe = [{"action": s.get("action"), "tool": s.get("tool")} for s in steps if isinstance(s, dict)]
        return ReasoningPath(
            path_id=path_id,
            task_type=task_type,
            input_pattern=input_pattern,
            steps=steps_safe,
            output_pattern=output_pattern,
        )
    
    def _abstract_pattern(self, text: str) -> str:
        """抽象化文本模式（去除具体值，保留结构）"""
        import re
        # 替换数字
        text = re.sub(r'\d+', '<NUM>', text)
        # 替换日期
        text = re.sub(r'\d{4}[-/]\d{2}[-/]\d{2}', '<DATE>', text)
        # 替换金额
        text = re.sub(r'[\d,]+\.?\d*\s*[万亿元]', '<MONEY>', text)
        # 截断
        return text[:100]
    
    # ============================================================
    # 置信度衰减和知识剪枝
    # ============================================================
    def apply_confidence_decay(self):
        """应用置信度衰减 - 定期调用"""
        if not self.kg:
            return
        
        now = datetime.now()
        decay_rate = self.config.decay_rate_per_day
        pruned_count = 0
        
        # 衰减实体置信度
        for entity in list(self.kg.entities.values()):
            # 计算距离上次使用的天数
            if hasattr(entity, 'last_used'):
                days = (now - entity.last_used).days
                entity.confidence *= (1 - decay_rate) ** days
            
            # 剪枝低置信度实体
            if entity.confidence < self.config.min_confidence_threshold:
                del self.kg.entities[entity.id]
                pruned_count += 1
        
        # 衰减推理路径置信度
        for path_id, path in list(self._reasoning_paths.items()):
            days = (now - path.last_used).days
            path.confidence *= (1 - decay_rate) ** days
            
            if path.confidence < self.config.min_confidence_threshold:
                del self._reasoning_paths[path_id]
                pruned_count += 1
        
        if pruned_count > 0:
            print(f"🧹 知识剪枝: 移除 {pruned_count} 个低置信度条目")
            self.save()
            if self.kg:
                self.kg.save()
    
    # ============================================================
    # 同步学习方法（供工具调用）
    # ============================================================
    def on_task_start(
        self,
        task_id: str,
        task_description: str,
        input_text: str = "",
    ) -> Dict[str, Any]:
        """任务开始时的学习"""
        result = {
            "task_id": task_id,
            "entities_extracted": 0,
            "context_enriched": False,
            "related_knowledge": [],
            "similar_paths": [],
        }
        
        if not self.kg:
            return result
        
        # 1. 提取实体
        if self._extractor:
            text = f"{task_description}\n{input_text}"
            entities = self._extractor.extract_entities(text, source=f"task_{task_id}")
            result["entities_extracted"] = len(entities)
        
        # 2. 查询知识图谱
        expansion = self.kg.expand_query(task_description)
        if expansion.get("matched_entities"):
            result["context_enriched"] = True
            result["related_knowledge"] = expansion.get("context", [])[:5]
        
        # 3. 查找相似推理路径
        task_type = self._infer_task_type(task_description)
        similar_paths = [
            p.to_dict() for p in self._reasoning_paths.values()
            if p.task_type == task_type and p.confidence > 0.5
        ]
        result["similar_paths"] = sorted(
            similar_paths, key=lambda x: x["success_count"], reverse=True
        )[:3]
        
        return result
    
    def on_document_processed(
        self,
        task_id: str,
        document_text: str,
        document_source: str,
    ) -> Dict[str, Any]:
        """文档处理时的学习"""
        result = {
            "entities_extracted": 0,
            "relations_extracted": 0,
            "kg_updated": False,
        }
        
        if not self._extractor:
            return result
        
        # 提取实体和关系
        entities = self._extractor.extract_entities(document_text, source=document_source)
        relations = self._extractor.extract_relations(document_text, entities, source=document_source)
        
        result["entities_extracted"] = len(entities)
        result["relations_extracted"] = len(relations)
        
        if entities or relations:
            if self.kg:
                self.kg.save()
            result["kg_updated"] = True
        
        return result
    
    def on_task_success(
        self,
        task_id: str,
        task_type: str,
        input_summary: str,
        output_summary: str,
        entities_used: List[str] = None,
        workspace_domain: Optional[str] = None,
    ) -> Dict[str, Any]:
        """任务成功时的学习。task_type/workspace_domain 用于模式分段与可选 KG 检索过滤。幂等：同一 task_id 只学习一次（见 docs/learning_trigger_contract.md）。"""
        if task_id and task_id in self._learned_task_ids_set:
            return {"skipped": True, "reason": "idempotent", "confidence_updated": 0, "pattern_recorded": False}
        result = {
            "confidence_updated": 0,
            "pattern_recorded": False,
        }
        
        # 1. 增加实体置信度
        if self.kg and entities_used:
            for name in entities_used:
                for entity in self.kg.find_entities(name=name):
                    entity.confidence = min(
                        entity.confidence + self.config.success_confidence_boost,
                        0.99
                    )
                    result["confidence_updated"] += 1
            self.kg.save()
        
        # 2. 记录成功模式（含 workspace_domain 便于按场景统计与 KG 衔接）
        domain_part = (workspace_domain or "general").replace(" ", "_")[:20]
        pattern_key = f"{task_type}_{domain_part}_{input_summary[:30]}"
        self._success_patterns[pattern_key] = self._success_patterns.get(pattern_key, 0) + 1
        result["pattern_recorded"] = True
        
        # 3. 保存
        self.save()
        self._register_learned_task_id(task_id)
        return result
    
    def on_task_failure(
        self,
        task_id: str,
        task_type: str,
        error_message: str,
        input_summary: str,
        workspace_domain: Optional[str] = None,
        failed_attempt: Optional[str] = None,
        recovery_hint: Optional[str] = None,
    ) -> Dict[str, Any]:
        """任务失败时的学习。task_type/workspace_domain 用于模式分段与可选 KG 检索过滤。幂等：同一 task_id 只学习一次（见 docs/learning_trigger_contract.md）。"""
        if task_id and task_id in self._learned_task_ids_set:
            return {"skipped": True, "reason": "idempotent", "confidence_updated": 0, "pattern_recorded": False, "suggestions": [], "lesson_recorded": False}
        result = {
            "confidence_updated": 0,
            "pattern_recorded": False,
            "suggestions": [],
            "lesson_recorded": False,
        }
        
        # 1. 记录失败模式（含 workspace_domain 便于按场景统计）
        domain_part = (workspace_domain or "general").replace(" ", "_")[:20]
        pattern_key = f"{task_type}_{domain_part}_{error_message[:30]}"
        self._failure_patterns[pattern_key] = self._failure_patterns.get(pattern_key, 0) + 1
        result["pattern_recorded"] = True
        
        # 2. 生成建议
        if "not found" in error_message.lower():
            result["suggestions"].append("expand_search_scope")
        if "timeout" in error_message.lower():
            result["suggestions"].append("reduce_complexity")

        # 3. 结构化失败教训（Episodic Memory）
        error_lower = (error_message or "").lower()
        root_cause = "参数或路径不匹配"
        if "not found" in error_lower or "不存在" in error_lower:
            root_cause = "目标资源路径错误或作用域不足"
        elif "timeout" in error_lower or "timed out" in error_lower:
            root_cause = "任务粒度过大或外部依赖响应慢"
        elif "permission" in error_lower or "denied" in error_lower:
            root_cause = "权限边界限制导致操作被拒绝"
        elif "connection" in error_lower or "refused" in error_lower:
            root_cause = "外部服务连接不可用"

        domain_part = (workspace_domain or "general").replace(" ", "_")[:20]
        lesson_key = f"{task_type}_{domain_part}_{error_message[:48]}"
        lesson_id = f"lesson_{abs(hash(lesson_key))}"
        failed_steps: List[str] = []
        if failed_attempt and failed_attempt.strip():
            failed_steps.append(failed_attempt.strip()[:220])
        else:
            failed_steps.append("重复同一调用导致失败")

        existing = self._failure_lessons.get(lesson_id)
        if existing:
            merged = list(existing.what_didnt_work)
            merged.extend(x for x in failed_steps if x not in merged)
            existing.what_didnt_work = merged[-6:]
            existing.what_worked = (recovery_hint or existing.what_worked or "改参数或换工具再试").strip()[:220]
            existing.root_cause = root_cause
            existing.confidence = min(existing.confidence + 0.03, 0.95)
            existing.last_updated = datetime.now()
        else:
            self._failure_lessons[lesson_id] = FailureLesson(
                lesson_id=lesson_id,
                task_type=task_type or "general",
                error_pattern=error_message[:120] if error_message else "unknown_error",
                root_cause=root_cause,
                what_worked=(recovery_hint or "改参数/换工具/换策略后再试")[:220],
                what_didnt_work=failed_steps[:6],
                applicable_context=f"{task_type}|{domain_part}|{input_summary[:120]}",
                confidence=0.62,
            )
        result["lesson_recorded"] = True
        
        # 4. 保存
        self.save()
        self._register_learned_task_id(task_id)
        return result
    
    def _infer_task_type(self, description: str) -> str:
        """推断任务类型"""
        desc_lower = description.lower()
        if any(k in desc_lower for k in ["招标", "投标", "bidding"]):
            return "bidding_analysis"
        if any(k in desc_lower for k in ["合同", "contract"]):
            return "contract_review"
        if any(k in desc_lower for k in ["报告", "report"]):
            return "report_writing"
        return "general"
    
    # ============================================================
    # 简化的知识检索（符合 Claude/Cursor 模式）
    # ============================================================
    def retrieve_context(self, query: str) -> Dict[str, Any]:
        """
        检索相关上下文（简化版）
        
        Claude/Cursor 模式：
        - 从知识图谱获取相关实体
        - 从历史中获取相似的成功路径
        - 不做复杂的分层，让 LLM 自己判断优先级
        """
        result = {
            "query": query,
            "entities": [],
            "similar_paths": [],
            "patterns": [],
            "failure_lessons": [],
        }
        
        # 1. 知识图谱上下文
        if self.kg:
            expansion = self.kg.expand_query(query)
            result["entities"] = expansion.get("matched_entities", [])[:10]
        
        # 2. 相似推理路径
        task_type = self._infer_task_type(query)
        result["similar_paths"] = self.get_similar_paths(task_type, limit=3)
        
        # 3. 相关成功模式
        result["patterns"] = [
            {"pattern": k, "count": v}
            for k, v in self._success_patterns.items()
            if any(word in k.lower() for word in query.lower().split()[:3])
        ][:5]

        # 4. 失败教训检索（避免重蹈覆辙）
        query_tokens = [t for t in query.lower().split() if t]
        lessons = list(self._failure_lessons.values())
        scored_lessons: List[tuple[int, FailureLesson]] = []
        for lesson in lessons:
            blob = f"{lesson.task_type} {lesson.error_pattern} {lesson.root_cause} {lesson.applicable_context}".lower()
            score = sum(1 for t in query_tokens[:6] if t in blob)
            if score > 0:
                scored_lessons.append((score, lesson))
        scored_lessons.sort(key=lambda x: (x[0], x[1].confidence), reverse=True)
        result["failure_lessons"] = [x[1].to_dict() for x in scored_lessons[:3]]
        
        return result
    
    # ============================================================
    # 统计和查询
    # ============================================================
    def get_learning_stats(self) -> Dict:
        """
        获取学习统计（简化版）
        
        符合 Claude/Cursor 模式：简洁的统计信息
        """
        kg_stats = self.kg.get_stats() if self.kg else {}
        
        return {
            # 核心统计
            "entities": kg_stats.get("total_entities", 0),
            "relations": kg_stats.get("total_relations", 0),
            "reasoning_paths": len(self._reasoning_paths),
            "success_patterns": len(self._success_patterns),
            "failure_patterns": len(self._failure_patterns),
            # Learning 状态（Memory 由 langmem 管理）
            "learning_persistence": "file-based",
            "kg_connected": self.kg is not None,
        }
    
    def get_similar_paths(self, task_type: str, limit: int = 5) -> List[Dict]:
        """获取相似的成功推理路径"""
        paths = [
            p.to_dict() for p in self._reasoning_paths.values()
            if p.task_type == task_type and p.confidence > 0.5
        ]
        return sorted(paths, key=lambda x: x["success_count"], reverse=True)[:limit]


# ============================================================
# 5. 全局实例（延迟初始化）
# ============================================================
_learning_manager: Optional[SelfLearningManager] = None
_learning_manager_lock = threading.Lock()
_execution_memory_manager: Any = None
_execution_memory_lock = threading.Lock()


def get_learning_manager() -> SelfLearningManager:
    """
    获取学习管理器单例
    
    注意：Memory 功能由 langmem 管理（memory_tools.py）
    Learning 数据使用文件持久化
    """
    global _learning_manager
    if _learning_manager is None:
        with _learning_manager_lock:
            if _learning_manager is None:
                _learning_manager = SelfLearningManager()
    return _learning_manager


def init_learning_manager(
    config: LearningConfig = None,
    llm: Any = None,
) -> SelfLearningManager:
    """
    初始化学习管理器
    
    Args:
        config: 学习配置
        llm: LLM 实例（用于 LLMGraphTransformer）
    """
    global _learning_manager
    _learning_manager = SelfLearningManager(config=config, llm=llm)
    return _learning_manager


async def _get_execution_memory_manager():
    """懒加载 langmem execution manager（仅一次初始化）。"""
    global _execution_memory_manager
    if _execution_memory_manager is not None:
        return _execution_memory_manager
    if not _HAS_LANGMEM_REFLECTION:
        return None
    if str(os.getenv("ENABLE_LANGMEM", "true")).lower() != "true":
        return None
    model_name = str(os.getenv("LEARNING_MEMORY_MODEL", "anthropic:claude-3-5-sonnet-latest")).strip()
    if not model_name:
        return None
    with _execution_memory_lock:
        if _execution_memory_manager is not None:
            return _execution_memory_manager
        try:
            _execution_memory_manager = create_memory_store_manager(
                model_name,
                namespace=("memories", "{langgraph_user_id}", "execution"),
                instructions=(
                    "Extract reusable execution memories from successful task runs. "
                    "Prioritize tool selection, parameter choices, verification steps, and failure-avoidance hints. "
                    "Store concise procedural memories with enough context to be reused later."
                ),
                enable_inserts=True,
                enable_deletes=False,
            )
        except Exception:
            _execution_memory_manager = None
    return _execution_memory_manager


def enqueue_execution_memory_reflection(
    *,
    user_id: str,
    task_id: str,
    task_type: str,
    query: str,
    result_summary: str,
    workspace_domain: Optional[str] = None,
    store: Any = None,
) -> Dict[str, Any]:
    """
    异步写入执行经验（langmem + ReflectionExecutor）。
    用于“成功执行后”把可复用的方法/参数沉淀到长期记忆。
    """
    if str(os.getenv("ENABLE_EXECUTION_MEMORY_REFLECTION", "true")).lower() != "true":
        return {"queued": False, "reason": "disabled"}
    if not result_summary.strip():
        return {"queued": False, "reason": "empty_result"}

    async def _run() -> Dict[str, Any]:
        manager = await _get_execution_memory_manager()
        if manager is None:
            return {"queued": False, "reason": "manager_unavailable"}

        normalized_user = (user_id or "").strip() or "system"
        cfg = {
            "configurable": {
                "langgraph_user_id": normalized_user,
                "user_id": normalized_user,
                "task_id": task_id or "unknown",
                "task_type": task_type or "general",
            }
        }

        payload = {
            "messages": [
                {
                    "role": "user",
                    "content": (
                        f"TaskType={task_type or 'general'}\n"
                        f"WorkspaceDomain={workspace_domain or 'general'}\n"
                        f"Request={query[:1200]}"
                    ),
                },
                {
                    "role": "assistant",
                    "content": (
                        "ExecutionSummary:\n"
                        f"{result_summary[:2000]}\n\n"
                        "Please extract reusable procedural memories: "
                        "tool choice, parameter patterns, and verification steps."
                    ),
                },
            ]
        }

        if store is not None and ReflectionExecutor is not None:
            try:
                executor = ReflectionExecutor(manager, store=store)
                executor.submit(payload, config=cfg, after_seconds=0)
                return {"queued": True, "mode": "reflection_executor"}
            except Exception:
                pass

        try:
            maybe_coro = manager.ainvoke(payload, config=cfg)
            if asyncio.iscoroutine(maybe_coro):
                await maybe_coro
                return {"queued": True, "mode": "ainvoke"}
        except Exception:
            pass

        try:
            manager.invoke(payload, config=cfg)
            return {"queued": True, "mode": "invoke"}
        except Exception as e:
            return {"queued": False, "reason": str(e)[:160]}

    try:
        loop = asyncio.get_running_loop()
        loop.create_task(_run())
        return {"queued": True, "mode": "background_task"}
    except RuntimeError:
        try:
            return asyncio.run(_run())
        except Exception as e:
            return {"queued": False, "reason": str(e)[:160]}


# ============================================================
# 用户记忆抽取（对话后沉淀「关于用户」的事实与偏好，供 search_memory 检索）
# ============================================================
_user_memory_manager = None
_user_memory_lock = threading.Lock()


async def _get_user_memory_manager():
    """懒加载 langmem 用户记忆 manager（仅一次初始化）。"""
    global _user_memory_manager
    if _user_memory_manager is not None:
        return _user_memory_manager
    if not _HAS_LANGMEM_REFLECTION:
        return None
    if str(os.getenv("ENABLE_LANGMEM", "true")).lower() != "true":
        return None
    if str(os.getenv("ENABLE_USER_MEMORY_EXTRACTION", "false")).lower() not in ("1", "true", "yes", "on"):
        return None
    model_name = str(os.getenv("LEARNING_MEMORY_MODEL", "anthropic:claude-3-5-sonnet-latest")).strip()
    if not model_name:
        return None
    with _user_memory_lock:
        if _user_memory_manager is not None:
            return _user_memory_manager
        try:
            _user_memory_manager = create_memory_store_manager(
                model_name,
                namespace=("memories", "{langgraph_user_id}", "user"),
                instructions=(
                    "Extract and store facts about the user, their preferences, habits, and context they shared. "
                    "Focus on: name, role, project context, communication preferences, domain expertise, "
                    "and any explicit preferences (e.g. language, detail level). Store concise, reusable user memories."
                ),
                enable_inserts=True,
                enable_deletes=False,
            )
        except Exception:
            _user_memory_manager = None
    return _user_memory_manager


def enqueue_user_memory_reflection(
    *,
    user_id: str,
    messages_snapshot: List[Dict[str, Any]],
    store: Any = None,
) -> Dict[str, Any]:
    """
    异步写入用户记忆（对话中关于用户的事实与偏好）。
    使后续会话可通过 search_memory 检索到「用户是谁、偏好什么」，提升「Agent 了解用户」的体感。
    触发条件：run 结束后、messages_snapshot 条数≥2 且含至少一条 user、Store 可用、ENABLE_USER_MEMORY_EXTRACTION 为 true；详见 CONTEXT_AND_MEMORY_SYSTEM_DESIGN §2.3。
    """
    if str(os.getenv("ENABLE_USER_MEMORY_EXTRACTION", "false")).lower() not in ("1", "true", "yes", "on"):
        return {"queued": False, "reason": "disabled"}
    if not messages_snapshot or len(messages_snapshot) < 2:
        return {"queued": False, "reason": "insufficient_messages"}

    async def _run() -> Dict[str, Any]:
        manager = await _get_user_memory_manager()
        if manager is None:
            return {"queued": False, "reason": "manager_unavailable"}
        normalized_user = (user_id or "").strip() or "system"
        cfg = {"configurable": {"langgraph_user_id": normalized_user, "user_id": normalized_user}}
        payload = {"messages": messages_snapshot}
        if store is not None and ReflectionExecutor is not None:
            try:
                executor = ReflectionExecutor(manager, store=store)
                executor.submit(payload, config=cfg, after_seconds=0)
                return {"queued": True, "mode": "reflection_executor"}
            except Exception:
                pass
        try:
            maybe_coro = manager.ainvoke(payload, config=cfg)
            if asyncio.iscoroutine(maybe_coro):
                await maybe_coro
            return {"queued": True, "mode": "ainvoke"}
        except Exception:
            pass
        try:
            manager.invoke(payload, config=cfg)
            return {"queued": True, "mode": "invoke"}
        except Exception as e:
            return {"queued": False, "reason": str(e)[:160]}

    try:
        loop = asyncio.get_running_loop()
        loop.create_task(_run())
        return {"queued": True, "mode": "background_task"}
    except RuntimeError:
        try:
            return asyncio.run(_run())
        except Exception as e:
            return {"queued": False, "reason": str(e)[:160]}


# ============================================================
# 6. 便捷函数（供工具调用）
# ============================================================
def learn_from_task_start(
    task_id: str,
    task_description: str,
    input_text: str = "",
) -> Dict[str, Any]:
    """任务开始时学习"""
    return get_learning_manager().on_task_start(task_id, task_description, input_text)


def learn_from_document(
    task_id: str,
    document_text: str,
    document_source: str,
) -> Dict[str, Any]:
    """从文档学习"""
    return get_learning_manager().on_document_processed(task_id, document_text, document_source)


def learn_from_success(
    task_id: str,
    task_type: str,
    input_summary: str,
    output_summary: str,
    entities_used: List[str] = None,
    workspace_domain: Optional[str] = None,
) -> Dict[str, Any]:
    """从成功学习。task_type/workspace_domain 可从 config.configurable 传入，用于模式分段与 KG 衔接。"""
    return get_learning_manager().on_task_success(
        task_id, task_type, input_summary, output_summary, entities_used, workspace_domain
    )


def learn_from_failure(
    task_id: str,
    task_type: str,
    error_message: str,
    input_summary: str,
    workspace_domain: Optional[str] = None,
    failed_attempt: Optional[str] = None,
    recovery_hint: Optional[str] = None,
) -> Dict[str, Any]:
    """从失败学习。task_type/workspace_domain 可从 config.configurable 传入，用于模式分段与 KG 衔接。"""
    return get_learning_manager().on_task_failure(
        task_id, task_type, error_message, input_summary, workspace_domain, failed_attempt, recovery_hint
    )


def feedback_knowledge(query: str, was_helpful: bool) -> Dict[str, Any]:
    """知识反馈"""
    manager = get_learning_manager()
    if manager.kg:
        expansion = manager.kg.expand_query(query)
        for entity_data in expansion.get("matched_entities", []):
            for entity in manager.kg.find_entities(name=entity_data.get("name")):
                if was_helpful:
                    entity.confidence = min(entity.confidence + 0.02, 0.99)
                else:
                    entity.confidence = max(entity.confidence - 0.05, 0.1)
        manager.kg.save()
    return {"updated": True}


def _skill_feedback_path() -> Path:
    return _get_learning_dir_static() / "skill_feedback_stats.json"


def _load_skill_feedback_stats() -> Dict[str, Any]:
    path = _skill_feedback_path()
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_skill_feedback_stats(stats: Dict[str, Any]) -> None:
    path = _skill_feedback_path()
    path.write_text(json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8")


def record_skill_feedback(
    skill_name: str,
    was_helpful: bool,
    score: int = 1,
    note: str = "",
) -> Dict[str, Any]:
    """记录技能反馈并更新统计（用于质量闭环）。"""
    skill = (skill_name or "").strip()
    if not skill:
        return {"ok": False, "error": "skill_name required"}
    stats = _load_skill_feedback_stats()
    item = stats.get(
        skill,
        {
            "skill_name": skill,
            "positive": 0,
            "negative": 0,
            "total": 0,
            "score_sum": 0,
            "last_note": "",
            "updated_at": "",
        },
    )
    if was_helpful:
        item["positive"] = int(item.get("positive", 0)) + 1
    else:
        item["negative"] = int(item.get("negative", 0)) + 1
    item["total"] = int(item.get("total", 0)) + 1
    item["score_sum"] = int(item.get("score_sum", 0)) + max(min(int(score), 5), -5)
    if note.strip():
        item["last_note"] = note.strip()[:300]
    item["updated_at"] = datetime.now().isoformat()
    stats[skill] = item
    _save_skill_feedback_stats(stats)
    return {"ok": True, "skill": item}


def get_skill_feedback_stats(limit: int = 20) -> Dict[str, Any]:
    """获取技能反馈统计（按总反馈数降序）。"""
    stats = _load_skill_feedback_stats()
    items = list(stats.values())
    items.sort(key=lambda x: int(x.get("total", 0)), reverse=True)
    sliced = items[: max(1, int(limit))]
    for it in sliced:
        total = int(it.get("total", 0))
        pos = int(it.get("positive", 0))
        it["positive_rate"] = round((pos / total), 4) if total > 0 else 0.0
        it["avg_score"] = round((int(it.get("score_sum", 0)) / total), 4) if total > 0 else 0.0
    return {"ok": True, "count": len(items), "items": sliced}


def apply_decay():
    """应用置信度衰减"""
    get_learning_manager().apply_confidence_decay()


def get_learning_context_for_prompt(
    query: str,
    max_tokens: int = 500,
    suppress_failure_lessons: bool = False,
) -> str:
    """
    获取学习上下文，用于注入到 Agent Prompt 中
    
    这是学习系统与 Agent 集成的关键接口：
    1. 从知识图谱获取相关实体
    2. 从历史中获取相似的成功推理路径
    3. 格式化为简洁的文本，便于 LLM 理解
    
    Args:
        query: 用户查询或任务描述
        max_tokens: 最大 token 数（避免上下文过长）
    
    Returns:
        格式化的学习上下文字符串
    """
    manager = get_learning_manager()
    context = manager.retrieve_context(query)
    
    parts = []
    
    # 1. 相关实体（知识图谱）
    if context.get("entities"):
        entities_text = []
        for e in context["entities"][:5]:  # 最多 5 个实体
            name = e.get("name", "")
            etype = e.get("type", "")
            if name:
                entities_text.append(f"- {name} ({etype})")
        if entities_text:
            parts.append("📚 相关知识:\n" + "\n".join(entities_text))
    
    # 2. 成功的推理路径
    if context.get("similar_paths"):
        paths_text = []
        for p in context["similar_paths"][:2]:  # 最多 2 个路径
            steps = p.get("steps", [])
            if steps:
                steps_str = " → ".join(
                    str(s.get("action") or s.get("tool") or s) if isinstance(s, dict) else str(s)
                    for s in steps[:5]
                )
                paths_text.append(f"- {steps_str}")
        if paths_text:
            parts.append("✅ 成功经验:\n" + "\n".join(paths_text))
    
    # 3. 相关模式
    if context.get("patterns"):
        patterns_text = []
        for p in context["patterns"][:3]:  # 最多 3 个模式
            pattern = p.get("pattern", "")
            count = p.get("count", 0)
            if pattern and count > 1:
                patterns_text.append(f"- {pattern} (成功 {count} 次)")
        if patterns_text:
            parts.append("📊 历史模式:\n" + "\n".join(patterns_text))

    # 4. 失败教训（优先避免已知死路）
    if not suppress_failure_lessons and context.get("failure_lessons"):
        lesson_lines = []
        for l in context["failure_lessons"][:2]:
            err = str(l.get("error_pattern", ""))[:80]
            avoid = "; ".join((l.get("what_didnt_work") or [])[:2])
            fix = str(l.get("what_worked", ""))[:80]
            if err:
                lesson_lines.append(f"- 避免: {err} | 不要再做: {avoid or '重复同一策略'} | 建议: {fix or '换策略'}")
        if lesson_lines:
            parts.append("⛔ 失败教训:\n" + "\n".join(lesson_lines))
    
    if not parts:
        return ""
    
    result = "\n\n".join(parts)
    
    # 简单的 token 估算（中文约 2 字符/token，英文约 4 字符/token）
    estimated_tokens = len(result) // 2
    if estimated_tokens > max_tokens:
        # 截断
        result = result[:max_tokens * 2] + "..."
    
    return result


def get_learning_system_status() -> Dict[str, Any]:
    """
    获取学习系统状态（用于调试和监控）
    
    Returns:
        学习系统的详细状态信息
    """
    manager = get_learning_manager()
    stats = manager.get_learning_stats()
    
    return {
        "status": "active" if manager else "inactive",
        "stats": stats,
        "config": {
            "min_complexity": manager.config.min_complexity_for_learning,
            "min_confidence": manager.config.min_confidence_for_storage,
            "async_learning": manager.config.async_learning,
        },
        "connections": {
            "persistence": "file-based",  # Learning 使用文件持久化
            "knowledge_graph": manager.kg is not None,
            "llm_transformer": manager._graph_transformer is not None,
        },
    }


def export_for_finetuning(min_confidence: float = 0.7, format: str = "jsonl") -> List[Dict]:
    """
    导出学习数据用于 LLM 微调
    
    将成功的推理路径转换为 SFT 训练数据格式：
    - input: 任务描述
    - output: 推理步骤和结果
    
    Args:
        min_confidence: 最小置信度阈值（只导出高质量数据）
        format: 输出格式 ("jsonl" 或 "conversation")
    
    Returns:
        适合微调的数据列表
    """
    manager = get_learning_manager()
    training_data = []
    
    for path in manager._reasoning_paths.values():
        if path.confidence < min_confidence:
            continue
        if path.success_count < 2:  # 至少成功 2 次
            continue
        
        if format == "jsonl":
            # OpenAI / LLaMA 风格的 JSONL 格式
            training_data.append({
                "messages": [
                    {
                        "role": "user",
                        "content": f"任务类型: {path.task_type}\n输入: {path.input_pattern}"
                    },
                    {
                        "role": "assistant", 
                        "content": f"推理步骤:\n" + "\n".join([
                            f"{i+1}. {step.get('tool', step.get('action', 'step'))}: {step.get('description', '')}"
                            for i, step in enumerate(path.steps)
                        ]) + f"\n\n输出: {path.output_pattern}"
                    }
                ],
                "metadata": {
                    "task_type": path.task_type,
                    "confidence": path.confidence,
                    "success_count": path.success_count,
                }
            })
        elif format == "conversation":
            # 对话格式（适合 ChatML）
            training_data.append({
                "instruction": f"执行{path.task_type}任务",
                "input": path.input_pattern,
                "output": path.output_pattern,
                "reasoning_steps": path.steps,
            })
    
    return training_data


def save_finetuning_dataset(output_path: str, min_confidence: float = 0.7):
    """
    保存微调数据集到文件（流式写入，避免一次性加载全部数据到内存）。
    
    Args:
        output_path: 输出文件路径（.jsonl）
        min_confidence: 最小置信度阈值
    """
    import json
    manager = get_learning_manager()
    count = 0
    with open(output_path, "w", encoding="utf-8") as f:
        for path in manager._reasoning_paths.values():
            if path.confidence < min_confidence or path.success_count < 2:
                continue
            item = {
                "messages": [
                    {"role": "user", "content": f"任务类型: {path.task_type}\n输入: {path.input_pattern}"},
                    {
                        "role": "assistant",
                        "content": "推理步骤:\n"
                        + "\n".join(
                            f"{i+1}. {(step.get('tool') or step.get('action') or 'step') if isinstance(step, dict) else 'step'}: {(step.get('description', '') if isinstance(step, dict) else '')}"
                            for i, step in enumerate(path.steps)
                        )
                        + f"\n\n输出: {path.output_pattern}",
                    },
                ],
                "metadata": {"task_type": path.task_type, "confidence": path.confidence, "success_count": path.success_count},
            }
            f.write(json.dumps(item, ensure_ascii=False) + "\n")
            count += 1
    return {"saved": count, "path": output_path}


# ============================================================
# 学习检索工具（供 Agent 主动调用）
# ============================================================
from langchain_core.tools import tool

@tool
def search_learning_experience(query: str) -> str:
    """搜索历史学习经验，获取相关的成功模式和推理路径。
    
    在处理复杂任务前使用此工具，可以获取之前类似任务的成功经验。
    
    Args:
        query: 任务描述或关键词
    
    Returns:
        相关的历史经验（成功模式、推理路径、相关知识）
    """
    return get_learning_context_for_prompt(query, max_tokens=500) or "暂无相关学习经验"


def get_learning_tool():
    """获取学习检索工具（供工具注册使用）"""
    return search_learning_experience


# ============================================================
# 导出（简化版）
# ============================================================
__all__ = [
    # 配置
    "LearningConfig",
    "LearningState",
    "ReasoningPath",
    # 管理器
    "SelfLearningManager",
    "get_learning_manager",
    "init_learning_manager",
    # 学习函数（核心）
    "learn_from_task_start",
    "learn_from_document",
    "learn_from_success",
    "learn_from_failure",
    "feedback_knowledge",
    "record_skill_feedback",
    "get_skill_feedback_stats",
    "apply_decay",
    # Agent 集成
    "get_learning_context_for_prompt",
    "get_learning_system_status",
    "enqueue_execution_memory_reflection",
    "enqueue_user_memory_reflection",
    "search_learning_experience",
    "get_learning_tool",
]
