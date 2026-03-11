from __future__ import annotations

from typing import Final, TypedDict


class ToolPolicyDecision(TypedDict):
    allowed: bool
    policy_layer: str
    reason_code: str
    reason_text: str


POLICY_LAYER_ROLE_MODE: Final[str] = "role_mode"
POLICY_LAYER_MODE: Final[str] = "mode"
POLICY_LAYER_AUTONOMY: Final[str] = "autonomy"
POLICY_LAYER_MODE_SPECIAL: Final[str] = "mode_special"

POLICY_LAYER_CODES: Final[frozenset[str]] = frozenset(
    {
        POLICY_LAYER_ROLE_MODE,
        POLICY_LAYER_MODE,
        POLICY_LAYER_AUTONOMY,
        POLICY_LAYER_MODE_SPECIAL,
    }
)

MODE_POLICY_REASON_CODES: Final[frozenset[str]] = frozenset(
    {
        "mode_invalid_tool_name",
        "mode_denied_tools_block",
        "mode_allow_all",
        "mode_allowlist_miss",
        "mode_allowlist_hit",
    }
)

AUTONOMY_POLICY_REASON_CODES: Final[frozenset[str]] = frozenset(
    {
        "autonomy_empty_tool_name",
        "autonomy_l3_allow",
        "autonomy_l0_readonly_only",
        "autonomy_l1_write_tool_block",
        "autonomy_l2_shell_policy_block",
        "autonomy_l2_shell_bypass_risk",
        "autonomy_l2_shell_destructive",
        "autonomy_default_allow",
    }
)

ROLE_MODE_POLICY_REASON_CODES: Final[frozenset[str]] = frozenset(
    {
        "role_mode_allowed",
        "role_mode_blocked",
    }
)

MODE_SPECIAL_POLICY_REASON_CODES: Final[frozenset[str]] = frozenset(
    {
        "mode_special_pass",  # 透传路径：未命中 ask/review 等特殊规则时，策略层放行，由上层或报告使用
        "ask_task_readonly_required",
        "ask_task_subagent_restricted",
        "review_write_output_only",
        "review_edit_shell_forbidden",
        "review_python_side_effect",
    }
)

ALL_POLICY_REASON_CODES: Final[frozenset[str]] = frozenset(
    set(MODE_POLICY_REASON_CODES)
    | set(AUTONOMY_POLICY_REASON_CODES)
    | set(ROLE_MODE_POLICY_REASON_CODES)
    | set(MODE_SPECIAL_POLICY_REASON_CODES)
)


def build_policy_decision(
    *,
    allowed: bool,
    policy_layer: str,
    reason_code: str,
    reason_text: str,
) -> ToolPolicyDecision:
    return {
        "allowed": bool(allowed),
        "policy_layer": str(policy_layer or "").strip(),
        "reason_code": str(reason_code or "").strip(),
        "reason_text": str(reason_text or "").strip(),
    }

