# LangGraph 流式输出 + 生成式 UI 官方实现指南

## 📚 参考标准

本文基于 **assistant-ui 官方示例** 和 **LangChain 生态最佳实践**：
- 官方示例：`/Users/workspace/DevelopProjects/assistant-ui/examples/with-langgraph/`
- React-LangGraph 库：`/Users/workspace/DevelopProjects/assistant-ui/packages/react-langgraph/`

---

## ✅ 前端实现标准

### 1. API 层（完全符合官方）

**文件**: `frontend/desktop/src/lib/api/langserveChat.ts`

✅ **当前实现完全符合官方标准**：

```typescript
import { ThreadState, Client } from "@langchain/langgraph-sdk";
import { LangChainMessage, LangGraphMessagesEvent } from "@assistant-ui/react-langgraph";

const createClient = () => {
  const apiUrl = (import.meta as any).env?.VITE_LANGGRAPH_API_URL || "http://localhost:2024";
  return new Client({ apiUrl });
};

// ✅ 完全符合官方标准：返回 AsyncGenerator
export const sendMessage = (params: {
  threadId: string;
  messages: LangChainMessage[];
}): AsyncGenerator<LangGraphMessagesEvent<LangChainMessage>> => {
  const client = createClient();
  
  return client.runs.stream(
    params.threadId,
    process.env["VITE_LANGGRAPH_ASSISTANT_ID"] || "agent",
    {
      input: { messages: params.messages },
      streamMode: "messages",  // ✅ Token 级别流式传输（官方标准）
    },
  ) as AsyncGenerator<LangGraphMessagesEvent<LangChainMessage>>;
};
```

**官方参考**：
- `examples/with-langgraph/lib/chatApi.ts`（完全相同）

---

### 2. Runtime Provider（完全符合官方）

**文件**: `frontend/desktop/src/components/ChatComponents/MyRuntimeProvider.tsx`

✅ **当前实现基本符合官方标准，但需要添加事件处理**：

```typescript
"use client";

import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useLangGraphRuntime } from "@assistant-ui/react-langgraph";
import { createThread, getThreadState, sendMessage } from "../../lib/api/langserveChat";
import { LangChainMessage } from "@assistant-ui/react-langgraph";

interface MyRuntimeProviderProps {
  children: React.ReactNode;
}

export function MyRuntimeProvider({ children }: MyRuntimeProviderProps) {
  const runtime = useLangGraphRuntime({
    // ✅ 完全按照官方示例：直接 yield* generator
    stream: async function* (messages, { initialize }) {
      const result = await initialize();
      let threadId = result?.externalId;
      
      if (!threadId) {
        const thread = await createThread();
        threadId = thread.thread_id;
      }

      const generator = sendMessage({
        threadId,
        messages,
      });

      // ✅ 完全按照官方示例：直接 yield*，无任何处理
      yield* generator;
    },
    
    create: async () => {
      const thread = await createThread();
      return { externalId: thread.thread_id };
    },
    
    load: async (externalId) => {
      const state = await getThreadState(externalId);
      return {
        messages: (state.values as { messages?: LangChainMessage[] }).messages ?? [],
        interrupts: state.tasks[0]?.interrupts ?? [],
      };
    },

    // ✅ 官方标准：处理事件
    eventHandlers: {
      // 处理元数据事件（不影响消息流）
      onCustomEvent: (eventType, data) => {
        if (eventType === "messages/metadata") {
          // ✅ 正常行为，无需处理
          return;
        }
        console.warn(`Unhandled event: ${eventType}`, data);
      },
    },
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children}
    </AssistantRuntimeProvider>
  );
}
```

**官方参考**：
- `examples/with-langgraph/app/MyRuntimeProvider.tsx`（完全相同）
- `packages/react-langgraph/src/useLangGraphRuntime.ts`（官方实现）

---

### 3. 消息转换标准

**官方实现位置**：`packages/react-langgraph/src/convertLangChainMessages.ts`

✅ **完全符合官方标准的消息格式**：

