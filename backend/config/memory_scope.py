from __future__ import annotations

import os
import re
from typing import Any, Mapping


_SCOPE_SANITIZE_RE = re.compile(r"[^a-z0-9._-]+")


def normalize_workspace_scope_id(workspace_path: str | None, fallback: str = "default") -> str:
    """将 workspace_path 归一化为稳定的 workspace scope id。"""
    raw = str(workspace_path or "").strip().lower().replace("\\", "/").rstrip("/")
    if not raw:
        return fallback
    normalized = _SCOPE_SANITIZE_RE.sub("_", raw).strip("._-")
    return normalized or fallback


def normalize_user_id(user_id: str | None, fallback: str = "default_user") -> str:
    raw = str(user_id or "").strip()
    if not raw:
        return fallback
    normalized = _SCOPE_SANITIZE_RE.sub("_", raw.lower()).strip("._-")
    return normalized or fallback


def resolve_memory_scope(configurable: Mapping[str, Any] | None) -> dict[str, Any]:
    cfg = dict(configurable or {})
    workspace_id = normalize_workspace_scope_id(
        str(cfg.get("workspace_id") or cfg.get("memory_workspace_id") or cfg.get("workspace_path") or "")
    )
    user_id = normalize_user_id(
        str(cfg.get("user_id") or cfg.get("langgraph_user_id") or os.environ.get("MAIBOT_USER_ID") or "")
    )
    shared_enabled = str(
        cfg.get("memory_shared_enabled", os.environ.get("MEMORY_SHARED_ENABLED", "false"))
    ).strip().lower() in {"1", "true", "yes", "on"}
    return {
        "workspace_id": workspace_id,
        "user_id": user_id,
        "memory_scope_mode": "workspace_isolated",
        "memory_shared_enabled": shared_enabled,
    }

