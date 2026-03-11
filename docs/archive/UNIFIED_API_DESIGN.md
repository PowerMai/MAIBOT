# 统一 API 设计 - 基于业务逻辑的请求路由

**改进设计：从关键词判断 → 业务源头 + 请求类型标识**

---

## 📊 核心设计原则

### 旧方案的问题
```
❌ 依赖关键词匹配
  ├─ 容易误判
  ├─ 扩展困难
  └─ 难以维护
```

### 新方案的优势
```
✅ 基于业务来源 + 请求类型标识
  ├─ 前端明确指定处理方式
  ├─ 后端简单路由
  ├─ API 接口统一
  └─ 易于扩展新业务
```

---

## 🎯 业务分类与处理方式

### 1. 对话框输入 → DeepAgent（复杂多步骤）

```
用户在 ChatArea 输入
  ↓
发送到 DeepAgent
  ↓
多步骤处理（规划、委派、综合）
  ↓
返回生成式 UI
```

**请求格式**：
```python
{
    "source": "chatarea",        # 来源：对话框
    "request_type": "agent",     # 类型：Agent 处理
    "input": "帮我优化这个函数",
    "context": {
        "currentFile": "/src/utils.ts",
        "editorContent": "function slowSort(...) { ... }",
        "selectedText": "..."
    }
}
```

**后端处理**：
```python
def route_chatarea_request(request) -> Dict:
    """对话框请求 → 直接调用 DeepAgent"""
    
    # 无需进一步判断，直接委派给 DeepAgent
    result = orchestrator_agent.invoke({
        "messages": [HumanMessage(content=request["input"])],
        "context": request.get("context")
    })
    
    return result
```

---

### 2. 编辑器区域 - 复杂操作（需要 Agent 处理）

```
用户选中代码 → 点击"扩写"/"重写"/"修改"
  ↓
前端发送请求（带 agent 标识）
  ↓
后端调用 Agent
  ↓
返回建议给编辑器
```

**请求格式**：
```python
{
    "source": "editor",                    # 来源：编辑器
    "request_type": "agent",               # 类型：Agent 处理
    "operation": "expand",                 # 具体操作：扩写、重写、修改
    "input": "请扩写这个函数的功能",
    "context": {
        "currentFile": "/src/main.ts",
        "selectedText": "function demo() { ... }",
        "cursorPosition": 123,
        "selectionRange": [100, 150]
    }
}
```

**后端处理**：
```python
def route_editor_agent_request(request) -> Dict:
    """编辑器 Agent 请求 → 调用 Agent"""
    
    operation = request.get("operation")  # expand, rewrite, modify
    
    # 构建操作提示词
    prompt_template = {
        "expand": "请扩展以下代码的功能，添加更多细节和功能...",
        "rewrite": "请重写以下代码，提高可读性和性能...",
        "modify": "请修改以下代码以满足需求..."
    }
    
    enhanced_input = f"{prompt_template[operation]}\n\n{request['input']}"
    
    # 调用 Agent
    result = orchestrator_agent.invoke({
        "messages": [HumanMessage(content=enhanced_input)],
        "context": request.get("context")
    })
    
    return result
```

---

### 3. 编辑器区域 - 一次性命令（直接执行工具）

```
用户选中代码 → 点击"查看类型"/"格式化"/"分析"
  ↓
前端发送请求（带 direct_tool 标识 + 工具名）
  ↓
后端直接调用工具（无需 Agent）
  ↓
立即返回结果
```

**请求格式**：
```python
{
    "source": "editor",                    # 来源：编辑器
    "request_type": "direct_tool",         # 类型：直接工具执行
    "tool": "format_code",                 # 具体工具
    "params": {
        "file_path": "/src/main.ts",
        "language": "typescript",
        "code": "function demo(){...}"
    },
    "context": {
        "currentFile": "/src/main.ts",
        "selectedText": "function demo(){...}"
    }
}
```