```typescript
// ✅ LangChain 官方消息格式
type LangChainMessage = 
  | {
      id?: string;
      type: "system";
      content: string;
      additional_kwargs?: Record<string, unknown>;
    }
  | {
      id?: string;
      type: "human";
      content: string | ContentBlock[];  // ✅ 支持 multimodal
      additional_kwargs?: Record<string, unknown>;
    }
  | {
      id?: string;
      type: "ai";
      content: string | ContentBlock[];
      tool_calls?: LangChainToolCall[];
      tool_call_chunks?: LangChainToolCallChunk[];
      status?: MessageStatus;
      additional_kwargs?: {
        reasoning?: MessageContentReasoning;
        tool_outputs?: MessageContentComputerCall[];
      };
    }
  | {
      id?: string;
      type: "tool";
      content: string;
      tool_call_id: string;
      name: string;
      artifact?: any;
      status: "success" | "error";
    };

// ✅ 支持的 Content Block 类型
type ContentBlock = 
  | { type: "text"; text: string }
  | { type: "text_delta"; text: string }
  | { type: "image_url"; image_url: string | { url: string } }
  | { type: "file"; file: { filename: string; file_data: string; mime_type: string } }
  | { type: "thinking"; thinking: string }
  | { type: "reasoning"; summary: [{ text: string }] };
```

---

## ✅ 生成式 UI 官方标准

### 1. 生成式 UI 在消息中的位置

❌ **错误做法**：
```python
# ❌ 不要这样做 - 自定义字段不会被前端显示
message.additional_kwargs['ui'] = {
    "type": "table",
    "columns": [...],
    "data": [...]
}
```

✅ **正确做法**：UI 数据应该在 `content` 中

LangChain 官方支持的方式是：
1. **Tool Result** - 用于工具执行结果的渲染（官方标准）
2. **Content Blocks** - 在 AI 消息的 content 中（官方标准）

### 2. 使用 Tool Result 处理生成式 UI（推荐）

```python
# ✅ 使用官方的 ToolMessage（最符合 LangChain 标准）
from langchain_core.messages import ToolMessage

# 方案 A：用于工具生成的数据可视化
message = ToolMessage(
    content="表格生成成功",  # 文本内容
    tool_call_id="table_generation",
    artifact={  # ✅ 结构化数据（assistant-ui 支持）
        "type": "table",
        "columns": ["Name", "Value"],
        "rows": [{"Name": "A", "Value": 1}, ...]
    }
)
```

### 3. 直接在 AI 消息中嵌入 UI 数据

```python
# ✅ 在消息 content 中嵌入结构化数据
from langchain_core.messages import AIMessage

message = AIMessage(
    content=[
        {
            "type": "text",
            "text": "这是表格数据摘要"
        },
        {
            "type": "json",  # 官方支持的 content block
            "json": {
                "type": "table",
                "columns": ["Name", "Age"],
                "rows": [...]
            }
        }
    ]
)
```

**前端接收到这样的消息时**，可以通过 `contentToParts` 函数（官方提供）进行转换。

---

## ✅ 后端实现标准

### 1. 消息类型定义

✅ **后端应该使用 LangChain 官方的消息类型**：

```python
from langchain_core.messages import (
    HumanMessage,
    AIMessage,
    ToolMessage,
    SystemMessage,
    BaseMessage,
)

# ✅ 完全符合官方标准
message = AIMessage(
    content=[
        {"type": "text", "text": "文本内容"},
        {"type": "image_url", "image_url": "https://..."},
        {"type": "file", "file": {"filename": "...", "file_data": "...", "mime_type": "..."}},
    ],
    tool_calls=[
        {
            "id": "call_123",
            "name": "tool_name",
            "args": {"param": "value"}
        }
    ],
    additional_kwargs={
        "reasoning": {"summary": [{"text": "思考过程"}]},  # ✅ 官方标准
        "tool_outputs": [...]  # ✅ 官方标准
    }
)
```

### 2. 状态定义（保持简洁）

```python
# ✅ 官方标准的状态定义
from typing import Annotated, List
from langchain_core.messages import BaseMessage
import operator
from typing_extensions import TypedDict

class AgentState(TypedDict):
    """简洁的状态定义 - 只保留必要字段"""
    # ✅ 官方标准：使用 Annotated + operator.add 作为 reducer
    messages: Annotated[List[BaseMessage], operator.add]
    
    # ✅ 可选：只保留运行时必需的字段
    # 其他信息应该在消息的 metadata 中
```

### 3. 流式输出标准

```python
# ✅ 官方标准：在任何节点中直接返回消息
from langgraph.graph import StateGraph

def output_node(state: AgentState) -> AgentState:
    """输出节点 - 直接生成包含所有内容的消息"""
    
    # 获取最后的结果
    result_text = "处理结果..."
    
    # ✅ 创建完整的消息（不需要后处理）
    message = AIMessage(
        content=[
            {"type": "text", "text": result_text},
            # ✅ 如果需要生成式 UI，直接放在这里
            {
                "type": "json",
                "json": {
                    "type": "table",
                    "columns": [...],
                    "rows": [...]
                }
            }
        ]
    )
    
    state['messages'].append(message)
    return state

# ✅ LangGraph 会自动流式输出这条消息
# 前端会通过 streamMode: "messages" 实时接收
```

