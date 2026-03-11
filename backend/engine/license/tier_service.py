from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)


class TierPermissionError(Exception):
    def __init__(self, detail: str, status_code: int = 402):
        super().__init__(detail)
        self.detail = detail
        self.status_code = status_code


def _get_cfg_path() -> Path:
    try:
        from backend.tools.base.paths import get_project_root
        return get_project_root() / "backend" / "config" / "license_tiers.json"
    except Exception:
        return Path(__file__).resolve().parents[2] / "config" / "license_tiers.json"

_DEFAULT_CFG: dict[str, Any] = {
    "tiers": {
        "free": {
            "max_autonomy_level": "L1",
            "allow_tools": [],
            "allow_skills": [],
            "allow_plugins": [],
            "allow_mcp_servers": [],
            "allow_middleware": [],
            "limits": {
                "max_custom_skills": 5,
                "max_mcp_connections": 2,
                "max_daily_autonomous_tasks": 3,
                "max_plugins": 2,
                "cloud_model_requests_daily": 0,
                "evolution_enabled": False,
                "parallel_agents": 1,
            },
        },
        "pro": {
            "max_autonomy_level": "L2",
            "allow_tools": ["*"],
            "allow_skills": ["*"],
            "allow_plugins": ["official/*"],
            "allow_mcp_servers": ["*"],
            "allow_middleware": ["*"],
            "limits": {
                "max_custom_skills": 50,
                "max_mcp_connections": 10,
                "max_daily_autonomous_tasks": 50,
                "max_plugins": 20,
                "cloud_model_requests_daily": 500,
                "evolution_enabled": True,
                "parallel_agents": 2,
            },
        },
        "max": {
            "max_autonomy_level": "L3",
            "allow_tools": ["*"],
            "allow_skills": ["*"],
            "allow_plugins": ["*"],
            "allow_mcp_servers": ["*"],
            "allow_middleware": ["*"],
            "limits": {
                "max_custom_skills": 200,
                "max_mcp_connections": 30,
                "max_daily_autonomous_tasks": 200,
                "max_plugins": 50,
                "cloud_model_requests_daily": 2500,
                "evolution_enabled": True,
                "distillation_enabled": True,
                "parallel_agents": 5,
            },
        },
        "enterprise": {
            "max_autonomy_level": "L3",
            "allow_tools": ["*"],
            "allow_skills": ["*"],
            "allow_plugins": ["*"],
            "allow_mcp_servers": ["*"],
            "allow_middleware": ["*"],
            "limits": {
                "max_custom_skills": -1,
                "max_mcp_connections": -1,
                "max_daily_autonomous_tasks": -1,
                "max_plugins": -1,
                "cloud_model_requests_daily": -1,
                "evolution_enabled": True,
                "parallel_agents": -1,
            },
        },
    },
    "default_tier": "free",
}


_tiers_config_cache: dict[str, Any] | None = None
_tiers_config_mtime: float = 0


