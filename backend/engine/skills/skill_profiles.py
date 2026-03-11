"""Skill Profile：按配置加载内置 skills，并动态叠加插件 skills。"""

import json
import logging
import threading
from pathlib import Path
from typing import Dict, List, Optional, Any

logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parents[3]
CONFIG_PATH = PROJECT_ROOT / "backend" / "config" / "skill_profiles.json"
AGENT_PROFILE_PATH = PROJECT_ROOT / "backend" / "config" / "agent_profile.json"

_CACHED_PROFILES: Optional[Dict[str, Any]] = None
_CACHED_PROFILES_MTIME: float = 0
_profiles_lock = threading.Lock()
PROFILE_ALIASES: Dict[str, str] = {
    "full": "general",
    "document": "general",
    "dev": "general",
    "community": "general",
    "analytics": "analyst",
    "knowledge-engineering": "knowledge_engineering",
    "report": "general",
    "research": "general",
    "contract": "general",
    "knowledge": "knowledge_engineering",
}


def normalize_skill_profile(profile: Optional[str]) -> str:
    raw = str(profile or "").strip().lower()
    return PROFILE_ALIASES.get(raw, raw)


def load_profiles(force_reload: bool = False) -> Dict[str, Any]:
    """加载 skill_profiles.json；文件缺失或解析失败时返回空 profiles，不抛错。线程安全。"""
    global _CACHED_PROFILES, _CACHED_PROFILES_MTIME
    if not force_reload and _CACHED_PROFILES is not None:
        try:
            mtime = CONFIG_PATH.stat().st_mtime if CONFIG_PATH.exists() else 0
        except OSError:
            mtime = 0
        if mtime == _CACHED_PROFILES_MTIME:
            return _CACHED_PROFILES
    with _profiles_lock:
        if not force_reload and _CACHED_PROFILES is not None:
            try:
                mtime = CONFIG_PATH.stat().st_mtime if CONFIG_PATH.exists() else 0
            except OSError:
                mtime = 0
            if mtime == _CACHED_PROFILES_MTIME:
                return _CACHED_PROFILES
        if not CONFIG_PATH.exists():
            logger.debug("skill_profiles.json 不存在，使用空 profiles")
            _CACHED_PROFILES = {"profiles": {}}
            _CACHED_PROFILES_MTIME = 0
            return _CACHED_PROFILES
        try:
            _CACHED_PROFILES_MTIME = CONFIG_PATH.stat().st_mtime
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
            if not isinstance(data.get("profiles"), dict):
                _CACHED_PROFILES = {"profiles": {}}
            else:
                _CACHED_PROFILES = data
        except Exception as e:
            logger.warning("加载 skill_profiles.json 失败，使用空 profiles: %s", e)
            _CACHED_PROFILES = {"profiles": {}}
        return _CACHED_PROFILES


def get_profile_list() -> List[Dict[str, Any]]:
    """返回所有可用 Profile 列表（供 API 使用）；含业务场景 label、能力组合说明。"""
    data = load_profiles()
    profiles = data.get("profiles", {})
    return [
        {
            "id": pid,
            "label": p.get("label", pid),
            "description": p.get("description", ""),
            "capabilities_summary": p.get("capabilities_summary", ""),
        }
        for pid, p in profiles.items()
    ]


def get_max_skills_per_session(profile: Optional[str]) -> Optional[int]:
    """
    返回该 profile 下单会话最多暴露的技能数；未配置或≤0 表示不截断。
    优先取 profile 下的 max_skills_per_session，否则取全局 max_skills_per_session。
    """
    data = load_profiles()
    profile = normalize_skill_profile(profile) or "general"
    profiles = data.get("profiles", {})
    if isinstance(profiles, dict) and profile in profiles:
        p = profiles[profile]
        if isinstance(p, dict):
            v = p.get("max_skills_per_session")
            if v is not None:
                try:
                    n = int(v)
                    if n > 0:
                        return n
                except (TypeError, ValueError):
                    pass
    v = data.get("max_skills_per_session")
    if v is not None:
        try:
            n = int(v)
            if n > 0:
                return n
        except (TypeError, ValueError):
            pass
    return None


