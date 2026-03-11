"""Orchestrator 系统提示词段落组装（join + 长度保护）。

由 create_orchestrator_agent 调用：传入已构建的段落列表，本模块负责拼接与截断。
段落内容仍由 deep_agent 按需加载（memory、project_rules、human_checkpoints 等），
以避免循环依赖；后续可将各段落构建逻辑逐步迁入本模块或 prompts 子包。
"""
from __future__ import annotations

import logging
from typing import List

logger = logging.getLogger(__name__)

DEFAULT_MAX_SYSTEM_PROMPT_CHARS = 400_000


def assemble_system_prompt(
    segments: List[str],
    *,
    max_chars: int = DEFAULT_MAX_SYSTEM_PROMPT_CHARS,
) -> str:
    """将段落列表拼接为最终 system_prompt，并做长度保护。"""
    system_prompt = "\n\n".join(s for s in segments if (s and isinstance(s, str)))
    if len(system_prompt) > max_chars:
        system_prompt = system_prompt[:max_chars] + "\n\n[系统提示已截断，超出长度限制]"
        logger.warning("系统提示词已截断至 %d 字符", max_chars)
    return system_prompt
