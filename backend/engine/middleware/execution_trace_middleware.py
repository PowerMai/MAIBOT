from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any

from langchain.agents.middleware.types import AgentMiddleware, ModelRequest, ToolCallRequest


class ExecutionTraceMiddleware(AgentMiddleware):
    """记录关键执行轨迹，便于排查中间件链路与工具执行顺序。Safe for singleton reuse; no per-request state."""

    def __init__(self) -> None:
        super().__init__()
        self.enabled = str(os.getenv("ENABLE_MIDDLEWARE_TRACE", "false")).lower() in {"1", "true", "yes", "on"}

    @staticmethod
    def _append_trace(state: dict[str, Any] | None, event: str, detail: dict[str, Any] | None = None) -> None:
        if state is None:
            return
        trace = state.get("middleware_trace")
        if not isinstance(trace, list):
            trace = []
        trace.append(
            {
                "ts": datetime.now(timezone.utc).isoformat(),
                "event": event,
                "detail": detail or {},
            }
        )
        # 仅保留最近 80 条，避免状态膨胀
        state["middleware_trace"] = trace[-80:]

    @staticmethod
    def _extract_correlation(request: Any) -> dict[str, Any]:
        config = getattr(request, "config", {}) or {}
        configurable = config.get("configurable", {}) if isinstance(config, dict) else {}
        state = getattr(request, "state", {}) or {}
        model_id = None
        try:
            model = getattr(request, "model", None)
            model_id = getattr(model, "model_name", None) or getattr(model, "model", None)
        except Exception:
            model_id = None
        return {
            "thread_id": configurable.get("thread_id") or state.get("thread_id"),
            "run_id": configurable.get("run_id") or state.get("run_id"),
            "request_id": configurable.get("request_id") or state.get("request_id"),
            "model_id": configurable.get("model") or model_id,
        }

    async def wrap_model_call(self, request: ModelRequest, handler):
        if self.enabled:
            self._append_trace(request.state, "model_call_before", self._extract_correlation(request))
        result = await handler(request)
        if self.enabled:
            self._append_trace(request.state, "model_call_after", self._extract_correlation(request))
        return result

    async def wrap_tool_call(self, request: ToolCallRequest, handler):
        if self.enabled:
            tool_call = getattr(request, "tool_call", {}) or {}
            detail = self._extract_correlation(request)
            detail.update({"name": str(tool_call.get("name") or ""), "id": str(tool_call.get("id") or "")})
            self._append_trace(
                getattr(request, "state", None),
                "tool_call_before",
                detail,
            )
        result = await handler(request)
        if self.enabled:
            tool_call = getattr(request, "tool_call", {}) or {}
            detail = self._extract_correlation(request)
            detail.update({"name": str(tool_call.get("name") or ""), "id": str(tool_call.get("id") or "")})
            self._append_trace(
                getattr(request, "state", None),
                "tool_call_after",
                detail,
            )
        return result

    async def awrap_model_call(self, request: ModelRequest, handler):
        return await self.wrap_model_call(request, handler)

    async def awrap_tool_call(self, request: ToolCallRequest, handler):
        return await self.wrap_tool_call(request, handler)
