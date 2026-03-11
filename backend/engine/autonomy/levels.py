from __future__ import annotations

import json
import re
import threading
import unicodedata
from pathlib import Path
from typing import Any, Dict, Optional

from backend.engine.architecture.tool_policy_contract import (
    POLICY_LAYER_AUTONOMY,
    ToolPolicyDecision,
    build_policy_decision,
)
from backend.tools.base.paths import get_workspace_root, get_project_root
from backend.tools.base.code_execution import is_shell_command_blocked
from backend.engine.license.tier_service import max_autonomy_level
from backend.engine.architecture.layer_taxonomy import AUTONOMY_LEVEL_SET

AUTONOMY_LEVELS = set(AUTONOMY_LEVEL_SET)
DEFAULT_AUTONOMY_LEVEL = "L1"

READ_ONLY_TOOLS = {
    "read_file",
    "batch_read_files",
    "glob",
    "grep",
    "search_knowledge",
    "web_search",
    "list_skills",
    "match_skills",
    "get_skill_info",
    "ls",
    "think_tool",
    "extended_thinking",
}

WRITE_TOOLS = {
    "write_file",
    "edit_file",
    "delete_file",
    "python_run",
    "shell_run",
    "run_skill_script",
}

DESTRUCTIVE_SHELL_PATTERNS = (
    "rm -rf",
    "rm -fr",
    "git reset --hard",
    "git checkout --",
    "git clean -fd",
    "drop table",
    "truncate table",
    "dd if=",
    "mkfs.",
    "mkswap",
    "wipefs",
    "chmod -r 777",
    "chmod -r 000",
    ">/dev/sd",
    ":(){",
    "shred -",
    "del /f/s/q",
    "format ",
)


def _normalize_shell_text(text: str, compact: bool = False) -> str:
    raw = str(text or "")
    nfc = unicodedata.normalize("NFC", raw)
    lowered = nfc.lower()
    lowered = lowered.replace("\\\n", " ")
    lowered = lowered.replace("\\", "")
    lowered = re.sub(r"[\"'`]", "", lowered)
    lowered = re.sub(r"\s+", " ", lowered).strip()
    if compact:
        lowered = lowered.replace(" ", "")
    return lowered


def _detect_shell_bypass_risk(command: str) -> Optional[str]:
    """接收原始未处理字符串，内部做 NFC 标准化与 lower 后检测绕过风险。"""
    text = unicodedata.normalize("NFC", str(command or ""))
    lowered = text.lower()
    compact = _normalize_shell_text(text, compact=True)
    if "\x00" in text:
        return "命令包含 NUL 字符"
    if re.search(r"\$\([^\)]{1,400}\)", text):
        return "检测到命令替换语法 $()"
    if re.search(r"`[^`]{1,400}`", text):
        return "检测到反引号命令替换语法"
    if "base64" in lowered and (" -d" in lowered or "--decode" in lowered or "base64-d" in compact):
        sinks = ("|sh", "|bash", "|zsh", "|python", "|python3", "|perl", "|node", "|ruby", "|php", "|powershell", "eval")
        if any(s in compact for s in sinks):
            return "检测到 base64 解码并执行链路"
    return None


def _settings_path() -> Path:
    return get_workspace_root() / ".maibot" / "settings.json"


def _license_profile_path() -> Path:
    return get_project_root() / "data" / "license.json"


_file_cache: Dict[str, tuple[Any, float]] = {}
_file_cache_lock = threading.Lock()


def _load_json_cached(path: Path, fallback: Dict[str, Any]) -> Dict[str, Any]:
    key = str(path)
    try:
        if not path.exists():
            return fallback
        mtime = path.stat().st_mtime
    except OSError:
        return fallback
    with _file_cache_lock:
        cached = _file_cache.get(key)
        if cached and cached[1] == mtime:
            return dict(cached[0])
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return fallback
    result = data if isinstance(data, dict) else fallback
    with _file_cache_lock:
        _file_cache[key] = (result, mtime)
    return dict(result)


def _load_license_profile() -> Dict[str, Any]:
    return _load_json_cached(_license_profile_path(), {"tier": "free"})


