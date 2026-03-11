# 流式输出调试指南

## 🎯 目标
解决 DeepAgent 和 Graph 的流式输出问题，确保前端能够实时显示 AI 响应。

## 🔧 已实施的调试措施

### 1. 后端调试配置

#### 启用 LangChain 详细调试
```python
# backend/engine/agent/deep_agent.py
os.environ["LANGCHAIN_TRACING_V2"] = "true"
os.environ["LANGCHAIN_VERBOSE"] = "true"
os.environ["LANGCHAIN_DEBUG"] = "true"
```

#### 流式输出日志
- 在 `main_graph.py` 中添加了 `log_streaming_event()` 函数
- 记录每个节点的流式输出事件
- 显示消息数量和内容预览

### 2. 前端调试配置

#### 详细事件日志
- 在 `langserveChat.ts` 中添加了详细的事件日志
- 记录原始事件格式、节点名称、消息数量
- 显示消息内容预览和 UI 配置

### 3. 测试脚本

运行测试脚本：
```bash
cd /Users/workspace/DevelopProjects/ccb-v0.378
export ENABLE_STREAMING_DEBUG=true
export ENABLE_LANGCHAIN_DEBUG=true
python backend/test_streaming_debug.py
```

## 📊 调试信息位置

### 后端日志
- **DeepAgent 流式输出**: 查看 `backend/engine/agent/deep_agent.py` 的日志
- **Graph 节点更新**: 查看 `backend/engine/core/main_graph.py` 的日志
- **LangChain 内部**: 查看 `LANGCHAIN_DEBUG` 环境变量启用的日志

### 前端日志
- **事件接收**: 浏览器控制台的 `[chatApi] 📥 收到原始事件`
- **消息提取**: `[chatApi] ✅ 提取/更新 AI 消息`
- **消息发送**: `[chatApi] 📤 发送完整消息列表给 assistant-ui`

## 🔍 问题排查步骤

### 1. 检查后端是否发送流式事件
```bash
# 查看后端日志，应该看到：
[更新 #1] 节点: router
[更新 #2] 节点: deepagent
  ✅ 包含 X 条消息
```

### 2. 检查前端是否接收事件
打开浏览器控制台，应该看到：
```
[chatApi] 📥 收到原始事件: { eventType: 'updates', ... }
[chatApi] 📥 节点更新 #1: { nodeNames: [...], ... }
```

### 3. 检查消息是否正确提取
应该看到：
```
[chatApi] ✅ 提取/更新 AI 消息: { node: 'model', contentLength: 123, ... }
[chatApi] 📤 发送完整消息列表给 assistant-ui: { totalMessages: 1, ... }
```

### 4. 检查 assistant-ui 是否正确显示
查看 `MyRuntimeProvider.tsx` 的日志：
```
[MyRuntimeProvider] 📨 收到事件: { hasMessages: true, ... }
```

## 🐛 常见问题

### 问题 1: 没有收到流式事件
**可能原因**:
- `streamMode` 配置错误
- DeepAgent 内部节点没有正确发送消息
- LangGraph SDK 版本问题

**解决方案**:
1. 检查 `langserveChat.ts` 中的 `streamMode: "updates"`
2. 检查后端日志，确认节点是否执行
3. 检查 `deepagent_graph` 是否正确配置为 Subgraph

### 问题 2: 收到事件但没有消息
**可能原因**:
- 节点更新中没有 `messages` 字段
- 消息格式不正确
- 消息类型不是 `ai`

**解决方案**:
1. 查看后端日志中的 `log_streaming_event()` 输出
2. 检查前端日志中的事件数据结构
3. 确认消息类型为 `AIMessage`

### 问题 3: 消息被覆盖而不是增量更新
**可能原因**:
- `assistant-ui` 的 `replaceMessages` 行为
- 消息 ID 不正确
- 累积消息列表逻辑错误

**解决方案**:
1. 确保每次发送完整的累积消息列表
2. 确保消息 ID 唯一且稳定
3. 检查 `accumulatedMessages` Map 的逻辑

## 📝 下一步

1. **运行测试脚本**，查看后端流式输出
2. **打开前端页面**，查看浏览器控制台日志
3. **对比前后端日志**，找出问题所在
4. **修复问题**，确保流式输出正常工作

## 🔗 相关文件

- `backend/engine/agent/deep_agent.py` - DeepAgent 配置
- `backend/engine/core/main_graph.py` - 主 Graph 配置
- `frontend/desktop/src/lib/api/langserveChat.ts` - 前端流式处理
- `frontend/desktop/src/components/ChatComponents/MyRuntimeProvider.tsx` - 前端运行时

