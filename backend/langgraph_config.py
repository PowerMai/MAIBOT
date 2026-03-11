"""
LangGraph Server 的配置 - 官方标准实现

✅ 遵循 LangChain 官方标准：
- 输入格式：{"messages": [BaseMessage, ...]}
- 输出格式：{"messages": [BaseMessage, ...]}
"""

from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any


class AgentInput(BaseModel):
    """
    ✅ Agent 输入定义 - 官方标准
    
    遵循 LangChain 官方标准：
    - 使用 messages 字段来传递消息列表
    - 每条消息都是标准的 BaseMessage 格式
    """
    messages: List[Dict[str, Any]] = Field(
        ...,
        description="消息列表（标准 LangChain BaseMessage 格式）"
    )


class AgentOutput(BaseModel):
    """
    ✅ Agent 输出定义 - 官方标准
    
    遵循 LangChain 官方标准：
    - 使用 messages 字段来返回消息列表
    - 所有数据都在消息的 content 中
    """
    messages: List[Dict[str, Any]] = Field(
        ...,
        description="消息列表（标准 LangChain BaseMessage 格式）"
    )


# ℹ️  注意：以下类型仅用于后向兼容性或特殊用途
# 不应该在主流程中使用，应该使用 messages 字段来传递所有数据

class AttachmentInfo(BaseModel):
    """附件信息（用于特殊场景，不推荐在主流程中使用）"""
    name: str = Field(..., description="文件名")
    content: str = Field(..., description="文件内容")
    extension: Optional[str] = Field(None, description="文件扩展名")
    size: Optional[int] = Field(None, description="文件大小")


class ContextInfo(BaseModel):
    """上下文信息（用于特殊场景，不推荐在主流程中使用）"""
    namespace: Optional[str] = Field(None, description="命名空间")
    attachments: Optional[List[AttachmentInfo]] = Field(None, description="附件列表")
    user_id: Optional[str] = Field(None, description="用户ID")
    session_id: Optional[str] = Field(None, description="会话ID")