**支持的直接工具**：
```python
DIRECT_TOOLS = {
    # 格式化
    "format_code": ("format", ["language", "code"]),
    
    # 分析
    "analyze_code": ("analyze", ["code", "language"]),
    "get_function_signature": ("get_sig", ["code"]),
    
    # 简单转换
    "convert_js_to_ts": ("convert", ["code", "from_lang", "to_lang"]),
    "minify_code": ("minify", ["code", "language"]),
    
    # 文件操作
    "read_file": ("read", ["file_path"]),
    "save_file": ("save", ["file_path", "content"]),
    "delete_file": ("delete", ["file_path"]),
    
    # 文件系统
    "list_files": ("ls", ["directory"]),
    "search_files": ("grep", ["pattern", "directory"]),
}
```

**后端处理**：
```python
def route_direct_tool_request(request) -> Dict:
    """编辑器直接工具请求 → 立即执行"""
    
    tool_name = request.get("tool")
    params = request.get("params", {})
    
    # 直接调用工具（无需 Agent）
    from backend.tools.base.registry import get_core_tool_by_name
    
    tool = get_core_tool_by_name(tool_name)
    
    if not tool:
        return {"success": False, "error": f"工具不存在: {tool_name}"}
    
    try:
        result = tool.run(**params)
        
        return {
            "success": True,
            "type": "tool_result",
            "tool": tool_name,
            "result": result
        }
    
    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "tool": tool_name
        }
```

---

### 4. 文件同步请求 → 专门处理

```
{
    "source": "system",                    # 来源：系统同步
    "request_type": "file_sync",           # 类型：文件同步
    "operation": "apply_changes",          # 同步操作
    "changes": [
        {"type": "create", "path": "/new.md", "content": "..."},
        {"type": "modify", "path": "/edit.md", "content": "..."}
    ]
}
```

**后端处理**：
```python
def route_file_sync_request(request) -> Dict:
    """文件同步请求 → 同步管理器"""
    
    from backend.systems.file_sync import FileSyncManager
    
    sync_manager = FileSyncManager(workspace_path="/workspace", store=store)
    
    result = sync_manager.apply_changes(request.get("changes", []))
    
    return result
```

---

## 🔄 统一的 API 接口

### 后端路由系统（新设计）

