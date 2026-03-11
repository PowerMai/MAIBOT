# 流式输出修复 - 累积消息列表

## 🔍 根本问题

从日志和代码分析发现：

1. **assistant-ui 的 `replaceMessages` 行为**：
   ```typescript
   case LangGraphKnownEventTypes.Updates:
     if (Array.isArray(chunk.data.messages)) {
       setMessages(accumulator.replaceMessages(chunk.data.messages));
     }
   ```
   - `replaceMessages` 会**替换所有消息**，而不是追加
   - 如果只发送新消息，之前的消息会被覆盖

2. **当前代码的问题**：
   - 每次只发送**新消息**（`messagesInThisUpdate`）
   - assistant-ui 收到后，会**替换**所有消息，导致之前的消息丢失
   - 用户看不到中间过程，只能看到最后的结果

## ✅ 修复方案

### 关键修复：维护累积消息列表

```typescript
// ✅ 使用 Map 按 ID 去重和更新
const accumulatedMessages = new Map<string, LangChainMessage>();

// 每次节点更新时：
// 1. 提取新消息
// 2. 更新或添加到累积列表（按 ID 去重）
// 3. 发送完整的累积消息列表
```

### 修复细节

1. **消息 ID 生成**：
   - 优先使用消息原有的 `id`
   - 如果没有，基于节点名和内容生成唯一 ID

2. **消息更新逻辑**：
   - 如果消息 ID 已存在，比较内容
   - 如果内容不同或更长，更新消息
   - 这样可以支持消息的增量更新

3. **发送完整列表**：
   ```typescript
   yield {
     event: 'updates',
     data: {
       messages: Array.from(accumulatedMessages.values()),  // ✅ 完整列表
     },
   };
   ```

## 📊 预期行为

### 修复前
- 节点 1 完成 → 发送消息 A → assistant-ui 显示 A
- 节点 2 完成 → 发送消息 B → assistant-ui **替换**为 B（A 丢失）
- 节点 3 完成 → 发送消息 C → assistant-ui **替换**为 C（A、B 丢失）
- **结果**：用户只能看到最后的消息 C

### 修复后
- 节点 1 完成 → 累积消息 A → 发送 [A] → assistant-ui 显示 A
- 节点 2 完成 → 累积消息 A、B → 发送 [A, B] → assistant-ui 显示 A、B
- 节点 3 完成 → 累积消息 A、B、C → 发送 [A, B, C] → assistant-ui 显示 A、B、C
- **结果**：用户可以看到完整的思考过程

## 🔍 调试信息

修复后的日志应该显示：
```
[chatApi] ✅ 提取/更新 AI 消息: { node: 'deepagent', messageKey: '...', contentLength: 335, isUpdate: false }
[chatApi] 📤 发送完整消息列表给 assistant-ui: { totalMessages: 1, updateNumber: 2 }
[chatApi] ✅ 提取/更新 AI 消息: { node: 'generative_ui', messageKey: '...', contentLength: 335, isUpdate: true }
[chatApi] 📤 发送完整消息列表给 assistant-ui: { totalMessages: 1, updateNumber: 3 }
```

## ✅ 验证清单

- [x] 使用 Map 维护累积消息列表
- [x] 每次节点更新时更新或添加消息
- [x] 发送完整的累积消息列表
- [x] 确保消息有唯一 ID
- [x] 支持消息内容更新（如果 ID 相同但内容不同）

## 🚀 测试步骤

1. **刷新前端**：`Cmd+Shift+R`
2. **发送消息**："写一个投标文件"
3. **观察控制台**：
   - 应该看到多次 `📤 发送完整消息列表给 assistant-ui`
   - `totalMessages` 应该逐渐增加
   - 前端应该实时显示消息更新

4. **观察 UI**：
   - 应该看到消息逐步出现
   - 不应该等到最后才一次性显示

