# 完全按照 LangChain 官方示例实现

## ✅ 已完成的修复

### 1. 简化 `sendMessage` 函数

**文件**: `frontend/desktop/src/lib/api/langserveChat.ts`

**修改**:
- ✅ 完全按照官方示例：直接返回 `client.runs.stream()` 的结果
- ✅ 使用 `streamMode: "messages"`（token 级别流式传输）
- ❌ 移除所有事件转换逻辑（让 `useLangGraphMessages` 处理）

**官方示例参考**:
```typescript
// 官方示例：https://github.com/Yonom/assistant-ui/blob/main/examples/with-langgraph/lib/chatApi.ts
export const sendMessage = (params: {
  threadId: string;
  messages: LangChainMessage[];
}): AsyncGenerator<LangGraphMessagesEvent<LangChainMessage>> => {
  const client = createClient();
  const input: Record<string, unknown> | null = {
    messages: params.messages,
  };
  return client.runs.stream(
    params.threadId,
    process.env["NEXT_PUBLIC_LANGGRAPH_ASSISTANT_ID"]!,
    {
      input,
      config,
      streamMode: "messages", // ✅ token 级别流式传输
    },
  ) as AsyncGenerator<LangGraphMessagesEvent<LangChainMessage>>;
};
```

### 2. 简化 `MyRuntimeProvider` 流式处理

**文件**: `frontend/desktop/src/components/ChatComponents/MyRuntimeProvider.tsx`

**修改**:
- ✅ 完全按照官方示例：直接 `yield* generator`，不做任何转换
- ✅ 保留编辑器操作检测（不影响流式输出）
- ✅ 保留文件上传适配器（符合 assistant-ui 标准）

**官方示例参考**:
```typescript
// 官方示例：https://github.com/Yonom/assistant-ui/blob/main/examples/with-langgraph/app/MyRuntimeProvider.tsx
const runtime = useLangGraphRuntime({
  stream: async function* (messages, { initialize }) {
    const { externalId } = await initialize();
    if (!externalId) throw new Error("Thread not found");

    const generator = sendMessage({
      threadId: externalId,
      messages,
    });

    yield* generator; // ✅ 直接 yield*，不做任何转换
  },
  // ...
});
```

### 3. 文件上传适配器

**文件**: `frontend/desktop/src/components/ChatComponents/MyRuntimeProvider.tsx`

**说明**:
- ✅ 保留 `adapters.attachments` 配置（符合 assistant-ui 标准）
- ✅ 文件格式符合 `getMessageContent` 的要求
- ✅ `file.data` 会被放到 `file.file_data` 中（LangChain 标准格式）

## 📋 关键发现

### 1. 流式输出

**官方实现**:
- 使用 `streamMode: "messages"` 实现 token 级别流式传输
- **直接返回** `client.runs.stream()` 的结果，**不做任何转换**
- `useLangGraphMessages` 会自动处理所有事件类型（Messages, MessagesPartial, MessagesComplete, Updates 等）

**我们的实现**:
- ✅ 完全符合官方示例
- ✅ 直接返回 stream，不做任何转换
- ✅ 让 `useLangGraphMessages` 处理所有事件

### 2. 文件上传

**官方实现**:
- assistant-ui 需要 `adapters.attachments` 来处理文件上传
- `getMessageContent` 会将 `attachment.content` 中的 `file` 类型转换为 LangChain 的 `file` content block
- `file.data` 会被放到 `file.file_data` 中

**我们的实现**:
- ✅ 符合 assistant-ui 标准
- ✅ 文件格式正确（Data URL 格式）
- ✅ 会被正确转换为 LangChain 的 file content block

## 🎯 预期效果

### 修复前
- ❌ 做了太多事件转换，破坏了事件格式
- ❌ 流式输出被阻塞
- ❌ 前端无法正确显示消息

### 修复后
- ✅ 完全按照官方示例实现
- ✅ 流式输出正常工作（token 级别）
- ✅ 文件上传正常工作
- ✅ 前端正确显示消息

## 📝 测试步骤

1. **重启后端**（应用新的 Graph 结构）
2. **刷新前端页面**（Cmd+Shift+R）
3. **测试流式输出**：
   - 发送测试消息："你好"
   - 应该能看到逐字显示（token 级别流式传输）
4. **测试文件上传**：
   - 上传一个文件
   - 检查后端是否接收到文件
   - 检查文件是否正确传递给 DeepAgent

---

*更新时间: 2026-01-04*
*参考: https://github.com/Yonom/assistant-ui/tree/main/examples/with-langgraph*

