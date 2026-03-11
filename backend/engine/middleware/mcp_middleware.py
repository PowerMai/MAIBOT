"""MCP middleware: dynamic tool loading + tool-call error handling."""

from __future__ import annotations

import os
from typing import Awaitable, Callable
import time
import asyncio
import concurrent.futures

import logging

from langchain.agents.middleware.types import AgentMiddleware, ToolCallRequest, ModelRequest, ModelResponse
from langchain_core.messages import ToolMessage
from langchain_core.tools import BaseTool
from langgraph.types import Command

logger = logging.getLogger(__name__)

RELOAD_INTERVAL_ENV = "MCP_RELOAD_INTERVAL_SECONDS"
MCP_TOOL_CALL_TIMEOUT_ENV = "MCP_TOOL_CALL_TIMEOUT_SECONDS"


def _reload_interval_seconds() -> float:
    try:
        return max(5.0, float(os.environ.get(RELOAD_INTERVAL_ENV, "30.0")))
    except (TypeError, ValueError):
        return 30.0


def _mcp_tool_call_timeout() -> float:
    try:
        return max(5.0, float(os.environ.get(MCP_TOOL_CALL_TIMEOUT_ENV, "60.0")))
    except (TypeError, ValueError):
        return 60.0


class MCPMiddleware(AgentMiddleware):
    """Manage MCP tools and handle MCP call failures at runtime. Safe for singleton reuse; no per-request state."""

    RELOAD_INTERVAL_SECONDS = 10.0

    def __init__(self) -> None:
        self.tools: list[BaseTool] = []
        self._tool_names: set[str] = set()
        self._last_reload_ts = 0.0
        self._reload_interval = _reload_interval_seconds()
        self._tool_call_timeout = _mcp_tool_call_timeout()

    def reload_tools(self) -> list[BaseTool]:
        """Reload tools from MCP manager so UI-side changes can take effect."""
        try:
            from tools.mcp import get_all_mcp_tools, get_all_mcp_tools_async
            try:
                asyncio.get_running_loop()
                # 已有事件循环时，避免直接 asyncio.run 导致 RuntimeError
                with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
                    future = executor.submit(asyncio.run, get_all_mcp_tools_async())
                    self.tools = list(future.result(timeout=10.0) or [])
            except RuntimeError:
                # 无运行中的事件循环，可直接 asyncio.run
                self.tools = list(asyncio.run(get_all_mcp_tools_async()) or [])
            except Exception:
                self.tools = list(get_all_mcp_tools() or [])
            self._tool_names = {str(getattr(t, "name", "") or "") for t in self.tools}
            if logger.isEnabledFor(logging.DEBUG):
                logger.debug("[MCPMiddleware] loaded tools=%d", len(self.tools))
        except ImportError:
            self.tools = []
            self._tool_names = set()
            logger.info("[MCPMiddleware] MCP module unavailable, skip loading tools")
        except Exception as exc:
            # 保留上一批 tools，避免一次异常导致所有 MCP 工具不可用
            logger.warning("[MCPMiddleware] reload tools failed (keeping previous tools): %s", exc)
        self._last_reload_ts = time.time()
        return self.tools

    def _reload_if_stale(self) -> None:
        if time.time() - self._last_reload_ts >= self._reload_interval:
            self.reload_tools()

    def wrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], ModelResponse],
    ):
        self._reload_if_stale()
        return handler(request)

    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelResponse]],
    ) -> ModelResponse:
        if time.time() - self._last_reload_ts >= self._reload_interval:
            loop = asyncio.get_running_loop()
            await loop.run_in_executor(None, self.reload_tools)
        return await handler(request)

    def _is_mcp_tool(self, tool_name: str) -> bool:
        return tool_name in self._tool_names or tool_name.startswith("mcp_")

    @staticmethod
    def _get_mode(request: ToolCallRequest) -> str:
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
    def _is_mutating_mcp_call(tool_name: str, tool_args: dict) -> bool:
        lowered_name = str(tool_name or "").lower()
        mutate_keywords = (
            "write", "edit", "delete", "remove", "create", "update",
            "upsert", "append", "insert", "save", "sync", "apply", "commit",
            "post", "put", "patch",
        )
        if any(k in lowered_name for k in mutate_keywords):
            return True
        if not isinstance(tool_args, dict):
            return False
        op = str(tool_args.get("operation") or tool_args.get("action") or "").lower()
        if any(k in op for k in mutate_keywords):
            return True
        # 出现内容写入字段时视为潜在修改
        payload_keys = {"content", "body", "payload", "patch", "diff", "data"}
        for k in payload_keys:
            if k in tool_args and tool_args.get(k) not in (None, "", [], {}):
                return True
        return False

    def wrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], ToolMessage | Command],
    ) -> ToolMessage | Command:
        self._reload_if_stale()
        tool_name = request.tool_call.get("name", "")
        if not self._is_mcp_tool(tool_name):
            return handler(request)
        mode = self._get_mode(request)
        tool_args = request.tool_call.get("args", {}) if isinstance(request.tool_call, dict) else {}
        if mode in {"ask", "review"} and self._is_mutating_mcp_call(tool_name, tool_args if isinstance(tool_args, dict) else {}):
            return ToolMessage(
                content=f"[MCPPermission] 模式 `{mode}` 下禁止调用可能修改状态的 MCP 工具 `{tool_name}`。",
                tool_call_id=str(request.tool_call.get("id") or ""),
                name=tool_name,
                status="error",
            )
        try:
            return handler(request)
        except (ConnectionError, TimeoutError, OSError) as exc:
            return ToolMessage(
                content=f"MCP server disconnected for '{tool_name}': {exc}",
                tool_call_id=str(request.tool_call.get("id") or ""),
                name=tool_name,
                status="error",
            )
        except Exception as exc:
            logger.warning("MCP tool call error for '%s': %s", tool_name, exc, exc_info=False)
            return ToolMessage(
                content=f"MCP tool error for '{tool_name}': {exc}",
                tool_call_id=str(request.tool_call.get("id") or ""),
                name=tool_name,
                status="error",
            )

    async def awrap_tool_call(self, request: ToolCallRequest, handler):
        tool_name = request.tool_call.get("name", "")
        if not self._is_mcp_tool(tool_name):
            result = handler(request)
            return await result if asyncio.iscoroutine(result) else result
        timeout = self._tool_call_timeout
        loop = asyncio.get_running_loop()
        try:
            if asyncio.iscoroutinefunction(handler):
                result = await asyncio.wait_for(handler(request), timeout=timeout)
            else:
                result = await asyncio.wait_for(
                    loop.run_in_executor(None, lambda: handler(request)),
                    timeout=timeout,
                )
            return result
        except asyncio.TimeoutError:
            return ToolMessage(
                content=f"MCP tool '{tool_name}' timed out after {timeout}s",
                tool_call_id=str(request.tool_call.get("id") or ""),
                name=tool_name,
                status="error",
            )
        except (ConnectionError, TimeoutError, OSError) as exc:
            return ToolMessage(
                content=f"MCP server disconnected for '{tool_name}': {exc}",
                tool_call_id=str(request.tool_call.get("id") or ""),
                name=tool_name,
                status="error",
            )
        except Exception as exc:
            logger.warning("MCP tool call error for '%s': %s", tool_name, exc, exc_info=False)
            return ToolMessage(
                content=f"MCP tool error for '{tool_name}': {exc}",
                tool_call_id=str(request.tool_call.get("id") or ""),
                name=tool_name,
                status="error",
            )

