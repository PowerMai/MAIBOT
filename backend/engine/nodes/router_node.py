"""路由决策节点 - 纯函数，无 LLM 调用"""
from typing import Literal, Optional
import sys
from pathlib import Path

# 添加项目根目录到 Python 路径
backend_root = Path(__file__).parent.parent.parent
if str(backend_root) not in sys.path:
    sys.path.insert(0, str(backend_root))

from engine.state.agent_state import AgentState
from langchain_core.messages import HumanMessage
from langchain_core.runnables import RunnableConfig
import logging

logger = logging.getLogger(__name__)


def router_node(state: AgentState, config: Optional[RunnableConfig] = None) -> AgentState:
    """
    ✅ 路由节点（扩展点）- 官方标准实现，支持 LangGraph Config
    
    职责（官方标准）：
    - 提取路由信息（用于路由决策）
    - 验证消息格式
    - 读取并记录配置信息（模型、任务、权限等）
    - 不修改 state（除了必要的消息提取）
    
    ℹ️  路由信息来自 messages[-1].additional_kwargs：
        - source: "chatarea" | "editor" | "system"
        - request_type: "agent_chat" | "complex_operation" | "tool_command" | "file_sync"
    
    ℹ️  配置信息来自 config.configurable：
        - model_id: 选择的模型
        - task_type: 任务类型
        - user_role: 用户角色
        - debug_mode: 调试模式
    
    ℹ️  文件已在消息的 content blocks 中（官方格式）
    ℹ️  不复制任何信息到 state（state 保持最小化）
    """
    try:
        from backend.engine.core.configurable_check import validate_configurable
        validate_configurable(config)
    except Exception as e:
        logger.debug("configurable 校验跳过: %s", e)
    if config and logger.isEnabledFor(logging.INFO):
        from backend.engine.utils.config_manager import get_config_manager
        config_mgr = get_config_manager(config)
        if config_mgr.model_id:
            logger.info("🎯 Config 模型: %s", config_mgr.model_id)
        if config_mgr.task_type != "chat":
            logger.info("📋 Config 任务类型: %s", config_mgr.task_type)
        if config_mgr.debug_mode and logger.isEnabledFor(logging.DEBUG):
            config_mgr.log_config("[router_node]")
    
    # ✅ 关键：当前仅作为“扩展点”保留，默认不改写状态，返回空 dict
    # LangGraph 的 operator.add reducer 会将返回值中的 messages 追加到已有 state，
    # 如果返回 state（包含所有已有 messages），会导致消息被重复追加！
    # 正确做法：路由节点不修改 state，返回空 dict
    logger.debug("router_node: 消息已按官方格式接收，路由信息在 additional_kwargs")
    return {}


def route_decision(state: AgentState) -> Literal["deepagent", "editor_tool", "error"]:
    """
    ✅ 路由决策函数 - 官方标准实现
    
    从消息的 additional_kwargs 中提取路由信息（不从 state）
    
    路由逻辑：
    - chatarea（对话框）→ deepagent（完整的智能处理）
    - editor + complex_operation（复杂编辑）→ deepagent
    - editor + tool_command（快速工具）→ editor_tool（无 LLM）
    - system + file_sync（文件同步）→ editor_tool
    - 其他 → 继续 deepagent（默认）
    """
    try:
        messages = state.get("messages", []) if isinstance(state, dict) else []
        if not messages:
            logger.warning("路由决策失败：messages 为空，转入 error 节点")
            return "error"
        last_message = messages[-1]
    except Exception:
        logger.exception("路由决策读取 state 失败，转入 error 节点")
        return "error"
    
    # ✅ 从消息的 additional_kwargs 中提取路由信息
    kwargs = getattr(last_message, "additional_kwargs", {}) or {}
    source = kwargs.get("source", "chatarea")
    request_type = kwargs.get("request_type", "agent_chat")
    skill_profile = str(kwargs.get("skill_profile", "") or "").strip().lower()
    task_type = str(kwargs.get("task_type", "") or "").strip().lower()
    
    # ============================================================
    # 对话框 → DeepAgent（完整的智能处理）
    # ============================================================
    if source == "chatarea":
        logger.info("🎯 路由决策: chatarea → deepagent（智能对话）")
        return "deepagent"
    
    # ============================================================
    # 编辑器复杂操作 → DeepAgent
    # ============================================================
    elif source == "editor" and request_type == "complex_operation":
        logger.info("🎯 路由决策: editor + complex → deepagent（智能编辑）")
        return "deepagent"
    
    # ============================================================
    # 编辑器快速工具 → 直接工具执行（无 LLM）
    # ============================================================
    elif source == "editor" and request_type == "tool_command":
        logger.info("🎯 路由决策: editor + tool → editor_tool（快速工具）")
        return "editor_tool"
    
    # ============================================================
    # 系统级文件同步 → 直接工具执行
    # ============================================================
    elif source == "system" and request_type == "file_sync":
        logger.info("🎯 路由决策: system + file_sync → editor_tool（文件同步）")
        return "editor_tool"

    # ============================================================
    # 本体工程场景（先复用 deepagent，后续可拆为专用节点）
    # ============================================================
    elif skill_profile in {"ontology", "knowledge"}:
        logger.info("🎯 路由决策: skill_profile=%s → deepagent（本体/知识增强）", skill_profile)
        return "deepagent"

    # ============================================================
    # 自主准备/本体自优化任务（先复用 deepagent）
    # ============================================================
    elif task_type in {
        "autonomous_prep",
        "ontology_self_improve",
        "inbox_triage",
        "knowledge_digest",
        "resource_scan",
        "learning_maintenance",
        "distillation_export",
    }:
        logger.info("🎯 路由决策: task_type=%s → deepagent（自治任务）", task_type)
        return "deepagent"

    # ============================================================
    # A2A 中继任务（先走 editor_tool，便于无 LLM 转发）
    # ============================================================
    elif request_type in {"a2a_relay", "external_a2a"}:
        logger.info("🎯 路由决策: request_type=%s → editor_tool（A2A中继）", request_type)
        return "editor_tool"
    
    # ============================================================
    # 其他情况 → 默认使用 DeepAgent
    # ============================================================
    else:
        logger.info(f"ℹ️  路由: source={source}, request_type={request_type} → deepagent（默认）")
        return "deepagent"


__all__ = ["router_node", "route_decision"]


