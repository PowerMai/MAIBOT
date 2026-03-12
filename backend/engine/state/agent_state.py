"""统一的 Agent State 定义 - 严格遵循 LangChain 官方标准"""
from typing import Annotated
from langchain_core.messages import AnyMessage
from langgraph.graph.message import add_messages
from typing_extensions import TypedDict


class AgentState(TypedDict):
    """
    主 Graph 的状态 - 官方标准的最小化定义
    
    ✅ 遵循 LangChain 官方设计原则：
    - 状态只保存必要字段
    - 所有信息通过 messages 传递
    - messages 使用 Annotated + add_messages 作为 reducer
    
    ℹ️  路由信息（source, request_type 等）从消息的 additional_kwargs 中提取
    ℹ️  执行结果、错误信息等都放在消息内容中，不在 state 中
    ℹ️  content 归一化在 router_node、deepagent 入口、yield 前完成（无自定义 reducer 以保证后端起得来）
    """
    messages: Annotated[list[AnyMessage], add_messages]


__all__ = ["AgentState"]