```python
# backend/engine/routing/unified_router.py

from typing import Literal, Dict, Any
from langgraph.graph import StateGraph, END

class UnifiedRouterState(Dict):
    """统一的请求状态"""
    source: Literal["chatarea", "editor", "system"]  # 请求来源
    request_type: Literal["agent", "direct_tool", "file_sync"]  # 请求类型
    operation: str  # 具体操作（如果有）
    input: str
    context: Dict[str, Any]
    params: Dict[str, Any]
    result: Dict[str, Any]


def validate_request(state: UnifiedRouterState) -> UnifiedRouterState:
    """验证请求的完整性"""
    
    logger.info(f"验证请求: source={state.get('source')}, type={state.get('request_type')}")
    
    # 检查必要字段
    if not state.get("source"):
        return {
            **state,
            "result": {"success": False, "error": "缺少 source 字段"}
        }
    
    if not state.get("request_type"):
        return {
            **state,
            "result": {"success": False, "error": "缺少 request_type 字段"}
        }
    
    # 验证通过
    return state


def route_based_on_type(state: UnifiedRouterState) -> Literal["chatarea", "editor_agent", "editor_tool", "file_sync", "error"]:
    """
    第一层路由：基于 source 和 request_type 判断
    
    这不是关键词判断，而是明确的业务逻辑
    """
    
    source = state.get("source")
    request_type = state.get("request_type")
    
    # 对话框 → Agent
    if source == "chatarea" and request_type == "agent":
        return "chatarea"
    
    # 编辑器 → Agent
    if source == "editor" and request_type == "agent":
        return "editor_agent"
    
    # 编辑器 → 直接工具
    if source == "editor" and request_type == "direct_tool":
        return "editor_tool"
    
    # 系统 → 文件同步
    if source == "system" and request_type == "file_sync":
        return "file_sync"
    
    # 无效组合
    return "error"


def handle_chatarea_request(state: UnifiedRouterState) -> UnifiedRouterState:
    """处理对话框请求"""
    
    logger.info("处理对话框请求...")
    
    from backend.engine.core.main_agent import agent
    from langchain_core.messages import HumanMessage
    
    try:
        messages = [HumanMessage(content=state.get("input", ""))]
        
        if state.get("context"):
            context_str = "\n\n上下文:\n" + str(state["context"])
            messages[0].content += context_str
        
        result = agent.invoke({"messages": messages})
        
        return {
            **state,
            "result": {
                "success": True,
                "source": "agent",
                "output": result.get("output"),
                "messages": result.get("messages")
            }
        }
    
    except Exception as e:
        logger.error(f"对话框请求处理错误: {e}")
        return {
            **state,
            "result": {"success": False, "error": str(e)}
        }


def handle_editor_agent_request(state: UnifiedRouterState) -> UnifiedRouterState:
    """处理编辑器 Agent 请求（需要多步骤处理）"""
    
    logger.info(f"处理编辑器 Agent 请求: operation={state.get('operation')}")
    
    from backend.engine.core.main_agent import agent
    from langchain_core.messages import HumanMessage
    
    try:
        operation = state.get("operation")
        
        # 根据操作添加上下文提示词
        operation_hints = {
            "expand": "请扩展以下代码的功能，添加更多细节和功能...",
            "rewrite": "请重写以下代码，提高可读性和性能...",
            "modify": "请修改以下代码以满足需求...",
            "analyze": "请分析以下代码的逻辑和潜在问题...",
            "document": "请为以下代码生成详细文档...",
            "test": "请为以下代码生成单元测试..."
        }
        
        hint = operation_hints.get(operation, "")
        full_input = f"{hint}\n\n{state.get('input', '')}"
        
        messages = [HumanMessage(content=full_input)]
        
        if state.get("context"):
            context_str = "\n\n选中的代码:\n" + state["context"].get("selectedText", "")
            messages[0].content += context_str
        
        result = agent.invoke({"messages": messages})
        
        return {
            **state,
            "result": {
                "success": True,
                "source": "agent",
                "operation": operation,
                "output": result.get("output"),
                "messages": result.get("messages")
            }
        }
    
    except Exception as e:
        logger.error(f"编辑器 Agent 请求处理错误: {e}")
        return {
            **state,
            "result": {"success": False, "error": str(e)}
        }


def handle_editor_tool_request(state: UnifiedRouterState) -> UnifiedRouterState:
    """处理编辑器直接工具请求（一次性命令）"""
    
    logger.info(f"处理编辑器工具请求: tool={state.get('params', {}).get('tool')}")
    
    from backend.tools.base.registry import get_core_tool_by_name
    
    try:
        tool_name = state.get("params", {}).get("tool")
        params = state.get("params", {})
        
        if not tool_name:
            return {
                **state,
                "result": {"success": False, "error": "缺少 tool 参数"}
            }
        
        tool = get_core_tool_by_name(tool_name)
        
        if not tool:
            return {
                **state,
                "result": {"success": False, "error": f"工具不存在: {tool_name}"}
            }
        
        # 调用工具
        result = tool.run(**{k: v for k, v in params.items() if k != "tool"})
        
        return {
            **state,
            "result": {
                "success": True,
                "source": "tool",
                "tool": tool_name,
                "output": result
            }
        }
    
    except Exception as e:
        logger.error(f"工具请求处理错误: {e}")
        return {
            **state,
            "result": {"success": False, "error": str(e)}
        }


def handle_file_sync_request(state: UnifiedRouterState) -> UnifiedRouterState:
    """处理文件同步请求"""
    
    logger.info("处理文件同步请求...")
    
    from backend.systems.file_sync import FileSyncManager
    
    try:
        sync_manager = FileSyncManager(
            workspace_path="/workspace",
            store=None  # 从后端获取
        )
        
        operation = state.get("operation")
        
        if operation == "apply_changes":
            result = sync_manager.apply_changes(state.get("changes", []))
        elif operation == "get_snapshot":
            result = sync_manager.get_snapshot()
        else:
            return {
                **state,
                "result": {"success": False, "error": f"未知操作: {operation}"}
            }
        
        return {
            **state,
            "result": {
                "success": True,
                "source": "sync",
                "operation": operation,
                "data": result
            }
        }
    
    except Exception as e:
        logger.error(f"文件同步请求处理错误: {e}")
        return {
            **state,
            "result": {"success": False, "error": str(e)}
        }


def handle_error(state: UnifiedRouterState) -> UnifiedRouterState:
    """处理无效请求"""
    
    logger.warning(f"无效请求: {state}")
    
    return {
        **state,
        "result": {
            "success": False,
            "error": f"无效的请求组合: source={state.get('source')}, request_type={state.get('request_type')}"
        }
    }


def create_unified_router_graph():
    """创建统一的请求路由 Graph"""
    
    graph = StateGraph(UnifiedRouterState)
    
    # 节点
    graph.add_node("validate", validate_request)
    graph.add_node("chatarea", handle_chatarea_request)
    graph.add_node("editor_agent", handle_editor_agent_request)
    graph.add_node("editor_tool", handle_editor_tool_request)
    graph.add_node("file_sync", handle_file_sync_request)
    graph.add_node("error", handle_error)
    
    # 入口
    graph.set_entry_point("validate")
    
    # 条件边：验证后路由
    graph.add_conditional_edges(
        "validate",
        route_based_on_type,
        {
            "chatarea": "chatarea",
            "editor_agent": "editor_agent",
            "editor_tool": "editor_tool",
            "file_sync": "file_sync",
            "error": "error"
        }
    )
    
    # 所有节点都导向 END
    graph.add_edge("chatarea", END)
    graph.add_edge("editor_agent", END)
    graph.add_edge("editor_tool", END)
    graph.add_edge("file_sync", END)
    graph.add_edge("error", END)
    
    return graph.compile()


# 创建全局路由器
unified_router = create_unified_router_graph()


async def process_unified_request(request: Dict) -> Dict:
    """处理统一格式的请求"""
    
    initial_state = UnifiedRouterState(
        source=request.get("source"),
        request_type=request.get("request_type"),
        operation=request.get("operation", ""),
        input=request.get("input", ""),
        context=request.get("context", {}),
        params=request.get("params", {}),
        result={}
    )
    
    final_state = unified_router.invoke(initial_state)
    
    return final_state.get("result", {})
```

