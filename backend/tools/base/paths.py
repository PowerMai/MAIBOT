"""
统一路径配置 - Claude 风格单一数据源

两种根目录：
- APP_ROOT: 应用代码与默认资产（开发时=本仓库，部署时=安装目录）
- WORKSPACE_ROOT: 用户项目目录（运行时通过 config.configurable.workspace_path 传入）

路径归属原则：
- APP_ROOT 下: backend/, frontend/, 默认 knowledge_base/, docs/
- WORKSPACE_ROOT 下: uploads/, outputs/, .maibot/, .memory/（含 learning/），用户数据

路径优先级：环境变量 > 运行时 config > 默认值

使用方式：
    from backend.tools.base.paths import (
        KB_PATH, SKILLS_ROOT, LEARNING_PATH, MEMORY_PATH,
        WORKSPACE_PATH, UPLOADS_PATH, OUTPUTS_PATH, MAIBOT_PATH,
        get_project_root, get_workspace_root, set_workspace_root,
    )
"""

from __future__ import annotations

import os
from pathlib import Path

# ============================================================
# 应用根目录（从当前文件位置推算，不可变）
# backend/tools/base/paths.py -> 向上 4 级 = 项目根目录
# ============================================================
_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent

# ============================================================
# 工作区根目录（用户项目目录，运行时可动态切换）
#
# 优先级：环境变量 WORKSPACE_ROOT > 默认回退到 _PROJECT_ROOT/tmp
# 运行时可通过 set_workspace_root() 从 config.configurable.workspace_path 更新
# ============================================================
_WORKSPACE_ROOT: Path = Path(os.getenv("WORKSPACE_ROOT", _PROJECT_ROOT / "tmp"))

# ============================================================
# 应用级路径（只读资产，归属 APP_ROOT）
# ============================================================

# 知识库根目录（默认资产 + Skills）
KB_PATH = Path(os.getenv("KB_PATH", _PROJECT_ROOT / "knowledge_base"))

# Skills 目录（知识库下的 skills/）
SKILLS_ROOT = KB_PATH / "skills"

# 学习产出的 Skills 草稿（与 skill_profiles 中 knowledge_base/learned/skills/ 对应）
LEARNED_SKILLS_ROOT = KB_PATH / "learned" / "skills"

# 角色包目录（knowledge_base/roles/{role_id}/ 含 config.json、skills/、knowledge/ 等）
ROLES_ROOT = KB_PATH / "roles"

# BUNDLE 路径已迁移至 backend/config/skill_profiles.json（bundle_path 字段），
# 由 deep_agent.py 从配置动态读取，不再在此硬编码。

# LangGraph API 缓存目录
LANGGRAPH_API_ROOT = _PROJECT_ROOT / ".langgraph_api"
LANGGRAPH_API_BACKEND = _PROJECT_ROOT / "backend" / ".langgraph_api"

# resources.json 路径
RESOURCES_CONFIG_PATH = KB_PATH / "resources.json"

# 本体/知识图谱单一权威路径（Schema 单源 + 主 KG 存储）
# - 读写：schema（get_canonical_schema_path）、entities.json、relations.json、entities.jsonl
# - 注入与抽取均从此路径读取 schema，保证一致
ONTOLOGY_PATH = KB_PATH / "learned" / "ontology"

# 外部本体导入暂存目录（LOV/Wikidata/Schema.org/OWL 导入产物落盘处，与主 KG 合并前）
# 主链路检索与 expand_query 使用 ONTOLOGY_PATH，不直接读本目录
ONTOLOGY_IMPORT_STAGING_PATH = KB_PATH / "ontology"

# 项目根目录下的 .maibot 目录（主路径）
PROJECT_MAIBOT_PATH = _PROJECT_ROOT / ".maibot"
# 兼容旧路径：项目根目录下的 .context 目录（回退用）
PROJECT_CONTEXT_PATH = _PROJECT_ROOT / ".context"

# ============================================================
# 工作区级路径（用户数据，归属 WORKSPACE_ROOT）
# 这些路径会随 set_workspace_root() 更新
# ============================================================

