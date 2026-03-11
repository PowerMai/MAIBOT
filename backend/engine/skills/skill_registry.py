"""
Skill 注册表 - Skills 发现和管理工具

============================================================
职责边界（Claude 风格：单一职责，无重复）
============================================================

┌─────────────────────────────────────────────────────────────┐
│  SkillRegistry（本模块）                                     │
│  ─────────────────────                                       │
│  职责：专门管理 Skills（SKILL.md）                           │
│  功能：发现、管理、查询、匹配 Skills                         │
│  路径：knowledge_base/skills/（使用 paths.py 统一路径）      │
│  调用：skills_tool.py (list_skills, match_skills)           │
└─────────────────────────────────────────────────────────────┘
                                ↕ 互补，不重复
┌─────────────────────────────────────────────────────────────┐
│  ResourceManager（embedding_tools.py）                       │
│  ───────────────────────────────────                         │
│  职责：管理通用资源（guides、cases、memory、user_files）     │
│  功能：语义检索、向量索引、知识图谱增强                      │
│  配置：knowledge_base/resources.json                         │
│  注意：不管理 Skills（由 SkillRegistry 专门负责）            │
└─────────────────────────────────────────────────────────────┘

与 DeepAgent 的关系（DeepAgent 无 SkillsMiddleware）：
- BUNDLE.md：按 skill_profile 内联能力速查到系统提示词
- Skills 工具（list_skills/match_skills）：运行时按需发现
- SkillRegistry：提供查询/匹配功能（match_skills_by_query 等）
- Skills 与 Agent 中间件的分工见 .cursor/rules/agent-architecture.mdc「Skills vs Agent 中间件」及 docs/main_pipeline_and_middleware_rationality.md。

设计原则（Claude/DeepAgent 风格）：
1. 自动发现：扫描 knowledge_base/skills/ 目录下所有 SKILL.md
2. 渐进式加载：只加载元数据（name + description），完整内容按需读取
3. 层级管理：foundation → format → general → domain
4. 与模式关联：不同模式可能使用不同的 Skill 子集

目录结构：
knowledge_base/skills/
├── foundation/            # 基础能力
│   ├── reasoning/         # 推理分析
│   ├── verification/      # 验证
│   ├── code-execution/    # 代码执行
│   └── web-research/      # 网络调研
├── format/                # 格式处理
│   ├── pdf/               # PDF 处理
│   ├── xlsx/              # Excel 表格
│   ├── docx/              # Word 文档
│   ├── pptx/              # PPT 演示
│   └── skill-creator/     # Skill 创建器
├── general/               # 通用能力
│   ├── text_analysis/
│   ├── data_analysis/
│   ├── report-generation/
│   └── project-management/
├── domain/                # 领域能力
│   └── bidding/
├── modes/                 # 模式专用
│   ├── ask/
│   ├── plan/
│   └── debug/
└── {domain}/              # 领域技能
    └── {skill}/SKILL.md

SKILL.md 格式（Agent Skills 标准）：
```yaml
---
name: pdf
description: Comprehensive PDF manipulation toolkit for extracting text...
license: Apache-2.0
metadata:
  author: anthropic
  version: "1.0"
---

# PDF Processing Guide
...
```

参考：
- Agent Skills 规范: https://agentskills.io/specification
- Anthropic Skills: https://github.com/anthropics/skills
"""

import json
import os
import re
import threading
import time
import yaml
from pathlib import Path
from typing import Dict, List, Optional, Set, Any, Tuple
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
import logging
import math

logger = logging.getLogger(__name__)

_RE_NORMALIZE_SPACES = re.compile(r"[\s_]+")
_RE_NORMALIZE_DASHES = re.compile(r"-{2,}")
_RE_YAML_FRONTMATTER = re.compile(r"^---\s*\n(.*?)\n---", re.DOTALL)
_RE_SCRIPT_REF = re.compile(r"(?:scripts/)?([a-zA-Z0-9_.-]+\.(?:py|sh|js))\b")

# ============================================================
# 使用统一路径模块（Claude 风格：单一数据源）
# ============================================================
from backend.tools.base.paths import SKILLS_ROOT, LEARNED_SKILLS_ROOT, KB_PATH, get_project_root

PROJECT_ROOT = get_project_root()


