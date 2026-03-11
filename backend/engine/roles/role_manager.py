"""角色管理器（精简版）.

目标：
1. 以 `default` 通用角色为主，避免角色能力割裂。
2. 兼容旧角色 ID（assistant/analyst/...）并映射到 default。
3. 保留文件系统角色发现能力，供社区扩展场景使用。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
import uuid
from collections import OrderedDict
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx

logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parents[2]
CONFIG_PATH = PROJECT_ROOT / "config" / "roles.json"
AGENT_PROFILE_PATH = PROJECT_ROOT / "config" / "agent_profile.json"

try:
    from backend.tools.base.paths import ROLES_ROOT
except ImportError:
    ROLES_ROOT = PROJECT_ROOT / "knowledge_base" / "roles"

_roles_data: Optional[Dict[str, Any]] = None
_filesystem_roles_cache: Optional[Dict[str, Dict[str, Any]]] = None
_get_role_cache: OrderedDict[str, Optional[Dict[str, Any]]] = OrderedDict()
_cache_generation: int = 0
_roles_lock = threading.RLock()
ROLE_CACHE_MAX_SIZE = 200

@lru_cache(maxsize=1)
def _valid_skill_profiles() -> tuple[str, ...]:
    valid: set[str] = {"general", "full"}
    try:
        from backend.engine.skills.skill_profiles import load_profiles

        data = load_profiles()
        valid.update(
            str(k).strip().lower()
            for k in (data.get("profiles", {}) or {}).keys()
            if str(k).strip()
        )
    except Exception as e:
        logger.debug("读取 skill_profiles 失败，使用默认集合: %s", e)
    return tuple(valid)


def _normalize_role_skill_profile(skill_profile: Any, role_id: str = "") -> str:
    raw = str(skill_profile or "").strip().lower()
    valid = set(_valid_skill_profiles())
    if raw in valid:
        return raw
    try:
        from backend.engine.skills.skill_profiles import normalize_skill_profile

        normalized = normalize_skill_profile(raw)
    except Exception:
        normalized = {"document": "general", "dev": "full", "community": "general", "analytics": "general"}.get(raw, raw)
    if normalized in valid:
        return normalized
    if raw and normalized != "general":
        logger.warning("角色 skill_profile 非法，已回退为 general: role=%s, skill_profile=%s", role_id or "unknown", raw)
    return "general"


def _load_roles_impl(force: bool = False) -> Dict[str, Any]:
    """必须在已持有 _roles_lock 时调用。"""
    global _roles_data, _filesystem_roles_cache, _get_role_cache
    if _roles_data is not None and not force:
        return _roles_data
    if force:
        _filesystem_roles_cache = None
        _get_role_cache.clear()
        _valid_skill_profiles.cache_clear()
    if not CONFIG_PATH.exists():
        _roles_data = {"version": "1.0", "roles": {}, "aliases": {}}
        return _roles_data
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            data = {}
        if not isinstance(data.get("roles"), dict):
            data["roles"] = {}
        if not isinstance(data.get("aliases"), dict):
            data["aliases"] = {}
        _roles_data = data
    except Exception as e:
        logger.warning("加载 roles.json 失败: %s", e)
        _roles_data = {"version": "1.0", "roles": {}, "aliases": {}}
    return _roles_data


def _load_roles(force: bool = False) -> Dict[str, Any]:
    with _roles_lock:
        return _load_roles_impl(force)


def _discover_roles_from_filesystem_impl(force: bool = False) -> Dict[str, Dict[str, Any]]:
    """必须在已持有 _roles_lock 时调用。"""
    global _filesystem_roles_cache
    if _filesystem_roles_cache is not None and not force:
        return _filesystem_roles_cache
    result: Dict[str, Dict[str, Any]] = {}
    if not ROLES_ROOT.exists():
        _filesystem_roles_cache = result
        return result
    try:
        it = ROLES_ROOT.iterdir()
    except OSError as e:
        logger.debug("迭代角色目录失败 %s: %s", ROLES_ROOT, e)
        _filesystem_roles_cache = result
        return result
    for path in it:
        if not path.is_dir():
            continue
        role_id = path.name
        for name in ("config.json", "role.json"):
            cfg = path / name
            if not cfg.exists():
                continue
            try:
                with open(cfg, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if isinstance(data, dict) and data.get("label"):
                    result[role_id] = data
            except Exception as e:
                logger.debug("读取角色配置失败 %s: %s", cfg, e)
            break
    _filesystem_roles_cache = result
    return result


def _discover_roles_from_filesystem(force: bool = False) -> Dict[str, Dict[str, Any]]:
    with _roles_lock:
        return _discover_roles_from_filesystem_impl(force)


def _resolve_alias(role_id: str, aliases: Dict[str, Any]) -> str:
    rid = str(role_id or "").strip()
    if not rid:
        return "default"
    target = str(aliases.get(rid) or rid).strip()
    return target or "default"


# Debug/Review 互斥：按代码能力二选一，与 Cursor/Claude 对标（未启用代码能力时不强调 Debug）
CODING_ROLE_IDS = frozenset(
    {"coding_engineer", "developer", "software_engineer", "programmer"}
)


def _has_code_capability(role_id: str, role_cfg: Dict[str, Any]) -> bool:
    """角色是否启用代码能力：编码类 role id 或 capabilities 含 code_execution。"""
    rid = str(role_id or "").strip().lower()
    if rid in CODING_ROLE_IDS:
        return True
    caps = role_cfg.get("capabilities") or []
    if isinstance(caps, list):
        for c in caps:
            if isinstance(c, dict) and str(c.get("id") or "").strip().lower() == "code_execution":
                return True
    return False


def _normalize_modes_debug_review_exclusive(
    modes: List[str], role_id: str, role_cfg: Dict[str, Any]
) -> List[str]:
    """保证 modes 中至多包含 debug 与 review 其一；按代码能力保留。"""
    if not modes:
        return list(modes)
    has_debug = "debug" in modes
    has_review = "review" in modes
    if not has_debug or not has_review:
        return list(modes)
    keep_debug = _has_code_capability(role_id, role_cfg)
    out = [m for m in modes if m != "debug" and m != "review"]
    out.append("debug" if keep_debug else "review")
    return sorted(out, key=lambda x: ("agent", "ask", "plan", "debug", "review").index(x) if x in ("agent", "ask", "plan", "debug", "review") else 99)


def list_roles() -> List[Dict[str, Any]]:
    with _roles_lock:
        data = _load_roles_impl()
        roles_from_json = data.get("roles", {})
        fs = _discover_roles_from_filesystem_impl()
    # 合并逻辑（单一事实源）：同一 role_id 下，config/roles.json 优先，knowledge_base/roles/{id}/ 为扩展基底；JSON 中存在的字段覆盖文件系统发现结果。
    merged: Dict[str, Dict[str, Any]] = {}
    for rid in set(roles_from_json.keys()) | set(fs.keys()):
        merged[rid] = {**(fs.get(rid, {}) or {}), **(roles_from_json.get(rid, {}) or {})}
    if "default" not in merged:
        merged["default"] = {
            "label": "通用 Agent",
            "description": "默认通用角色",
            "skill_profile": "general",
            "tools": ["*"],
            "modes": ["agent", "ask", "plan", "review"],
            "knowledge_scopes": ["global", "domain", "learned", "users"],
        }
    for rid, cfg in merged.items():
        if not isinstance(cfg, dict):
            merged[rid] = {"label": str(rid), "skill_profile": "general"}
            continue
        cfg["skill_profile"] = _normalize_role_skill_profile(cfg.get("skill_profile"), rid)
        raw_modes = cfg.get("modes") or []
        if isinstance(raw_modes, list):
            cfg["modes"] = _normalize_modes_debug_review_exclusive(raw_modes, rid, cfg)
    return [{"id": rid, **cfg} for rid, cfg in sorted(merged.items(), key=lambda x: x[0])]


def get_role(role_id: str) -> Optional[Dict[str, Any]]:
    with _roles_lock:
        if role_id in _get_role_cache:
            _get_role_cache.move_to_end(role_id)
            return _get_role_cache[role_id]
        gen = _cache_generation
    data = _load_roles()
    aliases = data.get("aliases", {})
    resolved_id = _resolve_alias(role_id, aliases if isinstance(aliases, dict) else {})

    roles = {item["id"]: item for item in list_roles() if item.get("id")}
    role = roles.get(resolved_id)
    if role is None:
        role = roles.get("default")
    with _roles_lock:
        if _cache_generation != gen:
            return role
        if role_id in _get_role_cache:
            _get_role_cache.move_to_end(role_id)
            return _get_role_cache[role_id]
        if len(_get_role_cache) >= ROLE_CACHE_MAX_SIZE:
            _get_role_cache.popitem(last=False)
        _get_role_cache[role_id] = role
    return role


def apply_role(role_id: str) -> Optional[Dict[str, Any]]:
    role = get_role(role_id)
    if not role:
        return None
    if not AGENT_PROFILE_PATH.exists():
        logger.warning("agent_profile.json 不存在: %s", AGENT_PROFILE_PATH)
        return None
    active_id = str(role.get("id") or "default")
    with _roles_lock:
        try:
            with open(AGENT_PROFILE_PATH, "r", encoding="utf-8") as f:
                profile = json.load(f)
        except Exception as e:
            logger.warning("读取 agent_profile 失败: %s", e)
            return None
        profile["name"] = role.get("label", profile.get("name", ""))
        profile["description"] = role.get("description", profile.get("description", ""))
        profile["active_role_id"] = active_id
        profile["role_id"] = active_id
        profile["skill_profile"] = str(role.get("skill_profile") or "general").strip() or "general"
        if "capabilities" not in profile:
            profile["capabilities"] = {}
        profile["capabilities"]["domains"] = role.get("knowledge_scopes", [])
        profile["capabilities"]["modes"] = role.get("modes", ["agent", "ask"])
        try:
            from backend.engine.skills.skill_profiles import save_agent_profile

            save_agent_profile(profile)
        except Exception as e:
            logger.warning("写入 agent_profile 失败: %s", e)
            return None
        _get_role_cache.pop(role_id, None)
    return profile


async def apply_role_to_thread(thread_id: str, role_id: str) -> Optional[Dict[str, Any]]:
    role = await asyncio.to_thread(get_role, role_id)
    if not role:
        return None
    tid = str(thread_id or "").strip()
    if not tid:
        return None
    try:
        uuid.UUID(tid)
    except (ValueError, TypeError):
        raise ValueError("thread_id 必须是有效的 UUID 格式")

    active_id = str(role.get("id") or "default")
    api_url = os.environ.get("LANGGRAPH_API_URL", "http://127.0.0.1:2024").rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{api_url}/threads/{tid}")
            if resp.status_code != 200:
                logger.warning("线程 GET 非 200 thread_id=%s status_code=%s", tid, resp.status_code)
                return None
            thread_data = resp.json() or {}
            metadata = dict(thread_data.get("metadata") or {})
            metadata["active_role_id"] = active_id
            metadata["role_id"] = active_id
            metadata["skill_profile"] = str(role.get("skill_profile") or "general").strip() or "general"
            patch_resp = await client.patch(f"{api_url}/threads/{tid}", json={"metadata": metadata})
            if patch_resp.status_code != 200:
                logger.warning("线程 PATCH 非 200 thread_id=%s status_code=%s", tid, patch_resp.status_code)
                return None
            patched = patch_resp.json() or {}
            return dict(patched.get("metadata") or metadata)
    except Exception as e:
        logger.warning("线程级应用角色失败 thread_id=%s role_id=%s: %s", tid, active_id, e)
        return None


def reload_roles() -> None:
    global _roles_data, _filesystem_roles_cache, _cache_generation
    with _roles_lock:
        _roles_data = None
        _filesystem_roles_cache = None
        _get_role_cache.clear()
        _cache_generation += 1
        _valid_skill_profiles.cache_clear()
    logger.debug("角色缓存已清除")


class RoleManager:
    def list_roles(self) -> List[Dict[str, Any]]:
        return list_roles()

    def get_role(self, role_id: str) -> Optional[Dict[str, Any]]:
        return get_role(role_id)

    def apply_role(self, role_id: str) -> Optional[Dict[str, Any]]:
        return apply_role(role_id)

    async def apply_role_to_thread(self, thread_id: str, role_id: str) -> Optional[Dict[str, Any]]:
        return await apply_role_to_thread(thread_id, role_id)

    def reload(self) -> None:
        reload_roles()


_role_manager: RoleManager = RoleManager()


def get_role_manager() -> RoleManager:
    return _role_manager
