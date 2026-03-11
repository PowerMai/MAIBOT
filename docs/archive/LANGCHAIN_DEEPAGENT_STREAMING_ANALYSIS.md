# LangChain + DeepAgent + LangGraph 流式输出完整分析

## 问题根源分析

### 当前架构
```
前端 (streamMode: "messages")
  ↓
LangGraph Server
  ↓
Main Graph (router → deepagent → generative_ui)
  ↓
DeepAgent Subgraph (Understanding → Planning → Delegation → Synthesis → Output)
  ↓
LLM (streaming=True ✅)
```

### 为什么没有流式输出？

**关键问题**：虽然 LLM 配置了 `streaming=True`，但流式输出在 **DeepAgent 的多节点工作流中被阻塞**。

#### 流式输出被阻塞的原因

1. **DeepAgent 的节点间依赖**：
   ```
   Understanding 节点 → 等待完整响应 → Planning 节点 → 等待完整响应 → ...
   ```
   每个节点都需要前一个节点的**完整输出**才能开始执行。

2. **LangGraph 的 Subgraph 流式传输限制**：
   - Subgraph 内部的流式事件**不会自动传递**到父 Graph
   - 只有 Subgraph **完成**后，才会返回最终结果
   - 这是 LangGraph 的设计限制，不是 bug

3. **`streamMode: "messages"` 的工作原理**：
   - 只有**单个 LLM 调用**的流式输出才能被捕获
   - 多节点 Graph 的流式输出需要特殊处理

## LangChain 官方解决方案

### 方案 1：使用 `streamMode: "updates"` + 前端处理（推荐）

这是 LangChain 官方推荐的多节点 Graph 流式输出方式。

#### 后端配置（已正确）

```python
# backend/engine/agent/deep_agent.py
llm = ChatOpenAI(
    model=model_name,
    base_url=OrchestratorConfig.MODEL_URL,
    api_key="sk-no-key",
    temperature=OrchestratorConfig.TEMPERATURE,
    max_tokens=OrchestratorConfig.MAX_TOKENS,
    timeout=OrchestratorConfig.TIMEOUT,
    streaming=True,  # ✅ 启用流式输出
)

# DeepAgent Graph 会自动传递流式事件
agent = create_deep_agent(
    model=model,
    tools=orchestrator_tools,
    system_prompt=enhanced_orchestrator_prompt,
    subagents=[document_agent_config],
    backend=backend_factory,
    debug=OrchestratorConfig.DEBUG_MODE,
    name="orchestrator",
)
```

#### 前端配置（需要修改）

```typescript
// frontend/desktop/src/lib/api/langserveChat.ts

// ✅ 使用 "updates" 模式获取节点级别的更新
const stream = client.runs.stream(
  params.threadId,
  assistantId,
  {
    input,
    streamMode: "updates",  // ✅ 节点更新模式
  },
);

// ✅ 处理流式事件，提取 AI 消息的增量更新
async function* transformEvents() {
  let lastAIMessageContent = "";
  
  for await (const event of stream) {
    const eventType = getattr(event, "event", "unknown");
    const eventData = getattr(event, "data", null);
    
    // 处理 updates 事件
    if (eventType === "updates" && eventData) {
      // 遍历所有节点的更新
      for (const nodeName in eventData) {
        const nodeData = eventData[nodeName];
        
        // 提取消息
        if (nodeData && nodeData.messages) {
          const messages = nodeData.messages;
          
          // 找到最新的 AI 消息
          for (const msg of messages) {
            if (msg.type === "ai" && msg.content) {
              const currentContent = msg.content;
              
              // ✅ 计算增量内容（新内容 - 旧内容）
              if (currentContent.length > lastAIMessageContent.length) {
                const incrementalContent = currentContent.substring(
                  lastAIMessageContent.length
                );
                
                // ✅ 发送增量更新
                yield {
                  event: "messages/partial",
                  data: [{
                    type: "ai",
                    content: incrementalContent,
                  }],
                };
                
                lastAIMessageContent = currentContent;
              }
            }
          }
        }
      }
    }
    
    // 最终完整消息
    if (eventType === "end" || eventType === "error") {
      if (lastAIMessageContent) {
        yield {
          event: "messages/complete",
          data: [{
            type: "ai",
            content: lastAIMessageContent,
          }],
        };
      }
    }
  }
}
```

### 方案 2：配置 DeepAgent 的流式模式（官方推荐）

DeepAgent 支持配置流式输出行为。

#### 修改 DeepAgent 配置

```python
# backend/engine/agent/deep_agent.py

agent = create_deep_agent(
    model=model,
    tools=orchestrator_tools,
    system_prompt=enhanced_orchestrator_prompt,
    subagents=[document_agent_config],
    backend=backend_factory,
    debug=OrchestratorConfig.DEBUG_MODE,
    name="orchestrator",
    # ✅ 关键：配置流式输出模式
    stream_mode="updates",  # 或 "messages"
)
```

**注意**：需要查看 `deepagents` 库的文档确认是否支持此参数。

### 方案 3：使用 LangGraph 的 `astream_events`（最佳方案）

这是 LangChain 官方推荐的**最强大**的流式输出方式，支持捕获所有 LLM 调用的流式输出。

#### 后端修改

```python
# backend/engine/core/main_graph.py

# 不需要修改 Graph 结构，只需要确保 LLM 配置了 streaming=True
```

#### 前端修改

