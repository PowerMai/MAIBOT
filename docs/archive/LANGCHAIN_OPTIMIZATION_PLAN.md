# LangChain 使用优化方案

## 🔍 发现的问题

### 1. 文件上传格式问题

**当前实现**：
- 使用 Data URL 格式：`data:mime/type;base64,<base64_data>`
- 但官方 `getMessageContent` 期望：`file_data: part.data`（纯 base64 或 Data URL）

**官方实现** (`useLangGraphRuntime.ts:61-69`)：
```typescript
case "file":
  return {
    type: "file" as const,
    file: {
      filename: part.filename ?? "file",
      file_data: part.data,  // ✅ 直接使用 part.data
      mime_type: part.mimeType,
    },
  };
```

**问题**：
- `toCreateMessage.ts` 中，`url: part.data` 说明 `part.data` 可以是 Data URL
- 但 `getMessageContent` 中，`file_data: part.data` 期望的是纯 base64 或 Data URL
- 需要确认后端是否能正确处理 Data URL 格式

### 2. 流式输出问题

**当前实现**：
- 使用 `streamMode: "updates"` - 节点级别的更新
- 手动转换事件格式
- 没有处理 `Messages` 事件（token 级别的流式传输）

**官方实现** (`useLangGraphMessages.ts:120-145`)：
```typescript
switch (chunk.event) {
  case LangGraphKnownEventTypes.MessagesPartial:
  case LangGraphKnownEventTypes.MessagesComplete:
    setMessages(accumulator.addMessages(chunk.data));
    break;
  case LangGraphKnownEventTypes.Updates:
    if (Array.isArray(chunk.data.messages)) {
      setMessages(accumulator.replaceMessages(chunk.data.messages));
    }
    break;
  case LangGraphKnownEventTypes.Messages: {
    // ✅ token 级别的流式传输
    const [messageChunk] = (chunk as LangChainMessageTupleEvent).data;
    if (isLangChainMessageChunk(messageChunk)) {
      const updatedMessages = accumulator.addMessages([
        messageChunk as unknown as TMessage,
      ]);
      setMessages(updatedMessages);
    }
    break;
  }
}
```

**问题**：
- 我们没有处理 `Messages` 事件，所以无法实现 token 级别的流式传输
- 官方示例使用 `streamMode: "messages"` 来获得 token 级别的流式传输

### 3. 消息累积问题

**当前实现**：
- 使用 `Map` 手动累积消息
- 手动处理消息更新

**官方实现**：
- 使用 `LangGraphMessageAccumulator` 类
- 使用 `appendMessage` 函数来处理消息块追加（实现逐字显示）

## ✅ 优化方案

### 优化1: 修复文件格式

**方案A（推荐）**：使用纯 base64 字符串
- 修改 `MyRuntimeProvider.tsx` 中的 `send` 方法
- 返回纯 base64 字符串，不是 Data URL
- 后端需要从 Data URL 中提取 base64 部分（已实现）

**方案B**：保持 Data URL 格式
- 确保后端能正确处理 Data URL 格式（已实现）
- 需要确认 `getMessageContent` 是否能处理 Data URL

### 优化2: 支持 token 级别的流式传输

**方案**：
1. 尝试使用 `streamMode: "messages"` 或 `streamMode: ["messages", "updates"]`
2. 处理 `Messages` 事件，使用 `appendLangChainChunk` 来累积消息块
3. 这样可以实现逐字显示（"打印机效果"）

### 优化3: 使用官方消息累积器

**方案**：
- 使用 `LangGraphMessageAccumulator` 类
- 使用 `appendLangChainChunk` 函数来处理消息块追加
- 这样可以自动处理消息累积和更新

## 📋 实施步骤

### 步骤1: 修复文件格式

1. 检查后端是否能正确处理 Data URL（已实现）
2. 如果需要，修改前端返回纯 base64 字符串

### 步骤2: 支持 token 级别的流式传输

1. 修改 `langserveChat.ts`，支持 `streamMode: "messages"` 或 `["messages", "updates"]`
2. 处理 `Messages` 事件，使用 `appendLangChainChunk` 来累积消息块
3. 处理 `Updates` 事件，使用 `replaceMessages` 来替换消息列表

### 步骤3: 使用官方消息累积器

1. 导入 `LangGraphMessageAccumulator` 和 `appendLangChainChunk`
2. 替换手动消息累积逻辑

---

*更新时间: 2026-01-04*