@dataclass
class SkillInfo:
    """Skill 信息（符合 Agent Skills 标准）"""
    # 基本信息（必需）
    name: str
    description: str = ""
    
    # 显示信息
    display_name: str = ""
    
    # 分类
    level: str = "general"  # foundation, general, domain, anthropic
    domain: str = "general"  # anthropic, foundation, general, modes, marketing, education, etc.
    source: str = "custom"  # anthropic, custom, learned
    
    # 触发和依赖
    triggers: List[str] = field(default_factory=list)
    dependencies: List[str] = field(default_factory=list)
    tools: List[str] = field(default_factory=list)
    allowed_tools: List[str] = field(default_factory=list)  # Agent Skills 标准字段
    
    # 文件信息
    path: str = ""
    relative_path: str = ""
    skill_dir: str = ""  # Skill 目录路径
    
    # 资源目录（Claude Skills 特性）
    scripts: List[str] = field(default_factory=list)  # scripts/ 中的可执行脚本
    references: List[str] = field(default_factory=list)  # references/ 中的参考文档
    assets: List[str] = field(default_factory=list)  # assets/ 中的资源文件
    has_scripts: bool = False
    has_references: bool = False
    has_assets: bool = False
    
    # 元数据
    version: str = "1.0"
    author: str = ""
    license: str = ""
    compatibility: str = ""
    metadata: Dict[str, Any] = field(default_factory=dict)
    updated_at: str = ""
    
    # 适用模式（为空表示所有模式）
    modes: List[str] = field(default_factory=list)
    
    # 是否禁用自动触发（需要显式调用）
    disable_model_invocation: bool = False

    @property
    def tier_path(self) -> str:
        """用于 license_tiers allow_skills 匹配的路径，格式 level/name（如 foundation/reasoning、domain/bidding）。"""
        level = (self.level or "general").strip() or "general"
        name = (self.name or "").strip() or "unknown"
        return f"{level}/{name}"

    def to_dict(self) -> Dict[str, Any]:
        """转换为字典（用于 API 返回）；与 Claude API Skills beta 对齐：type、id、display_title、version、updated_at。"""
        display_title = self.display_name or self.name
        skill_id = f"{self.domain}/{self.name}"
        return {
            "type": "skill",
            "id": skill_id,
            "name": self.name,
            "display_name": self.display_name or self.name,
            "display_title": display_title,
            "description": self.description[:500] if self.description else "",  # 限制长度
            "level": self.level,
            "domain": self.domain,
            "source": self.source,
            "version": self.version or "",
            "created_at": self.updated_at or "",  # 与 updated_at 一致（均来自文件 mtime 或 frontmatter）
            "updated_at": self.updated_at or "",
            "triggers": self.triggers[:5],
            "dependencies": self.dependencies,
            "tools": self.tools,
            "allowed_tools": self.allowed_tools,
            "relative_path": self.relative_path,
            "skill_dir": self.skill_dir,
            "has_scripts": self.has_scripts,
            "has_references": self.has_references,
            "has_assets": self.has_assets,
            "scripts": self.scripts[:10],
            "references": self.references[:10],
            "modes": self.modes,
            "license": self.license,
        }
    
    @staticmethod
    def _is_safe_subpath(base: Path, target: Path) -> bool:
        try:
            target.resolve().relative_to(base.resolve())
            return True
        except ValueError:
            return False

    def get_script_path(self, script_name: str) -> Optional[str]:
        """获取脚本的完整路径（含目录穿越保护）"""
        if not self.skill_dir:
            return None
        base = Path(self.skill_dir)
        script_path = base / "scripts" / script_name
        if script_path.exists() and self._is_safe_subpath(base, script_path):
            return str(script_path)
        return None
    
    def get_reference_path(self, ref_name: str) -> Optional[str]:
        """获取参考文档的完整路径（含目录穿越保护）"""
        if not self.skill_dir:
            return None
        base = Path(self.skill_dir)
        for subdir in ("references", "reference", ""):
            ref_path = base / subdir / ref_name if subdir else base / ref_name
            if ref_path.exists() and self._is_safe_subpath(base, ref_path):
                return str(ref_path)
        return None


