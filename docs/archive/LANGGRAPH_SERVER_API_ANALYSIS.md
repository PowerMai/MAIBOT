# LangGraph Server API 端点分析与使用指南

## 核心概念

LangGraph Server 使用两个核心概念：

1. **Assistant（助手）**：对应一个已部署的 Graph（我们的 `agent`）
2. **Thread（线程）**：对应一个对话会话，保存状态和历史

## API 端点分类与使用

### 1. Assistant 端点（Graph 管理）

#### `/assistants`
- **用途**：列出所有可用的 assistants（graphs）
- **方法**：GET
- **使用场景**：发现系统中有哪些可用的 graphs
- **前端使用**：启动时可以获取，但我们已知 assistant_id 是 `"agent"`，通常不需要

#### `/assistants/{assistant_id}`
- **用途**：获取特定 assistant 的详细信息
- **方法**：GET
- **参数**：`assistant_id = "agent"`
- **返回**：assistant 的元数据、配置等
- **使用场景**：了解 graph 的结构和配置

#### `/assistants/{assistant_id}/graph`
- **用途**：获取 Graph 的可视化结构（节点、边等）
- **方法**：GET
- **使用场景**：调试、可视化展示 Graph 结构
- **前端使用**：可以在设置界面展示 Graph 结构图

#### `/assistants/{assistant_id}/schemas`
- **用途**：获取 Graph 的输入/输出 schema
- **方法**：GET
- **使用场景**：类型验证、自动生成 TypeScript 类型
- **前端使用**：开发时获取类型定义

---

### 2. Thread 端点（会话管理）⭐ **最常用**

#### `/threads` - 创建线程
- **用途**：创建新的对话线程
- **方法**：POST
- **Body**：`{"metadata": {...}}`
- **返回**：`{"thread_id": "...", "created_at": "...", "metadata": {...}}`
- **使用场景**：
  - ✅ 用户开始新对话时
  - ✅ 切换工作区时
  - ✅ 需要独立会话时

**示例**：
```typescript
const response = await fetch('http://localhost:2024/threads', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({
    metadata: {type: 'chat', workspace_id: 'workspace-123'}
  })
});
const {thread_id} = await response.json();
```

#### `/threads/{thread_id}` - 获取/删除线程
- **用途**：获取或删除特定线程
- **方法**：GET / DELETE
- **使用场景**：
  - GET：查看线程元数据
  - DELETE：清理旧对话

#### `/threads/{thread_id}/state` - 获取线程状态 ⭐
- **用途**：获取线程的当前状态（包括所有消息和变量）
- **方法**：GET
- **返回**：整个 `AgentState`，包括 `messages` 列表
- **使用场景**：
  - ✅ 执行完成后获取结果
  - ✅ 恢复对话历史
  - ✅ 调试状态

**示例**：
```typescript
const response = await fetch(`http://localhost:2024/threads/${threadId}/state`);
const state = await response.json();
// state.values.messages - 所有消息
// state.values.result - 执行结果
```

#### `/threads/{thread_id}/history`
- **用途**：获取线程的历史快照（所有 checkpoints）
- **方法**：GET
- **使用场景**：
  - 查看执行历史
  - 时光旅行调试
  - 回滚到之前的状态

---

### 3. Run 端点（任务执行）⭐ **最核心**

#### `/threads/{thread_id}/runs` - 创建执行任务
- **用途**：在线程中执行 Graph
- **方法**：POST
- **Body**：
```json
{
  "assistant_id": "agent",
  "input": {
    "messages": [
      {"type": "human", "content": "你好", "additional_kwargs": {...}}
    ]
  },
  "config": {...},
  "metadata": {...}
}
```
- **返回**：`{"run_id": "...", "thread_id": "...", "status": "pending"}`
- **使用场景**：
  - ✅ **这是执行任务的主要端点**
  - 每次用户发送消息都调用这个

#### `/threads/{thread_id}/runs/wait` - 执行并等待 ⭐⭐⭐
- **用途**：创建 Run 并等待完成（一次调用）
- **方法**：POST
- **Body**：同上
- **返回**：完整的执行结果（包括最终状态）
- **使用场景**：
  - ✅ **最推荐的端点**，简化了创建+轮询的流程
  - 适合同步等待结果的场景

**示例**：
```typescript
const response = await fetch(`http://localhost:2024/threads/${threadId}/runs/wait`, {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({
    assistant_id: 'agent',
    input: {
      messages: [{type: 'human', content: '你好', additional_kwargs: {...}}]
    }
  })
});
const result = await response.json();
// result 包含完整的最终状态
```

#### `/threads/{thread_id}/runs/stream` - 流式执行 ⭐⭐
- **用途**：创建 Run 并通过 SSE 流式返回中间结果
- **方法**：POST
- **返回**：Server-Sent Events 流
- **使用场景**：
  - ✅ 实时显示 AI 生成的文本
  - ✅ 显示中间步骤（如"正在理解..."、"正在规划..."）
  - ✅ 提升用户体验

**示例**：
```typescript
const response = await fetch(`http://localhost:2024/threads/${threadId}/runs/stream`, {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({
    assistant_id: 'agent',
    input: {messages: [{type: 'human', content: '你好'}]},
    stream_mode: 'values' // 或 'updates' / 'messages'
  })
});