### 4. 文件附件处理（官方标准）

```python
# ✅ 官方标准：在消息的 content 中直接使用 file content block
from langchain_core.messages import HumanMessage

message = HumanMessage(
    content=[
        {"type": "text", "text": "用户输入"},
        {
            "type": "file",  # ✅ 官方支持的 content block
            "file": {
                "filename": "document.pdf",
                "file_data": "base64_encoded_data",  # ✅ Base64 编码
                "mime_type": "application/pdf"
            }
        }
    ]
)

# ✅ 提取文件的方式
if isinstance(content, list):
    for block in content:
        if block.get("type") == "file":
            file_data = block["file"]["file_data"]
            # 处理文件...
```

**不要这样做**：
```python
# ❌ 错误：使用自定义的 additional_kwargs.attachments
message.additional_kwargs['attachments'] = [...]
```

---

## 🔄 完整的前后端流程

### 1. 前端发送消息

```typescript
// ✅ 完全符合官方标准的消息
const messages: LangChainMessage[] = [
  {
    type: "human",
    content: [
      { type: "text", text: "用户输入" },
      {
        type: "file",
        file: {
          filename: "file.txt",
          file_data: "base64_data",
          mime_type: "text/plain"
        }
      }
    ],
    additional_kwargs: {
      // ✅ 可选的元数据（不影响消息解析）
      source: "editor",
      request_id: "req_123"
    }
  }
];

// ✅ 调用 sendMessage（自动流式传输）
yield* sendMessage({ threadId, messages });
```

### 2. 后端接收并处理

```python
# ✅ 后端直接接收 LangChain 消息
def route_node(state: AgentState) -> AgentState:
    last_message = state['messages'][-1]  # HumanMessage
    
    # ✅ 提取消息内容
    if isinstance(last_message.content, list):
        for block in last_message.content:
            if block.get("type") == "text":
                user_text = block["text"]
            elif block.get("type") == "file":
                file_data = block["file"]["file_data"]
    
    # ✅ 提取元数据（可选）
    metadata = last_message.additional_kwargs or {}
    
    return state
```

### 3. 后端返回带 UI 的消息

```python
# ✅ 直接在消息中包含 UI 数据
def process_node(state: AgentState) -> AgentState:
    # 处理逻辑...
    result = generate_table_data()
    
    # ✅ 创建包含 UI 的消息
    message = AIMessage(
        content=[
            {"type": "text", "text": "处理完成"},
            {
                "type": "json",
                "json": {
                    "type": "table",
                    "columns": result["columns"],
                    "rows": result["rows"]
                }
            }
        ]
    )
    
    state['messages'].append(message)
    return state
```

### 4. 前端接收并显示

```typescript
// ✅ useLangGraphMessages 自动处理所有事件类型
for await (const chunk of response) {
  // chunk.event = "messages" (token级)
  // chunk.data = [AIMessageChunk, metadata]
  
  // ✅ LangGraphMessageAccumulator 自动合并chunks
  // ✅ convertLangChainMessages 自动转换消息格式
  // ✅ 前端组件自动渲染 UI
}
```

---

## 🚀 流式输出事件类型

### 官方支持的事件类型

```typescript
// ✅ 官方定义的事件类型
enum LangGraphKnownEventTypes {
  Messages = "messages",              // ✅ Token 级别流式输出
  MessagesPartial = "messages/partial", // ✅ 部分消息（不推荐）
  MessagesComplete = "messages/complete", // ✅ 完整消息
  Metadata = "metadata",               // ✅ 元数据（不影响消息）
  Updates = "updates",                 // ✅ 状态更新
  Info = "info",                       // ✅ 信息事件
  Error = "error",                     // ✅ 错误事件
}
```

### 前端处理事件

```typescript
// ✅ 官方标准的事件处理（来自 useLangGraphMessages.ts）
for await (const chunk of response) {
  switch (chunk.event) {
    case "messages":  // ✅ Token 级别
      // chunk.data = [messageChunk, metadata]
      accumulator.addMessages([messageChunk]);
      break;
      
    case "messages/partial":  // ✅ 部分消息
      accumulator.addMessages(chunk.data);  // chunk.data = messages[]
      break;
      
    case "messages/complete":  // ✅ 完整消息
      accumulator.addMessages(chunk.data);
      break;
      
    case "updates":  // ✅ 状态更新
      // 可能包含其他 state 字段
      break;
      
    case "metadata":  // ✅ 元数据
      onMetadata?.(chunk.data);
      break;
      
    default:
      onCustomEvent?.(chunk.event, chunk.data);
      break;
  }
}
```

