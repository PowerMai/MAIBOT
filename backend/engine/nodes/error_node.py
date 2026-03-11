"""错误处理节点 - 官方标准实现"""
import sys
from pathlib import Path

# 添加项目根目录到 Python 路径
backend_root = Path(__file__).parent.parent.parent
if str(backend_root) not in sys.path:
    sys.path.insert(0, str(backend_root))

from engine.state.agent_state import AgentState
from langchain_core.messages import AIMessage
import logging

logger = logging.getLogger(__name__)


def error_node(state: AgentState) -> AgentState:
    """
    ✅ 错误处理节点 - 官方标准实现
    
    职责：
    - 处理无法路由或执行失败的请求
    - 返回友好的错误消息
    - 记录错误日志
    
    ℹ️  返回包含错误信息的 AIMessage
    ℹ️  错误信息在消息 content 中，而不是 state 中
    """
    last_message = state.get("messages", [])[-1] if state.get("messages") else None
    
    if last_message is None:
        error_message = "无效的请求：没有消息"
    else:
        # 从消息的 additional_kwargs 中获取路由信息
        kwargs = getattr(last_message, 'additional_kwargs', {}) or {}
        source = kwargs.get('source', 'unknown')
        request_type = kwargs.get('request_type', 'unknown')
        
        error_message = (
            f"抱歉，无法处理您的请求。\n"
            f"请求来源: {source}\n"
            f"请求类型: {request_type}\n"
            f"请提供更明确的指令。"
        )
        logger.error(f"❌ 路由错误: source={source}, request_type={request_type}")
    
    # ✅ 返回包含错误信息的 AIMessage（官方标准）
    return {
        "messages": [
            AIMessage(content=error_message)
        ]
    }


__all__ = ["error_node"]


