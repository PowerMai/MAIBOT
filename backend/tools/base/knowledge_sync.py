"""
知识库云端同步 - 基于 LangGraph Store namespace 的增量缓存与 TTL

Namespace 约定：
- local/{user_id}/{domain}: 本地缓存（云端知识拉取后的缓存）
- sync/{user_id}/{domain}: 同步状态（last_sync_ts, cloud_version）
- 云端数据源由 CloudKnowledgeProvider 抽象，默认 stub 实现

策略：增量缓存 + 30 天 TTL；断网使用本地缓存并标记「可能过期」。
"""

import json
import logging
import time
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# 缓存默认 TTL（秒），30 天
DEFAULT_CACHE_TTL_SECONDS = 30 * 24 * 3600


def _ns_local(user_id: str, domain: str) -> tuple:
    return ("local", user_id, domain)


def _ns_sync(user_id: str, domain: str) -> tuple:
    return ("sync", user_id, domain)


class CloudKnowledgeProvider:
    """云端知识提供方抽象。默认 stub：无网络时返回空。"""

    def fetch_domain(self, domain: str) -> List[Dict[str, Any]]:
        """从云端拉取指定领域的知识条目。返回 [{"id", "content", "source", "updated_at"}, ...]。"""
        return []

    def is_available(self) -> bool:
        """是否可访问云端（网络与配置）。"""
        return False


def get_sync_status(store: Any, user_id: str, domain: str) -> Dict[str, Any]:
    """
    获取指定用户、领域的同步状态。
    返回: { "last_sync_ts": int | None, "cloud_version": str | None, "expired": bool, "cached": bool }
    """
    try:
        ns = _ns_sync(user_id, domain)
        meta_raw = None
        if hasattr(store, "get"):
            meta_raw = store.get(ns, "meta")
        if meta_raw is None and hasattr(store, "list"):
            items = list(store.list(ns))
            for item in (items or []):
                if getattr(item, "key", None) == "meta" or (isinstance(item, dict) and item.get("key") == "meta"):
                    meta_raw = item.get("value") if isinstance(item, dict) else getattr(item, "value", None)
                    break
        if meta_raw is None:
            return {
                "last_sync_ts": None,
                "cloud_version": None,
                "expired": True,
                "cached": False,
            }
        meta = meta_raw
        if isinstance(meta, str):
            meta = json.loads(meta)
        if not meta:
            return {"last_sync_ts": None, "cloud_version": None, "expired": True, "cached": False}
        last = meta.get("last_sync_ts") or 0
        now = int(time.time())
        expired = (now - last) > DEFAULT_CACHE_TTL_SECONDS
        local_ns = _ns_local(user_id, domain)
        local_raw = None
        if hasattr(store, "get"):
            local_raw = store.get(local_ns, "data")
        cached = local_raw is not None
        return {
            "last_sync_ts": last,
            "cloud_version": meta.get("cloud_version"),
            "expired": expired,
            "cached": cached,
        }
    except Exception as e:
        logger.warning("get_sync_status failed: %s", e)
        return {"last_sync_ts": None, "cloud_version": None, "expired": True, "cached": False}


def sync_domain(
    store: Any,
    user_id: str,
    domain: str,
    provider: Optional[CloudKnowledgeProvider] = None,
) -> Dict[str, Any]:
    """
    从云端同步指定领域到本地缓存并更新同步状态。
    返回: { "success": bool, "message": str, "entries_count": int }
    """
    provider = provider or CloudKnowledgeProvider()
    if not provider.is_available():
        return {"success": False, "message": "云端不可用", "entries_count": 0}
    try:
        entries = provider.fetch_domain(domain)
        ns_local = _ns_local(user_id, domain)
        ns_sync = _ns_sync(user_id, domain)
        payload = json.dumps({"entries": entries, "domain": domain}, ensure_ascii=False)
        meta = json.dumps({"last_sync_ts": int(time.time()), "cloud_version": str(len(entries))}, ensure_ascii=False)
        if hasattr(store, "put"):
            store.put(ns_local, "data", payload)
            store.put(ns_sync, "meta", meta)
        elif hasattr(store, "write"):
            store.write(ns_local, "data", payload)
            store.write(ns_sync, "meta", meta)
        return {"success": True, "message": "同步成功", "entries_count": len(entries)}
    except Exception as e:
        logger.exception("sync_domain failed")
        return {"success": False, "message": str(e), "entries_count": 0}


def get_cached_knowledge(
    store: Any,
    user_id: str,
    domain: str,
    query: Optional[str] = None,
) -> Dict[str, Any]:
    """
    从本地缓存读取知识；若缓存过期则返回时带 warning。
    返回: { "entries": [...], "expired": bool, "warning": str | None }
    """
    status = get_sync_status(store, user_id, domain)
    try:
        ns = _ns_local(user_id, domain)
        raw = None
        if hasattr(store, "get"):
            raw = store.get(ns, "data")
        if raw is None:
            return {"entries": [], "expired": status["expired"], "warning": "无本地缓存" if status["expired"] else None}
        if isinstance(raw, str):
            raw = json.loads(raw)
        entries = (raw or {}).get("entries") or []
        warning = None
        if status["expired"]:
            warning = "知识库缓存已过期（超过 30 天），建议联网刷新"
        return {"entries": entries, "expired": status["expired"], "warning": warning}
    except Exception as e:
        logger.warning("get_cached_knowledge failed: %s", e)
        return {"entries": [], "expired": True, "warning": str(e)}
