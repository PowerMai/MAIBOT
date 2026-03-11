"""
Token 估算工具 - 供 main_graph、API 等统一使用

系统提示词（orchestrator + tool_strategy + memory + bundle + 中间件 + user_context）
实际约 3000~5000 tokens，默认取 3500 便于前端显示接近真实值。
"""

# 默认系统提示词 token 数（与 agent_prompts + tool_strategy + memory + BUNDLE + 中间件 一致）
DEFAULT_SYSTEM_PROMPT_TOKENS = 3500


def estimate_tokens(text: str) -> int:
    """估算文本 token 数（无 tiktoken 时使用，与 API _count_tokens 回退逻辑一致）"""
    if not text:
        return 0
    cn_chars = sum(1 for c in text if "\u4e00" <= c <= "\u9fff")
    en_chars = len(text) - cn_chars
    return int(cn_chars * 1.5 + en_chars * 0.25)
