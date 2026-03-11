# 编辑工具完整架构设计 - 基于 Cursor IDE 和 LangGraph

## 一、核心架构原则

### 1. 前后端职责划分（关键！）

```
┌─────────────────────────────────────────────┐
│         Frontend (React/TS)                 │
│  ┌─────────────────────────────────────┐  │
│  │  UI Layer (Three-pane Layout)       │  │
│  │  - FileTree + Editor + ChatArea     │  │
│  ├─────────────────────────────────────┤  │
│  │  State Management (Zustand/Jotai)  │  │
│  │  - File Content Cache               │  │
│  │  - Selection State                  │  │
│  │  - UI State                         │  │
│  ├─────────────────────────────────────┤  │
│  │  NO Tools Here! ❌                  │  │
│  │  Only receives results from backend │  │
│  └─────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
         ↕ WebSocket/HTTP
┌─────────────────────────────────────────────┐
│     Backend (LangGraph)                     │
│  ┌─────────────────────────────────────┐  │
│  │  LangGraph Runtime                  │  │
│  │  - Graph state machine              │  │
│  │  - Message routing                  │  │
│  ├─────────────────────────────────────┤  │
│  │  Tool Layer (All Tools Here) ✅     │  │
│  │  - file_read: 读文件                │  │
│  │  - file_write: 写文件               │  │
│  │  - file_list: 列文件                │  │
│  │  - code_execute: 执行代码           │  │
│  ├─────────────────────────────────────┤  │
│  │  LLM Integration                    │  │
│  │  - Think/Plan                       │  │
│  │  - Call Tools                       │  │
│  │  - Generate Response                │  │
│  └─────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
```

### 2. 数据流向

```
用户在编辑器输入
  ↓
前端检测变化（debounce）
  ↓
发送到后端："用户要求XXX，上下文如下"
  ↓
LangGraph执行工作流：
  - 分析意图
  - 调用文件工具
  - 执行代码
  - 生成AI响应
  ↓
后端通过WebSocket推送：
  {
    type: 'file_update',
    fileId: 'xxx',
    content: 'xxx',
    timestamp: 123
  }
  或
  {
    type: 'ai_message',
    content: 'xxx',
    suggestions: []
  }
  ↓
前端接收并更新UI
```

---

## 二、推荐的 LangChain 成熟库

### A. 核心库

```python
# requirements.txt
langgraph>=0.0.50
langchain>=0.1.0
langchain-core>=0.1.0
langchain-openai>=0.0.5  # 或其他LLM提供商
langchain-community>=0.0.10  # 社区工具

# 异步和WebSocket
fastapi>=0.100.0
python-socketio>=5.9.0
uvicorn>=0.23.0
pydantic>=2.0

# 文件和代码
watchdog>=3.0  # 文件监听
ast-grep-py>=0.0.1  # 代码解析
```

### B. 最佳实践：使用 LangChain 的成熟工具

```python
# ✅ 推荐：使用 LangChain 的标准 Tool 定义
from langchain_core.tools import tool, BaseTool
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from typing import Annotated

@tool
def file_read(file_path: str) -> str:
    """
    Read file content from workspace.
    
    Args:
        file_path: Path relative to workspace root
        
    Returns:
        File content as string
    """
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            return f.read()
    except Exception as e:
        return f"Error reading file: {str(e)}"

@tool  
def file_write(file_path: str, content: str) -> str:
    """
    Write content to file in workspace.
    
    Args:
        file_path: Path relative to workspace root
        content: File content to write
        
    Returns:
        Success message
    """
    try:
        # Create parent directories if needed
        Path(file_path).parent.mkdir(parents=True, exist_ok=True)
        with open(file_path, 'w', encoding='utf-8') as f:
            f.write(content)
        return f"Successfully wrote to {file_path}"
    except Exception as e:
        return f"Error writing file: {str(e)}"

@tool
def file_list(directory: str = ".") -> list:
    """
    List files in directory.
    
    Args:
        directory: Directory path (default: workspace root)
        
    Returns:
        List of file paths
    """
    try:
        files = []
        for path in Path(directory).rglob("*"):
            if path.is_file() and not str(path).startswith('.'):
                files.append(str(path.relative_to(directory)))
        return sorted(files)
    except Exception as e:
        return [f"Error listing files: {str(e)}"]

# 注意：不要在前端定义工具！
```

---

