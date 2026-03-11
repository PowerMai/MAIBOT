from __future__ import annotations

import os
import time
import json
from typing import Any

from langchain.agents.middleware.types import AgentMiddleware, ModelRequest


_DEFAULT_BUDGET_USD = float(os.getenv("MAX_BUDGET_PER_TASK_USD", "1.0"))
_MODEL_COST_PER_1K = {}
try:
    raw_price = str(os.getenv("MODEL_COST_PER_1K_JSON", "") or "").strip()
    if raw_price:
        loaded = json.loads(raw_price)
        if isinstance(loaded, dict):
            _MODEL_COST_PER_1K = {str(k): float(v) for k, v in loaded.items()}
except Exception:
    _MODEL_COST_PER_1K = {}


class SchedulingGuardMiddleware(AgentMiddleware):
    """统一调度信号与轻量预算守卫，减少分散实现。"""

    @staticmethod
    def _queue_wait_ms(enqueued_at: Any) -> int:
        try:
            if isinstance(enqueued_at, (int, float)):
                return max(0, int(time.time() * 1000) - int(enqueued_at))
            if isinstance(enqueued_at, str) and enqueued_at.strip():
                from datetime import datetime, timezone
                ts = datetime.fromisoformat(enqueued_at.strip().replace("Z", "+00:00"))
                if ts.tzinfo is None:
                    ts = ts.replace(tzinfo=timezone.utc)
                return max(0, int((datetime.now(timezone.utc) - ts).total_seconds() * 1000))
        except Exception:
            return 0
        return 0

    @staticmethod
    def _step_cost_usd(cost_tier: str, configurable: dict[str, Any]) -> float:
        fallback = {
            "zero": 0.0,
            "low": 0.002,
            "medium": 0.01,
            "high": 0.03,
        }.get(str(cost_tier or "medium").lower(), 0.01)
        model_id = str(
            configurable.get("resolved_model_id")
            or configurable.get("actual_model_id")
            or configurable.get("model")
            or ""
        ).strip()
        if not model_id:
            return fallback
        per_1k = _MODEL_COST_PER_1K.get(model_id)
        if per_1k is None:
            return fallback
        est_tokens = max(1.0, float(configurable.get("estimated_tokens_per_step", 1200) or 1200))
        return max(0.0, float(per_1k) * (est_tokens / 1000.0))

    async def wrap_model_call(self, request: ModelRequest, handler):
        config = getattr(request, "config", {}) or {}
        configurable = config.get("configurable", {}) if isinstance(config, dict) else {}
        state = getattr(request, "state", None)
        if isinstance(state, dict):
            queue_wait_ms = int(configurable.get("queue_wait_ms") or 0)
            if queue_wait_ms <= 0:
                queue_wait_ms = self._queue_wait_ms(configurable.get("request_enqueued_at"))
            state["queue_wait_ms"] = max(0, queue_wait_ms)
            if isinstance(configurable, dict):
                configurable["queue_wait_ms"] = state["queue_wait_ms"]

            budget_max = configurable.get("budget_max_usd")
            if budget_max is None:
                budget_max = _DEFAULT_BUDGET_USD
            try:
                budget_limit = max(0.0, float(budget_max))
            except (TypeError, ValueError):
                budget_limit = _DEFAULT_BUDGET_USD
            spent = max(0.0, float(state.get("_budget_estimated_usd", 0.0) or 0.0))
            if budget_limit > 0 and spent > budget_limit:
                raise RuntimeError(f"budget_guard_exceeded: spent={spent:.4f} limit={budget_limit:.4f}")
        try:
            result = await handler(request)
        except Exception:
            if isinstance(state, dict):
                state["retry_count"] = int(state.get("retry_count", 0) or 0) + 1
                if isinstance(configurable, dict):
                    configurable["retry_count"] = int(state["retry_count"])
            raise
        if isinstance(state, dict):
            tier = str(configurable.get("cost_tier", "medium") or "medium")
            step_cost = self._step_cost_usd(tier, configurable if isinstance(configurable, dict) else {})
            state["_budget_estimated_usd"] = float(state.get("_budget_estimated_usd", 0.0) or 0.0) + step_cost
        return result

    async def awrap_model_call(self, request: ModelRequest, handler):
        return await self.wrap_model_call(request, handler)

