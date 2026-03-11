from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Dict, Optional


class CircuitState(str, Enum):
    CLOSED = "closed"
    OPEN = "open"
    HALF_OPEN = "half_open"


@dataclass
class LoopSignal:
    is_looping: bool
    reason: str = ""
    breaker_state: CircuitState = CircuitState.CLOSED
    suggested_strategy: str = "retry_with_variation"
    consecutive_failures: int = 0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "is_looping": self.is_looping,
            "reason": self.reason,
            "breaker_state": self.breaker_state.value,
            "suggested_strategy": self.suggested_strategy,
            "consecutive_failures": self.consecutive_failures,
        }


class LoopDetector:
    """
    轻量循环检测器：
    - 同一工具+参数重复
    - 同一错误重复
    - 连续无进展
    """

    def __init__(
        self,
        max_identical_tool_calls: int = 3,
        max_same_error_retries: int = 2,
        max_no_progress_rounds: int = 4,
    ) -> None:
        self.max_identical_tool_calls = max(2, int(max_identical_tool_calls))
        self.max_same_error_retries = max(1, int(max_same_error_retries))
        self.max_no_progress_rounds = max(2, int(max_no_progress_rounds))

        self._last_tool_fingerprint = ""
        self._last_tool_name = ""
        self._last_tool_args = ""
        self._same_tool_call_count = 0

        self._last_error_signature = ""
        self._same_error_count = 0

        self._no_progress_rounds = 0
        self._consecutive_failures = 0
        self._escalation_level = 0
        self._breaker_state = CircuitState.CLOSED
        self._opened_at: Optional[str] = None

    def _normalize_args(self, args: Any) -> str:
        try:
            return json.dumps(args if args is not None else {}, ensure_ascii=False, sort_keys=True)
        except Exception:
            return str(args)

    def _classify_error(self, message: str) -> str:
        lower = (message or "").lower()
        if any(k in lower for k in ("timeout", "timed out")):
            return "timeout"
        if any(k in lower for k in ("not found", "不存在", "no such file")):
            return "not_found"
        if any(k in lower for k in ("permission", "denied", "权限")):
            return "permission"
        if any(k in lower for k in ("connection", "refused", "econn")):
            return "connection"
        if any(k in lower for k in ("rate limit", "429")):
            return "rate_limit"
        if any(k in lower for k in ("traceback", "exception", "error", "失败")):
            return "generic_error"
        return "unknown_error"

    def _strategy_for_level(self, level: int) -> str:
        if level <= 1:
            return "retry_with_variation"
        if level == 2:
            return "switch_tool"
        if level == 3:
            return "switch_strategy"
        return "escalate_human"

    def _trip(self, reason: str) -> LoopSignal:
        self._escalation_level += 1
        self._consecutive_failures += 1
        self._breaker_state = CircuitState.OPEN
        self._opened_at = datetime.now(timezone.utc).isoformat()
        return LoopSignal(
            is_looping=True,
            reason=reason,
            breaker_state=self._breaker_state,
            suggested_strategy=self._strategy_for_level(self._escalation_level),
            consecutive_failures=self._consecutive_failures,
        )

    def observe_tool_call(self, tool_name: str, args: Any) -> LoopSignal:
        normalized_args = self._normalize_args(args)
        fingerprint = f"{tool_name}:{normalized_args}"
        if fingerprint == self._last_tool_fingerprint:
            self._same_tool_call_count += 1
        else:
            self._same_tool_call_count = 1
            self._last_tool_fingerprint = fingerprint
            self._last_tool_name = tool_name
            self._last_tool_args = normalized_args

        if self._same_tool_call_count >= self.max_identical_tool_calls:
            return self._trip(f"相同工具调用重复过多: {tool_name}")
        return LoopSignal(is_looping=False)

    def observe_error(self, error_message: str) -> LoopSignal:
        signature = self._classify_error(error_message)
        if signature == self._last_error_signature:
            self._same_error_count += 1
        else:
            self._same_error_count = 1
            self._last_error_signature = signature

        if self._same_error_count > self.max_same_error_retries:
            return self._trip(f"同类错误重复: {signature}")
        return LoopSignal(is_looping=False)

    def observe_round_progress(self, progressed: bool) -> LoopSignal:
        if progressed:
            self._no_progress_rounds = 0
            if self._breaker_state == CircuitState.HALF_OPEN:
                self._breaker_state = CircuitState.CLOSED
            return LoopSignal(is_looping=False, breaker_state=self._breaker_state)

        self._no_progress_rounds += 1
        if self._no_progress_rounds >= self.max_no_progress_rounds:
            return self._trip("连续无进展")
        return LoopSignal(is_looping=False)

    def half_open(self) -> None:
        if self._breaker_state == CircuitState.OPEN:
            self._breaker_state = CircuitState.HALF_OPEN

    def register_success(self) -> None:
        self._breaker_state = CircuitState.CLOSED
        self._same_tool_call_count = 0
        self._same_error_count = 0
        self._no_progress_rounds = 0
        self._consecutive_failures = 0
        self._last_error_signature = ""

    def generate_escape_plan(self) -> str:
        """基于最近失败信号给出结构化逃逸建议（不额外调用 LLM）。"""
        tool = self._last_tool_name or "unknown_tool"
        err = self._last_error_signature or "unknown_error"
        strategy = self._strategy_for_level(self._escalation_level)
        args_preview = (self._last_tool_args or "{}")[:200]

        lines = [
            "检测到循环风险，建议执行逃逸方案：",
            f"1) 当前卡点：tool={tool}, error_signature={err}, repeated_calls={self._same_tool_call_count}",
            f"2) 已尝试：重复调用 {tool}，最近参数片段={args_preview}",
        ]
        if strategy == "switch_tool":
            lines.append("3) 建议：切换为等价但不同的数据源/搜索工具，避免继续沿用当前工具。")
        elif strategy == "switch_strategy":
            lines.append("3) 建议：切换整体方法（先缩小问题范围，再分步验证），必要时委派子代理。")
        elif strategy == "escalate_human":
            lines.append("3) 建议：停止自动重试，整理已尝试路径与阻塞点，请求用户决策。")
        else:
            lines.append("3) 建议：保留目标不变，调整参数后仅重试一次。")
        return "\n".join(lines)

    def status(self) -> Dict[str, Any]:
        return {
            "breaker_state": self._breaker_state.value,
            "opened_at": self._opened_at,
            "same_tool_call_count": self._same_tool_call_count,
            "same_error_count": self._same_error_count,
            "no_progress_rounds": self._no_progress_rounds,
            "consecutive_failures": self._consecutive_failures,
            "escalation_level": self._escalation_level,
            "last_tool_name": self._last_tool_name,
        }

