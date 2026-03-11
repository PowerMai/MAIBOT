"""
API 层共享依赖：供各 router 使用，避免与 app 循环引用。
"""
import hmac
import logging
import os
import time
from pathlib import Path
from typing import Dict, Any, Tuple

logger = logging.getLogger(__name__)

_API_TIER_CACHE_TTL = 60.0
_api_tier_cache: Tuple[float, str] = (0.0, "")

from fastapi import Request, HTTPException
from backend.tools.base.paths import get_project_root


VALID_BOARD_SCOPES = ("personal", "org", "public")


_LOOPBACK_HOSTS = ("127.0.0.1", "::1", "testclient")


def verify_internal_token(request: Request) -> None:
    """校验内部 API：接受 X-Internal-Token 或 Authorization: Bearer 与 INTERNAL_API_TOKEN 一致。
    未配置 INTERNAL_API_TOKEN 时，仅允许来自 loopback（127.0.0.1、::1）或无 client（如 TestClient）的请求，便于本地零配置开发与测试。"""
    token = os.environ.get("INTERNAL_API_TOKEN", "").strip()
    if not token:
        client_host = getattr(request.client, "host", None) if request.client else None
        if client_host is None or client_host in _LOOPBACK_HOSTS:
            return
        raise HTTPException(
            status_code=401,
            detail="INTERNAL_API_TOKEN not configured; internal API requires authentication or loopback access",
        )
    internal_header = (request.headers.get("X-Internal-Token") or "").strip()
    auth_header = (request.headers.get("Authorization") or "").strip()
    bearer = auth_header.startswith("Bearer ") and (auth_header[7:].strip() or "")
    if hmac.compare_digest(internal_header, token) or (bearer and hmac.compare_digest(bearer, token)):
        return
    raise HTTPException(status_code=401, detail="invalid or missing internal token")


def get_api_project_root() -> Path:
    """与 app.PROJECT_ROOT 一致的应用根目录。"""
    return get_project_root()


def get_api_current_tier() -> str:
    """与 app._current_tier() 一致的当前许可档位，供 router 使用。TTL 缓存 60 秒。"""
    global _api_tier_cache
    now = time.monotonic()
    if _api_tier_cache[0] > 0 and (now - _api_tier_cache[0]) < _API_TIER_CACHE_TTL:
        return _api_tier_cache[1]
    from backend.engine.license.tier_service import current_tier
    path = get_project_root() / "data" / "license.json"
    fallback: Dict[str, Any] = {
        "tier": "free",
        "limits": {"max_custom_skills": 5, "max_mcp_connections": 2, "max_daily_autonomous_tasks": 10},
    }
    tier = "free"
    if path.exists():
        import json
        try:
            profile = json.loads(path.read_text(encoding="utf-8"))
            tier = current_tier(profile)
        except Exception as e:
            logger.warning("license.json 解析失败，降级为 free tier: %s", e)
    else:
        tier = current_tier(fallback)
    _api_tier_cache = (now, tier)
    return tier