---

## ✅ 检查清单

### 前端检查

- [ ] 使用 `useLangGraphRuntime`（官方 hook）
- [ ] `stream` 函数直接 `yield* generator`（无任何处理）
- [ ] `sendMessage` 返回 `AsyncGenerator<LangGraphMessagesEvent>`
- [ ] 使用 `streamMode: "messages"`（Token 级流式）
- [ ] 事件处理在 `eventHandlers` 中定义
- [ ] 消息格式使用 `LangChainMessage` 类型
- [ ] 文件使用 `file` content block（不是自定义字段）

### 后端检查

- [ ] 状态定义使用 `Annotated[List[BaseMessage], operator.add]`
- [ ] 消息使用官方的 `HumanMessage`, `AIMessage` 等
- [ ] 内容使用 official content blocks（text, file, image_url 等）
- [ ] UI 数据在 `content` 中，不在 `additional_kwargs`
- [ ] 没有自定义消息转换逻辑
- [ ] 没有"后处理"节点阻塞流式输出
- [ ] 所有数据在消息中，状态字段最小化

### 消息流检查

- [ ] 前端消息 → 后端直接接收（无转换）
- [ ] 后端处理 → 返回完整的 `AIMessage`
- [ ] 消息字段都是官方标准
- [ ] 流式输出直接返回消息（无中间件）
- [ ] 前端自动转换并显示

---

## 🔗 参考文档

### 官方示例
1. `examples/with-langgraph/lib/chatApi.ts` - API 层
2. `examples/with-langgraph/app/MyRuntimeProvider.tsx` - Runtime Provider
3. `examples/with-langgraph/components/tools/` - Tool 组件示例

### 官方库实现
1. `packages/react-langgraph/src/useLangGraphRuntime.ts` - Runtime 实现
2. `packages/react-langgraph/src/useLangGraphMessages.ts` - 消息处理
3. `packages/react-langgraph/src/convertLangChainMessages.ts` - 消息转换
4. `packages/react-langgraph/src/types.ts` - 类型定义

### LangChain 官方文档
1. [BaseMessage](https://python.langchain.com/docs/concepts/messages/)
2. [Content Blocks](https://python.langchain.com/docs/concepts/messages/#content-blocks)
3. [LangGraph Streaming](https://python.langchain.com/docs/concepts/langgraph_streaming/)
4. [LangGraph State](https://python.langchain.com/docs/concepts/langgraph_state/)

---

## ❌ 常见错误及修正

### 错误 1：在 additional_kwargs 中放 UI 数据

```python
# ❌ 错误
message.additional_kwargs['ui'] = {"type": "table", ...}

# ✅ 正确
message.content = [
    {"type": "text", "text": "..."},
    {"type": "json", "json": {"type": "table", ...}}
]
```

### 错误 2：自定义消息转换逻辑

```typescript
// ❌ 错误
const customConvert = (msg) => {
  if (msg.additional_kwargs?.ui) {
    // 自定义处理 UI
  }
};

// ✅ 正确（官方已处理）
// 直接使用 convertLangChainMessages，无需自定义
```

### 错误 3：后处理节点阻塞流式输出

```python
# ❌ 错误
def output_node(state):  # 后处理节点
    for msg in state['messages']:
        # 修改消息格式
    return state

# ✅ 正确
def process_node(state):  # 处理节点
    # 直接创建包含所有数据的消息
    message = AIMessage(content=[...])
    state['messages'].append(message)
    return state
```

### 错误 4：自定义路由元数据字段

```typescript
// ❌ 错误
msg.additional_kwargs = {
    source: "editor",
    request_type: "tool",
    operation: "expand"
};

// ✅ 正确（如需要）
// 使用 metadata（新版本支持）
// 或在单独的 metadata message 中传递
```

---

## 🎯 关键要点总结

1. **消息是唯一的数据承载体** - 所有数据都应该在消息中
2. **官方类型优先** - 使用 `HumanMessage`, `AIMessage` 等
3. **Content Block 标准** - UI 数据使用 `json` content block
4. **无中间件流式** - 流式输出直接返回消息
5. **前端透明处理** - 前端库自动处理所有消息转换
6. **状态最小化** - 只保留必要的字段在 state 中


