"""编辑器工具节点 - 直接工具调用，无 LLM"""
import sys
import json
from pathlib import Path
from typing import Optional

# 添加项目根目录到 Python 路径
backend_root = Path(__file__).parent.parent.parent
if str(backend_root) not in sys.path:
    sys.path.insert(0, str(backend_root))

from engine.state.agent_state import AgentState
from langchain_core.messages import AIMessage
from langchain_core.runnables import RunnableConfig
import logging

logger = logging.getLogger(__name__)


def _to_bool(raw) -> bool:
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, str):
        return raw.strip().lower() in {"1", "true", "yes", "on"}
    return False


def _is_editor_op_allowed(mode: str, operation: str, plan_confirmed: bool) -> tuple[bool, str]:
    mutating_ops = {"write_file", "delete_file", "file_sync"}
    if operation not in mutating_ops:
        return True, ""
    m = (mode or "agent").strip().lower()
    if m == "ask":
        return False, "Ask 模式不允许通过 editor_tool 执行写入/删除操作。"
    if m == "review":
        return False, "Review 模式不允许通过 editor_tool 修改文件。"
    if m == "plan" and not plan_confirmed:
        return False, "Plan 模式确认前不允许通过 editor_tool 执行写入/删除操作。"
    return True, ""


def _resolve_workspace_path(file_path: str) -> tuple[Optional[Path], Optional[str]]:
    try:
        from backend.tools.base.paths import get_workspace_root
        ws = get_workspace_root().resolve()
    except Exception as e:
        logger.warning("editor_tool 工作区根目录获取失败，不降级到 cwd 以避免越权: %s", e)
        return None, "工作区根目录获取失败，无法解析路径"
    raw = str(file_path or "").strip()
    if not raw:
        return None, "缺少 file_path"
    p = Path(raw)
    if not p.is_absolute():
        p = ws / p
    try:
        resolved = p.resolve()
    except Exception as e:
        return None, f"路径解析失败: {e}"
    if resolved != ws and ws not in resolved.parents:
        return None, f"路径越界: {resolved}"
    return resolved, None


def _fallback_editor_op(operation: str, file_path: str, file_content: Optional[str]) -> tuple[bool, str]:
    target, err = _resolve_workspace_path(file_path)
    if err or target is None:
        return False, err or "路径无效"

    try:
        if operation == "read_file":
            if not target.exists() or not target.is_file():
                return False, f"文件不存在: {target}"
            return True, target.read_text(encoding="utf-8")

        if operation == "write_file" or operation == "file_sync":
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("" if file_content is None else str(file_content), encoding="utf-8")
            return True, f"已写入: {target}"

        if operation == "list_directory":
            if not target.exists() or not target.is_dir():
                return False, f"目录不存在: {target}"
            items = []
            for child in sorted(target.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower())):
                items.append(
                    {
                        "name": child.name,
                        "path": str(child),
                        "type": "directory" if child.is_dir() else "file",
                    }
                )
            return True, json.dumps(items, ensure_ascii=False)

        if operation == "delete_file":
            if not target.exists():
                return True, f"文件不存在，无需删除: {target}"
            if target.is_dir():
                return False, f"不支持删除目录: {target}"
            target.unlink()
            return True, f"已删除: {target}"

        return False, f"不支持的操作: {operation}"
    except Exception as e:
        return False, f"执行失败: {e}"


