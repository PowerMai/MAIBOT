from __future__ import annotations

import os
import re
import logging
from typing import Any

from langchain.agents.middleware.types import AgentMiddleware, ModelRequest, ModelResponse
from langchain_core.messages import SystemMessage

logger = logging.getLogger(__name__)

_RE_LIST_PREFIX = re.compile(r"^\s*(?:[-*•]|\d+[.)、]|\(\d+\)|（\d+）)\s*")
_RE_SENTENCE_SPLIT = re.compile(r"[；;。!?！？\n]+")
_RE_TOKEN_EXTRACT = re.compile(r"[a-zA-Z0-9_]{2,}|[\u4e00-\u9fff]{2,}")


class ReflectionMiddleware(AgentMiddleware):
    """在关键节点注入简短反思提醒，减少线性盲执行。"""

    def __init__(self, every_n_tool_calls: int = 5) -> None:
        super().__init__()
        self.every_n_tool_calls = max(1, int(every_n_tool_calls))
        self._checkpoint_key = "_reflection_last_tool_checkpoint"
        self._error_checkpoint_key = "_reflection_last_error_checkpoint"
        self._meta_progress_key = "_reflection_no_progress_count"
        self._meta_last_human_key = "_reflection_last_human"
        self._meta_last_ai_key = "_reflection_last_ai"
        self._req_items_key = "_reflection_req_items"
        self._req_missing_key = "_reflection_req_missing"
        self._req_checkpoint_key = "_reflection_req_checkpoint"
        self._req_last_human_key = "_reflection_req_last_human"
        self._req_last_missing_sig_key = "_reflection_req_last_missing_sig"
        self._req_gate_enabled = str(os.getenv("ENABLE_REQUIREMENT_COVERAGE_GATE", "true")).lower() == "true"
        self._req_cooldown_tools = max(1, int(os.getenv("REQUIREMENT_GATE_COOLDOWN_TOOLS", "3")))
        self._no_info_checkpoint_key = "_reflection_no_info_checkpoint"
        self._no_info_threshold = max(2, int(os.getenv("NO_NEW_INFO_THRESHOLD", "3")))
        self._no_info_cooldown_tools = max(1, int(os.getenv("NO_NEW_INFO_COOLDOWN_TOOLS", "4")))
        self._destructive_tools = {"shell_run", "write_file", "edit_file", "write_file_binary"}

    @staticmethod
    def _extract_recent_text(messages: list[Any], msg_type: str) -> str:
        for msg in reversed(messages):
            if getattr(msg, "type", "") == msg_type:
                return str(getattr(msg, "content", "") or "").strip()
        return ""

    @staticmethod
    def _extract_requirements(user_text: str) -> list[str]:
        raw = (user_text or "").strip()
        if not raw:
            return []
        lines = []
        for line in raw.splitlines():
            s = line.strip()
            if not s:
                continue
            s = _RE_LIST_PREFIX.sub("", s).strip()
            if s:
                lines.append(s)
        if len(lines) >= 2:
            return lines[:10]
        parts = _RE_SENTENCE_SPLIT.split(raw)
        merged = [p.strip() for p in parts if p.strip()]
        if len(merged) >= 2:
            return merged[:10]
        return [raw[:200]]

    @staticmethod
    def _req_hit(req: str, ai_text: str) -> bool:
        req_low = (req or "").lower()
        ai_low = (ai_text or "").lower()
        if not req_low or not ai_low:
            return False
        tokens = _RE_TOKEN_EXTRACT.findall(req_low)
        if not tokens:
            return req_low[:6] in ai_low
        strong_tokens = [t for t in tokens if len(t) >= 2][:8]
        hit = sum(1 for t in strong_tokens if t in ai_low)
        threshold = 1 if len(strong_tokens) <= 3 else 2
        return hit >= threshold

    @staticmethod
    def _count_no_new_info_tools(messages: list[Any], window: int = 6) -> int:
        markers = (
            "未找到相关内容",
            "暂无相关",
            "无法确认",
            "no result",
            "no results",
            "not found",
            "unable to confirm",
        )
        tool_msgs = [m for m in messages if getattr(m, "type", "") == "tool"]
        if not tool_msgs:
            return 0
        recent = tool_msgs[-window:]
        count = 0
        for m in recent:
            content = str(getattr(m, "content", "") or "").lower()
            if any(mark in content for mark in markers):
                count += 1
        return count

    async def wrap_model_call(self, request: ModelRequest, handler):
        messages = request.state.get("messages", []) if request.state else []
        tool_msg_count = 0
        recent_tool_error_count = 0
        for m in messages:
            mtype = getattr(m, "type", "")
            if mtype == "tool":
                tool_msg_count += 1
                status = getattr(m, "status", None)
                if status == "error":
                    recent_tool_error_count += 1

        last_checkpoint = int(request.state.get(self._checkpoint_key, 0) or 0) if request.state else 0
        if (
            tool_msg_count > 0
            and tool_msg_count % self.every_n_tool_calls == 0
            and tool_msg_count != last_checkpoint
        ):
            suffix = (
                "\n<system_reminder>"
                "反思检查点：你已执行多步操作。继续前请快速确认："
                "当前方向是否正确？是否遗漏了关键约束或验证步骤？"
                "</system_reminder>"
            )
            current = request.system_prompt or ""
            request = request.override(system_message=SystemMessage(content=current + suffix))
            if request.state is not None:
                request.state[self._checkpoint_key] = tool_msg_count

        # 若最近工具错误累计，追加“先收敛问题再继续”的提醒，减少盲目重试
        last_error_checkpoint = int(request.state.get(self._error_checkpoint_key, 0) or 0) if request.state else 0
        if recent_tool_error_count >= 2 and recent_tool_error_count != last_error_checkpoint:
            suffix = (
                "\n<system_reminder>"
                "错误反思检查点：最近出现连续工具错误。"
                "继续调用前请先明确根因、验证修复思路，并给出最小化重试方案。"
                "</system_reminder>"
            )
            current = request.system_prompt or ""
            request = request.override(system_message=SystemMessage(content=current + suffix))
            if request.state is not None:
                request.state[self._error_checkpoint_key] = recent_tool_error_count

        # 元认知监控：目标-状态对齐（ReflAct 风格）
        if request.state is not None:
            latest_human = self._extract_recent_text(messages, "human")
            latest_ai = self._extract_recent_text(messages, "ai")
            prev_human = str(request.state.get(self._meta_last_human_key, "") or "")
            prev_ai = str(request.state.get(self._meta_last_ai_key, "") or "")
            no_progress = int(request.state.get(self._meta_progress_key, 0) or 0)
            if latest_human and latest_ai and latest_human == prev_human and latest_ai == prev_ai:
                no_progress += 1
            elif latest_human:
                no_progress = 0
            request.state[self._meta_last_human_key] = latest_human
            request.state[self._meta_last_ai_key] = latest_ai
            request.state[self._meta_progress_key] = no_progress
            if no_progress >= 3:
                suffix = (
                    "\n<system_reminder>"
                    "元认知检查点：你已连续多步无明显进展。"
                    "继续前请先做目标-状态对齐：当前状态距离目标还差什么？"
                    "必须切换策略（换工具/换路径/补证据/询问用户关键缺口），禁止机械重试。"
                    "</system_reminder>"
                )
                current = request.system_prompt or ""
                request = request.override(system_message=SystemMessage(content=current + suffix))
                request.state[self._meta_progress_key] = 0

            # 需求覆盖门禁（复合需求场景）—— 规则判定，避免额外 LLM 阻塞
            if self._req_gate_enabled and latest_human and latest_ai and tool_msg_count >= 2:
                last_req_ckpt = int(request.state.get(self._req_checkpoint_key, 0) or 0)
                if (tool_msg_count - last_req_ckpt) >= self._req_cooldown_tools:
                    last_req_human = str(request.state.get(self._req_last_human_key, "") or "")
                    if latest_human != last_req_human:
                        req_items = self._extract_requirements(latest_human)
                        request.state[self._req_items_key] = req_items
                    else:
                        req_items = request.state.get(self._req_items_key) or []
                    if len(req_items) >= 2:
                        missing = []
                        for r in req_items:
                            if not self._req_hit(r, latest_ai):
                                missing.append(r)
                        request.state[self._req_missing_key] = missing
                        if missing:
                            last_missing_sig = str(request.state.get(self._req_last_missing_sig_key, "") or "")
                            missing_sig = "|".join(missing[:5])
                            if not (latest_human == last_req_human and missing_sig == last_missing_sig):
                                missing_preview = "；".join(missing[:3])
                                suffix = (
                                    "\n<system_reminder>"
                                    "需求覆盖门禁：检测到可能遗漏的用户要求。"
                                    "在逐项覆盖或明确说明原因前，禁止直接给出“已完成”结论。"
                                    f"疑似遗漏: {missing_preview}"
                                    "</system_reminder>"
                                )
                                current = request.system_prompt or ""
                                request = request.override(system_message=SystemMessage(content=current + suffix))
                                request.state[self._req_checkpoint_key] = tool_msg_count
                                request.state[self._req_last_human_key] = latest_human
                                request.state[self._req_last_missing_sig_key] = missing_sig

            # 连续无新增信息时收敛，避免“聊天区反复”
            no_new_info_hits = self._count_no_new_info_tools(messages, window=6)
            last_no_info_ckpt = int(request.state.get(self._no_info_checkpoint_key, 0) or 0)
            if (
                no_new_info_hits >= self._no_info_threshold
                and tool_msg_count >= 2
                and (tool_msg_count - last_no_info_ckpt) >= self._no_info_cooldown_tools
            ):
                suffix = (
                    "\n<system_reminder>"
                    "收敛检查点：最近连续检索未获得新增信息。"
                    "请停止重复搜索，基于现有证据给出阶段性结论，并列出待澄清点。"
                    "</system_reminder>"
                )
                current = request.system_prompt or ""
                request = request.override(system_message=SystemMessage(content=current + suffix))
                request.state[self._no_info_checkpoint_key] = tool_msg_count

        return await handler(request)

    async def awrap_model_call(self, request: ModelRequest, handler) -> ModelResponse:
        return await self.wrap_model_call(request, handler)

    async def wrap_tool_call(self, request, handler):
        tool_name = str(((getattr(request, "tool_call", None) or {}).get("name", "")) or "")
        if tool_name in self._destructive_tools:
            try:
                state = getattr(request, "state", None)
                if state is not None:
                    state["reflection_destructive_checkpoint"] = (
                        "即将执行潜在破坏性操作，请确认已完成影响评估与回滚方案。"
                    )
            except Exception as e:
                logger.debug("[ReflectionMiddleware] 写入 destructive checkpoint 失败: %s", e)
        return await handler(request)

    async def awrap_tool_call(self, request, handler):
        return await self.wrap_tool_call(request, handler)

