"""
用户级文件版本（P3）- Store 快照

将工作区文件的快照写入 LangGraph Store，供回退。命名空间见 store_namespaces.ns_file_versions。
Key 格式：path::timestamp_iso，便于按 path 前缀列出。
"""

import hashlib
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

_KEY_SEP = "::"
_MAX_VERSIONS_PER_FILE = 50


def _workspace_scope(workspace_path: Optional[str]) -> str:
    if workspace_path and str(workspace_path).strip():
        p = Path(workspace_path).resolve()
        return hashlib.sha256(str(p).encode("utf-8")).hexdigest()[:16]
    return "default"


def _make_key(path: str, ts: Optional[datetime] = None) -> str:
    ts = ts or datetime.now(timezone.utc)
    ts_str = ts.strftime("%Y%m%dT%H%M%SZ")
    path_n = (path or "").strip().lstrip("/")
    return f"{path_n}{_KEY_SEP}{ts_str}"


def save_file_version(
    store: Any,
    workspace_path: Optional[str],
    path: str,
    content: str,
    description: str = "",
) -> Dict[str, Any]:
    """将文件内容写入 Store 作为快照。返回 { key, path, ts }。"""
    from backend.config.store_namespaces import ns_file_versions

    scope = _workspace_scope(workspace_path)
    ns = ns_file_versions(scope)
    ts = datetime.now(timezone.utc)
    key = _make_key(path, ts)
    value = {
        "path": path.strip().lstrip("/"),
        "content": content,
        "ts": ts.isoformat(),
        "description": (description or "").strip()[:500],
    }
    try:
        store.put(ns, key, value)
    except Exception as e:
        logger.warning("file_version_store save: %s", e)
        raise
    return {"key": key, "path": value["path"], "ts": value["ts"]}


def list_file_versions(
    store: Any,
    workspace_path: Optional[str],
    path: str,
    limit: int = 50,
) -> List[Dict[str, Any]]:
    """列出某文件的快照列表，按时间倒序。path 为工作区相对路径。"""
    from backend.config.store_namespaces import ns_file_versions

    scope = _workspace_scope(workspace_path)
    ns = ns_file_versions(scope)
    path_prefix = (path or "").strip().lstrip("/")
    prefix = path_prefix + _KEY_SEP
    out: List[Dict[str, Any]] = []
    try:
        keys = list(store.list(ns))
    except Exception as e:
        logger.debug("file_version_store list keys: %s", e)
        return []
    for k in keys:
        if not isinstance(k, str) or not k.startswith(prefix):
            continue
        try:
            val = store.get(ns, k)
            if isinstance(val, dict):
                out.append({"key": k, "path": val.get("path"), "ts": val.get("ts"), "description": val.get("description", "")})
        except Exception:
            continue
    out.sort(key=lambda x: x.get("ts") or "", reverse=True)
    return out[:limit]


def get_file_version(
    store: Any,
    workspace_path: Optional[str],
    key: str,
) -> Optional[Dict[str, Any]]:
    """按 key 取一条快照（含 content）。"""
    from backend.config.store_namespaces import ns_file_versions

    scope = _workspace_scope(workspace_path)
    ns = ns_file_versions(scope)
    try:
        val = store.get(ns, key)
        if isinstance(val, dict):
            return val
    except Exception as e:
        logger.debug("file_version_store get: %s", e)
    return None


def prune_old_versions(store: Any, workspace_path: Optional[str], path: str, keep: int = _MAX_VERSIONS_PER_FILE) -> int:
    """保留每个文件最近 keep 条，删除更旧的。返回删除条数。"""
    from backend.config.store_namespaces import ns_file_versions

    scope = _workspace_scope(workspace_path)
    ns = ns_file_versions(scope)
    path_prefix = (path or "").strip().lstrip("/")
    prefix = path_prefix + _KEY_SEP
    keys = [k for k in (list(store.list(ns)) or []) if isinstance(k, str) and k.startswith(prefix)]
    if len(keys) <= keep:
        return 0
    keys.sort(reverse=True)
    to_del = keys[keep:]
    deleted = 0
    for k in to_del:
        try:
            if hasattr(store, "delete"):
                store.delete(ns, k)
                deleted += 1
        except Exception as e:
            logger.debug("file_version_store delete: %s", e)
    return deleted
