"""
用户画像 API：GET/PUT /agent/user-model；结晶建议 GET /agent/crystallization-suggestion（含工作区建议，统一由 CrystallizationToast 展示）。

持久化用户画像（UserProfile）的读写，命名空间按 workspace_id 隔离。
蒸馏质量门通过时写入结晶建议；idle 循环检测到工作区变更时写入工作区建议，同一端点返回。
"""
from __future__ import annotations

import logging
import os
from typing import Any, Dict, List, Optional

from pydantic import BaseModel
from fastapi import APIRouter, Depends, HTTPException, Query

from backend.api.deps import verify_internal_token


def _safe_error_detail(e: Exception) -> str:
    """生产环境不暴露内部异常详情，仅开发环境返回 str(e)。"""
    if os.getenv("APP_ENV", "production") == "development":
        return str(e)
    return "内部服务器错误"


from backend.engine.idle.idle_loop import get_and_clear_copilot_suggestion
from backend.engine.middleware.distillation_middleware import get_crystallization_suggestion
from backend.memory.user_model import (
    UserProfile,
    get_user_profile,
    save_user_profile,
    update_user_profile,
)

router = APIRouter(tags=["agent-user-model"])
logger = logging.getLogger(__name__)


class UserProfileUpdateBody(BaseModel):
    """PUT /agent/user-model 请求体白名单，仅允许更新以下字段。"""
    expertise_areas: Optional[Dict[str, str]] = None
    communication_style: Optional[str] = None
    detail_level: Optional[str] = None
    domain_expertise: Optional[str] = None
    decision_patterns: Optional[List[str]] = None
    unsolved_intents: Optional[List[Dict[str, Any]]] = None
    learning_trajectory: Optional[List[str]] = None
    custom_rules: Optional[List[str]] = None
    last_updated: Optional[str] = None


def _get_store():
    try:
        from backend.engine.core.main_graph import get_sqlite_store
        return get_sqlite_store()
    except Exception as e:
        logger.debug("get_sqlite_store: %s", e)
        return None


# 未接入 record_task_* 写入钩子前，不在 API 中返回杠杆率相关字段，避免展示恒为 0 的虚假指标
_PROFILE_RESPONSE_EXCLUDE = {"ai_leverage_score", "iteration_patterns", "tool_breadth"}


def _profile_for_response(profile_dict: Dict[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in profile_dict.items() if k not in _PROFILE_RESPONSE_EXCLUDE}


@router.get("/agent/user-model")
async def get_agent_user_model(
    workspace_id: Optional[str] = Query(None, description="工作区 ID，默认 default"),
    _: None = Depends(verify_internal_token),
):
    """读取当前工作区的用户画像。杠杆率相关字段在写入钩子接入前不返回。"""
    try:
        store = _get_store()
        if store is None:
            raise HTTPException(status_code=503, detail="Store 不可用")
        ws = (workspace_id or "").strip() or "default"
        profile = get_user_profile(store, ws)
        return {
            "ok": True,
            "profile": _profile_for_response(profile.to_dict()),
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("get_agent_user_model: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


@router.put("/agent/user-model")
async def put_agent_user_model(
    body: UserProfileUpdateBody,
    workspace_id: Optional[str] = Query(None, description="工作区 ID，默认 default"),
    _: None = Depends(verify_internal_token),
):
    """更新用户画像（部分或全量）。body 中仅需包含要更新的字段。"""
    try:
        store = _get_store()
        if store is None:
            raise HTTPException(status_code=503, detail="Store 不可用")
        ws = (workspace_id or "").strip() or "default"
        updates = body.model_dump(exclude_none=True)
        if not updates:
            return {"ok": True, "profile": _profile_for_response(get_user_profile(store, ws).to_dict())}
        profile = update_user_profile(store, ws, updates)
        if profile is None:
            raise HTTPException(status_code=500, detail="更新失败")
        return {"ok": True, "profile": _profile_for_response(profile.to_dict())}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("put_agent_user_model: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


@router.get("/agent/crystallization-suggestion")
async def get_crystallization_suggestion_api(
    thread_id: Optional[str] = Query(None, description="当前 thread_id"),
    workspace_id: Optional[str] = Query(None, description="工作区 ID 或路径，用于拉取工作区建议"),
    _: None = Depends(verify_internal_token),
):
    """获取并消费结晶建议（thread）与工作区建议（idle 检测到变更时写入）。统一由前端 CrystallizationToast 展示。"""
    try:
        suggestion = None
        if (thread_id or "").strip():
            suggestion = get_crystallization_suggestion((thread_id or "").strip())
        workspace_suggestion = None
        ws = (workspace_id or "").strip() or "default"
        workspace_suggestion = get_and_clear_copilot_suggestion(ws)
        return {"ok": True, "suggestion": suggestion, "workspace_suggestion": workspace_suggestion}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("get_crystallization_suggestion: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))
