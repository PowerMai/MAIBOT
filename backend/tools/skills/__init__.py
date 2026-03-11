"""
提示词模块 - 给 LLM 的能力指导

这些是纯文本提示词，用于指导 LLM 如何使用工具组合。
"""

from .skills_doc import DOCUMENT_AGENT_SKILLS_PROMPT

__all__ = [
    "DOCUMENT_AGENT_SKILLS_PROMPT",
]