---

## 📝 前端使用方式

### ChatArea（对话框）

```typescript
// 来自对话框的请求
async function sendChatMessage(message: string, context: any) {
  const response = await fetch("http://localhost:2024/api/route", {
    method: "POST",
    body: JSON.stringify({
      source: "chatarea",        // ✅ 明确来源
      request_type: "agent",     // ✅ 明确类型
      input: message,
      context: context
    })
  });
  
  return response.json();
}
```

### 编辑器 - 编辑操作（需要 Agent）

```typescript
// 编辑器中的复杂操作
async function expandCode(selectedText: string, context: any) {
  const response = await fetch("http://localhost:2024/api/route", {
    method: "POST",
    body: JSON.stringify({
      source: "editor",          // ✅ 明确来源
      request_type: "agent",     // ✅ 明确类型
      operation: "expand",       // ✅ 具体操作
      input: "请扩写选中的代码",
      context: {
        ...context,
        selectedText: selectedText
      }
    })
  });
  
  return response.json();
}

// 其他操作
async function rewriteCode(selectedText: string) {
  // 同样的请求格式，只改 operation
  return fetch("http://localhost:2024/api/route", {
    method: "POST",
    body: JSON.stringify({
      source: "editor",
      request_type: "agent",
      operation: "rewrite",  // 改这里
      input: "请重写选中的代码以提高可读性",
      context: { selectedText }
    })
  }).then(r => r.json());
}

async function analyzeCode(selectedText: string) {
  return fetch("http://localhost:2024/api/route", {
    method: "POST",
    body: JSON.stringify({
      source: "editor",
      request_type: "agent",
      operation: "analyze",  // 改这里
      input: "请分析选中代码的逻辑",
      context: { selectedText }
    })
  }).then(r => r.json());
}
```

### 编辑器 - 直接命令（无需 Agent）

