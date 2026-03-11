"""消息内容修复中间件

修复本地模型（seed-oss-36b, qwen 等）的常见问题：
1. 当 AIMessage.content 为 None 时，Jinja 模板会报错
2. 消息格式不正确导致的解析错误
3. 重复的系统消息导致的上下文混乱

错误信息：
"Cannot perform operation in on undefined values"

根本原因：
seed-oss-36b 的 Jinja 模板中有这样的代码：
```jinja
{%- elif message.role in ["user", "system"] %}
{{ bos_token + message.role + "\n" + message.content + eos_token }}
```
当 message.content 为 None 时，字符串拼接会失败。
本中间件在送入 LM 前统一将 content 置为 ""，避免模板报错；若 LM 侧模板支持，可同时使用 message.content or "" 兜底。
"""
from typing import Any, Callable, List
from langchain.agents.middleware.types import AgentMiddleware, ModelRequest
from langchain_core.messages import BaseMessage, AIMessage, HumanMessage, SystemMessage, ToolMessage
import hashlib
import logging
import os

logger = logging.getLogger(__name__)

DEBUG_400_REQUEST = str(os.environ.get("DEBUG_400_REQUEST", "0")).strip().lower() in ("1", "true", "yes")


class ContentFixMiddleware(AgentMiddleware):
    """修复消息内容的中间件

    内部维护上次修复的消息数（_prev_len）和 id 指纹，
    当消息列表未增长时跳过遍历以减少热路径开销。
    
    功能：
    1. 确保所有消息的 content 不为 None
    2. 合并重复的系统消息（避免丢失重要内容）
    3. 修复消息格式问题
    """
    
    def __init__(self, dedupe_system_messages: bool = True, max_system_messages: int = 10):
        """
        Args:
            dedupe_system_messages: 是否去重系统消息
            max_system_messages: 最多保留的系统消息数量（默认 10，避免误删重要块）
        """
        self.dedupe_system_messages = dedupe_system_messages
        self.max_system_messages = max_system_messages
        self._prev_msg_len = 0
        self._prev_sig: str | None = None  # 稳定签名，用于热路径跳过（不依赖 id()）
    
    def _fix_message(self, message: BaseMessage) -> BaseMessage:
        """修复单条消息的 content。支持 dict 形式（前端/ reducer 未反序列化时），归一为 LangChain 消息且 content 为 string。"""
        if isinstance(message, dict):
            c = message.get("content")
            content_str = "" if c is None else (c if isinstance(c, str) else self._content_blocks_to_string(c))
            role = str((message.get("type") or message.get("role") or "")).lower()
            if role in ("human", "user"):
                return HumanMessage(content=content_str, additional_kwargs=message.get("additional_kwargs") or {})
            if role in ("system",):
                return SystemMessage(content=content_str, additional_kwargs=message.get("additional_kwargs") or {})
            if role in ("ai", "assistant"):
                return AIMessage(
                    content=content_str,
                    tool_calls=message.get("tool_calls") or [],
                    additional_kwargs=message.get("additional_kwargs") or {},
                    response_metadata=message.get("response_metadata") or {},
                    id=message.get("id"),
                )
            if role == "tool":
                return ToolMessage(content=content_str, tool_call_id=message.get("tool_call_id") or "", name=message.get("name"))
            return HumanMessage(content=content_str, additional_kwargs=message.get("additional_kwargs") or {})
        # 处理 content 为 None 的情况
        if message.content is None:
            if isinstance(message, AIMessage):
                # AIMessage 可能只有 tool_calls，没有 content
                return AIMessage(
                    content="",
                    tool_calls=getattr(message, 'tool_calls', []),
                    additional_kwargs=message.additional_kwargs,
                    response_metadata=getattr(message, 'response_metadata', {}),
                    id=getattr(message, 'id', None),
                )
            elif isinstance(message, HumanMessage):
                return HumanMessage(
                    content="",
                    additional_kwargs=message.additional_kwargs,
                )
            elif isinstance(message, SystemMessage):
                return SystemMessage(
                    content="",
                    additional_kwargs=message.additional_kwargs,
                )
            elif isinstance(message, ToolMessage):
                tool_call_id = getattr(message, 'tool_call_id', None) or ''
                return ToolMessage(
                    content="",
                    tool_call_id=tool_call_id,
                    additional_kwargs=message.additional_kwargs,
                )
            else:
                # 其他类型，尝试直接修改
                try:
                    message.content = ""
                except Exception:
                    pass
        
        # 处理 content 为非字符串的情况（如 list）：部分云端 API 只接受 content 为 string，list 会触发 400 No schema matches
        if message.content is not None and not isinstance(message.content, str):
            if isinstance(message.content, list):
                logger.debug("[ContentFix] content 为 list，转为 string 避免 No schema matches (msg type=%s)", type(message).__name__)
            content_str = self._content_blocks_to_string(message.content)
            if isinstance(message, AIMessage):
                return AIMessage(
                    content=content_str,
                    tool_calls=getattr(message, 'tool_calls', []) or [],
                    additional_kwargs=getattr(message, 'additional_kwargs', {}),
                    response_metadata=getattr(message, 'response_metadata', {}),
                    id=getattr(message, 'id', None),
                )
            if isinstance(message, HumanMessage):
                return HumanMessage(content=content_str, additional_kwargs=getattr(message, 'additional_kwargs', {}))
            if isinstance(message, SystemMessage):
                return SystemMessage(content=content_str, additional_kwargs=getattr(message, 'additional_kwargs', {}))
            if isinstance(message, ToolMessage):
                return ToolMessage(
                    content=content_str,
                    tool_call_id=getattr(message, 'tool_call_id', ''),
                    name=getattr(message, 'name', None),
                )
            try:
                message.content = content_str
            except Exception:
                message.content = ""
        return message
    
    @staticmethod
    def _ensure_system_first_single(messages: List[BaseMessage]) -> List[BaseMessage]:
        """模型调用前最后一道防线：将所有 SystemMessage 移到开头并合并为一条，满足「System message must be at the beginning」。
        解决第二轮及以后请求因 state 中夹带 loop_guidance/done_verifier 等中间 SystemMessage 导致 400。
        """
        if not messages:
            return messages
        system_parts: List[str] = []
        others: List[BaseMessage] = []
        for m in messages:
            if isinstance(m, SystemMessage):
                content = getattr(m, "content", None)
                if content is not None and (isinstance(content, str) and content.strip() or content):
                    system_parts.append(content if isinstance(content, str) else str(content))
            else:
                others.append(m)
        if not system_parts:
            return messages
        return [SystemMessage(content="\n\n".join(system_parts))] + others

    def _dedupe_system_messages(self, messages: List[BaseMessage]) -> List[BaseMessage]:
        """去重系统消息：先去除内容完全相同的重复项，超限时合并而非丢弃"""
        if not self.dedupe_system_messages:
            return messages
        
        system_messages = []
        other_messages = []
        
        for msg in messages:
            if isinstance(msg, SystemMessage):
                system_messages.append(msg)
            else:
                other_messages.append(msg)
        
        if len(system_messages) <= 1:
            return system_messages + other_messages
        
        # Phase 1: 去除内容完全相同的重复 SystemMessage
        seen_contents = set()
        unique_system = []
        for msg in system_messages:
            content_key = msg.content if isinstance(msg.content, str) else str(msg.content)
            if content_key not in seen_contents:
                seen_contents.add(content_key)
                unique_system.append(msg)
            else:
                logger.debug("[ContentFix] 去除重复系统消息（内容相同），长度: %d", len(content_key))
        
        deduped_count = len(system_messages) - len(unique_system)
        if deduped_count > 0:
            logger.info("[ContentFix] 去除 %d 条内容完全重复的系统消息", deduped_count)
        
        # Phase 2: 若去重后仍超限，合并为一条而非丢弃
        if len(unique_system) > self.max_system_messages:
            logger.warning(
                "[ContentFix] 系统消息数 %d 超过上限 %d，将合并为一条（可能存在多处注入系统消息的来源，需排查）",
                len(unique_system), self.max_system_messages,
            )
            # 合并所有系统消息内容为一条，避免丢失重要块
            merged_content = "\n\n".join(
                msg.content for msg in unique_system
                if isinstance(msg.content, str) and msg.content.strip()
            )
            unique_system = [SystemMessage(content=merged_content)]
        
        return unique_system + other_messages
    
    def _strip_empty_messages(self, messages: List[BaseMessage]) -> List[BaseMessage]:
        """移除对话历史中无意义的空消息（节省 token，减少噪声）
        
        保留规则：
        - SystemMessage：始终保留（即使空，已在 _dedupe 中处理）
        - AIMessage：有 tool_calls 时保留（即使 content 空）；否则 content 空则移除
        - ToolMessage：始终保留（工具返回，即使空也需要与 tool_call 配对）
        - HumanMessage：content 空则移除（无意义的空用户消息）
        """
        result = []
        removed = 0
        for msg in messages:
            if isinstance(msg, SystemMessage) or isinstance(msg, ToolMessage):
                result.append(msg)
            elif isinstance(msg, AIMessage):
                has_tool_calls = bool(getattr(msg, 'tool_calls', None))
                content = msg.content if isinstance(msg.content, str) else str(msg.content or "")
                if has_tool_calls or content.strip():
                    result.append(msg)
                else:
                    removed += 1
            elif isinstance(msg, HumanMessage):
                content = msg.content if isinstance(msg.content, str) else str(msg.content or "")
                if content.strip():
                    result.append(msg)
                else:
                    removed += 1
            else:
                result.append(msg)
        
        if removed > 0:
            logger.debug("[ContentFix] 移除 %d 条空内容消息", removed)
        return result
    
    def _truncate_long_tool_results(self, messages: List[BaseMessage], max_tool_content_chars: int = 30000) -> List[BaseMessage]:
        """截断过长的工具返回内容（防止单次工具调用撑爆上下文）
        
        典型场景：python_run 返回大量输出、read_file 读取大文件
        """
        result = []
        truncated = 0
        for msg in messages:
            if isinstance(msg, ToolMessage) and isinstance(msg.content, str) and len(msg.content) > max_tool_content_chars:
                truncated += 1
                truncated_content = msg.content[:max_tool_content_chars] + (
                    f"\n\n[... 工具返回已截断，原始长度 {len(msg.content)} chars，保留前 {max_tool_content_chars} chars ...]"
                )
                result.append(ToolMessage(
                    content=truncated_content,
                    tool_call_id=getattr(msg, 'tool_call_id', None) or '',
                    additional_kwargs=msg.additional_kwargs,
                ))
            else:
                result.append(msg)
        
        if truncated > 0:
            logger.info("[ContentFix] 截断 %d 条过长工具返回（>%d chars）", truncated, max_tool_content_chars)
        return result
    
    @staticmethod
    def _last_message_signature(messages: list) -> str | None:
        """生成最后一条消息的稳定签名，用于热路径跳过（不依赖 id()）。"""
        if not messages:
            return None
        last = messages[-1]
        if not isinstance(last, BaseMessage):
            return str(type(last).__name__)
        content = getattr(last, "content", None)
        typ = type(last).__name__
        if content is None:
            payload = f"{typ}:None"
        elif isinstance(content, str):
            payload = f"{typ}:len={len(content)}:{content[:80]!r}"
        else:
            payload = f"{typ}:nonstr"
        return hashlib.sha1(payload.encode("utf-8")).hexdigest()[:16]

    def _fix_messages(self, messages: list) -> list:
        """修复消息列表（合并遍历以减少开销）；消息未变时按稳定签名跳过全量处理。"""
        if not isinstance(messages, list):
            return messages
        # 模型调用前最后一道防线：system 置前并合并为一条，避免第二轮起 400「System message must be at the beginning」
        messages = self._ensure_system_first_single(messages)

        cur_len = len(messages)
        cur_sig = self._last_message_signature(messages)
        if (
            cur_len == self._prev_msg_len
            and cur_sig is not None
            and cur_sig == self._prev_sig
            and cur_len > 0
        ):
            return messages

        # 单次遍历：修复 content / tool_call_id + 过滤空消息 + 截断过长工具返回
        max_tool_chars = 30000
        fixed: list[BaseMessage] = []
        removed = 0
        truncated = 0
        for raw in messages:
            m = self._fix_message(raw) if isinstance(raw, BaseMessage) else raw
            if isinstance(m, ToolMessage):
                if getattr(m, 'tool_call_id', None) is None:
                    m = ToolMessage(
                        content=m.content or "",
                        tool_call_id="",
                        additional_kwargs=getattr(m, 'additional_kwargs', {}) or {},
                        id=getattr(m, 'id', None),
                    )
                if isinstance(m.content, str) and len(m.content) > max_tool_chars:
                    truncated += 1
                    m = ToolMessage(
                        content=m.content[:max_tool_chars] + f"\n\n[... 工具返回已截断，原始长度 {len(m.content)} chars ...]",
                        tool_call_id=getattr(m, 'tool_call_id', None) or '',
                        additional_kwargs=m.additional_kwargs,
                    )
                fixed.append(m)
            elif isinstance(m, AIMessage):
                has_tool_calls = bool(getattr(m, 'tool_calls', None))
                content = m.content if isinstance(m.content, str) else str(m.content or "")
                if has_tool_calls or content.strip():
                    fixed.append(m)
                else:
                    removed += 1
            elif isinstance(m, HumanMessage):
                content = m.content if isinstance(m.content, str) else str(m.content or "")
                if content.strip():
                    fixed.append(m)
                else:
                    removed += 1
            else:
                fixed.append(m)

        if removed > 0:
            logger.debug("[ContentFix] 移除 %d 条空内容消息", removed)
        if truncated > 0:
            logger.info("[ContentFix] 截断 %d 条过长工具返回（>%d chars）", truncated, max_tool_chars)

        # 去重系统消息（需要全局视角，单独遍历）
        fixed = self._dedupe_system_messages(fixed)

        # 发往云端前最后一道防线：确保每条消息 content 均为 string，避免 400 No schema matches
        fixed = self._normalize_rest_content_to_string(fixed)

        # 诊断统计（仅在需要时遍历）
        msg_count = len(fixed)
        if msg_count > 50:
            total_content_chars = 0
            type_counts: dict[str, int] = {}
            for m in fixed:
                t = type(m).__name__
                type_counts[t] = type_counts.get(t, 0) + 1
                if isinstance(m, BaseMessage) and isinstance(m.content, str):
                    total_content_chars += len(m.content)
            logger.warning(
                "[ContentFix] 对话历史较大: %d 条消息, %d chars | 分布: %s",
                msg_count, total_content_chars, type_counts,
            )
        elif logger.isEnabledFor(logging.DEBUG):
            total_chars = sum(len(m.content) for m in fixed if isinstance(m, BaseMessage) and isinstance(m.content, str))
            logger.debug("[ContentFix] 消息数: %d, 总内容: %d chars", msg_count, total_chars)

        self._prev_msg_len = len(fixed)
        self._prev_sig = self._last_message_signature(fixed)
        return fixed

    @staticmethod
    def _content_blocks_to_string(content: Any) -> str:
        """将 content_blocks（list）或任意 content 转为 API 可接受的单字符串，避免 No schema matches。
        带 @ 附件时前端会发 content 为 list（如 text + file 块），云端仅接受 string，故全部归一为字符串。"""
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
                        name = (block.get("file") or {}) if isinstance(block.get("file"), dict) else {}
                        if isinstance(name, dict):
                            name = name.get("filename") or name.get("name") or ""
                        parts.append("[附件: %s]" % (name or "file"))
                    elif t in ("image", "image_url"):
                        parts.append("[图片]")
                    else:
                        parts.append(str(block.get("text") or block.get("content") or ""))
                elif isinstance(block, str):
                    parts.append(block)
            return "\n".join(parts) if parts else ""
        return str(content)

    def _normalize_rest_content_to_string(self, rest: List[BaseMessage]) -> List[BaseMessage]:
        """将 rest 中 content 非 string 的消息替换为 content 为 string 的副本，满足只接受 string 的 API（避免 400 No schema matches）。
        带 @ 附件时前端可能发 content 为 list 或 dict 形式消息，此处统一归一为 string。"""
        out: List[BaseMessage] = []
        for m in rest:
            if isinstance(m, dict):
                c = m.get("content")
                if isinstance(c, str):
                    out.append(m)
                    continue
                content_str = self._content_blocks_to_string(c)
                role = str((m.get("type") or m.get("role") or "")).lower()
                if role in ("human", "user"):
                    out.append(HumanMessage(content=content_str, additional_kwargs=m.get("additional_kwargs") or {}))
                elif role in ("system",):
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
            c = getattr(m, "content", None)
            if isinstance(c, str):
                out.append(m)
                continue
            content_str = self._content_blocks_to_string(c)
            if isinstance(m, HumanMessage):
                out.append(HumanMessage(content=content_str, additional_kwargs=getattr(m, "additional_kwargs", {})))
            elif isinstance(m, AIMessage):
                out.append(AIMessage(
                    content=content_str,
                    tool_calls=getattr(m, "tool_calls", []) or [],
                    additional_kwargs=getattr(m, "additional_kwargs", {}),
                    response_metadata=getattr(m, "response_metadata", {}),
                    id=getattr(m, "id", None),
                ))
            elif isinstance(m, SystemMessage):
                out.append(SystemMessage(content=content_str, additional_kwargs=getattr(m, "additional_kwargs", {})))
            elif isinstance(m, ToolMessage):
                out.append(ToolMessage(
                    content=content_str,
                    tool_call_id=getattr(m, "tool_call_id", ""),
                    name=getattr(m, "name", None),
                ))
            else:
                out.append(m)
        return out

    @staticmethod
    def _fix_state_messages(state: Any, fixer: Callable[[list], list]) -> None:
        if state is None:
            return
        if hasattr(state, "messages"):
            result = fixer(state.messages)
            state.messages = result if result is not None else []
        elif isinstance(state, dict) and "messages" in state:
            result = fixer(state["messages"])
            if result is not None:
                state["messages"] = result
            else:
                state["messages"] = []
                logger.debug("[ContentFix] fixer 返回 None，已写回空列表避免下游报错")

    def _merge_leading_system_into_request(self, request: ModelRequest) -> ModelRequest:
        """若 request.messages 前若干条为 SystemMessage，全部合并到 request.system_message 并移除。
        框架用 [request.system_message, *request.messages] 发 API，必须保证 request.messages 不以 System 开头；
        若有多条连续 System（如 license_gate + 归一化），需全部剥掉并合并为一条。
        使用已修复的 state.messages 作为来源，避免把 content=None 等未修复消息传给 API 导致 No schema matches。"""
        state = getattr(request, "state", None)
        # 优先用 state.messages（已经 _fix_state_messages/_fix_messages 处理），否则用 request.messages
        if state is not None:
            messages = state.messages if hasattr(state, "messages") else (state.get("messages", []) if isinstance(state, dict) else [])
        else:
            messages = getattr(request, "messages", None) or []
        if not messages:
            return request
        # 剥掉所有前导 SystemMessage（含 content 为空的），合并非空内容
        leading_system_count = 0
        system_parts: List[str] = []
        for m in messages:
            if not isinstance(m, SystemMessage):
                break
            leading_system_count += 1
            content = getattr(m, "content", None)
            if content is not None and (isinstance(content, str) and content.strip() or content):
                if isinstance(content, list):
                    system_parts.append(self._content_blocks_to_string(content))
                else:
                    system_parts.append(content if isinstance(content, str) else str(content))
        rest = list(messages[leading_system_count:])
        if leading_system_count == 0:
            return request
        # 部分云端 API 只接受 content 为 string，content 为 list（content_blocks）会触发 No schema matches；归一为字符串再传出
        rest = self._normalize_rest_content_to_string(rest)
        existing = ""
        if getattr(request, "system_message", None) is not None:
            sm = request.system_message
            content_val = getattr(sm, "content", None)
            if isinstance(content_val, list):
                existing = self._content_blocks_to_string(content_val) or ""
            else:
                existing = getattr(sm, "text", None) or (sm.content if isinstance(content_val, str) else "") or ""
        merged = (existing + "\n\n" + "\n\n".join(system_parts)).strip() if existing else "\n\n".join(system_parts)
        if state is not None:
            if hasattr(state, "messages"):
                state.messages = rest
            elif isinstance(state, dict) and "messages" in state:
                state["messages"] = rest
        # 仅在有合并内容时覆盖 system_message，避免 SystemMessage(content="") 导致部分 API 返回 No schema matches
        if merged:
            return request.override(system_message=SystemMessage(content=merged), messages=rest)
        return request.override(messages=rest)

    @staticmethod
    def _request_shape_summary(request: ModelRequest) -> dict:
        """用于 400 诊断：请求体形状摘要（不包含敏感内容）。"""
        messages = getattr(request, "messages", None) or []
        system_msg = getattr(request, "system_message", None)
        n = len(messages) + (1 if system_msg else 0)
        content_types: List[str] = []
        if system_msg:
            c = getattr(system_msg, "content", None)
            content_types.append("system:" + ("str" if isinstance(c, str) else ("list" if isinstance(c, list) else type(c).__name__)))
        for m in messages:
            c = getattr(m, "content", None)
            role = getattr(m, "type", type(m).__name__)
            content_types.append(f"{role}:str" if isinstance(c, str) else f"{role}:list" if isinstance(c, list) else f"{role}:{type(c).__name__}")
        tools = getattr(request, "tools", None)
        tools_count = len(tools) if tools is not None and hasattr(tools, "__len__") else (0 if tools is None else "?")
        return {"message_count": n, "content_types": content_types, "has_tools": tools is not None and (tools_count != 0 if isinstance(tools_count, int) else True), "tools_count": tools_count}

    @staticmethod
    def _is_400_like(exc: BaseException) -> bool:
        msg = (getattr(exc, "message", "") or str(exc) or "").lower()
        return "400" in msg or "no schema matches" in msg or ("validation" in msg and "body" in msg)

    def wrap_model_call(self, request: ModelRequest, handler):
        self._fix_state_messages(getattr(request, "state", None), self._fix_messages)
        request = self._merge_leading_system_into_request(request)
        if DEBUG_400_REQUEST:
            try:
                return handler(request)
            except BaseException as e:
                if self._is_400_like(e):
                    logger.warning(
                        "[ContentFix] 400 诊断请求体形状: %s",
                        self._request_shape_summary(request),
                        exc_info=False,
                    )
                raise
        return handler(request)

    async def awrap_model_call(self, request: ModelRequest, handler):
        self._fix_state_messages(getattr(request, "state", None), self._fix_messages)
        request = self._merge_leading_system_into_request(request)
        if DEBUG_400_REQUEST:
            try:
                return await handler(request)
            except BaseException as e:
                if self._is_400_like(e):
                    logger.warning(
                        "[ContentFix] 400 诊断请求体形状: %s",
                        self._request_shape_summary(request),
                        exc_info=False,
                    )
                raise
        return await handler(request)
    
    def __call__(self, call_next: Callable) -> Callable:
        """中间件入口"""
        async def middleware(state: Any, config: Any = None) -> Any:
            # 兼容旧版调用路径
            self._fix_state_messages(state, self._fix_messages)
            
            # 调用下一个中间件
            return await call_next(state, config)
        
        return middleware


def create_content_fix_middleware(
    dedupe_system_messages: bool = True,
    max_system_messages: int = 10,
) -> ContentFixMiddleware:
    """创建消息内容修复中间件
    
    Args:
        dedupe_system_messages: 是否去重系统消息（默认 True）
        max_system_messages: 最多保留的系统消息数量（默认 10）
    """
    return ContentFixMiddleware(
        dedupe_system_messages=dedupe_system_messages,
        max_system_messages=max_system_messages,
    )
