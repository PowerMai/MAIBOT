"""License gate middleware: gate premium tools by license tier."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any, Dict, Set

from langchain.agents.middleware.types import AgentMiddleware, AgentState, ToolCallRequest
from langchain_core.messages import SystemMessage
from langchain_core.messages import ToolMessage
from langgraph.runtime import Runtime
from langgraph.types import Command
from backend.engine.license.tier_service import (
    current_tier as resolve_current_tier,
    tier_rank,
)
from backend.engine.plugins import PluginLoader


class LicenseGateMiddleware(AgentMiddleware):
    def __init__(self) -> None:
        super().__init__()
        self._cfg_path = Path(__file__).resolve().parents[2] / "config" / "license_tiers.json"
        self._license_path = Path(__file__).resolve().parents[3] / "data" / "license.json"
        self._project_root = Path(__file__).resolve().parents[3]
        self._cfg = self._load_json(self._cfg_path, {})
        self._license = self._load_json(self._license_path, {})
        self._plugin_tool_tier = self._build_plugin_tool_tier_map()

    @staticmethod
    def _load_json(path: Path, fallback: Dict[str, Any]) -> Dict[str, Any]:
        try:
            if path.exists():
                data = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    return data
        except Exception:
            pass
        return fallback

    def _current_tier(self) -> str:
        tier = resolve_current_tier(self._license)
        if tier in {"free", "pro", "max", "enterprise"}:
            return tier
        return str((self._cfg or {}).get("default_tier") or "free").strip().lower()

    def _allowed_tools(self) -> Set[str]:
        tiers = (self._cfg or {}).get("tiers") or {}
        tier_cfg = tiers.get(self._current_tier()) or tiers.get(str((self._cfg or {}).get("default_tier") or "free")) or {}
        allow = tier_cfg.get("allow_tools") or []
        return {str(x).strip() for x in allow if str(x).strip()}

    def _build_plugin_tool_tier_map(self) -> Dict[str, str]:
        mapping: Dict[str, str] = {}
        try:
            loader = PluginLoader(project_root=self._project_root, profile={"tier": "enterprise"})
            for spec in loader.discover():
                required = str(spec.requires_tier or "free").strip().lower()
                components = spec.components or {}
                for tool in components.get("tools", []) or []:
                    name = str(tool or "").strip()
                    if not name:
                        continue
                    prev = mapping.get(name)
                    if not prev or tier_rank(required) > tier_rank(prev):
                        mapping[name] = required
        except Exception:
            return {}
        return mapping

    def before_model(self, state: AgentState, runtime: Runtime[Any]) -> Dict[str, Any] | None:  # noqa: ARG002
        # 仅做轻量门控提示：阻断明显高级工具（避免影响基础体验）
        messages = state.get("messages", [])
        if not messages:
            return None
        allowed = self._allowed_tools()
        if "*" in allowed:
            return None
        blocked = []
        if self._current_tier() == "free":
            blocked = ["premium_tools", "plugin_tools"]
        if not blocked:
            return None
        # 对 premium 工具做软门控：返回系统提醒，由代理自行降级到可用工具
        msg = (
            "[LicenseGate] 当前授权层级不允许以下工具："
            + ", ".join(sorted(set(blocked))[:10])
            + "。请优先使用已授权工具完成任务；如需高级功能请升级授权。"
        )
        return {"messages": [SystemMessage(content=msg), *messages]}

    def wrap_tool_call(self, request: ToolCallRequest, handler) -> ToolMessage | Command:
        tool_call = getattr(request, "tool_call", {}) or {}
        tool_name = str(tool_call.get("name") or "").strip()
        if not tool_name:
            return handler(request)

        required_plugin_tier = self._plugin_tool_tier.get(tool_name)
        if required_plugin_tier and tier_rank(self._current_tier()) < tier_rank(required_plugin_tier):
            return ToolMessage(
                content=(
                    f"[LicenseGate] 工具 `{tool_name}` 由 Plugin 提供，至少需要 `{required_plugin_tier}` 版本。"
                    f"当前为 `{self._current_tier()}`。请安装对应 Plugin 并升级授权。"
                ),
                tool_call_id=str(tool_call.get("id") or ""),
                name=tool_name,
                status="error",
            )

        allowed = self._allowed_tools()
        if "*" in allowed or tool_name in allowed:
            return handler(request)
        return ToolMessage(
            content=(
                f"[LicenseGate] 当前授权层级 `{self._current_tier()}` 不允许使用工具 `{tool_name}`。"
                "请切换为已授权工具或升级授权。"
            ),
            tool_call_id=str(tool_call.get("id") or ""),
            name=tool_name,
            status="error",
        )

    async def awrap_tool_call(self, request: ToolCallRequest, handler):
        # wrap_tool_call 是同步的，内部 return handler(request) 在异步链下会得到 coroutine，必须在此 await
        result = self.wrap_tool_call(request, handler)
        return await result if asyncio.iscoroutine(result) else result

