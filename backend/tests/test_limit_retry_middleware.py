"""Limit/Retry 中间件：实例化与 run_limit/max_retries 行为可断言。"""
import pytest

from langchain.agents.middleware import (
    ModelCallLimitMiddleware,
    ModelRetryMiddleware,
    ToolCallLimitMiddleware,
    ToolRetryMiddleware,
)


def test_model_call_limit_middleware_instantiate():
    """ModelCallLimitMiddleware 可实例化且 run_limit 生效。"""
    m = ModelCallLimitMiddleware(run_limit=2)
    assert m.run_limit == 2


def test_tool_call_limit_middleware_instantiate():
    """ToolCallLimitMiddleware 可实例化且 run_limit 生效。"""
    m = ToolCallLimitMiddleware(run_limit=10)
    assert m.run_limit == 10


def test_tool_retry_middleware_instantiate():
    """ToolRetryMiddleware 可实例化且 max_retries 生效。"""
    m = ToolRetryMiddleware(max_retries=3)
    assert m.max_retries == 3


def test_model_retry_middleware_instantiate():
    """ModelRetryMiddleware 可实例化且 max_retries 生效。"""
    m = ModelRetryMiddleware(max_retries=2)
    assert m.max_retries == 2
