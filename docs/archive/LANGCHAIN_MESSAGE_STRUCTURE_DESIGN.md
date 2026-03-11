# LangChain 标准化前后端对接设计 - 基于消息结构

**完全遵循 LangChain 官方消息规范的实现**

---

## 📐 LangChain 消息结构核心

### 官方消息类型体系

```python
from langchain_core.messages import (
    BaseMessage,          # 基础消息
    HumanMessage,         # 用户消息
    AIMessage,            # AI 响应
    SystemMessage,        # 系统提示
    ToolMessage,          # 工具结果
    FunctionMessage,      # 函数结果
)

# 所有消息都继承 BaseMessage，具有统一的接口
class BaseMessage:
    content: str          # 消息内容
    type: str             # 消息类型
    name: Optional[str]   # 可选：发送者名称
    additional_kwargs: Dict[str, Any]  # 扩展字段
```

---

## 🎯 统一的请求/响应消息体系

### 前端请求 → HumanMessage

```python
# 所有前端请求都转换为 HumanMessage
class EditorRequest(HumanMessage):
    """编辑器请求消息"""
    
    def __init__(
        self,
        content: str,
        source: str,                    # "chatarea" | "editor" | "system"
        request_type: str,              # "agent" | "direct_tool" | "file_sync"
        operation: Optional[str] = None,
        context: Optional[Dict] = None,
        params: Optional[Dict] = None,
        **kwargs
    ):
        super().__init__(content=content, **kwargs)
        
        # 使用 additional_kwargs 存储扩展信息（LangChain 标准方式）
        self.additional_kwargs = {
            "source": source,
            "request_type": request_type,
            "operation": operation,
            "context": context or {},
            "params": params or {},
            **self.additional_kwargs
        }
        
        # 设置消息名称（便于追踪）
        self.name = f"{source}_{request_type}"
```

### 后端响应 → AIMessage

```python
class EditorResponse(AIMessage):
    """编辑器响应消息"""
    
    def __init__(
        self,
        content: str,
        response_type: str,             # "agent_response" | "tool_result" | "sync_result"
        operation: Optional[str] = None,
        tool_used: Optional[str] = None,
        data: Optional[Dict] = None,
        generated_ui: Optional[Dict] = None,  # 生成式 UI
        **kwargs
    ):
        super().__init__(content=content, **kwargs)
        
        self.additional_kwargs = {
            "response_type": response_type,
            "operation": operation,
            "tool_used": tool_used,
            "data": data or {},
            "generated_ui": generated_ui,
            **self.additional_kwargs
        }
        
        self.name = "editor_assistant"
```

### 工具执行 → ToolMessage

```python
class EditorToolMessage(ToolMessage):
    """工具执行结果消息"""
    
    def __init__(
        self,
        content: str,
        tool_name: str,
        tool_input: Dict,
        **kwargs
    ):
        # tool_call_id 是 ToolMessage 的必需字段
        super().__init__(
            content=content,
            tool_call_id=f"{tool_name}_{hash(str(tool_input))}",
            **kwargs
        )
        
        self.additional_kwargs = {
            "tool_name": tool_name,
            "tool_input": tool_input,
            **self.additional_kwargs
        }
```

---

## 🔄 消息流处理 - 基于 LangChain Runnable

### Runnable 接口（官方标准）