```typescript
// frontend/desktop/src/lib/api/langserveChat.ts

// ✅ 使用 "events" 模式（最强大的流式模式）
const stream = client.runs.stream(
  params.threadId,
  assistantId,
  {
    input,
    streamMode: "events",  // ✅ 事件流模式
  },
);

async function* transformEvents() {
  for await (const event of stream) {
    const eventType = event.event;
    const eventData = event.data;
    
    // ✅ 捕获所有 LLM 的流式输出
    if (eventType === "on_chat_model_stream") {
      // 这是 LLM 的增量输出
      const chunk = eventData.chunk;
      if (chunk && chunk.content) {
        yield {
          event: "messages/partial",
          data: [{
            type: "ai",
            content: chunk.content,
          }],
        };
      }
    }
    
    // 其他事件类型...
  }
}
```

## 推荐实现方案

### 最佳方案：`streamMode: "events"` + 事件过滤

这是 LangChain 官方文档推荐的方式，适用于复杂的多节点 Graph。

#### 完整实现

```typescript
// frontend/desktop/src/lib/api/langserveChat.ts

export const sendMessage = (params: {
  threadId: string;
  messages: LangChainMessage[];
}): AsyncGenerator<LangGraphMessagesEvent<LangChainMessage>> => {
  const client = createClient();
  const assistantId = "agent";  // 使用完整的 DeepAgent
  
  // ✅ 使用 events 模式
  const stream = client.runs.stream(
    params.threadId,
    assistantId,
    {
      input: { messages: params.messages },
      streamMode: "events",  // ✅ 事件流模式
    },
  );
  
  async function* transformEvents() {
    let accumulatedContent = "";
    
    for await (const event of stream) {
      const eventType = event.event;
      const eventName = event.name;
      const eventData = event.data;
      
      console.log(`[chatApi] 📥 事件: ${eventType} | ${eventName}`);
      
      // ✅ 捕获 LLM 流式输出
      if (eventType === "on_chat_model_stream") {
        const chunk = eventData?.chunk;
        if (chunk && chunk.content) {
          accumulatedContent += chunk.content;
          
          // 发送增量更新
          yield {
            event: "messages/partial",
            data: [{
              type: "ai",
              content: chunk.content,  // 增量内容
            }],
          };
        }
      }
      
      // ✅ 捕获节点完成事件
      else if (eventType === "on_chain_end" && eventName === "orchestrator") {
        // DeepAgent 完成
        const output = eventData?.output;
        if (output && output.messages) {
          const lastMessage = output.messages[output.messages.length - 1];
          
          // 发送完整消息
          yield {
            event: "messages/complete",
            data: [lastMessage],
          };
        }
      }
      
      // ✅ 错误处理
      else if (eventType === "on_chain_error") {
        yield {
          event: "error",
          data: {
            message: eventData?.error || "Unknown error",
          },
        };
      }
    }
  }
  
  return transformEvents();
};
```

## 关键配置对比

| 配置项 | `messages` 模式 | `updates` 模式 | `events` 模式（推荐） |
|--------|----------------|----------------|---------------------|
| **适用场景** | 单节点 Graph | 多节点 Graph | 任何 Graph |
| **流式粒度** | 逐 token | 节点级别 | 所有事件（最细粒度） |
| **DeepAgent 支持** | ❌ 不支持（被阻塞） | ✅ 支持（节点更新） | ✅ 完美支持（LLM 流式） |
| **前端处理复杂度** | 低 | 中 | 中 |
| **真正流式输出** | ✅（单节点） | ⚠️（节点完成后） | ✅（逐 token） |

## 实施步骤

### 步骤 1：确认后端配置（已完成）

```python
# backend/engine/agent/deep_agent.py
llm = ChatOpenAI(
    streaming=True,  # ✅ 已配置
    # ...
)
```

### 步骤 2：修改前端流式模式

```typescript
// frontend/desktop/src/lib/api/langserveChat.ts
streamMode: "events",  // ✅ 改为 events 模式
```

### 步骤 3：实现事件过滤和转换

参考上面的完整实现代码。

### 步骤 4：测试

1. 重启后端（如果修改了后端）
2. 刷新前端
3. 发送消息
4. 观察流式输出

## 故障排除

### 问题：仍然没有流式输出

**检查清单**：
1. ✅ LLM 配置了 `streaming=True`
2. ✅ 前端使用 `streamMode: "events"`
3. ✅ 事件过滤逻辑正确
4. ✅ LM Studio 模型支持流式输出

**调试方法**：
```typescript
// 打印所有事件
for await (const event of stream) {
  console.log('[DEBUG] 事件:', event.event, event.name, event.data);
}
```

### 问题：事件类型不匹配

**原因**：LangGraph SDK 的事件格式可能与文档不同。

**解决**：
1. 打印所有事件类型
2. 根据实际事件类型调整过滤逻辑

## 参考文档

- [LangGraph Streaming](https://langchain-ai.github.io/langgraph/concepts/streaming/)
- [LangGraph Stream Modes](https://langchain-ai.github.io/langgraph/how-tos/stream-values/)
- [assistant-ui LangGraph Integration](https://www.assistant-ui.com/docs/runtimes/langgraph)
- [DeepAgents Documentation](https://github.com/langchain-ai/deepagents)

## 总结

✅ **LangChain + DeepAgent 完全支持流式输出**  
✅ **关键是使用正确的 `streamMode`**  
✅ **推荐使用 `events` 模式获得最佳流式体验**  

**核心原则**：
1. 后端：LLM 必须配置 `streaming=True`
2. 前端：使用 `streamMode: "events"` 捕获所有 LLM 流式输出
3. 前端：实现事件过滤和转换逻辑
4. 测试：验证流式输出是否逐 token 显示

