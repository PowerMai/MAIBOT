from __future__ import annotations

import asyncio
import json
import logging
import re
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from langchain.agents.middleware.types import AgentMiddleware, ToolCallRequest
from langchain_core.messages import ToolMessage
from langgraph.types import Command

from backend.engine.architecture.tool_policy_contract import (
    POLICY_LAYER_MODE_SPECIAL,
    POLICY_LAYER_ROLE_MODE,
    ToolPolicyDecision,
    build_policy_decision,
)
from backend.engine.autonomy.levels import get_autonomy_settings, explain_tool_policy_by_level
from backend.engine.modes import explain_tool_policy_decision
from backend.engine.roles.role_manager import get_role_manager
from backend.tools.base.paths import get_workspace_root

logger = logging.getLogger(__name__)


class ModePermissionMiddleware(AgentMiddleware):
    """运行时模式权限门控，避免仅靠提示词约束。"""

    def __init__(self) -> None:
        super().__init__()
        self._workspace_root = get_workspace_root()
        self._policy_events_path = self._workspace_root / "backend" / "data" / "policy_decision_events.jsonl"
        self._policy_events_path.parent.mkdir(parents=True, exist_ok=True)
        self._policy_events_lock = threading.Lock()

    def _get_mode(self, request: ToolCallRequest) -> str:
        state = getattr(request, "state", None) or {}
        mode = str(state.get("mode") or "").strip().lower()
        if mode:
            return mode
        runtime = getattr(request, "runtime", None)
        ctx = getattr(runtime, "context", None) if runtime is not None else None
        configurable = (ctx or {}).get("configurable", {}) if isinstance(ctx, dict) else {}
        mode = str((configurable or {}).get("mode") or "").strip().lower()
        return mode or "agent"

    @staticmethod
    def _get_active_role_id(request: ToolCallRequest) -> str:
        state = getattr(request, "state", None) or {}
        role_id = str(state.get("active_role_id") or state.get("role_id") or "").strip()
        if role_id:
            return role_id
        runtime = getattr(request, "runtime", None)
        ctx = getattr(runtime, "context", None) if runtime is not None else None
        configurable = (ctx or {}).get("configurable", {}) if isinstance(ctx, dict) else {}
        role_id = str(
            (configurable or {}).get("active_role_id")
            or (configurable or {}).get("role_id")
            or ""
        ).strip()
        return role_id

    @staticmethod
    def _is_mode_allowed_for_role(role_id: str, mode: str) -> bool:
        if not role_id:
            return True
        try:
            role = get_role_manager().get_role(role_id) or {}
            modes = role.get("modes")
            if not isinstance(modes, list):
                return True
            allowed_modes = {str(m).strip().lower() for m in modes if str(m).strip()}
            if not allowed_modes:
                return True
            return mode in allowed_modes
        except Exception:
            logger.warning("角色读取异常，默认拒绝工具调用以保障安全")
            return False

    @staticmethod
    def _role_mode_decision(role_id: str, mode: str, allowed: bool) -> ToolPolicyDecision:
        if allowed:
            return build_policy_decision(
                allowed=True,
                policy_layer=POLICY_LAYER_ROLE_MODE,
                reason_code="role_mode_allowed",
                reason_text=f"角色 `{role_id or 'default'}` 允许在 `{mode}` 模式执行",
            )
        return build_policy_decision(
            allowed=False,
            policy_layer=POLICY_LAYER_ROLE_MODE,
            reason_code="role_mode_blocked",
            reason_text=(
                f"当前角色 `{role_id}` 不允许在 `{mode}` 模式下执行。"
                "请切换到角色允许的模式，或先更换角色。"
            ),
        )

    @staticmethod
    def _as_bool(value: Any) -> bool:
        if isinstance(value, bool):
            return value
        if isinstance(value, str):
            return value.strip().lower() in {"1", "true", "yes", "on"}
        return False

    @staticmethod
    def _is_ask_safe_task_args(tool_args: dict[str, Any]) -> tuple[bool, str]:
        # Ask 模式下 task 仅允许只读子代理探索；explore-agent 白名单也要求 readonly=True，不跳过校验。
        readonly = ModePermissionMiddleware._as_bool(tool_args.get("readonly"))
        if not readonly:
            return False, "Ask 模式下 `task` 必须显式设置 readonly=true。"
        sub_type = str(tool_args.get("subagent_type") or "").strip()
        if sub_type in ("explore-agent", "explore"):
            return True, ""
        if sub_type and sub_type not in {"explore", "explore-agent", "generalPurpose", "general-purpose"}:
            return False, f"Ask 模式下 `task.subagent_type` 仅允许 explore/general-purpose，当前为 `{sub_type}`。"
        return True, ""

    @staticmethod
    def _extract_path(args: dict[str, Any]) -> str:
        for key in ("path", "file_path", "filepath", "filename", "target_file"):
            raw = args.get(key)
            if isinstance(raw, str) and raw.strip():
                return raw.strip()
        return ""

    @staticmethod
    def _extract_python_code(args: dict[str, Any]) -> str:
        raw = args.get("code")
        return raw if isinstance(raw, str) else ""

    @staticmethod
    def _extract_shell_command(args: dict[str, Any]) -> str:
        for key in ("command", "cmd", "script"):
            raw = args.get(key)
            if isinstance(raw, str) and raw.strip():
                return raw.strip()
        return ""

    @staticmethod
    def _has_python_side_effect(code: str) -> tuple[bool, str]:
        text = (code or "").lower()
        if not text.strip():
            return False, ""

        # Best-effort 静态检测：高危 marker 命中时直接拒绝（字符串混淆可绕过，仅作防护层）
        high_risk_markers = [
            "subprocess.",
            "os.system(",
            "os.popen(",
            "os.execv(",
            "__import__(",
            "exec(",
            "eval(",
        ]
        for m in high_risk_markers:
            if m in text:
                return True, m

        # 仅拦截明显会产生副作用的模式，保留只读计算/校验能力
        # 仅匹配明确文件/IO 副作用；不含 ".replace(" 以免误判 str.replace() 等数据处理
        markers = [
            ".write(",
            ".write_text(",
            ".write_bytes(",
            ".unlink(",
            ".rename(",
            ".mkdir(",
            ".rmdir(",
            ".touch(",
            "shutil.rmtree(",
            "shutil.move(",
            "shutil.copy(",
            "os.remove(",
            "os.unlink(",
            "os.rmdir(",
            "os.rename(",
            "os.replace(",
            "os.makedirs(",
            "os.mkdir(",
        ]
        for marker in markers:
            if marker in text:
                return True, marker

        # open(..., "w"/"a"/"x"/"+") 视为潜在写操作
        if re.search(r"open\s*\([^)]*,\s*['\"][^'\"]*[wax\+][^'\"]*['\"]", text):
            return True, "open(..., write-mode)"

        return False, ""

    def _is_mode_output_path(self, path: str, mode_dir: str) -> bool:
        if not path:
            return False
        p = Path(path)
        ws = self._workspace_root
        if not p.is_absolute():
            p = ws / p
        try:
            resolved = p.resolve()
            return (ws / "outputs" / mode_dir).resolve() in (resolved, *resolved.parents)
        except Exception:
            return False

    def _emit_policy_event(self, *, tool_name: str, mode: str, level: str, decision: ToolPolicyDecision) -> None:
        if bool(decision.get("allowed")):
            return
        payload = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "tool_name": str(tool_name or ""),
            "mode": str(mode or ""),
            "autonomy_level": str(level or ""),
            "allowed": bool(decision.get("allowed")),
            "policy_layer": str(decision.get("policy_layer") or ""),
            "reason_code": str(decision.get("reason_code") or ""),
            "reason_text": str(decision.get("reason_text") or ""),
        }
        try:
            with self._policy_events_lock:
                with self._policy_events_path.open("a", encoding="utf-8") as f:
                    f.write(json.dumps(payload, ensure_ascii=False) + "\n")
        except Exception:
            return

    def _deny(self, *, tool_call: dict[str, Any], tool_name: str, mode: str, level: str, decision: ToolPolicyDecision) -> ToolMessage:
        self._emit_policy_event(tool_name=tool_name, mode=mode, level=level, decision=decision)
        content = json.dumps(
            {
                "error": "permission_denied",
                "allowed": bool(decision.get("allowed")),
                "policy_layer": str(decision.get("policy_layer") or ""),
                "reason_code": str(decision.get("reason_code") or ""),
                "reason_text": str(decision.get("reason_text") or ""),
                "mode": mode,
                "autonomy_level": level,
                "tool_name": tool_name,
            },
            ensure_ascii=False,
        )
        return ToolMessage(
            content=content,
            tool_call_id=str(tool_call.get("id") or ""),
            name=tool_name,
            status="error",
        )

    def wrap_tool_call(self, request: ToolCallRequest, handler) -> ToolMessage | Command:
        tool_call = getattr(request, "tool_call", {}) or {}
        tool_name = str(tool_call.get("name") or "").strip()
        tool_args = tool_call.get("args", {}) if isinstance(tool_call, dict) else {}
        if not isinstance(tool_args, dict):
            tool_args = {}
        mode = self._get_mode(request)
        active_role_id = self._get_active_role_id(request)

        autonomy = get_autonomy_settings()
        level = str(autonomy.get("level", "L1"))

        # 固化优先级：role_mode -> mode -> autonomy -> mode_special
        role_decision = self._role_mode_decision(
            role_id=active_role_id,
            mode=mode,
            allowed=self._is_mode_allowed_for_role(active_role_id, mode),
        )
        if not bool(role_decision.get("allowed")):
            return self._deny(
                tool_call=tool_call,
                tool_name=tool_name,
                mode=mode,
                level=level,
                decision=role_decision,
            )

        mode_decision = explain_tool_policy_decision(mode, tool_name)
        if not bool(mode_decision.get("allowed")):
            return self._deny(
                tool_call=tool_call,
                tool_name=tool_name,
                mode=mode,
                level=level,
                decision=mode_decision,
            )

        autonomy_decision = explain_tool_policy_by_level(tool_name=tool_name, level=level, args=tool_args)
        if not bool(autonomy_decision.get("allowed")):
            return self._deny(
                tool_call=tool_call,
                tool_name=tool_name,
                mode=mode,
                level=level,
                decision=autonomy_decision,
            )

        if mode == "ask" and tool_name == "task":
            ask_task_allowed, ask_task_reason = self._is_ask_safe_task_args(tool_args)
            if not ask_task_allowed:
                reason_code = "ask_task_readonly_required"
                if "subagent_type" in ask_task_reason:
                    reason_code = "ask_task_subagent_restricted"
                return self._deny(
                    tool_call=tool_call,
                    tool_name=tool_name,
                    mode=mode,
                    level=level,
                    decision=build_policy_decision(
                        allowed=False,
                        policy_layer=POLICY_LAYER_MODE_SPECIAL,
                        reason_code=reason_code,
                        reason_text=ask_task_reason,
                    ),
                )

        # Plan 模式工具权限与 Agent 一致；确认与阶段控制由图级流程负责。

        # Review 模式：write_file / write_file_binary 仅允许写入 outputs/review
        if mode == "review" and tool_name in {"write_file", "write_file_binary"}:
            target_path = self._extract_path(tool_args)
            if not self._is_mode_output_path(target_path, "review"):
                return self._deny(
                    tool_call=tool_call,
                    tool_name=tool_name,
                    mode=mode,
                    level=level,
                    decision=build_policy_decision(
                        allowed=False,
                        policy_layer=POLICY_LAYER_MODE_SPECIAL,
                        reason_code="review_write_output_only",
                        reason_text=(
                            "Review 模式仅允许写入 `outputs/review/`。"
                            f"当前目标路径不允许: {target_path or '<empty>'}"
                        ),
                    ),
                )

        # Review 模式只允许评审与报告产出，不允许直接修改现有文件与命令执行
        if mode == "review" and tool_name in {"edit_file", "shell_run"}:
            return self._deny(
                tool_call=tool_call,
                tool_name=tool_name,
                mode=mode,
                level=level,
                decision=build_policy_decision(
                    allowed=False,
                    policy_layer=POLICY_LAYER_MODE_SPECIAL,
                    reason_code="review_edit_shell_forbidden",
                    reason_text=f"Review 模式禁止执行 `{tool_name}`。请切换到 Agent/Debug 模式。",
                ),
            )

        if mode == "review" and tool_name in {"python_run", "python_internal"}:
            code = self._extract_python_code(tool_args)
            has_effect, marker = self._has_python_side_effect(code)
            if has_effect:
                return self._deny(
                    tool_call=tool_call,
                    tool_name=tool_name,
                    mode=mode,
                    level=level,
                    decision=build_policy_decision(
                        allowed=False,
                        policy_layer=POLICY_LAYER_MODE_SPECIAL,
                        reason_code="review_python_side_effect",
                        reason_text=(
                            "Review 模式下，`python_run/python_internal` 仅允许数据校验与只读分析。"
                            f"检测到潜在副作用片段: {marker}"
                        ),
                    ),
                )

        return handler(request)

    async def awrap_tool_call(self, request: ToolCallRequest, handler):
        # wrap_tool_call 为同步，内部 return handler(request) 在异步链下返回 coroutine，必须 await
        result = self.wrap_tool_call(request, handler)
        if asyncio.iscoroutine(result):
            return await result
        return result