## 三、完整的 LangGraph 工作流设计

### 后端：graph.py

```python
# backend/graph.py
from typing import TypedDict, Annotated, Sequence
from langchain_core.messages import BaseMessage, AIMessage, HumanMessage, ToolMessage
from langchain_core.tools import Tool
from langgraph.graph import StateGraph, END
from langgraph.prebuilt import ToolNode
from langgraph.types import StreamMode
import json

# ============================================================================
# 1. 定义 Agent State
# ============================================================================

class AgentState(TypedDict):
    """Agent的完整状态"""
    messages: Annotated[Sequence[BaseMessage], "Chat messages"]
    workspace_id: str
    current_file: str | None
    context: dict  # 额外上下文 {selected_text, file_list, etc}

# ============================================================================
# 2. 构建工具集
# ============================================================================

tools = [
    file_read,
    file_write,
    file_list,
    code_execute,  # 自定义工具
]

# ============================================================================
# 3. 定义 Agent 节点
# ============================================================================

def should_use_tools(state: AgentState) -> str:
    """决定是否需要调用工具"""
    messages = state["messages"]
    last_message = messages[-1]
    
    # 如果最后一条消息已经有工具调用，就去执行工具
    if hasattr(last_message, "tool_calls") and last_message.tool_calls:
        return "tools"
    # 否则交给LLM决定
    return "model"

def call_model(state: AgentState):
    """调用LLM"""
    messages = state["messages"]
    
    model = ChatOpenAI(model="gpt-4", temperature=0)
    # 绑定工具到模型
    model_with_tools = model.bind_tools(tools)
    
    response = model_with_tools.invoke(messages)
    
    # 返回新消息
    return {"messages": [response]}

# ============================================================================
# 4. 构建 LangGraph
# ============================================================================

def create_agent_graph():
    """创建编辑助手图"""
    
    workflow = StateGraph(AgentState)
    
    # 添加节点
    workflow.add_node("model", call_model)
    workflow.add_node("tools", ToolNode(tools))  # LangGraph内置工具执行
    
    # 添加条件边
    workflow.add_conditional_edges(
        "model",
        should_use_tools,
        {
            "tools": "tools",
            "end": END,
        }
    )
    
    # 工具执行后回到模型
    workflow.add_edge("tools", "model")
    
    # 设置入口
    workflow.set_entry_point("model")
    
    return workflow.compile()

agent = create_agent_graph()
```

---

## 四、前后端通信协议

### 推荐：使用成熟的消息格式

```python
# backend/schemas.py
from pydantic import BaseModel
from enum import Enum

class MessageType(str, Enum):
    """消息类型"""
    USER_INPUT = "user_input"  # 用户输入
    AI_MESSAGE = "ai_message"  # AI响应
    FILE_UPDATE = "file_update"  # 文件更新
    TOOL_CALL = "tool_call"  # 工具调用
    ERROR = "error"

class WSMessage(BaseModel):
    """WebSocket消息"""
    type: MessageType
    data: dict
    timestamp: float
    session_id: str

# 前端 → 后端
class UserInputRequest(BaseModel):
    content: str
    context: dict  # {selectedText, currentFile, etc}

# 后端 → 前端
class FileUpdateNotification(BaseModel):
    type: MessageType = MessageType.FILE_UPDATE
    file_id: str
    content: str  # 新内容
    path: str
    
class AIMessageNotification(BaseModel):
    type: MessageType = MessageType.AI_MESSAGE
    content: str
    suggestions: list  # AI建议的操作
```

---

## 五、前端集成实现

### A. 推荐：使用 Zustand 管理状态（简洁高效）

```typescript
// frontend/store/editorStore.ts
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

interface EditorStore {
  // 文件状态
  openFiles: Map<string, FileContent>;
  activeFileId: string | null;
  
  // 同步状态
  isSyncing: boolean;
  lastSyncTime: number;
  
  // 操作
  updateFileContent: (fileId: string, content: string) => void;
  applyRemoteUpdate: (fileId: string, content: string) => void;
  
  // WebSocket连接
  wsConnected: boolean;
  setWSConnected: (connected: boolean) => void;
}

export const useEditorStore = create<EditorStore>()(
  subscribeWithSelector((set) => ({
    openFiles: new Map(),
    activeFileId: null,
    isSyncing: false,
    lastSyncTime: 0,
    wsConnected: false,
    
    updateFileContent: (fileId, content) => set((state) => {
      const newFiles = new Map(state.openFiles);
      if (newFiles.has(fileId)) {
        newFiles.get(fileId)!.content = content;
        newFiles.get(fileId)!.modified = true;
      }
      return { openFiles: newFiles };
    }),
    
    applyRemoteUpdate: (fileId, content) => set((state) => {
      const newFiles = new Map(state.openFiles);
      if (newFiles.has(fileId)) {
        newFiles.get(fileId)!.content = content;
        newFiles.get(fileId)!.modified = false;
      }
      return { openFiles: newFiles, isSyncing: false };
    }),
    
    setWSConnected: (connected) => set({ wsConnected: connected }),
  }))
);
```

