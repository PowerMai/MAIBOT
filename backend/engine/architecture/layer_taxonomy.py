from __future__ import annotations

from typing import Final

# Prompt 层级（提示词分层）
PROMPT_LAYER_CORE_IDENTITY: Final[str] = "PromptLayer0"
PROMPT_LAYER_OS_POLICY: Final[str] = "PromptLayer1"
PROMPT_LAYER_MODE_POLICY: Final[str] = "PromptLayer2"
PROMPT_LAYER_ROLE_PERSONA: Final[str] = "PromptLayer3"
PROMPT_LAYER_CAPABILITY: Final[str] = "PromptLayer4"
PROMPT_LAYER_RUNTIME_CONTEXT: Final[str] = "PromptLayer5"

PROMPT_LAYER_ORDER: Final[tuple[str, ...]] = (
    PROMPT_LAYER_CORE_IDENTITY,
    PROMPT_LAYER_OS_POLICY,
    PROMPT_LAYER_MODE_POLICY,
    PROMPT_LAYER_ROLE_PERSONA,
    PROMPT_LAYER_CAPABILITY,
    PROMPT_LAYER_RUNTIME_CONTEXT,
)

# Autonomy 层级（运行时自治等级）
AUTONOMY_LEVEL_CODES: Final[tuple[str, ...]] = ("L0", "L1", "L2", "L3")
AUTONOMY_LEVEL_SET: Final[frozenset[str]] = frozenset(AUTONOMY_LEVEL_CODES)

AUTONOMY_LEVEL_LABELS: Final[dict[str, str]] = {
    "L0": "manual_approval_only",
    "L1": "semi_auto_with_write_approval",
    "L2": "auto_execute_with_guardrails",
    "L3": "full_auto_with_gated_changes",
}

