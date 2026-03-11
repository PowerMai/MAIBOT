# 流式输出调试检查清单

## 🔍 问题现象
- 后端日志显示有 `[updates]` 事件和消息
- 前端控制台有调试日志
- **但聊天页面没有显示消息**

## 📋 检查步骤

### 1. 检查前端是否收到事件
打开浏览器控制台，应该看到：
```
[chatApi] 📥 收到原始事件: { eventType: 'updates', ... }
[chatApi] 📥 节点更新 #1: { nodeNames: [...], ... }
```

### 2. 检查消息是否被提取
应该看到：
```
[chatApi] 🔍 处理节点: { nodeName: 'model', hasMessages: true, ... }
[chatApi] 📨 节点消息: { messageCount: 1, ... }
[chatApi] 🔎 检查消息: { msgType: 'ai', isAIMessage: true, ... }
[chatApi] ✅ 提取/更新 AI 消息: { node: 'model', contentLength: 123, ... }
```

### 3. 检查消息是否发送给 assistant-ui
应该看到：
```
[chatApi] 📤 发送完整消息列表给 assistant-ui: { totalMessages: 1, ... }
[MyRuntimeProvider] 📨 收到事件: { hasEvent: true, ... }
[MyRuntimeProvider] 📊 事件数据: { hasMessages: true, messagesLength: 1, ... }
```

### 4. 检查 assistant-ui 是否正确处理
查看 `useLangGraphMessages` 的日志（如果有）

## 🐛 可能的问题

### 问题 1: 消息类型不匹配
**症状**: `isAIMessage: false`
**解决**: 检查 `msgType` 的值，可能需要添加更多类型判断

### 问题 2: 消息内容为空
**症状**: `contentLength: 0`
**解决**: 检查消息对象的 `content` 字段格式

### 问题 3: 消息格式不正确
**症状**: `hasMessages: false` 在 MyRuntimeProvider
**解决**: 检查发送给 assistant-ui 的消息格式

### 问题 4: assistant-ui 没有更新
**症状**: 所有日志都正常，但 UI 不更新
**解决**: 检查 assistant-ui 的 `replaceMessages` 是否正确调用

## 🔧 下一步调试

1. **刷新前端页面**（Cmd+Shift+R）
2. **发送测试消息**："你好"
3. **查看控制台日志**，按照上述检查清单逐项检查
4. **如果某个步骤失败**，记录具体的日志输出

