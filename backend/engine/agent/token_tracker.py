"""
Token 使用量追踪 - 从 LLM 响应中提取真实 token 统计

用于替换基于 tiktoken/估算的上下文统计，使前端显示真实每次调用的 token 消耗。
"""

import logging
from typing import Any, Dict, List

logger = logging.getLogger(__name__)

try:
    from langchain_core.callbacks import BaseCallbackHandler
    from langchain_core.outputs import LLMResult
except ImportError:
    BaseCallbackHandler = object  # type: ignore
    LLMResult = Any  # type: ignore


class TokenTrackingCallback(BaseCallbackHandler):
    """
    追踪单次 Run 内所有 LLM 调用的 token 使用量。
    在 on_llm_end 中从 LLMResult 提取 usage（prompt_tokens, completion_tokens），
    供 main_graph 在流式结束后发送 context_stats 时使用。
    """

    def __init__(self) -> None:
        self.total_prompt_tokens = 0
        self.total_completion_tokens = 0
        self.call_count = 0
        self._per_call: List[Dict[str, Any]] = []

    def on_llm_end(self, response: LLMResult, **kwargs: Any) -> None:
        """从 LLMResult 提取 token usage 并累加。"""
        try:
            # LLMResult 可能带有 llm_output["token_usage"]（OpenAI 等）
            usage = None
            if hasattr(response, "llm_output") and isinstance(response.llm_output, dict):
                usage = response.llm_output.get("token_usage") or response.llm_output.get("usage")
            if not usage and hasattr(response, "generations"):
                for gen_list in response.generations or []:
                    for gen in gen_list:
                        if hasattr(gen, "generation_info") and isinstance(gen.generation_info, dict):
                            u = gen.generation_info.get("usage") or gen.generation_info.get("token_usage")
                            if u:
                                usage = u
                                break
                    if usage:
                        break
            if usage and isinstance(usage, dict):
                pt = usage.get("prompt_tokens") or usage.get("input_tokens") or 0
                ct = usage.get("completion_tokens") or usage.get("output_tokens") or 0
                self.total_prompt_tokens += int(pt)
                self.total_completion_tokens += int(ct)
                self.call_count += 1
                self._per_call.append({"prompt_tokens": pt, "completion_tokens": ct})
        except Exception as e:
            logger.debug("TokenTrackingCallback.on_llm_end 解析失败: %s", e)

    def get_totals(self) -> Dict[str, Any]:
        """返回本 Run 累计的 token 统计。"""
        total = self.total_prompt_tokens + self.total_completion_tokens
        return {
            "prompt_tokens": self.total_prompt_tokens,
            "completion_tokens": self.total_completion_tokens,
            "total_tokens": total,
            "call_count": self.call_count,
        }

    def has_usage(self) -> bool:
        """是否有真实统计（至少一次 LLM 调用带 usage）。"""
        return self.call_count > 0 and (self.total_prompt_tokens > 0 or self.total_completion_tokens > 0)
