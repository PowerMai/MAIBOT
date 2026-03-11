"""Streaming middleware: 从 get_config 取 callbacks 并注入到 model。"""
import asyncio
from unittest.mock import MagicMock, patch

from backend.engine.middleware.streaming_middleware import StreamingMiddleware


def test_streaming_middleware_injects_callbacks_when_config_has_callbacks():
    """当 get_config() 返回含 callbacks 的 config 时，request.model 被替换为带 callbacks 的实例。"""
    from langchain.agents.middleware.types import ModelRequest, ModelResponse

    cb = MagicMock()
    config = {"callbacks": [cb]}
    fake_model = MagicMock()
    patched_model = MagicMock()
    fake_model.with_config.return_value = patched_model

    async def run():
        with patch("langgraph.config.get_config", side_effect=lambda: config):
            req = ModelRequest(model=fake_model, messages=[])
            captured_request = None

            async def handler(r):
                nonlocal captured_request
                captured_request = r
                return ModelResponse(result=MagicMock())

            m = StreamingMiddleware()
            await m.awrap_model_call(req, handler)
        return captured_request

    captured_request = asyncio.run(run())
    assert captured_request is not None
    assert getattr(captured_request, "model", None) is patched_model
    fake_model.with_config.assert_called_once()
    call_kw = fake_model.with_config.call_args[1]
    assert "callbacks" in call_kw
    assert call_kw["callbacks"] == [cb]


def test_streaming_middleware_no_config_calls_handler_unchanged():
    """当 get_config 失败或无 callbacks 时，仍调用 handler，不替换 model。"""
    from langchain.agents.middleware.types import ModelRequest, ModelResponse

    fake_model = MagicMock()
    req = ModelRequest(model=fake_model, messages=[])

    async def run():
        with patch("langgraph.config.get_config", return_value=None):
            captured = None

            async def handler(r):
                nonlocal captured
                captured = r
                return ModelResponse(result=MagicMock())

            m = StreamingMiddleware()
            await m.awrap_model_call(req, handler)
        return captured

    captured = asyncio.run(run())
    assert captured is not None
    assert captured.model is fake_model
    fake_model.with_config.assert_not_called()