def get_skills_paths_for_profile(
    profile: Optional[str],
    mode: str,
    default_paths: List[str],
) -> List[str]:
    """
    根据 profile 和 mode 返回要使用的 skills_paths。

    Args:
        profile: 来自 config.configurable.skill_profile，如 full / office / bidding / contract
        mode: agent / ask / plan / debug
        default_paths: 默认全量路径（已含 community），当 profile 为 full 或未指定时使用

    Returns:
        skills_paths 列表
    """
    profile = normalize_skill_profile(profile) or "general"
    if not profile:
        base_paths = list(default_paths)
        return _append_plugin_skill_paths(base_paths)

    data = load_profiles()
    profiles = data.get("profiles", {})
    if profile not in profiles:
        return _append_plugin_skill_paths(list(default_paths))

    paths = profiles[profile].get("paths")
    if paths is None:
        return _append_plugin_skill_paths(list(default_paths))

    resolved = [p for p in paths if p]
    return _append_plugin_skill_paths(resolved)


def _append_plugin_skill_paths(base_paths: List[str]) -> List[str]:
    """将已启用 Plugin 的 skill 路径动态注入 profile 路径。"""
    seen = set(base_paths)
    merged = list(base_paths)
    for p in _get_active_plugin_skill_paths():
        if p and p not in seen:
            merged.append(p)
            seen.add(p)
    return merged


def _get_active_plugin_skill_paths() -> List[str]:
    state_path = PROJECT_ROOT / "data" / "plugins_state.json"
    if not state_path.exists():
        return []
    try:
        names = json.loads(state_path.read_text(encoding="utf-8"))
        if not isinstance(names, list):
            return []
        from backend.engine.plugins import PluginLoader
        loader = PluginLoader(project_root=PROJECT_ROOT, profile={"tier": "enterprise"})
        for name in names:
            try:
                if str(name).strip():
                    loader.load(str(name).strip())
            except Exception:
                continue
        return loader.get_active_skill_paths()
    except Exception:
        return []


_CACHED_AGENT_PROFILE: Optional[Dict[str, Any]] = None
_CACHED_AGENT_PROFILE_MTIME: float = 0


def load_agent_profile(force_reload: bool = False) -> Dict[str, Any]:
    """加载 agent_profile.json；mtime 未变化时返回缓存。文件缺失或解析失败时返回默认结构，不抛错。"""
    global _CACHED_AGENT_PROFILE, _CACHED_AGENT_PROFILE_MTIME
    if not AGENT_PROFILE_PATH.exists():
        logger.debug("agent_profile.json 不存在，返回默认结构")
        _CACHED_AGENT_PROFILE = None
        _CACHED_AGENT_PROFILE_MTIME = 0
        return _default_agent_profile()
    try:
        mtime = AGENT_PROFILE_PATH.stat().st_mtime
    except OSError:
        mtime = 0
    if not force_reload and _CACHED_AGENT_PROFILE is not None and mtime == _CACHED_AGENT_PROFILE_MTIME:
        return _CACHED_AGENT_PROFILE
    try:
        with open(AGENT_PROFILE_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        result = data if isinstance(data, dict) else _default_agent_profile()
        _CACHED_AGENT_PROFILE = result
        _CACHED_AGENT_PROFILE_MTIME = mtime
        return result
    except Exception as e:
        logger.warning("加载 agent_profile.json 失败，使用默认: %s", e)
        return _default_agent_profile()


def save_agent_profile(profile: Dict[str, Any]) -> None:
    """保存 Agent 能力档案到 agent_profile.json。"""
    global _CACHED_AGENT_PROFILE, _CACHED_AGENT_PROFILE_MTIME
    AGENT_PROFILE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(AGENT_PROFILE_PATH, "w", encoding="utf-8") as f:
        json.dump(profile, f, ensure_ascii=False, indent=2)
    _CACHED_AGENT_PROFILE = profile
    try:
        _CACHED_AGENT_PROFILE_MTIME = AGENT_PROFILE_PATH.stat().st_mtime
    except OSError:
        _CACHED_AGENT_PROFILE_MTIME = 0


def _default_agent_profile() -> Dict[str, Any]:
    return {
        "agent_id": "agent-001",
        "name": "AI 工作助手",
        "description": "通用办公与专业领域的数字员工",
        "capabilities": {
            "skills": [],
            "domains": ["office", "reports"],
            "modes": ["agent", "ask", "plan", "debug", "review"],
            "max_parallel_tasks": 2,
            "supported_input_types": ["text", "document", "data", "image"],
            "supported_output_types": ["document", "report", "analysis", "code"],
        },
        "resources": {
            "compute_tier": "medium",
            "available_models": ["auto"],
            "max_context_tokens": 128000,
            "storage_available_mb": 1024,
        },
        "pricing": {"currency": "credit", "base_rate_per_task": 0, "token_cost_per_1k": 0},
        "network": {
            "openclaw_enabled": False,
            "openclaw_gateway": None,
            "openclaw_node_id": None,
            "channels": ["local"],
        },
    }