# 兼容旧代码：WORKSPACE_PATH 指向工作区根
WORKSPACE_PATH = _WORKSPACE_ROOT

# 上传目录
UPLOADS_PATH = _WORKSPACE_ROOT / "uploads"

# 输出目录
OUTPUTS_PATH = _WORKSPACE_ROOT / "outputs"

# MAIBOT 项目目录（记忆、规则、身份）— 用户项目的 .maibot
MAIBOT_PATH = _WORKSPACE_ROOT / ".maibot"
# 兼容旧代码：CONTEXT_PATH 保留为 .context（迁移期回退）
CONTEXT_PATH = _WORKSPACE_ROOT / ".context"

# 记忆目录（知识图谱、学习模式）
MEMORY_PATH = _WORKSPACE_ROOT / ".memory"

# 学习数据目录（成功/失败模式、推理路径，随工作区切换）
LEARNING_PATH = MEMORY_PATH / "learning"

# 数据目录（向量索引、数据库）
DATA_PATH = Path(os.getenv("DATA_PATH", _PROJECT_ROOT / "data"))

# 向量存储目录
_vector_explicit = os.getenv("VECTOR_STORE_PATH")
_vector_in_kb = os.getenv("VECTOR_STORE_IN_KB", "false").lower() == "true"
if _vector_explicit:
    VECTOR_STORE_PATH = Path(_vector_explicit).resolve()
elif _vector_in_kb:
    VECTOR_STORE_PATH = KB_PATH / ".vectorstore"
else:
    VECTOR_STORE_PATH = DATA_PATH / "vectorstore"

# SQLite 数据库路径
CHECKPOINTS_DB_PATH = DATA_PATH / "checkpoints.db"
STORE_DB_PATH = DATA_PATH / "store.db"


# ============================================================
# 辅助函数
# ============================================================

def ensure_dirs():
    """确保所有必要目录存在"""
    for path in [
        UPLOADS_PATH,
        OUTPUTS_PATH,
        MAIBOT_PATH,
        CONTEXT_PATH,
        MEMORY_PATH,
        LEARNING_PATH,
        DATA_PATH,
        VECTOR_STORE_PATH,
    ]:
        path.mkdir(parents=True, exist_ok=True)


def get_project_root() -> Path:
    """获取应用根目录（代码与默认资产所在目录）"""
    return _PROJECT_ROOT


def get_workspace_root() -> Path:
    """获取当前工作区根目录（用户项目目录）"""
    return _WORKSPACE_ROOT


def set_workspace_root(path: str | Path) -> None:
    """运行时设置工作区根目录（由 config.configurable.workspace_path 驱动）

    更新所有工作区级路径（WORKSPACE_PATH, UPLOADS_PATH, OUTPUTS_PATH, MAIBOT_PATH, CONTEXT_PATH, MEMORY_PATH, LEARNING_PATH）。
    仅当传入路径存在且是目录时才生效。
    """
    global _WORKSPACE_ROOT, WORKSPACE_PATH, UPLOADS_PATH, OUTPUTS_PATH, MAIBOT_PATH, CONTEXT_PATH, MEMORY_PATH, LEARNING_PATH

    resolved = Path(path).resolve()
    if not resolved.is_dir():
        return  # 路径无效，保持当前值

    _WORKSPACE_ROOT = resolved
    WORKSPACE_PATH = resolved
    UPLOADS_PATH = resolved / "uploads"
    OUTPUTS_PATH = resolved / "outputs"
    MAIBOT_PATH = resolved / ".maibot"
    CONTEXT_PATH = resolved / ".context"
    MEMORY_PATH = resolved / ".memory"
    LEARNING_PATH = MEMORY_PATH / "learning"

    # 确保新路径下的目录存在
    for d in [UPLOADS_PATH, OUTPUTS_PATH, MAIBOT_PATH, CONTEXT_PATH, MEMORY_PATH, LEARNING_PATH]:
        d.mkdir(parents=True, exist_ok=True)


# 模块加载时确保目录存在
ensure_dirs()
