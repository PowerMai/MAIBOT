"""configurable 必含字段校验（开发/测试环境）。

与 INTEGRATION_CONTRACTS §2、domain-model.mdc 一致：run 时 configurable 应含
thread_id、mode、role_id 或 active_role_id、workspace_path。
仅在开发/测试环境打 log warning，不阻断请求。
"""
from __future__ import annotations

import logging
import os
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

_REQUIRED_KEYS = ("thread_id", "mode", "workspace_path")
_ROLE_KEYS = ("role_id", "active_role_id")


def _is_dev_or_test() -> bool:
    if os.getenv("APP_ENV", "production") == "development":
        return True
    try:
        import sys
        if "pytest" in sys.modules or any("pytest" in str(a) for a in (getattr(sys, "argv", []) or [])):
            return True
    except Exception:
        pass
    return False


def validate_configurable(config: Optional[Any]) -> None:
    """校验 config.configurable 必含字段；缺则在开发/测试环境打 warning。不抛异常。"""
    if not _is_dev_or_test():
        return
    if not config or not isinstance(config, dict):
        return
    cfg = config.get("configurable")
    if not cfg or not isinstance(cfg, dict):
        logger.warning("[configurable] 开发/测试环境：config.configurable 缺失或非 dict，建议含 thread_id、mode、role_id/active_role_id、workspace_path")
        return
    missing = [k for k in _REQUIRED_KEYS if not str(cfg.get(k) or "").strip()]
    if not any(str(cfg.get(k) or "").strip() for k in _ROLE_KEYS):
        missing.append("role_id 或 active_role_id")
    if missing:
        logger.warning("[configurable] 开发/测试环境：缺少 %s，建议前端在 config 中传入", missing)