def editor_tool_node(state: AgentState, config: Optional[RunnableConfig] = None) -> AgentState:
    """
    ✅ 编辑器工具节点 - 官方标准实现
    
    职责：
    - 直接调用工具，不经过 LLM
    - 适用于确定性操作（读写文件、格式化等）
    - 返回标准的 AIMessage
    
    ℹ️  从消息的 additional_kwargs 中提取操作信息（不从 state）
    ℹ️  返回 {"messages": [AIMessage]} 格式
    """
    try:
        from backend.tools.base.registry import get_core_tool_by_name
        
        last_message = state["messages"][-1] if state.get("messages") else None
        if not last_message:
            return {"messages": [AIMessage(content="无可执行的操作")]}
        
        # ✅ 从消息的 additional_kwargs 中提取操作信息（官方方式）
        kwargs = getattr(last_message, 'additional_kwargs', {}) or {}
        operation = kwargs.get('operation')
        file_path = kwargs.get('file_path')
        file_content = kwargs.get('file_content')
        configurable = {}
        if isinstance(config, dict):
            maybe_cfg = config.get("configurable")
            if isinstance(maybe_cfg, dict):
                configurable = maybe_cfg
        mode = str(
            configurable.get("mode")
            or kwargs.get("mode")
            or "agent"
        )
        plan_confirmed = _to_bool(
            configurable.get("plan_confirmed")
            if "plan_confirmed" in configurable
            else kwargs.get("plan_confirmed")
        )
        
        logger.info(f"→ 工具执行: {operation} (文件: {file_path})")
        allowed, reason = _is_editor_op_allowed(mode, str(operation or ""), plan_confirmed)
        if not allowed:
            logger.warning("⛔ editor_tool 被模式门禁拦截: mode=%s operation=%s reason=%s", mode, operation, reason)
            return {
                "messages": [
                    AIMessage(
                        content=f"⛔ {reason}",
                        additional_kwargs={
                            "result": {
                                "success": False,
                                "error": reason,
                            }
                        },
                    )
                ]
            }
        
        tool_output = "工具未执行"
        tool_executed = False
        normalized_op = str(operation or "").strip()
        if normalized_op in {"file_sync"}:
            normalized_op = "write_file"

        # 优先尝试 registry 工具；若不可用则走本地安全兜底
        try:
            if normalized_op == "read_file" and file_path:
                tool = get_core_tool_by_name("read_file")
                tool_output = tool.invoke(file_path) if tool else "read_file 工具不可用"
                tool_executed = bool(tool)
            elif normalized_op == "write_file" and file_path and file_content is not None:
                tool = get_core_tool_by_name("write_file")
                tool_output = tool.invoke({"file_path": file_path, "content": file_content}) if tool else "write_file 工具不可用"
                tool_executed = bool(tool)
            elif normalized_op == "list_directory" and file_path:
                tool = get_core_tool_by_name("ls")
                tool_output = tool.invoke(file_path) if tool else "ls 工具不可用"
                tool_executed = bool(tool)
            elif normalized_op == "delete_file" and file_path:
                tool = get_core_tool_by_name("delete_file")
                tool_output = tool.invoke(file_path) if tool else "delete_file 工具不可用"
                tool_executed = bool(tool)
        except Exception as tool_err:
            logger.debug("editor_tool registry 调用失败，降级本地执行: %s", tool_err)

        if not tool_executed:
            fallback_ok, fallback_output = _fallback_editor_op(str(operation or ""), str(file_path or ""), file_content)
            tool_executed = fallback_ok
            tool_output = fallback_output
        
        # ✅ 官方标准：返回包含消息的状态更新
        # 格式与前端 langgraphApi.readFile 期望的一致
        return {
            "messages": [
                AIMessage(
                    content=tool_output if not tool_executed else f"✅ {operation} 完成",
                    additional_kwargs={
                        "tool_executed": operation,
                        "result": {
                            "success": tool_executed,
                            "content": tool_output if tool_executed else None,
                            "error": tool_output if not tool_executed else None
                        }
                    }
                )
            ]
        }
    
    except Exception as e:
        logger.error(f"❌ 工具执行失败: {e}", exc_info=True)
        
        # ✅ 官方标准：返回错误消息（格式与前端期望一致）
        return {
            "messages": [
                AIMessage(
                    content=f"工具执行出错：{e}",
                    additional_kwargs={
                        "result": {
                            "success": False,
                            "error": str(e)
                        }
                    }
                )
            ]
        }


__all__ = ["editor_tool_node"]


