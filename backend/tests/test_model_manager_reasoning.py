# 测试推理模型（qwen3.5 等）的 reasoning_content 流式透传：model_manager 对 delta.reasoning_content 与 <think> 的解析。
# 确保主通道能拿到 reasoning_content 并通过 type=reasoning 事件发给前端。

import pytest
from unittest.mock import patch, MagicMock

from langchain_core.messages import AIMessageChunk
from langchain_core.outputs import ChatGenerationChunk

from backend.engine.agent.model_manager import ModelManager, ModelConfig, ModelInfo


def _make_mock_llm():
    """返回带 _convert_chunk_to_generation_chunk 的 mock LLM，供 create_llm 打补丁用。"""
    def _orig(chunk, default_chunk_class, base_generation_info):
        choices = (chunk.get("choices") or []) or (chunk.get("chunk", {}).get("choices") or [])
        if not choices:
            return None
        delta = choices[0].get("delta") or {}
        content = delta.get("content") or ""
        msg = default_chunk_class(content=content, additional_kwargs={})
        return ChatGenerationChunk(message=msg, generation_info=base_generation_info or {})

    llm = MagicMock()
    llm._convert_chunk_to_generation_chunk = _orig
    return llm


def test_reasoning_model_delta_reasoning_content_injected():
    """路径 A：服务端返回 delta.reasoning_content 时，converter 应将其注入 message.additional_kwargs。"""
    with patch("langchain.chat_models.init_chat_model") as m_init:
        mock_llm = _make_mock_llm()
        m_init.return_value = mock_llm

        manager = ModelManager()
        manager._ensure_llm_cache_initialized = lambda: None
        manager._config = ModelConfig(
            models=[
                ModelInfo(
                    id="qwen3.5-9b",
                    name="Qwen3.5 9B",
                    description="",
                    url="http://localhost:1234/v1",
                    enabled=True,
                    available=True,
                    priority=0,
                    tier="local",
                    context_length=262144,
                    is_reasoning_model=True,
                    config={"enable_thinking": True, "max_tokens_default": 4096},
                ),
            ],
            default_model="qwen3.5-9b",
            subagent_model="same_as_main",
        )
        manager._rebuild_model_index()

        llm = manager.create_llm(config={"configurable": {"model": "qwen3.5-9b"}})
        assert llm is mock_llm
        convert = getattr(llm, "_convert_chunk_to_generation_chunk")
        assert callable(convert)

        chunk = {"choices": [{"delta": {"reasoning_content": "这是思考内容"}}]}
        out = convert(chunk, AIMessageChunk, {})
        assert out is not None
        assert getattr(out.message, "additional_kwargs", {}) or {}
        assert (out.message.additional_kwargs or {}).get("reasoning_content") == "这是思考内容"


def test_reasoning_model_think_tags_parsed():
    """路径 B：服务端在 content 中返回 <think>...</think> 时，converter 应拆出 reasoning 并清空 content。"""
    with patch("langchain.chat_models.init_chat_model") as m_init:
        mock_llm = _make_mock_llm()
        m_init.return_value = mock_llm

        manager = ModelManager()
        manager._ensure_llm_cache_initialized = lambda: None
        manager._config = ModelConfig(
            models=[
                ModelInfo(
                    id="qwen3.5-9b",
                    name="Qwen3.5 9B",
                    description="",
                    url="http://localhost:1234/v1",
                    enabled=True,
                    available=True,
                    priority=0,
                    tier="local",
                    context_length=262144,
                    is_reasoning_model=True,
                    config={"enable_thinking": True, "max_tokens_default": 4096},
                ),
            ],
            default_model="qwen3.5-9b",
            subagent_model="same_as_main",
        )
        manager._rebuild_model_index()

        llm = manager.create_llm(config={"configurable": {"model": "qwen3.5-9b"}})
        convert = llm._convert_chunk_to_generation_chunk

        chunk = {"choices": [{"delta": {"content": "<think>\n内部推理\n</think>\n最终回答"}}]}
        out = convert(chunk, AIMessageChunk, {})
        assert out is not None
        assert (out.message.additional_kwargs or {}).get("reasoning_content") == "\n内部推理\n"
        assert (out.message.content or "") == "\n最终回答"


def test_non_reasoning_model_no_converter_patch():
    """未开启 enable_thinking 或非推理模型时，不应挂载 reasoning_content 解析。"""
    with patch("langchain.chat_models.init_chat_model") as m_init:
        mock_llm = _make_mock_llm()
        m_init.return_value = mock_llm

        manager = ModelManager()
        manager._ensure_llm_cache_initialized = lambda: None
        manager._config = ModelConfig(
            models=[
                ModelInfo(
                    id="qwen3-coder-30b",
                    name="Qwen3 Coder",
                    description="",
                    url="http://localhost:1234/v1",
                    enabled=True,
                    available=True,
                    priority=0,
                    tier="local",
                    context_length=131072,
                    is_reasoning_model=True,
                    config={"max_tokens_default": 4096},  # 无 enable_thinking，本地默认 False
                ),
            ],
            default_model="qwen3-coder-30b",
            subagent_model="same_as_main",
        )
        manager._rebuild_model_index()

        llm = manager.create_llm(config={"configurable": {"model": "qwen3-coder-30b"}})
        convert = llm._convert_chunk_to_generation_chunk

        chunk = {"choices": [{"delta": {"reasoning_content": "不应注入"}}]}
        out = convert(chunk, AIMessageChunk, {})
        assert out is not None
        # 原始 mock 不会注入 reasoning_content，所以 additional_kwargs 仍为空
        assert (out.message.additional_kwargs or {}).get("reasoning_content") is None