```typescript
// 编辑器中的一次性命令
async function formatCode(code: string, language: string) {
  const response = await fetch("http://localhost:2024/api/route", {
    method: "POST",
    body: JSON.stringify({
      source: "editor",            // ✅ 明确来源
      request_type: "direct_tool",  // ✅ 直接工具
      params: {
        tool: "format_code",       // ✅ 具体工具
        language: language,
        code: code
      }
    })
  });
  
  return response.json();
}

// 查看函数签名
async function getFunctionSignature(code: string) {
  return fetch("http://localhost:2024/api/route", {
    method: "POST",
    body: JSON.stringify({
      source: "editor",
      request_type: "direct_tool",
      params: {
        tool: "get_function_signature",
        code: code
      }
    })
  }).then(r => r.json());
}

// 转换代码
async function convertJsToTs(code: string) {
  return fetch("http://localhost:2024/api/route", {
    method: "POST",
    body: JSON.stringify({
      source: "editor",
      request_type: "direct_tool",
      params: {
        tool: "convert_js_to_ts",
        code: code,
        from_lang: "javascript",
        to_lang: "typescript"
      }
    })
  }).then(r => r.json());
}
```

### 文件操作（系统级）

```typescript
// 文件同步
async function syncFileChanges(changes: any[]) {
  return fetch("http://localhost:2024/api/route", {
    method: "POST",
    body: JSON.stringify({
      source: "system",           // ✅ 明确来源
      request_type: "file_sync",  // ✅ 文件同步
      operation: "apply_changes",
      changes: changes
    })
  }).then(r => r.json());
}

// 读取文件（通过工具）
async function readFile(filePath: string) {
  return fetch("http://localhost:2024/api/route", {
    method: "POST",
    body: JSON.stringify({
      source: "editor",
      request_type: "direct_tool",
      params: {
        tool: "read_file",
        file_path: filePath
      }
    })
  }).then(r => r.json());
}
```

---

## 📊 请求格式总结

### 通用格式

```typescript
{
  // 必填：请求来源（决定业务流程）
  source: "chatarea" | "editor" | "system",
  
  // 必填：请求类型（决定处理方式）
  request_type: "agent" | "direct_tool" | "file_sync",
  
  // 可选：具体操作（对于 agent 和 file_sync）
  operation?: "expand" | "rewrite" | "modify" | "analyze" | "document" | "test" | "apply_changes" | "get_snapshot",
  
  // 必填：用户输入或问题
  input: string,
  
  // 可选：编辑器上下文
  context?: {
    currentFile?: string,
    editorContent?: string,
    selectedText?: string,
    cursorPosition?: number,
    selectionRange?: [number, number],
    workspaceFiles?: string[]
  },
  
  // 可选：工具参数（对于 direct_tool）
  params?: {
    tool: string,
    [key: string]: any
  }
}
```

### 响应格式

```typescript
{
  success: boolean,
  source: "agent" | "tool" | "sync",
  
  // 对于 agent 结果
  output?: string,
  messages?: any[],
  
  // 对于 tool 结果
  tool?: string,
  result?: any,
  
  // 对于 sync 结果
  operation?: string,
  data?: any,
  
  // 错误信息
  error?: string
}
```

---

## ✅ 优势总结

### vs 关键词判断

| 方面 | 关键词判断 | 业务逻辑标识 |
|------|----------|----------|
| **准确性** | ❌ 低（容易误判） | ✅ 高（明确指定） |
| **扩展性** | ❌ 差（需改路由逻辑） | ✅ 好（前端指定） |
| **维护性** | ❌ 差（难以追踪） | ✅ 好（清晰流程） |
| **可观测性** | ❌ 差 | ✅ 好（源和类型清晰） |
| **前端复杂度** | ❌ 低 | ✅ 中（但更清晰） |
| **后端复杂度** | ❌ 高（需判断） | ✅ 低（直接路由） |

---

## 🚀 实现步骤

### Step 1: 后端路由图（1 天）
- [ ] 创建 `backend/engine/routing/unified_router.py`
- [ ] 实现 6 个处理节点
- [ ] 测试各种请求组合

### Step 2: 前端适配（1-2 天）
- [ ] 修改 ChatArea 发送格式
- [ ] 编辑器快捷键集成
- [ ] 文件同步集成

### Step 3: 测试和优化（1 天）
- [ ] 端到端测试
- [ ] 性能优化
- [ ] 错误处理

---

这个设计的核心优势是：
✅ **清晰**：来源 + 类型完全明确
✅ **灵活**：新操作只需前端指定，后端自动路由
✅ **统一**：所有请求都用同一个 API
✅ **可扩展**：轻松添加新的 operation 或 tool


