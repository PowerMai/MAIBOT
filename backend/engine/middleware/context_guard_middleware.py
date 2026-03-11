"""
ContextGuardMiddleware：在 before_model 时预防性裁剪消息，避免「Context size exceeded」。

在 DeepAgent SummarizationMiddleware 之后作为兜底：若估算 token 数超过
SUMMARIZATION_TRIGGER_RATIO * context_length，则用 LangChain trim_messages 按「保留最近」策略
裁剪到安全范围，减少触及推理服务端硬限制的概率。

参照：LangChain trim_messages、DeepAgent SummarizationMiddleware、docs/CONTEXT_AND_MEMORY_SYSTEM_DESIGN.md
"""

from __future__ import annotations

import logging
import os
from typing import Any

from langchain.agents.middleware.types import AgentMiddleware, AgentState
from langchain_core.messages.utils import count_tokens_approximately, trim_messages
from langgraph.runtime import Runtime

logger = logging.getLogger(__name__)

_DEFAULT_CONTEXT_LENGTH = 65536
_TRIGGER_RATIO = float(os.getenv("SUMMARIZATION_TRIGGER_RATIO", "0.75"))
_TARGET_RATIO = 0.65  # 裁剪后目标占用比例，留出余量
_ENABLE_KEY = "ENABLE_CONTEXT_GUARD"


def _get_context_length(runtime: Runtime[Any]) -> int:
    try:
        ctx = getattr(runtime, "context", None)
        if isinstance(ctx, dict):
            cfg = ctx.get("configurable") or {}
            v = cfg.get("context_length")
            if v is not None:
                return int(v)
    except Exception:
        pass
    return _DEFAULT_CONTEXT_LENGTH


class ContextGuardMiddleware(AgentMiddleware):
    """在模型调用前按 token 预算裁剪消息，防止上下文超长。"""

    def __init__(
        self,
        trigger_ratio: float = _TRIGGER_RATIO,
        target_ratio: float = _TARGET_RATIO,
        default_context_length: int = _DEFAULT_CONTEXT_LENGTH,
    ) -> None:
        super().__init__()
        self._trigger_ratio = trigger_ratio
        self._target_ratio = target_ratio
        self._default_context_length = default_context_length

    def before_model(self, state: AgentState, runtime: Runtime[Any]) -> dict[str, Any] | None:
        if os.getenv(_ENABLE_KEY, "true").strip().lower() not in ("1", "true", "yes", "on"):
            return None
        messages = state.get("messages") or []
        if not messages or not isinstance(messages, list):
            return None
        try:
            context_length = _get_context_length(runtime) or self._default_context_length
            trigger_tokens = int(context_length * self._trigger_ratio)
            target_tokens = int(context_length * self._target_ratio)
            total = count_tokens_approximately(list(messages))
            if total <= trigger_tokens:
                return None
            trimmed = trim_messages(
                messages,
                max_tokens=target_tokens,
                token_counter="approximate",
                strategy="last",
                include_system=True,
                start_on="human",
            )
            if not isinstance(trimmed, list) or len(trimmed) == 0:
                return None
            logger.info(
                "[ContextGuard] 预防性裁剪: 约 %s -> %s tokens (context_length=%s)",
                total,
                count_tokens_approximately(trimmed),
                context_length,
            )
            return {"messages": trimmed}
        except Exception as e:
            logger.debug("[ContextGuard] 裁剪跳过: %s", e)
            return None
