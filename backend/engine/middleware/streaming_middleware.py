"""Streaming Middleware: 注入 LangGraph config 中的 callbacks 到 LLM 调用。

langchain/agents/factory.py 的 _execute_model_async 调用 model_.ainvoke(messages)
时不传 config，导致外部注入的 callbacks（如 _TokenStreamHandler）无法收到
on_llm_new_token 回调。

本中间件通过 awrap_model_call 在 model 调用前，从 LangGraph contextvars 获取
当前 config 中的 callbacks，并通过 model.with_config() 注入到 model 实例中，
使 ainvoke 内部的 _should_stream 判断为 True，从而触发 token 级流式回调。
"""

from __future__ import annotations

import logging
from typing import Any, Awaitable, Callable

from langchain.agents.middleware.types import (
    AgentMiddleware,
    ModelRequest,
    ModelResponse,
)

logger = logging.getLogger(__name__)


class StreamingMiddleware(AgentMiddleware):
    """将 LangGraph config 中的 callbacks 注入到 LLM model 实例。Safe for singleton reuse; no per-request state. 流式仅支持异步 model 调用（awrap_model_call）；同步路径 wrap_model_call 不注入 callbacks。"""

    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelResponse]],
    ) -> ModelResponse:
        try:
            from langgraph.config import get_config
            config = get_config()
        except Exception as e:
            config = None
            logger.debug("[StreamingMiddleware] get_config 失败: %s", e)

        callbacks = None
        if config and isinstance(config, dict):
            callbacks = config.get("callbacks")
        if callbacks:
            model = request.model
            patched_model = model.with_config(callbacks=callbacks)
            # RunnableBinding 无 streaming 字段，设置会触发 Pydantic 校验报错；仅对非 Binding 的 runnable 设置
            is_binding = any(c.__name__ == "RunnableBinding" for c in type(patched_model).__mro__)
            if not is_binding:
                try:
                    if hasattr(patched_model, "streaming"):
                        setattr(patched_model, "streaming", True)
                except (ValueError, AttributeError, TypeError) as e:
                    logger.debug("[StreamingMiddleware] 跳过设置 streaming（%s）: %s", type(patched_model).__name__, e)
            request = request.override(model=patched_model)
            if logger.isEnabledFor(logging.DEBUG):
                logger.debug("[StreamingMiddleware] 已注入 callbacks 并设 streaming=True，handler 数=%s", len(callbacks) if isinstance(callbacks, list) else "?")
        else:
            if logger.isEnabledFor(logging.DEBUG):
                logger.debug("[StreamingMiddleware] 未注入 callbacks（config=%s, callbacks=%s）", type(config).__name__, "absent" if not callbacks else "empty")

        return await handler(request)

    def wrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], ModelResponse],
    ) -> ModelResponse:
        return handler(request)