def _clamp_level_by_tier(level: str, profile: Optional[Dict[str, Any]] = None) -> str:
    rank = {"L0": 0, "L1": 1, "L2": 2, "L3": 3}
    target = str(level or DEFAULT_AUTONOMY_LEVEL).upper()
    if target not in AUTONOMY_LEVELS:
        target = DEFAULT_AUTONOMY_LEVEL
    tier_max = max_autonomy_level(profile or _load_license_profile())
    if rank.get(target, 1) > rank.get(tier_max, 1):
        return tier_max
    return target


def _load_settings() -> Dict[str, Any]:
    return _load_json_cached(_settings_path(), {})


def get_autonomy_settings() -> Dict[str, Any]:
    data = _load_settings()
    autonomous = data.get("autonomous", {}) if isinstance(data, dict) else {}
    if not isinstance(autonomous, dict):
        autonomous = {}
    level = str(autonomous.get("level", DEFAULT_AUTONOMY_LEVEL) or DEFAULT_AUTONOMY_LEVEL).upper()
    if level not in AUTONOMY_LEVELS:
        level = DEFAULT_AUTONOMY_LEVEL
    level = _clamp_level_by_tier(level)
    allow_idle = bool(autonomous.get("allow_idle_loop", level in {"L2", "L3"}))
    raw_auto_accept = autonomous.get("auto_accept_tools")
    if isinstance(raw_auto_accept, list):
        auto_accept_tools = [str(x).strip() for x in raw_auto_accept if str(x).strip()]
    else:
        auto_accept_tools = []
    return {
        "level": level,
        "require_tool_approval": bool(autonomous.get("require_tool_approval", level in {"L0", "L1"})),
        "auto_accept_tools": auto_accept_tools,
        "allow_idle_loop": allow_idle,
        "allow_copilot_suggestions": bool(autonomous.get("allow_copilot_suggestions", allow_idle)),
        "allow_gated_code_changes": bool(autonomous.get("allow_gated_code_changes", level == "L3")),
    }


def is_tool_allowed_by_level(tool_name: str, level: Optional[str], args: Optional[Dict[str, Any]] = None) -> tuple[bool, Optional[str]]:
    decision = explain_tool_policy_by_level(tool_name=tool_name, level=level, args=args)
    return bool(decision.get("allowed")), str(decision.get("reason_text") or "")