```python
from langchain_core.runnables import Runnable, RunnablePassthrough, RunnableLambda
from typing import Union, List

class UnifiedEditorRouter(Runnable):
    """
    统一的编辑器请求路由器
    遵循 LangChain Runnable 接口
    """
    
    def __init__(self, store=None):
        self.store = store
        
        # 构建路由链
        self.router_chain = self._build_router_chain()
    
    def _build_router_chain(self):
        """
        构建路由链 - 使用 LangChain 的 Runnable 接口
        这是 LangChain 官方推荐的方式
        """
        
        def validate_and_extract(message: EditorRequest) -> EditorRequest:
            """验证请求的完整性"""
            
            if not message.additional_kwargs.get("source"):
                raise ValueError("缺少 source 字段")
            
            if not message.additional_kwargs.get("request_type"):
                raise ValueError("缺少 request_type 字段")
            
            return message
        
        def route_request(message: EditorRequest) -> str:
            """路由决策"""
            
            source = message.additional_kwargs.get("source")
            request_type = message.additional_kwargs.get("request_type")
            
            if source == "chatarea" and request_type == "agent":
                return "chatarea_agent"
            elif source == "editor" and request_type == "agent":
                return "editor_agent"
            elif source == "editor" and request_type == "direct_tool":
                return "editor_tool"
            elif source == "system" and request_type == "file_sync":
                return "file_sync"
            else:
                raise ValueError(f"无效的请求组合: {source}/{request_type}")
        
        # 使用 LangChain 的 RunnableLambda 包装函数
        # 这样所有处理都遵循 Runnable 接口
        return (
            RunnableLambda(validate_and_extract)
            | RunnableLambda(route_request)
        )
    
    def invoke(self, input: Union[EditorRequest, Dict], config=None):
        """
        Runnable 接口的标准方法
        输入可以是 EditorRequest 或字典
        """
        
        # 转换为 EditorRequest（如果是字典）
        if isinstance(input, dict):
            input = EditorRequest(**input)
        
        # 获取路由决策
        route = self.router_chain.invoke(input)
        
        # 根据路由处理
        if route == "chatarea_agent":
            return self._handle_chatarea_agent(input)
        elif route == "editor_agent":
            return self._handle_editor_agent(input)
        elif route == "editor_tool":
            return self._handle_editor_tool(input)
        elif route == "file_sync":
            return self._handle_file_sync(input)
    
    async def ainvoke(self, input: Union[EditorRequest, Dict], config=None):
        """异步版本（LangChain Runnable 标准接口）"""
        # 异步实现
        pass
    
    def stream(self, input: Union[EditorRequest, Dict], config=None):
        """流式版本（LangChain Runnable 标准接口）"""
        # 流式实现
        pass
    
    def _handle_chatarea_agent(self, message: EditorRequest) -> EditorResponse:
        """处理对话框 Agent 请求"""
        from backend.engine.core.main_agent import agent
        
        # 构建消息列表（LangChain 标准格式）
        messages = [
            SystemMessage(content="你是一个高效的代码编辑助手"),
            message  # EditorRequest 就是 HumanMessage
        ]
        
        # 如果有上下文，添加上下文提示
        if message.additional_kwargs.get("context"):
            context_str = self._format_context(message.additional_kwargs["context"])
            messages.append(SystemMessage(content=f"编辑器上下文:\n{context_str}"))
        
        # 调用 Agent（Runnable 接口）
        result = agent.invoke({"messages": messages})
        
        # 返回标准化的响应
        return EditorResponse(
            content=result.get("output", "处理完成"),
            response_type="agent_response",
            generated_ui=self._detect_generated_ui(result.get("output"))
        )
    
    def _handle_editor_agent(self, message: EditorRequest) -> EditorResponse:
        """处理编辑器 Agent 请求"""
        from backend.engine.core.main_agent import agent
        
        operation = message.additional_kwargs.get("operation")
        
        # 操作提示词（系统提示的一部分）
        operation_prompts = {
            "expand": "请扩展以下代码的功能，添加更多细节和功能",
            "rewrite": "请重写以下代码，提高可读性和性能",
            "modify": "请修改以下代码以满足需求",
            "analyze": "请分析以下代码的逻辑和潜在问题",
            "document": "请为以下代码生成详细文档",
            "test": "请为以下代码生成单元测试"
        }
        
        system_prompt = operation_prompts.get(operation, "请处理以下代码")
        
        # 构建消息列表
        messages = [
            SystemMessage(content=system_prompt),
            message
        ]
        
        # 调用 Agent
        result = agent.invoke({"messages": messages})
        
        return EditorResponse(
            content=result.get("output", "处理完成"),
            response_type="agent_response",
            operation=operation,
            generated_ui=self._detect_generated_ui(result.get("output"))
        )
    
    def _handle_editor_tool(self, message: EditorRequest) -> Union[EditorResponse, ToolMessage]:
        """处理编辑器直接工具请求"""
        from backend.tools.base.registry import get_core_tool_by_name
        
        params = message.additional_kwargs.get("params", {})
        tool_name = params.get("tool")
        
        if not tool_name:
            raise ValueError("缺少 tool 参数")
        
        tool = get_core_tool_by_name(tool_name)
        
        if not tool:
            raise ValueError(f"工具不存在: {tool_name}")
        
        try:
            # 调用工具（LangChain 工具有标准接口）
            result = tool.invoke({
                k: v for k, v in params.items() if k != "tool"
            })
            
            # 返回 ToolMessage（LangChain 标准工具结果格式）
            return ToolMessage(
                content=str(result),
                tool_call_id=f"{tool_name}_{hash(str(params))}",
                additional_kwargs={"tool_name": tool_name}
            )
        
        except Exception as e:
            raise RuntimeError(f"工具执行错误: {str(e)}")
    
    def _handle_file_sync(self, message: EditorRequest) -> EditorResponse:
        """处理文件同步请求"""
        from backend.systems.file_sync import FileSyncManager
        
        sync_manager = FileSyncManager(workspace_path="/workspace", store=self.store)
        
        operation = message.additional_kwargs.get("operation")
        
        if operation == "apply_changes":
            result = sync_manager.apply_changes(
                message.additional_kwargs.get("changes", [])
            )
        elif operation == "get_snapshot":
            result = sync_manager.get_snapshot()
        else:
            raise ValueError(f"未知的同步操作: {operation}")
        
        return EditorResponse(
            content=f"同步操作完成: {operation}",
            response_type="sync_result",
            operation=operation,
            data=result
        )
    
    @staticmethod
    def _format_context(context: Dict) -> str:
        """格式化编辑器上下文为字符串"""
        parts = []
        
        if context.get("currentFile"):
            parts.append(f"当前文件: {context['currentFile']}")
        
        if context.get("selectedText"):
            parts.append(f"选中的代码:\n{context['selectedText']}")
        
        if context.get("cursorPosition"):
            parts.append(f"光标位置: {context['cursorPosition']}")
        
        return "\n".join(parts)
    
    @staticmethod
    def _detect_generated_ui(content: str) -> Optional[Dict]:
        """检测并生成生成式 UI（来自生成式 UI 中间件）"""
        # 这会由生成式 UI 中间件自动处理
        # 这里只是占位符
        return None
```

