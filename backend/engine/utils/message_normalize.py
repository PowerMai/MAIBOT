"""消息 content 归一化 - 供 router 与 deepagent 等节点统一使用，避免 list content 导致上游 API 400。"""
from typing import Any

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage


def content_blocks_to_str(content: Any) -> str:
    """将 content 为 list（content_blocks）或非字符串时转为单字符串。"""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict):
                t = block.get("type")
                if t == "text":
                    parts.append(str(block.get("text") or ""))
                elif t in ("reasoning", "thinking"):
                    parts.append(str(block.get("text") or block.get("thinking") or ""))
                elif t == "file":
                    f = block.get("file")
                    fn = (f.get("filename") or f.get("name") or "file") if isinstance(f, dict) else "file"
                    parts.append("[附件: %s]" % fn)
                elif t in ("image", "image_url"):
                    parts.append("[图片]")
                else:
                    parts.append(str(block.get("text") or block.get("content") or ""))
            elif isinstance(block, str):
                parts.append(block)
        return "\n".join(parts) if parts else ""
    return str(content)


def normalize_messages_content_to_string(messages: list) -> list:
    """将 messages 中所有 content 非 string 的消息转为 content 为 string，避免多轮后 state 中 list content 导致 400。
    支持 message 为 LangChain 对象或 dict（checkpoint 反序列化后可能为 dict）。"""
    if not messages:
        return messages
    out = []
    for m in messages:
        is_dict = isinstance(m, dict)
        c = m.get("content") if is_dict else getattr(m, "content", None)
        if isinstance(c, str):
            out.append(m)
            continue
        content_str = content_blocks_to_str(c)
        if is_dict:
            role = str((m.get("type") or m.get("role") or "")).lower()
            if role in ("human", "user"):
                out.append(HumanMessage(content=content_str, additional_kwargs=m.get("additional_kwargs") or {}))
            elif role == "system":
                out.append(SystemMessage(content=content_str, additional_kwargs=m.get("additional_kwargs") or {}))
            elif role in ("ai", "assistant"):
                out.append(AIMessage(
                    content=content_str,
                    tool_calls=m.get("tool_calls") or [],
                    additional_kwargs=m.get("additional_kwargs") or {},
                    response_metadata=m.get("response_metadata") or {},
                    id=m.get("id"),
                ))
            elif role == "tool":
                out.append(ToolMessage(content=content_str, tool_call_id=m.get("tool_call_id") or "", name=m.get("name")))
            else:
                out.append({**m, "content": content_str})
            continue
        if isinstance(m, AIMessage):
            out.append(AIMessage(
                content=content_str,
                tool_calls=getattr(m, "tool_calls", []) or [],
                additional_kwargs=getattr(m, "additional_kwargs", {}) or {},
                response_metadata=getattr(m, "response_metadata", {}) or {},
                id=getattr(m, "id", None),
            ))
        elif isinstance(m, HumanMessage):
            out.append(HumanMessage(content=content_str, additional_kwargs=getattr(m, "additional_kwargs", {}) or {}))
        elif isinstance(m, SystemMessage):
            out.append(SystemMessage(content=content_str, additional_kwargs=getattr(m, "additional_kwargs", {}) or {}))
        elif isinstance(m, ToolMessage):
            out.append(ToolMessage(content=content_str, tool_call_id=getattr(m, "tool_call_id", "") or "", name=getattr(m, "name", None)))
        else:
            out.append(m)
    return out
