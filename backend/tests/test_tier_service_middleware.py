"""许可层中间件过滤：REQUIRED_MIDDLEWARE_NAMES 始终放行，不受 allow_middleware 限制。"""
import pytest
from backend.engine.license.tier_service import (
    REQUIRED_MIDDLEWARE_NAMES,
    is_middleware_allowed,
    _tier_profile,
)


def test_required_middleware_always_allowed_even_when_allow_list_empty():
    """free tier 的 allow_middleware 为 [] 时，required 中间件仍应放行。"""
    profile = _tier_profile({"tier": "free"}) or {}
    allow = profile.get("allow_middleware")
    allow_list = allow if isinstance(allow, list) else []
    # free 默认 allow_middleware 可能为 [] 或配置覆盖
    for name in REQUIRED_MIDDLEWARE_NAMES:
        assert is_middleware_allowed(name, {"tier": "free"}) is True, f"required middleware {name!r} should be allowed"
    assert is_middleware_allowed("streaming", None) is True
    assert is_middleware_allowed("license_gate", {}) is True


def test_non_required_middleware_respects_allow_list():
    """非 required 中间件在 allow_middleware=[] 时不应放行（free）。"""
    profile = _tier_profile({"tier": "free"}) or {}
    allow = profile.get("allow_middleware")
    if isinstance(allow, list) and "*" not in allow and len(allow) == 0:
        assert is_middleware_allowed("skill_evolution", {"tier": "free"}) is False
    # pro/max 有 "*" 则任意放行
    assert is_middleware_allowed("skill_evolution", {"tier": "pro"}) is True