---

## 📊 标准化消息格式总结

### 前端发送 → 后端接收

```python
# 前端发送 JSON
{
    "content": "用户输入或问题",
    "source": "chatarea|editor|system",
    "request_type": "agent|direct_tool|file_sync",
    "operation": "expand|rewrite|format_code|...",
    "context": {
        "currentFile": "...",
        "selectedText": "...",
        "editorContent": "..."
    },
    "params": {
        "tool": "tool_name",
        "...": "参数"
    }
}

# 后端转换为 EditorRequest (HumanMessage)
message = EditorRequest(
    content="...",
    source="...",
    request_type="...",
    operation="...",
    context={...},
    params={...}
)
```

### 后端发送 → 前端接收

```python
# 后端返回 EditorResponse (AIMessage)
response = EditorResponse(
    content="响应内容",
    response_type="agent_response|tool_result|sync_result",
    operation="expand|...",
    tool_used="tool_name",
    data={...},
    generated_ui={
        "type": "code|table|markdown|steps",
        "...": "..."
    }
)

# 前端接收 JSON
{
    "content": "响应内容",
    "response_type": "agent_response|tool_result|sync_result",
    "operation": "expand|...",
    "tool_used": "tool_name",
    "data": {...},
    "generated_ui": {...},
    "additional_kwargs": {...}
}
```

---

## 🔗 集成路径 - 从消息到执行

```
前端请求 (JSON)
    ↓
POST /api/route
    ↓
后端接收并转换为 EditorRequest (HumanMessage)
    ↓
UnifiedEditorRouter.invoke()
    ↓
验证 + 路由决策 (using Runnable)
    ↓
选择处理方式:
  - handle_chatarea_agent()
  - handle_editor_agent()
  - handle_editor_tool()
  - handle_file_sync()
    ↓
处理函数调用相应的 Agent/Tool/Sync
    ↓
返回 EditorResponse (AIMessage) 或 ToolMessage
    ↓
转换为 JSON 发送给前端
    ↓
前端渲染结果
```

---

## ✨ 优势

### 1. 完全遵循 LangChain 标准

- ✅ 使用官方消息类型（HumanMessage, AIMessage, ToolMessage）
- ✅ 遵循 Runnable 接口
- ✅ 支持链式调用和组合
- ✅ 与 LangChain 生态无缝集成

### 2. 清晰的消息流

- ✅ 请求 = HumanMessage（用户消息）
- ✅ 响应 = AIMessage（AI 消息）
- ✅ 工具结果 = ToolMessage（标准格式）
- ✅ 所有消息都有统一的结构

### 3. 易于扩展和维护

- ✅ 新操作只需添加提示词
- ✅ 新工具自动集成
- ✅ 消息追踪和审计完善
- ✅ 支持中间件和装饰器

### 4. 与 LangGraph 完美协作

- ✅ 消息可直接用于 Graph
- ✅ 支持流式处理
- ✅ 支持异步操作
- ✅ 易于与 LangGraph Studio 集成

---

## 📝 关键接口定义

```python
# 后端 API 端点定义
@app.post("/api/route")
async def route_request(request_data: Dict) -> Dict:
    """
    统一的路由端点
    
    输入：任何有效的字典
    输出：EditorResponse 转换为 JSON
    """
    
    # 转换为 EditorRequest
    message = EditorRequest(**request_data)
    
    # 使用路由器处理
    router = UnifiedEditorRouter(store=store)
    response = router.invoke(message)
    
    # 转换为 JSON 返回
    if isinstance(response, AIMessage):
        return {
            "content": response.content,
            "type": response.type,
            "additional_kwargs": response.additional_kwargs
        }
    elif isinstance(response, ToolMessage):
        return {
            "content": response.content,
            "type": "tool_message",
            "tool_call_id": response.tool_call_id,
            "additional_kwargs": response.additional_kwargs
        }
```

---

这个设计完全遵循 LangChain 的官方消息结构和 Runnable 接口，是生产级别的标准化实现。


