"""
Diff 审批中间件：在 HumanInTheLoop 的 interrupt 负载中为 write_file/edit_file/delete_file 注入 diff/preview，
供前端在聊天区展示执行详情（diff 或预览）及接受/拒绝按钮。
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from langchain.agents.middleware.human_in_the_loop import (
    HumanInTheLoopMiddleware,
    ActionRequest,
    ReviewConfig,
)
from langchain.agents.middleware.types import AgentState
from langgraph.runtime import Runtime

from backend.tools.base.paths import get_workspace_root

logger = logging.getLogger(__name__)

DIFF_TOOLS = {"write_file", "edit_file", "delete_file", "write_file_binary"}
PREVIEW_TOOLS = {"shell_run", "python_run"}


def _get_workspace_root_from_runtime(runtime: Runtime) -> Path:
    try:
        ctx = getattr(runtime, "context", None) or {}
        if callable(ctx):
            ctx = ctx() or {}
        configurable = ctx.get("configurable", {}) if isinstance(ctx, dict) else {}
        wp = configurable.get("workspace_path") or ""
        if wp and Path(wp).is_dir():
            return Path(wp).resolve()
    except Exception as e:
        logger.debug("diff_approval: get workspace from runtime: %s", e)
    return get_workspace_root()


def _prepare_diff_for_tool(tool_name: str, tool_args: dict[str, Any], workspace_root: Path) -> dict[str, Any] | None:
    """为需审批的工具准备 diff 或 preview，供前端展示。"""
    if tool_name == "write_file":
        path = (tool_args.get("file_path") or tool_args.get("path") or "").strip()
        content = tool_args.get("content") or ""
        if not path:
            return {"preview": "新建文件（路径为空）", "path": ""}
        full = (workspace_root / path.lstrip("/")).resolve()
        try:
            if full.exists() and full.is_file():
                original = full.read_text(encoding="utf-8", errors="replace")
                return {"original": original, "modified": content, "path": path}
        except Exception as e:
            logger.debug("diff_approval read_file for write_file: %s", e)
        return {"original": "", "modified": content, "path": path}

    if tool_name == "edit_file":
        old_s = tool_args.get("old_string") or tool_args.get("old_str") or ""
        new_s = tool_args.get("new_string") or tool_args.get("new_str") or ""
        path = (tool_args.get("file_path") or tool_args.get("path") or "").strip()
        return {"original": old_s, "modified": new_s, "path": path}

    if tool_name == "delete_file":
        path = (tool_args.get("file_path") or tool_args.get("path") or "").strip()
        full = (workspace_root / path.lstrip("/")).resolve() if path else None
        exists = full.exists() and full.is_file() if full else False
        return {"path": path, "preview": f"将删除: {path}" + ("（文件存在）" if exists else "（文件不存在）")}

    if tool_name == "write_file_binary":
        path = (tool_args.get("file_path") or "").strip()
        content = tool_args.get("content") or ""
        size_hint = f", base64 约 {len(content)} 字符" if content else ""
        return {"path": path, "preview": f"将写入二进制文件: {path}{size_hint}", "binary": True}

    if tool_name == "shell_run":
        cmd = (tool_args.get("command") or tool_args.get("cmd") or "").strip()
        return {"preview": f"即将执行命令:\n{cmd}" if cmd else "命令为空"}

    if tool_name == "python_run":
        code = (tool_args.get("code") or "").strip()
        preview = (code[:500] + "…") if len(code) > 500 else code
        return {"preview": f"即将执行代码:\n{preview}" if preview else "代码为空"}

    return None


class DiffAwareHumanInTheLoopMiddleware(HumanInTheLoopMiddleware):
    """
    在 HITL 的 action_request 中为 write_file/edit_file/delete_file 注入 diff 或 preview，
    前端可据此在聊天区展示 InlineDiffView + 接受/拒绝。
    """

    def _create_action_and_config(
        self,
        tool_call: dict[str, Any],
        config: dict[str, Any],
        state: AgentState[Any],
        runtime: Runtime[Any],
    ) -> tuple[ActionRequest, ReviewConfig]:
        action_request, review_config = super()._create_action_and_config(
            tool_call, config, state, runtime
        )
        tool_name = (tool_call.get("name") or "").strip().lower()
        tool_args = tool_call.get("args") or {}
        if tool_name not in DIFF_TOOLS and tool_name not in PREVIEW_TOOLS:
            return action_request, review_config
        workspace_root = _get_workspace_root_from_runtime(runtime)
        diff_data = _prepare_diff_for_tool(tool_name, tool_args, workspace_root)
        if diff_data:
            # 注入 diff/preview 为额外键，interrupt 负载会原样传到前端
            action_request = {**dict(action_request), "diff": diff_data}
        return action_request, review_config