class SkillRegistry:
    """
    Skill 注册表 - 单例
    
    功能：
    1. 自动发现 knowledge_base/skills/ 下的所有 SKILL.md
    2. 解析 YAML frontmatter 获取元数据
    3. 按层级、领域、模式分类管理
    4. 提供查询和匹配接口
    """
    
    _instance = None
    _lock = threading.Lock()
    
    def __new__(cls):
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
                    cls._instance._initialized = False
        return cls._instance
    
    def __init__(self):
        if self._initialized:
            return
        
        self._skills: Dict[str, SkillInfo] = {}
        self._normalized_name_index: Dict[str, str] = {}
        self._by_level: Dict[str, List[str]] = {}
        self._by_domain: Dict[str, List[str]] = {}
        self._by_mode: Dict[str, List[str]] = {}
        self._loaded = False
        self._initialized = True
        # 文件修改时间缓存（效率优化：避免重复解析未修改的文件）
        self._file_mtimes: Dict[str, float] = {}
        # embedding 缓存（避免每次 match 都重复为每个 Skill 生成向量）
        self._embedding_cache: Dict[str, List[float]] = {}
        self._embedding_cache_lock = threading.Lock()
        self._semantic_threshold = float(os.getenv("SKILL_SEMANTIC_THRESHOLD", "0.45") or 0.45)
        # runtime_index 短期缓存（与 KNOWLEDGE_ARCHITECTURE 建议一致，减少重复 profile/扫描）
        self._runtime_index_cache: Dict[Tuple[str, str, Optional[int]], Tuple[Dict[str, Any], float]] = {}
        self._runtime_index_cache_lock = threading.Lock()
        self._runtime_index_cache_ttl = float(os.getenv("SKILL_RUNTIME_INDEX_CACHE_TTL", "60") or 60)

    @staticmethod
    def _normalize_skill_name(name: str) -> str:
        """标准化 Skill 名称：下划线/连字符/空格等价。"""
        raw = str(name or "").strip().lower()
        if not raw:
            return ""
        normalized = _RE_NORMALIZE_SPACES.sub("-", raw)
        normalized = _RE_NORMALIZE_DASHES.sub("-", normalized).strip("-")
        return normalized
    
    def discover_skills(self, force_reload: bool = False) -> Dict[str, SkillInfo]:
        """
        发现所有 Skills（带增量更新优化，线程安全）。
        I/O（扫描目录、读取文件）在锁外执行，仅更新缓存在锁内执行。
        """
        if self._loaded and not force_reload:
            return self._skills

        with self._lock:
            if self._loaded and not force_reload:
                return self._skills
            if force_reload:
                self._skills.clear()
                self._normalized_name_index.clear()
                self._by_level.clear()
                self._by_domain.clear()
                self._by_mode.clear()
                self._file_mtimes.clear()
                with self._embedding_cache_lock:
                    self._embedding_cache.clear()
                with self._runtime_index_cache_lock:
                    self._runtime_index_cache.clear()
            if not SKILLS_ROOT.exists():
                logger.warning("Skills 目录不存在: %s", SKILLS_ROOT)
                self._loaded = True
                return self._skills
            file_mtimes_snapshot = dict(self._file_mtimes)

        collected = self._collect_skill_infos(file_mtimes_snapshot)

        with self._lock:
            for skill_path, current_mtime, skill_info in collected:
                if skill_info:
                    self._register_skill(skill_info)
                    self._file_mtimes[skill_path] = current_mtime
            self._loaded = True
            new_count = sum(1 for _, _, info in collected if info)
            if len(collected) > new_count or new_count > 0:
                logger.info("✅ Skills: %d 个 (本轮新增/更新: %d)", len(self._skills), new_count)
            else:
                logger.info("✅ 发现 %d 个 Skills", len(self._skills))
            return self._skills

    def _collect_skill_infos(
        self, file_mtimes_snapshot: Dict[str, float]
    ) -> List[Tuple[str, float, Optional[SkillInfo]]]:
        """在锁外执行：扫描 SKILL.md 并解析，返回 (path_str, mtime, skill_info) 列表。"""
        result: List[Tuple[str, float, Optional[SkillInfo]]] = []

        def iter_skill_files():
            if SKILLS_ROOT.exists():
                for skill_md in SKILLS_ROOT.rglob("SKILL.md"):
                    try:
                        rel = skill_md.relative_to(SKILLS_ROOT)
                        if "template" in rel.parts or "spec" in rel.parts:
                            continue
                        yield skill_md
                    except ValueError:
                        continue
            if LEARNED_SKILLS_ROOT.exists():
                for skill_md in LEARNED_SKILLS_ROOT.rglob("SKILL.md"):
                    yield skill_md

        for skill_md in iter_skill_files():
            try:
                skill_path = str(skill_md)
                current_mtime = skill_md.stat().st_mtime
                if skill_path in file_mtimes_snapshot and file_mtimes_snapshot[skill_path] == current_mtime:
                    continue
                skill_info = self._parse_skill_file(skill_md)
                result.append((skill_path, current_mtime, skill_info))
            except Exception as e:
                logger.warning("解析 Skill 失败: %s, 错误: %s", skill_md, e)
        return result
    
    def _parse_skill_file(self, skill_md: Path) -> Optional[SkillInfo]:
        """
        解析 SKILL.md 文件（符合 Agent Skills 标准）
        
        优化：只读取前 4KB 来解析 frontmatter，避免加载整个文件
        """
        try:
            # 优化：只读取前 4KB（frontmatter 通常很小）
            with open(skill_md, 'rb') as f:
                content_bytes = f.read(4096)
            content = content_bytes.decode('utf-8', errors='ignore')
            
            # 解析 YAML frontmatter
            match = _RE_YAML_FRONTMATTER.match(content)
            if not match:
                logger.warning(f"Skill 缺少 YAML frontmatter: {skill_md}")
                return None
            
            metadata = yaml.safe_load(match.group(1))
            if not metadata:
                return None
            if metadata.get("moved_to"):
                logger.debug("Skill 已迁移，跳过: %s -> %s", skill_md, metadata["moved_to"])
                return None

            def _ensure_str_list(val: Any) -> List[str]:
                """YAML 可能为字符串或列表，统一为 List[str] 避免迭代/ in 判断出错"""
                if val is None:
                    return []
                if isinstance(val, list):
                    return [str(x).strip() for x in val if str(x).strip()]
                return [str(val).strip()] if str(val).strip() else []

            # 从路径推断信息
            relative_path = skill_md.relative_to(PROJECT_ROOT)
            parts = relative_path.parts
            skill_dir = skill_md.parent
            
            # 推断 domain（从路径：knowledge_base/skills/domain/... 或 knowledge_base/learned/skills/...）
            domain = "general"
            if len(parts) >= 4:
                domain = parts[2]  # skills 下为 domain；learned 下为 "learned"
            
            # 推断 source
            source = "custom"
            if domain == "anthropic":
                source = "anthropic"
            elif domain == "learned" or "learned" in str(relative_path):
                source = "learned"
            
            # 推断 level
            level = metadata.get("level", "general")
            if domain == "anthropic":
                level = "anthropic"
            elif domain == "foundation":
                level = "foundation"
            elif domain == "modes":
                level = "modes"
            elif domain == "learned":
                level = metadata.get("level", "learned")
            elif domain != "general" and level == "general":
                level = "domain"
            
            # 检查 scripts/ 目录
            scripts_dir = skill_dir / "scripts"
            has_scripts = scripts_dir.exists() and scripts_dir.is_dir()
            scripts = []
            if has_scripts:
                scripts = [f.name for f in scripts_dir.iterdir() 
                          if f.is_file() and f.suffix in ['.py', '.sh', '.js', '.ts']]
            
            # 检查 references/ 或 reference/ 目录
            references_dir = skill_dir / "references"
            if not references_dir.exists():
                references_dir = skill_dir / "reference"
            has_references = references_dir.exists() and references_dir.is_dir()
            references = []
            if has_references:
                references = [f.name for f in references_dir.iterdir() 
                             if f.is_file() and f.suffix in ['.md', '.txt', '.json', '.yaml']]
            
            # 检查 assets/ 目录
            assets_dir = skill_dir / "assets"
            has_assets = assets_dir.exists() and assets_dir.is_dir()
            assets = []
            if has_assets:
                assets = [f.name for f in assets_dir.iterdir() if f.is_file()][:20]  # 限制数量
            
            # 解析 allowed-tools（Agent Skills 标准字段）
            allowed_tools = []
            raw_allowed_tools = metadata.get("allowed-tools")
            if isinstance(raw_allowed_tools, str) and raw_allowed_tools.strip():
                allowed_tools = [x for x in raw_allowed_tools.split(" ") if x]
            elif isinstance(raw_allowed_tools, list):
                allowed_tools = [str(x).strip() for x in raw_allowed_tools if str(x).strip()]
            
            # 解析 metadata 字段
            meta_dict = metadata.get("metadata", {})
            if isinstance(meta_dict, dict):
                author = meta_dict.get("author", metadata.get("author", ""))
                version = meta_dict.get("version", metadata.get("version", "1.0"))
            else:
                author = metadata.get("author", "")
                version = metadata.get("version", "1.0")

            # updated_at：优先 frontmatter，否则用 SKILL.md 的 mtime（ISO8601）
            updated_at_val = (metadata.get("updated_at") or "").strip()
            if not updated_at_val:
                try:
                    mtime = skill_md.stat().st_mtime
                    updated_at_val = datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat()
                except Exception:
                    pass

            return SkillInfo(
                name=metadata.get("name", skill_md.parent.name),
                display_name=metadata.get("display_name", metadata.get("name", skill_md.parent.name)),
                description=metadata.get("description", ""),
                level=level,
                domain=domain,
                source=source,
                triggers=_ensure_str_list(metadata.get("triggers")),
                dependencies=_ensure_str_list(metadata.get("dependencies")),
                tools=_ensure_str_list(metadata.get("tools")),
                allowed_tools=allowed_tools,
                path=str(skill_md),
                relative_path=str(relative_path),
                skill_dir=str(skill_dir),
                has_scripts=has_scripts,
                has_references=has_references,
                has_assets=has_assets,
                scripts=scripts,
                references=references,
                assets=assets,
                version=str(version),
                author=author,
                license=metadata.get("license", ""),
                compatibility=metadata.get("compatibility", ""),
                metadata=meta_dict if isinstance(meta_dict, dict) else {},
                updated_at=updated_at_val,
                modes=_ensure_str_list(metadata.get("modes")),
                disable_model_invocation=metadata.get("disable-model-invocation", False),
            )
            
        except Exception as e:
            logger.error(f"解析 Skill 文件失败: {skill_md}, 错误: {e}")
            return None
    
    def _register_skill(self, skill: SkillInfo):
        """注册 Skill 到索引"""
        existed = self._skills.get(skill.name)
        if existed is not None:
            def _score(s: SkillInfo) -> tuple[int, int]:
                # 优先级：foundation > domain > general > 其他；其次优先带 scripts/references 的实现
                level_rank = {
                    "foundation": 4,
                    "domain": 3,
                    "general": 2,
                    "modes": 2,
                    "learned": 1,
                    "anthropic": 1,
                }.get(str(getattr(s, "level", "") or "").lower(), 0)
                feature_rank = int(bool(getattr(s, "has_scripts", False))) + int(bool(getattr(s, "has_references", False)))
                return (level_rank, feature_rank)

            old_score = _score(existed)
            new_score = _score(skill)
            if new_score <= old_score:
                logger.info(
                    "检测到同名 Skill，保留优先级更高条目: name=%s kept=%s ignored=%s",
                    skill.name,
                    existed.path,
                    skill.path,
                )
                return

            # 新 Skill 优先级更高，替换旧索引
            if existed.level in self._by_level and existed.name in self._by_level[existed.level]:
                self._by_level[existed.level].remove(existed.name)
            if existed.domain in self._by_domain and existed.name in self._by_domain[existed.domain]:
                self._by_domain[existed.domain].remove(existed.name)
            if existed.modes:
                for mode in existed.modes:
                    if mode in self._by_mode and existed.name in self._by_mode[mode]:
                        self._by_mode[mode].remove(existed.name)
            for alias in {existed.name, Path(existed.path).parent.name if existed.path else ""}:
                norm = self._normalize_skill_name(alias)
                if norm and self._normalized_name_index.get(norm) == existed.name:
                    self._normalized_name_index.pop(norm, None)
            logger.info(
                "检测到同名 Skill，已替换为优先级更高条目: name=%s old=%s new=%s",
                skill.name,
                existed.path,
                skill.path,
            )
        self._skills[skill.name] = skill
        for alias in {skill.name, Path(skill.path).parent.name if skill.path else ""}:
            norm = self._normalize_skill_name(alias)
            if norm:
                current = self._normalized_name_index.get(norm)
                if current and current != skill.name:
                    logger.warning(
                        "Skill 别名冲突，保留首个映射: alias=%s kept=%s ignored=%s",
                        norm,
                        current,
                        skill.name,
                    )
                    continue
                self._normalized_name_index[norm] = skill.name
        
        # 按层级索引
        if skill.level not in self._by_level:
            self._by_level[skill.level] = []
        self._by_level[skill.level].append(skill.name)
        
        # 按领域索引
        if skill.domain not in self._by_domain:
            self._by_domain[skill.domain] = []
        self._by_domain[skill.domain].append(skill.name)
        
        # 按模式索引
        if skill.modes:
            for mode in skill.modes:
                if mode not in self._by_mode:
                    self._by_mode[mode] = []
                self._by_mode[mode].append(skill.name)
    
    # ============================================================
    # 查询接口
    # ============================================================
    
    def get_all_skills(self) -> List[SkillInfo]:
        """获取所有 Skills"""
        if not self._loaded:
            self.discover_skills()
        return list(self._skills.values())
    
    def get_skill(self, name: str) -> Optional[SkillInfo]:
        """获取单个 Skill"""
        if not self._loaded:
            self.discover_skills()
        if name in self._skills:
            return self._skills.get(name)
        normalized = self._normalize_skill_name(name)
        target = self._normalized_name_index.get(normalized)
        return self._skills.get(target) if target else None
    
    def get_skills_by_level(self, level: str) -> List[SkillInfo]:
        """按层级获取 Skills"""
        if not self._loaded:
            self.discover_skills()
        names = self._by_level.get(level, [])
        return [self._skills[n] for n in names if n in self._skills]
    
    def get_skills_by_domain(self, domain: str) -> List[SkillInfo]:
        """按领域获取 Skills"""
        if not self._loaded:
            self.discover_skills()
        names = self._by_domain.get(domain, [])
        return [self._skills[n] for n in names if n in self._skills]
    
    def get_skills_for_mode(self, mode: str) -> List[SkillInfo]:
        """获取适用于特定模式的 Skills
        
        如果 Skill 的 modes 为空，表示适用于所有模式
        """
        if not self._loaded:
            self.discover_skills()
        
        result = []
        for skill in self._skills.values():
            if not skill.modes or mode in skill.modes:
                result.append(skill)
        return result
    
    # 关键词到 Skill 名称的映射（支持中文匹配）
    KEYWORD_MAPPING = {
        # 文档处理
        "excel": ["xlsx"],
        "表格": ["xlsx", "data-analysis"],
        "pdf": ["pdf"],
        "word": ["docx"],
        "文档": ["docx", "document-generation", "document-writing"],
        "ppt": ["pptx"],
        "演示": ["pptx"],
        "幻灯片": ["pptx"],
        # 数据分析
        "数据分析": ["data-analysis", "xlsx"],
        "报表": ["xlsx", "data-analysis", "reports"],
        "报告": ["reports", "document-writing", "document-generation"],
        "汇报": ["reports", "pptx", "visualization"],
        "周报": ["reports", "document-writing"],
        "月报": ["reports", "document-writing"],
        "调研": ["business-planning", "text-analysis", "data-analysis", "reports"],
        "材料撰写": ["document-writing", "reports", "business-planning"],
        "图表": ["visualization", "data-analysis"],
        "可视化": ["visualization"],
        # 系统巡检 / 知识库治理
        "系统状态": ["auto-discovery", "quality-report"],
        "健康检查": ["auto-discovery", "quality-report"],
        "系统巡检": ["auto-discovery", "quality-report"],
        "/status": ["auto-discovery", "quality-report"],
        "/status all": ["auto-discovery", "quality-report"],
        "/status prompt": ["auto-discovery", "quality-report"],
        "/status prompt_modules": ["auto-discovery", "quality-report"],
        "/status module": ["auto-discovery", "quality-report"],
        "/status modules": ["auto-discovery", "quality-report"],
        "/status health": ["auto-discovery", "quality-report"],
        "/status rollout": ["auto-discovery", "quality-report"],
        "/status gate": ["auto-discovery", "quality-report"],
        "/status commands": ["auto-discovery", "quality-report"],
        "/status command": ["auto-discovery", "quality-report"],
        "/status help": ["auto-discovery", "quality-report"],
        "status": ["auto-discovery", "quality-report"],
        "能力注册表": ["auto-discovery", "skillsmp-integration"],
        "知识库分析": ["knowledge-building", "quality-report", "auto-discovery"],
        "知识库审计": ["quality-report", "knowledge-building", "auto-discovery"],
        "知识库系统": ["knowledge-building", "quality-report", "auto-discovery"],
        "EDA": ["data-analysis"],
        "探索性分析": ["data-analysis"],
        "统计分析": ["data-analysis"],
        "趋势分析": ["data-analysis", "visualization"],
        "数据报告": ["data-analysis", "reports"],
        "数据清洗": ["data-analysis", "xlsx"],
        "相关性分析": ["data-analysis"],
        "回归分析": ["data-analysis"],
        "热力图": ["visualization", "data-analysis"],
        "箱线图": ["visualization"],
        "仪表盘": ["visualization", "data-analysis"],
        "dashboard": ["visualization", "data-analysis"],
        # 招投标（单一专项 skill：bidding）
        "招标": ["bidding"],
        "招标文件": ["bidding"],
        "招标分析": ["bidding"],
        "投标": ["bidding"],
        "投标文件": ["bidding"],
        "标书": ["bidding"],
        "标书撰写": ["bidding"],
        "技术方案": ["bidding"],
        "商务报价": ["bidding"],
        "响应矩阵": ["bidding"],
        "合规": ["bidding"],
        "合规检查": ["bidding"],
        "合规审查": ["bidding"],
        "废标": ["bidding"],
        "资格审查": ["bidding"],
        "符合性检查": ["bidding"],
        "评标": ["bidding"],
        "评分": ["bidding"],
        "评分标准": ["bidding"],
        "中标": ["bidding"],
        "竞争分析": ["bidding"],
        "得分预测": ["bidding"],
        "投标决策": ["bidding"],
        "竞争策略": ["bidding"],
        "报价策略": ["bidding"],
        "竞争力分析": ["bidding"],
        "资格预审": ["bidding"],
        "资格预审检查": ["bidding"],
        "资质验证": ["bidding"],
        "产品匹配": ["bidding"],
        "实质性响应": ["bidding"],
        "投标策划": ["bidding"],
        "RFP": ["bidding"],
        "投标响应": ["bidding"],
        "废标审查": ["bidding"],
        "中标分析": ["bidding"],
        "投标保证金": ["bidding"],
        "技术偏离": ["bidding"],
        "陷阱条款": ["bidding"],
        "资格要求": ["bidding"],
        "评标办法": ["bidding"],
        "招标公告": ["bidding"],
        "投标邀请": ["bidding"],
        "询价": ["bidding"],
        # 合同
        "合同": ["contracts", "contract-management"],
        "协议": ["contracts"],
        # 开发
        "mcp": ["mcp-builder"],
        "skill": ["skill-creator"],
        "测试": ["webapp-testing"],
        "前端": ["frontend-design"],
        # 教育
        "学习": ["student-learning"],
        "作业": ["homework-check"],
        "备课": ["teacher-lesson-prep"],
        "教案": ["teacher-lesson-prep"],
        # 推理
        "分析": ["reasoning", "text-analysis", "data-analysis"],
        "推理": ["reasoning"],
        "验证": ["verification"],
        # 协作
        "写作": ["doc-coauthoring", "document-writing"],
        "协作": ["doc-coauthoring"],
    }
    
    def match_skills_by_query_with_reasons(
        self, query: str, mode: str = None
    ) -> List[Tuple[SkillInfo, str]]:
        """根据查询匹配相关 Skills，并返回每条匹配的简要原因。返回 [(SkillInfo, match_reason), ...]。"""
        if not self._loaded:
            self.discover_skills()
        query_lower = query.lower()
        query_norm = self._normalize_skill_name(query_lower)
        scores: Dict[str, int] = {}
        reasons: Dict[str, List[str]] = {}
        first_seen: Dict[str, int] = {}
        seen_order = 0

        def add_score(skill: SkillInfo, value: int, reason: str):
            nonlocal seen_order
            if skill.name not in first_seen:
                first_seen[skill.name] = seen_order
                seen_order += 1
            scores[skill.name] = scores.get(skill.name, 0) + value
            if skill.name not in reasons:
                reasons[skill.name] = []
            if reason and reason not in reasons[skill.name]:
                reasons[skill.name].append(reason)

        # 1. 精确匹配 Skill 名称
        for skill in self._skills.values():
            if mode and skill.modes and mode not in skill.modes:
                continue
            skill_norm = self._normalize_skill_name(skill.name)
            if (
                skill.name.lower() in query_lower
                or skill.name.replace("-", " ") in query_lower
                or (skill_norm and skill_norm in query_norm)
            ):
                add_score(skill, 100, "名称匹配")

        # 2. 关键词映射
        for keyword, skill_names in self.KEYWORD_MAPPING.items():
            keyword_lower = keyword.lower()
            if keyword_lower in query_lower:
                bonus = min(len(keyword_lower), 10)
                for name in skill_names:
                    skill = self.get_skill(name)
                    if skill and (not mode or not skill.modes or mode in skill.modes):
                        add_score(skill, 70 + bonus, f"关键词：{keyword}")

        # 3. 触发词匹配
        for skill in self._skills.values():
            if mode and skill.modes and mode not in skill.modes:
                continue
            for trigger in skill.triggers:
                trigger_lower = str(trigger).lower()
                if not trigger_lower:
                    continue
                if trigger_lower in query_lower or str(trigger) in query:
                    add_score(skill, 90 + min(len(trigger_lower), 12), f"触发词：{trigger}")
                    break

        # 4. 描述匹配
        if len(scores) < 3:
            query_words = [w for w in query_lower.split() if len(w) > 2]
            for skill in self._skills.values():
                if mode and skill.modes and mode not in skill.modes:
                    continue
                desc_lower = skill.description.lower()
                for word in query_words:
                    if word in desc_lower:
                        add_score(skill, 20, "描述匹配")
                        break

        # 5. embedding 语义匹配
        semantic_scores = self._semantic_match_scores(query, mode=mode)
        for skill_name, sem_score in semantic_scores.items():
            scores[skill_name] = scores.get(skill_name, 0) + int(max(0.0, sem_score) * 100)
            if skill_name not in first_seen:
                first_seen[skill_name] = seen_order
                seen_order += 1
            if skill_name not in reasons:
                reasons[skill_name] = []
            if "语义相似" not in reasons[skill_name]:
                reasons[skill_name].append("语义相似")

        ranked_names = sorted(
            scores.keys(),
            key=lambda name: (-scores[name], first_seen[name], name),
        )
        out: List[Tuple[SkillInfo, str]] = []
        for name in ranked_names:
            skill = self._skills.get(name)
            if not skill:
                continue
            reason_list = reasons.get(name, [])
            reason = reason_list[0] if reason_list else "相关"
            out.append((skill, reason))
        return out

    def match_skills_by_query(self, query: str, mode: str = None) -> List[SkillInfo]:
        """根据查询匹配相关 Skills。仅返回技能列表，不包含匹配原因；需原因时用 match_skills_by_query_with_reasons。"""
        return [s for s, _ in self.match_skills_by_query_with_reasons(query, mode)]

    def _semantic_match_scores(self, query: str, mode: Optional[str] = None) -> Dict[str, float]:
        """基于 embedding 的语义相似度评分，返回 [0, 1]。"""
        try:
            from backend.tools.base.embedding_tools import get_embeddings
            emb = get_embeddings()
            if emb is None:
                return {}
            query_vec = emb.embed_query(query or "")
            if not query_vec:
                return {}
        except Exception:
            return {}

        def cosine(a: List[float], b: List[float]) -> float:
            if not a or not b or len(a) != len(b):
                return 0.0
            dot = sum(float(x) * float(y) for x, y in zip(a, b))
            na = math.sqrt(sum(float(x) * float(x) for x in a))
            nb = math.sqrt(sum(float(y) * float(y) for y in b))
            if na == 0 or nb == 0:
                return 0.0
            return max(0.0, min(1.0, dot / (na * nb)))

        score_map: Dict[str, float] = {}
        for skill in self._skills.values():
            if mode and skill.modes and mode not in skill.modes:
                continue
            text = f"{skill.name}\n{skill.description}\n{' '.join(skill.triggers[:8])}"
            cache_key = f"skill:{skill.name}"
            try:
                with self._embedding_cache_lock:
                    skill_vec = self._embedding_cache.get(cache_key)
                if not skill_vec:
                    skill_vec = emb.embed_query(text)
                    if skill_vec:
                        with self._embedding_cache_lock:
                            self._embedding_cache[cache_key] = skill_vec
                sim = cosine(query_vec, skill_vec)
            except Exception:
                sim = 0.0
            if sim >= self._semantic_threshold:
                score_map[skill.name] = sim
        return score_map
    
    def get_domains(self) -> List[str]:
        """获取所有领域"""
        if not self._loaded:
            self.discover_skills()
        return list(self._by_domain.keys())
    
    def get_levels(self) -> List[str]:
        """获取所有层级"""
        if not self._loaded:
            self.discover_skills()
        return list(self._by_level.keys())
    
    def get_skills_by_source(self, source: str) -> List[SkillInfo]:
        """按来源获取 Skills
        
        Args:
            source: 来源类型 ("anthropic", "custom", "learned")
        
        Returns:
            符合条件的 Skills 列表
        """
        if not self._loaded:
            self.discover_skills()
        return [s for s in self._skills.values() if s.source == source]
    
    def get_anthropic_skills(self) -> List[SkillInfo]:
        """获取 Anthropic 官方 Skills"""
        return self.get_skills_by_source("anthropic")
    
    def get_skills_with_scripts(self) -> List[SkillInfo]:
        """获取包含可执行脚本的 Skills"""
        if not self._loaded:
            self.discover_skills()
        return [s for s in self._skills.values() if s.has_scripts]
    
    def get_skills_with_references(self) -> List[SkillInfo]:
        """获取包含参考文档的 Skills"""
        if not self._loaded:
            self.discover_skills()
        return [s for s in self._skills.values() if s.has_references]
    
    # ============================================================
    # API 数据格式
    # ============================================================
    
    def to_api_response(self, mode: str = None) -> Dict[str, Any]:
        """生成 API 响应格式的数据"""
        if not self._loaded:
            self.discover_skills()
        
        # 获取适用的 Skills
        if mode:
            skills = self.get_skills_for_mode(mode)
        else:
            skills = list(self._skills.values())
        
        # 按领域分组
        by_domain = {}
        for skill in skills:
            domain = skill.domain
            if domain not in by_domain:
                by_domain[domain] = []
            by_domain[domain].append(skill.to_dict())
        
        return {
            "total": len(skills),
            "domains": list(by_domain.keys()),
            "levels": list(set(s.level for s in skills)),
            "skills_by_domain": by_domain,
            "skills": [s.to_dict() for s in skills],
        }
    
    def get_stats(self) -> Dict[str, Any]:
        """获取统计信息"""
        if not self._loaded:
            self.discover_skills()
        
        return {
            "total_skills": len(self._skills),
            "by_level": {k: len(v) for k, v in self._by_level.items()},
            "by_domain": {k: len(v) for k, v in self._by_domain.items()},
            "skills_root": str(SKILLS_ROOT),
            "loaded": self._loaded,
        }

    def _tier_profile_cache_key(self, tier_profile: Optional[Dict[str, Any]]) -> Optional[int]:
        """生成 tier_profile 的稳定缓存键（用于 runtime_index 缓存）。"""
        if not tier_profile or not isinstance(tier_profile, dict):
            return None
        try:
            return hash(json.dumps(tier_profile, sort_keys=True, default=str)[:2000])
        except Exception:
            return None

    def build_runtime_index(
        self,
        profile: Optional[str] = None,
        mode: Optional[str] = None,
        tier_profile: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        输出“管理面可见 + 运行面可用”的统一索引。
        runtime_enabled 由 profile 路径裁剪 + tier_profile（allow_skills）共同决定。
        带短期 TTL 缓存，减少同 profile/mode 重复扫描（见 KNOWLEDGE_ARCHITECTURE）。
        """
        cache_key = (str(profile or ""), str(mode or "agent"), self._tier_profile_cache_key(tier_profile))
        now = time.time()
        with self._runtime_index_cache_lock:
            if cache_key in self._runtime_index_cache:
                cached_result, ts = self._runtime_index_cache[cache_key]
                if now - ts < self._runtime_index_cache_ttl:
                    return cached_result
                del self._runtime_index_cache[cache_key]
        if not self._loaded:
            self.discover_skills()
        all_skills = self.get_all_skills()
        runtime_paths: List[str] = []
        if profile:
            try:
                from backend.engine.skills.skill_profiles import get_skills_paths_for_profile

                runtime_paths = get_skills_paths_for_profile(
                    profile=profile,
                    mode=mode or "agent",
                    default_paths=["skills"],
                )
            except Exception:
                runtime_paths = []

        normalized_paths = []
        for p in runtime_paths:
            raw = str(p or "").strip().replace("\\", "/").lstrip("./")
            if not raw:
                continue
            raw = raw.removeprefix("knowledge_base/")
            normalized_paths.append(raw.rstrip("/"))

        def _runtime_enabled(relative_path: str) -> bool:
            if not normalized_paths:
                return True if not profile else False
            rp = str(relative_path or "").replace("\\", "/").lstrip("./")
            rp = rp.removeprefix("knowledge_base/").rstrip("/")
            return any(rp.startswith(prefix) for prefix in normalized_paths)

        tier_allowed = None
        if tier_profile is not None:
            try:
                from backend.engine.license.tier_service import is_skill_path_allowed
                tier_allowed = is_skill_path_allowed
            except Exception:
                tier_allowed = None

        items: List[Dict[str, Any]] = []
        runtime_total = 0
        for skill in all_skills:
            row = skill.to_dict()
            enabled = _runtime_enabled(getattr(skill, "relative_path", ""))
            if enabled and tier_allowed is not None:
                enabled = tier_allowed(skill.tier_path, tier_profile)
            row["runtime_enabled"] = enabled
            if enabled:
                runtime_total += 1
            items.append(row)

        # 单会话技能数上限（与 Claude 每请求技能数思路一致，避免上下文过长）
        max_per_session: Optional[int] = None
        try:
            from backend.engine.skills.skill_profiles import get_max_skills_per_session
            max_per_session = get_max_skills_per_session(profile)
        except Exception:
            pass
        if max_per_session is not None and max_per_session > 0 and runtime_total > max_per_session:
            level_order = {"foundation": 0, "general": 1, "format": 2, "modes": 3, "domain": 4, "anthropic": 5, "learned": 6}
            enabled_indices = [i for i, row in enumerate(items) if row.get("runtime_enabled")]
            enabled_indices.sort(
                key=lambda i: (level_order.get(str(items[i].get("level", "general")), 1), str(items[i].get("name", "")))
            )
            keep = set(enabled_indices[:max_per_session])
            runtime_total = 0
            for i, row in enumerate(items):
                if row.get("runtime_enabled") and i not in keep:
                    row["runtime_enabled"] = False
                if row.get("runtime_enabled"):
                    runtime_total += 1

        result = {
            "profile": profile or "",
            "mode": mode or "",
            "runtime_paths": runtime_paths,
            "management_total": len(items),
            "runtime_total": runtime_total,
            "skills": items,
        }
        with self._runtime_index_cache_lock:
            if len(self._runtime_index_cache) >= 32:
                oldest = min(self._runtime_index_cache.items(), key=lambda x: x[1][1])
                del self._runtime_index_cache[oldest[0]]
            self._runtime_index_cache[cache_key] = (result, time.time())
        return result


def validate_skill_scripts(skill: SkillInfo) -> List[str]:
    """
    检查 SKILL.md 正文中引用的脚本是否均存在于 scripts/ 目录。
    返回在文档中出现但不在 skill.scripts 中的脚本名列表（供 CI/健康检查用）。
    """
    path = Path(skill.path) if getattr(skill, "path", None) else None
    if not path or not path.exists():
        return []
    try:
        content = path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return []
    match = _RE_YAML_FRONTMATTER.match(content)
    body = content[match.end() :] if match else content
    refs = set(_RE_SCRIPT_REF.findall(body))
    refs = {r for r in refs if not r.startswith(".")}
    actual = set(skill.scripts or [])
    missing = [r for r in refs if r not in actual]
    return sorted(missing)


# ============================================================
# 全局实例
# ============================================================
_registry: Optional[SkillRegistry] = None
_registry_lock = threading.Lock()


def get_skill_registry() -> SkillRegistry:
    """获取 Skill 注册表实例（线程安全）"""
    global _registry
    if _registry is None:
        with _registry_lock:
            if _registry is None:
                _registry = SkillRegistry()
    return _registry


def reload_skills():
    """重新加载 Skills（热重载）"""
    registry = get_skill_registry()
    registry.discover_skills(force_reload=True)
    return registry.get_stats()


# ============================================================
# 导出
# ============================================================

__all__ = [
    "SkillRegistry",
    "SkillInfo",
    "get_skill_registry",
    "reload_skills",
    "validate_skill_scripts",
]