### B. WebSocket 连接管理

```typescript
// frontend/lib/websocket.ts
import { useEditorStore } from '@/store/editorStore';

export class EditorWebSocket {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;

  connect(url: string) {
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      console.log('Connected to editor backend');
      useEditorStore.setState({ wsConnected: true });
      this.reconnectAttempts = 0;
    };

    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      this.handleMessage(message);
    };

    this.ws.onerror = () => {
      this.attemptReconnect(url);
    };
  }

  private handleMessage(message: WSMessage) {
    const { type, data } = message;

    switch (type) {
      case 'file_update':
        // 后端推送文件更新
        useEditorStore.getState().applyRemoteUpdate(
          data.file_id,
          data.content
        );
        break;

      case 'ai_message':
        // AI响应，发送给ChatArea
        window.dispatchEvent(
          new CustomEvent('ai_message', { detail: data })
        );
        break;

      case 'tool_call':
        // 工具执行反馈
        this.handleToolResult(data);
        break;
    }
  }

  send(message: UserInputRequest) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  private attemptReconnect(url: string) {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      setTimeout(() => this.connect(url), 1000 * this.reconnectAttempts);
    }
  }
}

export const editorWS = new EditorWebSocket();
```

---

## 六、参考 Cursor IDE 的优点实现

### 1. 智能文件感知

```python
# backend/context_manager.py
from langchain_core.documents import Document
from langchain_text_splitters import RecursiveCharacterTextSplitter

class WorkspaceContext:
    """维护工作空间上下文"""
    
    def __init__(self, workspace_path: str):
        self.workspace_path = workspace_path
        self.file_cache = {}
        self.splitter = RecursiveCharacterTextSplitter(
            chunk_size=1000,
            chunk_overlap=200,
        )
    
    def get_file_context(self, file_path: str) -> list[Document]:
        """获取文件作为LangChain Document"""
        if file_path in self.file_cache:
            return self.file_cache[file_path]
        
        try:
            content = file_read(file_path)
            docs = self.splitter.create_documents(
                [content],
                metadatas=[{"source": file_path}]
            )
            self.file_cache[file_path] = docs
            return docs
        except Exception as e:
            return []
```

### 2. 上下文注入到 LLM 提示

```python
# backend/prompts.py
from langchain_core.prompts import ChatPromptTemplate

def create_editor_prompt() -> ChatPromptTemplate:
    """创建编辑器专用提示"""
    return ChatPromptTemplate.from_messages([
        ("system", """
You are an intelligent code editor assistant similar to Cursor IDE.
You help developers write, refactor, and understand code.

Guidelines:
1. Always consider the current workspace context
2. Use tools to read/write files when needed
3. Provide clear explanations of your changes
4. Suggest improvements and best practices
5. Format code output properly

Current workspace files:
{file_list}

Current file being edited:
Path: {current_file}
Content: {file_content}

User selection:
{selected_text}
        """),
        ("human", "{input}"),
    ])
```

### 3. 增量更新而不是完整刷新

```typescript
// frontend/components/Editor/useEditorSync.ts
import { useEffect } from 'react';
import { useEditorStore } from '@/store/editorStore';

export function useEditorSync() {
  const { updateFileContent } = useEditorStore();

  useEffect(() => {
    const unsubscribe = useEditorStore.subscribe(
      (state) => state.openFiles,
      (files) => {
        // 只在文件改变时发送增量更新
        files.forEach((file, fileId) => {
          if (file.modified && !file.syncing) {
            sendIncrementalUpdate(fileId, file.content);
          }
        });
      },
      { equalityFn: shallowEqual }
    );

    return unsubscribe;
  }, []);
}

function sendIncrementalUpdate(fileId: string, content: string) {
  // 发送差异而不是整个文件
  const delta = calculateDelta(fileId, content);
  editorWS.send({
    type: 'file_update',
    fileId,
    delta, // 只发送改变的部分
  });
}
```