const reader = response.body.getReader();
while (true) {
  const {done, value} = await reader.read();
  if (done) break;
  // 处理流式数据
  const chunk = new TextDecoder().decode(value);
  console.log('Received:', chunk);
}
```

#### `/threads/{thread_id}/runs/{run_id}` - 获取 Run 状态
- **用途**：查询特定 Run 的状态
- **方法**：GET
- **返回**：`{"run_id": "...", "status": "pending|running|done|failed", ...}`
- **使用场景**：
  - 轮询 Run 状态（如果不使用 `/wait`）
  - 检查是否完成

#### `/threads/{thread_id}/runs/{run_id}/join` - 等待 Run 完成
- **用途**：等待特定 Run 完成
- **方法**：GET
- **使用场景**：
  - 已创建 Run，后续等待完成

#### `/threads/{thread_id}/runs/{run_id}/cancel` - 取消 Run
- **用途**：取消正在执行的 Run
- **方法**：POST
- **使用场景**：
  - 用户点击"停止生成"
  - 超时取消

---

## 推荐使用流程

### 方案 A：简单同步模式（当前实现）⭐ **推荐用于初期**

```typescript
// 1. 创建或获取 Thread
const thread = await fetch('http://localhost:2024/threads', {method: 'POST'});
const {thread_id} = await thread.json();

// 2. 执行并等待（一次调用）
const result = await fetch(`http://localhost:2024/threads/${thread_id}/runs/wait`, {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({
    assistant_id: 'agent',
    input: {
      messages: [{
        type: 'human',
        content: '你好',
        additional_kwargs: {
          source: 'chatarea',
          request_type: 'agent_chat'
        }
      }]
    }
  })
});

const data = await result.json();
// data.values.messages - 所有消息（包括 AI 回复）
// data.values.result - 执行结果
```

**优点**：
- ✅ 简单直接，一次 HTTP 调用
- ✅ 无需轮询或管理 Run ID
- ✅ 适合同步等待的场景

**缺点**：
- ❌ 无法显示中间进度
- ❌ 长时间执行可能超时

---

### 方案 B：流式模式⭐⭐ **推荐用于生产**

```typescript
// 1. 创建 Thread（同上）

// 2. 流式执行
const response = await fetch(`http://localhost:2024/threads/${thread_id}/runs/stream`, {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({
    assistant_id: 'agent',
    input: {messages: [...]},
    stream_mode: 'values', // 返回完整状态更新
    // stream_mode: 'messages', // 仅返回新消息
    // stream_mode: 'updates', // 仅返回状态变化
  })
});

// 3. 处理 SSE 流
const reader = response.body.getReader();
const decoder = new TextDecoder();

while (true) {
  const {done, value} = await reader.read();
  if (done) break;
  
  const chunk = decoder.decode(value);
  const lines = chunk.split('\n');
  
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const data = JSON.parse(line.slice(6));
      
      // 实时更新 UI
      if (data.messages) {
        const lastMessage = data.messages[data.messages.length - 1];
        updateChatUI(lastMessage);
      }
    }
  }
}
```

**优点**：
- ✅ 实时显示 AI 生成内容（打字机效果）
- ✅ 显示中间步骤（Understanding → Planning → Execution）
- ✅ 更好的用户体验
- ✅ 不会超时

**缺点**：
- ❌ 实现稍复杂
- ❌ 需要处理流式数据

---

### 方案 C：异步轮询模式（不推荐）

```typescript
// 1. 创建 Run
const run = await fetch(`http://localhost:2024/threads/${thread_id}/runs`, {...});
const {run_id} = await run.json();

// 2. 轮询状态
while (true) {
  const status = await fetch(`http://localhost:2024/threads/${thread_id}/runs/${run_id}`);
  const {status} = await status.json();
  
  if (status === 'done') break;
  await new Promise(r => setTimeout(r, 500));
}

// 3. 获取结果
const state = await fetch(`http://localhost:2024/threads/${thread_id}/state`);
```

**缺点**：
- ❌ 需要轮询，浪费资源
- ❌ 代码复杂
- ❌ 已有 `/wait` 和 `/stream` 替代

---

## 实际应用建议

### 1. 聊天对话（ChatArea）
**使用**：`/threads/{thread_id}/runs/stream`
- 实时显示 AI 回复
- 显示生成进度

### 2. 文件操作（快速工具）
**使用**：`/threads/{thread_id}/runs/wait`
- 同步等待结果
- 简单快速

### 3. 编辑器 AI 操作（代码扩展、重构）
**使用**：`/threads/{thread_id}/runs/stream`
- 实时显示分析过程
- 用户可以看到 AI 的思考步骤

### 4. 获取对话历史
**使用**：`/threads/{thread_id}/state`
- 恢复会话
- 显示完整对话

### 5. 调试和可视化
**使用**：`/assistants/agent/graph`
- 开发阶段查看 Graph 结构

---

## 消息格式说明

LangChain 消息会自动序列化，前端发送：

```typescript
{
  type: 'human',  // 或 'ai', 'system', 'tool'
  content: '你好',
  additional_kwargs: {
    source: 'chatarea',
    request_type: 'agent_chat',
    // ... 其他路由信息
  }
}
```

后端收到的是完整的 LangChain `HumanMessage` 对象，**无需手动转换**！

---

## 总结

### 立即使用
1. ✅ `/threads` - 创建会话
2. ✅ `/threads/{thread_id}/runs/wait` - 简单同步执行
3. ✅ `/threads/{thread_id}/state` - 获取结果

### 生产优化
1. ⭐ `/threads/{thread_id}/runs/stream` - 流式执行（最佳用户体验）
2. ⭐ `/assistants/agent/graph` - 可视化调试

### 不需要
- ❌ 手动轮询 `/runs/{run_id}` 状态
- ❌ 手动序列化/反序列化消息
- ❌ 复杂的状态管理

---

**当前实现问题**：我之前实现的 API 客户端使用了轮询模式，应该改为使用 `/runs/wait` 端点，更简单高效。