def explain_tool_policy_by_level(
    tool_name: str,
    level: Optional[str],
    args: Optional[Dict[str, Any]] = None,
) -> ToolPolicyDecision:
    lv = str(level or DEFAULT_AUTONOMY_LEVEL).upper()
    if lv not in AUTONOMY_LEVELS:
        lv = DEFAULT_AUTONOMY_LEVEL
    name = str(tool_name or "").strip().lower()
    if not name:
        return build_policy_decision(
            allowed=False,
            policy_layer=POLICY_LAYER_AUTONOMY,
            reason_code="empty_tool_name_blocked",
            reason_text="tool_name 为空，拒绝放行",
        )

    # L3: 免除审批，但对 shell_run 仍保留与 L2 相同的命令安全检测
    if lv == "L3":
        if name == "shell_run":
            payload = args or {}
            raw_cmd = str(payload.get("command") or payload.get("cmd") or "")
            blocked, reason = is_shell_command_blocked(raw_cmd)
            if blocked:
                return build_policy_decision(
                    allowed=False,
                    policy_layer=POLICY_LAYER_AUTONOMY,
                    reason_code="autonomy_l3_shell_policy_block",
                    reason_text=f"L3 命令策略拦截：{reason}",
                )
            normalized_raw = unicodedata.normalize("NFC", raw_cmd)
            cmd = normalized_raw.lower()
            compact_cmd = _normalize_shell_text(normalized_raw, compact=True)
            bypass_reason = _detect_shell_bypass_risk(raw_cmd)
            if bypass_reason:
                return build_policy_decision(
                    allowed=False,
                    policy_layer=POLICY_LAYER_AUTONOMY,
                    reason_code="autonomy_l3_shell_bypass_risk",
                    reason_text=f"L3 禁止潜在绕过命令：{bypass_reason}。",
                )
            for pattern in DESTRUCTIVE_SHELL_PATTERNS:
                p = str(pattern or "").lower()
                if p in cmd:
                    return build_policy_decision(
                        allowed=False,
                        policy_layer=POLICY_LAYER_AUTONOMY,
                        reason_code="autonomy_l3_shell_destructive",
                        reason_text=f"L3 禁止破坏性命令：检测到 `{pattern}`。",
                    )
                if p != "format ":  # "format " 经 compact 后变 "format"，会误拦截含 format 子串的合法命令
                    p_compact = _normalize_shell_text(p, compact=True)
                    if p_compact and p_compact in compact_cmd:
                        return build_policy_decision(
                            allowed=False,
                            policy_layer=POLICY_LAYER_AUTONOMY,
                            reason_code="autonomy_l3_shell_destructive",
                            reason_text=f"L3 禁止破坏性命令：检测到 `{pattern}`。",
                        )
        return build_policy_decision(
            allowed=True,
            policy_layer=POLICY_LAYER_AUTONOMY,
            reason_code="autonomy_l3_allow",
            reason_text="L3 允许全部工具调用",
        )

    if lv == "L0":
        if name not in READ_ONLY_TOOLS:
            return build_policy_decision(
                allowed=False,
                policy_layer=POLICY_LAYER_AUTONOMY,
                reason_code="autonomy_l0_readonly_only",
                reason_text=f"L0 仅允许只读工具，当前工具 `{name}` 被拦截。",
            )
        return build_policy_decision(
            allowed=True,
            policy_layer=POLICY_LAYER_AUTONOMY,
            reason_code="autonomy_default_allow",
            reason_text=f"L0 只读工具 `{name}` 允许执行",
        )

    if lv == "L1":
        # L1: 写入/执行类工具与 task 委派均允许，由 HumanInTheLoop 在聊天区展示 diff/预览并等待接受/拒绝后再执行（与 Agent 模式预期一致）
        return build_policy_decision(
            allowed=True,
            policy_layer=POLICY_LAYER_AUTONOMY,
            reason_code="autonomy_default_allow",
            reason_text=f"L1 工具 `{name}` 允许执行（需审批时在聊天区确认）",
        )

    # L2: 允许一般写操作，但拦截明显破坏性 shell 命令
    if lv == "L2" and name == "shell_run":
        payload = args or {}
        raw_cmd = str(payload.get("command") or payload.get("cmd") or "")
        blocked, reason = is_shell_command_blocked(raw_cmd)
        if blocked:
            return build_policy_decision(
                allowed=False,
                policy_layer=POLICY_LAYER_AUTONOMY,
                reason_code="autonomy_l2_shell_policy_block",
                reason_text=f"L2 命令策略拦截：{reason}",
            )
        normalized_raw = unicodedata.normalize("NFC", raw_cmd)
        cmd = normalized_raw.lower()
        compact_cmd = _normalize_shell_text(normalized_raw, compact=True)
        bypass_reason = _detect_shell_bypass_risk(raw_cmd)
        if bypass_reason:
            return build_policy_decision(
                allowed=False,
                policy_layer=POLICY_LAYER_AUTONOMY,
                reason_code="autonomy_l2_shell_bypass_risk",
                reason_text=f"L2 禁止潜在绕过命令：{bypass_reason}。",
            )
        for pattern in DESTRUCTIVE_SHELL_PATTERNS:
            p = str(pattern or "").lower()
            if p in cmd:
                return build_policy_decision(
                    allowed=False,
                    policy_layer=POLICY_LAYER_AUTONOMY,
                    reason_code="autonomy_l2_shell_destructive",
                    reason_text=f"L2 禁止破坏性命令：检测到 `{pattern}`。",
                )
            if p != "format ":
                p_compact = _normalize_shell_text(p, compact=True)
                if p_compact and p_compact in compact_cmd:
                    return build_policy_decision(
                        allowed=False,
                        policy_layer=POLICY_LAYER_AUTONOMY,
                        reason_code="autonomy_l2_shell_destructive",
                        reason_text=f"L2 禁止破坏性命令：检测到 `{pattern}`。",
                    )
    return build_policy_decision(
        allowed=True,
        policy_layer=POLICY_LAYER_AUTONOMY,
        reason_code="autonomy_default_allow",
        reason_text=f"{lv} 工具 `{name}` 允许执行",
    )