---

## 七、降低集成复杂度的最佳实践

### 1. 使用预构建的 LangGraph 模板

```python
# ❌ 不要这样做：从零开始构建复杂的状态机
# ✅ 应该这样做：使用 LangGraph 的预构建模式

from langgraph.prebuilt import (
    create_react_agent,  # 标准 ReAct 循环
    ToolNode,  # 工具执行
)

# 最简单的方式
agent = create_react_agent(
    model=ChatOpenAI(model="gpt-4"),
    tools=tools,
    state_modifier="You are a helpful code editor assistant.",
)
```

### 2. 使用 LangServe 自动生成 API

```python
# ❌ 不要这样做：手写所有 FastAPI 端点
# ✅ 应该这样做：使用 LangServe 自动生成

from langserve import add_routes

app = FastAPI(title="Editor API")

add_routes(
    app,
    agent,
    path="/editor",
)

# 自动生成：
# - POST /editor/invoke
# - POST /editor/stream
# - WebSocket /editor/stream_events
```

### 3. 类型安全和验证

```python
# ❌ 不要这样做：接收无类型的字典
# ✅ 应该这样做：使用 Pydantic 模型

@app.post("/editor/request")
async def handle_request(request: UserInputRequest):
    """类型安全的请求处理"""
    # Pydantic 自动验证和转换
    return {"status": "ok"}
```

---

## 八、前端架构参考

### 推荐结构

```
frontend/
├── components/
│   ├── Editor/
│   │   ├── EditorPanel.tsx          # 中间编辑区
│   │   ├── FileTree.tsx             # 左侧文件树
│   │   ├── useEditorSync.ts         # 同步钩子
│   │   └── useDebouncedSave.ts      # 防抖保存
│   ├── Chat/
│   │   ├── ChatArea.tsx             # 右侧ChatArea（从assistant-ui复制）
│   │   └── useWebSocket.ts          # WebSocket钩子
│   └── FullEditor.tsx               # 主容器
├── store/
│   ├── editorStore.ts               # Zustand状态
│   └── chatStore.ts                 # ChatArea状态
├── lib/
│   ├── websocket.ts                 # WebSocket管理
│   └── api.ts                       # API调用
└── hooks/
    └── useAsync.ts                  # 异步操作钩子
```

---

## 九、核心要点总结

| 方面 | 推荐方案 | 原因 |
|------|--------|------|
| **工具位置** | 全部后端 | 保证一致性、安全性、可维护性 |
| **状态管理** | Zustand | 简洁、高效、零样板 |
| **LLM集成** | LangServe | 自动API生成，减少样板 |
| **Graph框架** | create_react_agent | 预构建，可靠，文档全 |
| **前后端通信** | WebSocket + Pydantic | 实时、类型安全 |
| **代码分割** | 编辑器/聊天分离 | 逻辑清晰、容易测试 |
| **缓存策略** | 本地缓存+增量更新 | 性能优秀 |

---

## 十、快速开始清单

```python
# 后端快速开始
[ ] 1. 定义 Tool 集合 (file_read, file_write, etc)
[ ] 2. 创建 AgentState TypedDict
[ ] 3. 使用 create_react_agent 创建 graph
[ ] 4. 设置 LangServe 路由
[ ] 5. 添加 WebSocket 端点推送文件更新

# 前端快速开始
[ ] 1. 创建 Zustand store
[ ] 2. 实现 WebSocket 连接
[ ] 3. 构建三分栏布局
[ ] 4. 集成 ChatArea（从assistant-ui）
[ ] 5. 添加编辑器同步钩子
```

---

## 十一、成熟的参考项目

1. **LangChain Cookbook - Chat LangChain**
   - 路径：`templates/chat-langchain/`
   - 学习：Agent + WebSocket集成

2. **LangServe 官方示例**
   - 学习：API自动生成
   - 文档：https://github.com/langchain-ai/langserve

3. **Vercel AI SDK**
   - 学习：流式响应处理
   - 参考：前端最佳实践

4. **Assistant UI 项目**
   - 已复制：使用即可
   - 学习：生成式UI集成