def _load_tiers_config() -> dict[str, Any]:
    global _tiers_config_cache, _tiers_config_mtime
    try:
        cfg_path = _get_cfg_path()
        mtime = cfg_path.stat().st_mtime
        if _tiers_config_cache is not None and mtime == _tiers_config_mtime:
            return _tiers_config_cache
        data = json.loads(cfg_path.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            _tiers_config_cache = data
            _tiers_config_mtime = mtime
            return data
    except Exception as e:
        logger.debug("加载 license_tiers.json 失败: %s", e)
    if _tiers_config_cache is not None:
        return _tiers_config_cache
    return _DEFAULT_CFG


def _tier_to_cfg_key(tier: str) -> str:
    normalized = normalize_tier(tier)
    return normalized


def _tier_profile(profile: Optional[dict]) -> dict[str, Any]:
    cfg = _load_tiers_config()
    tiers = cfg.get("tiers") if isinstance(cfg, dict) else {}
    tiers = tiers if isinstance(tiers, dict) else {}
    key = _tier_to_cfg_key(current_tier(profile))
    default_key = str(cfg.get("default_tier") or "free")
    val = tiers.get(key) or tiers.get(default_key) or {}
    return val if isinstance(val, dict) else {}


def normalize_tier(tier: Optional[str]) -> str:
    raw = str(tier or "").strip().lower()
    alias = {
        "community": "free",
        "business": "enterprise",
    }
    normalized = alias.get(raw, raw)
    if normalized in {"free", "pro", "max", "enterprise"}:
        return normalized
    return "free"


def tier_rank(tier: str) -> int:
    mapping = {"free": 0, "pro": 1, "max": 2, "enterprise": 3}
    return mapping.get(normalize_tier(tier), 0)


def current_tier(profile: Optional[dict]) -> str:
    tier = (profile or {}).get("tier", "free")
    return normalize_tier(str(tier))


def tier_limits(profile: Optional[dict]) -> dict:
    tier_cfg = _tier_profile(profile)
    cfg_limits = tier_cfg.get("limits")
    cfg_limits = cfg_limits if isinstance(cfg_limits, dict) else {}
    profile_limits = (profile or {}).get("limits")
    profile_limits = profile_limits if isinstance(profile_limits, dict) else {}
    defaults = {
        "max_custom_skills": 5,
        "max_mcp_connections": 2,
        "max_daily_autonomous_tasks": 3,
        "max_plugins": 2,
        "cloud_model_requests_daily": 0,
        "evolution_enabled": False,
        "parallel_agents": 1,
    }
    merged = dict(defaults)
    merged.update(cfg_limits)
    merged.update(profile_limits)
    return merged


def max_autonomy_level(profile: Optional[dict]) -> str:
    level = str(_tier_profile(profile).get("max_autonomy_level") or "L1").strip().upper()
    if level in {"L0", "L1", "L2", "L3"}:
        return level
    return "L1"


# 任何 tier 下都不可裁掉的中间件（流式、鉴权、限流等核心运行所需）
REQUIRED_MIDDLEWARE_NAMES = frozenset({
    "streaming", "inject_runtime_context", "license_gate", "mode_permission",
    "content_fix", "cloud_call_gate", "model_call_limit", "tool_call_limit",
})


def is_middleware_allowed(middleware_name: str, profile: Optional[dict]) -> bool:
    name = str(middleware_name or "").strip()
    if name in REQUIRED_MIDDLEWARE_NAMES:
        return True
    allow = _tier_profile(profile).get("allow_middleware")
    allow_list = allow if isinstance(allow, list) else []
    normalized = {str(x).strip() for x in allow_list if str(x).strip()}
    return "*" in normalized or name in normalized


def is_cloud_model_allowed(profile: Optional[dict]) -> bool:
    quota = int(tier_limits(profile).get("cloud_model_requests_daily", 0) or 0)
    return quota != 0


def check_daily_cloud_quota(profile: Optional[dict], used_today: int) -> tuple[bool, int]:
    quota = int(tier_limits(profile).get("cloud_model_requests_daily", 0) or 0)
    if quota < 0:
        return True, -1
    remaining = max(0, quota - max(0, int(used_today)))
    return remaining > 0, remaining


def is_evolution_allowed(profile: Optional[dict]) -> bool:
    return bool(tier_limits(profile).get("evolution_enabled", False))


def is_memory_allowed(profile: Optional[dict]) -> bool:
    return bool(tier_limits(profile).get("memory_enabled", False))


def is_distillation_allowed(profile: Optional[dict]) -> bool:
    return bool(tier_limits(profile).get("distillation_enabled", False))


def is_plugin_install_allowed(profile: Optional[dict], current_count: int) -> bool:
    max_plugins = int(tier_limits(profile).get("max_plugins", 2) or 2)
    if max_plugins < 0:
        return True
    return int(current_count) < max_plugins


def is_plugin_tier_allowed(plugin_spec: Any, profile: Optional[dict]) -> bool:
    current = current_tier(profile)
    required = normalize_tier(getattr(plugin_spec, "requires_tier", "free"))
    return tier_rank(current) >= tier_rank(required)


def is_skill_path_allowed(skill_path: str, profile: Optional[dict]) -> bool:
    cfg = _tier_profile(profile)
    allow = cfg.get("allow_skills")
    allow_list = allow if isinstance(allow, list) else []
    normalized = {str(x).strip() for x in allow_list if str(x).strip()}
    if not normalized or "*" in normalized:
        return True
    path = str(skill_path or "").strip().replace("\\", "/")
    for pattern in normalized:
        p = pattern.replace("\\", "/").strip()
        if p.endswith("/*"):
            prefix = p[:-1]
            if prefix and prefix in path:
                return True
        if p and p in path:
            return True
    return False


def ensure_skill_install_allowed(
    current_tier_value: str,
    limits: dict,
    current_custom_skills: int,
    requires_tier: Optional[str] = None,
) -> None:
    normalized_current_tier = normalize_tier(current_tier_value)
    max_custom_skills = int((limits or {}).get("max_custom_skills", 5) or 5)
    if max_custom_skills >= 0 and current_custom_skills >= max_custom_skills:
        raise TierPermissionError(
            f"当前版本最多安装 {max_custom_skills} 个自定义 Skill，当前已达上限。请升级授权。"
        )
    required = normalize_tier((requires_tier or "").strip().lower())
    if required and tier_rank(normalized_current_tier) < tier_rank(required):
        raise TierPermissionError(f"该 Skill 需要 {required} 版本，当前为 {normalized_current_tier}。")
