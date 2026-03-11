# 🔗 前端-后端 LangGraph SDK Lite 对接检查清单

## 📋 对接状态概览

### ✅ 已完成项

#### 后端 - LangGraph Server 配置
- [x] `langgraph.json` 已配置，指向 `backend.engine.core.main_agent:agent`
- [x] `agent` 已在 `main_agent.py` 中正确导出
- [x] DeepAgent 已正确初始化，支持 `stream()` 方法
- [x] FilesystemBackend 已配置，避免 `os.getcwd()` 阻塞调用
- [x] LLM 配置正确：使用 `ChatOpenAI` 连接到 LM Studio (`http://localhost:1234`)

#### 前端 - LangGraph SDK 集成
- [x] 安装了 `@langchain/langgraph-sdk`
- [x] `langserveChat.ts` 使用官方 `Client` API
- [x] `MyRuntimeProvider.tsx` 实现了标准的 `useLangGraphRuntime`
- [x] 主编辑页面已集成 `<MyRuntimeProvider><Thread/></MyRuntimeProvider>`
- [x] ChatComponents 已完整复制（thread, thread-list, attachment, markdown-text 等）

#### 前端 - 文件处理
- [x] 前端 UI（非 LangGraph Studio）可以处理文件上传
- [x] 文件内容在前端预先处理，避免发送 LangGraph file block
- [x] FullEditorV2 能够将文件作为 text content 传递给后端

---

## ❌ 问题和风险点

### 1. 环境变量配置
**现状**: `langserveChat.ts` 期望以下环境变量：
```typescript
process.env["NEXT_PUBLIC_LANGGRAPH_API_URL"]  // 默认: /api
process.env["NEXT_PUBLIC_LANGGRAPH_ASSISTANT_ID"]  // 未设置，使用 "default"
```

**问题**: 
- `NEXT_PUBLIC_LANGGRAPH_API_URL` 默认值是 `/api`，这可能不正确
- 需要指向实际的 LangGraph Server 地址（如 `http://localhost:2024`）

**必须设置**:
```bash
NEXT_PUBLIC_LANGGRAPH_API_URL=http://localhost:2024  # LangGraph Server Lite 地址
NEXT_PUBLIC_LANGGRAPH_ASSISTANT_ID=orchestrator       # 后端 langgraph.json 中的图名
```

### 2. 图 ID 和助手 ID 对应
**现状**:
- `langgraph.json` 中定义的图：`orchestrator`
- 前端 `langserveChat.ts` 中的助手 ID：`process.env["NEXT_PUBLIC_LANGGRAPH_ASSISTANT_ID"] || "default"`

**问题**: 如果不设置环境变量，助手 ID 会是 `"default"`，但实际图是 `orchestrator`

**解决**: 必须在前端 `.env.local` 中设置：
```
NEXT_PUBLIC_LANGGRAPH_ASSISTANT_ID=orchestrator
```

---

## 🚀 对接流程

### 后端启动
```bash
cd /Users/workspace/DevelopProjects/ccb-v0.378
source .venv/bin/activate
langgraph dev
```
输出应该显示:
```
✅ Listening on http://127.0.0.1:2024
```

### 前端启动
```bash
cd /Users/workspace/DevelopProjects/ccb-v0.378/frontend/desktop
npm run dev
```

### 前端 API 调用流程
```
1. 用户在聊天区域输入消息并发送
   ↓
2. MyRuntimeProvider 中的 stream() 调用 langserveChat.sendMessage()
   ↓
3. langserveChat.ts 创建 Client，连接到后端 API URL
   ↓
4. 调用 client.runs.stream(threadId, assistantId, input)
   ↓
5. LangGraph Server 处理请求，调用后端 agent.stream()
   ↓
6. 消息通过 SSE 流式返回到前端
   ↓
7. assistant-ui 的 Thread 组件展示消息
```

---

## 🔍 验证步骤

### 1. 检查环境变量
```bash
# 前端 .env.local
grep "NEXT_PUBLIC_LANGGRAPH" /Users/workspace/DevelopProjects/ccb-v0.378/frontend/desktop/.env.local
```

**预期输出**:
```
NEXT_PUBLIC_LANGGRAPH_API_URL=http://localhost:2024
NEXT_PUBLIC_LANGGRAPH_ASSISTANT_ID=orchestrator
```

### 2. 检查后端启动日志
查看终端输出是否有：
```
✅ Listening on http://127.0.0.1:2024
✅ Orchestrator Agent created successfully
```

### 3. 检查浏览器控制台
访问前端，打开开发者工具（F12），检查控制台：
```javascript
// 应该看到：
[langserveChat] Creating client with apiUrl: http://localhost:2024
[langserveChat] Creating thread...
[langserveChat] Thread created: {thread_id: "...", ...}
[langserveChat] Sending message to thread: ...
```

### 4. 测试消息流
- 在前端聊天区域输入 "你好"
- 观察浏览器网络选项卡（Network tab）
- 应该看到 HTTP 请求到 `/threads/{thread_id}/runs/{assistant_id}/stream`
- 响应应该是流式的 SSE 数据

---

## 📌 待做项

### 高优先级 - 阻塞对接
- [ ] **确认环境变量设置正确**
  - [ ] `.env.local` 中设置 `NEXT_PUBLIC_LANGGRAPH_API_URL=http://localhost:2024`
  - [ ] `.env.local` 中设置 `NEXT_PUBLIC_LANGGRAPH_ASSISTANT_ID=orchestrator`
  - [ ] 验证 LM Studio 仍在运行 (`http://localhost:1234`)

- [ ] **启动后端并验证**
  - [ ] 运行 `langgraph dev` 
  - [ ] 检查输出中是否有 "Listening on http://127.0.0.1:2024"
  - [ ] 查看是否有错误日志

- [ ] **启动前端并测试**
  - [ ] 运行 `npm run dev`
  - [ ] 打开浏览器开发者工具
  - [ ] 在聊天区域发送一条消息
  - [ ] 检查浏览器控制台的日志和网络请求

### 中优先级 - 文件上传
- [ ] 实现前端文件上传处理
  - [ ] 拦截用户选择的文件
  - [ ] 在前端转换为 base64 或文本内容
  - [ ] 作为 text content block 发送（不是 file content block）

### 低优先级 - 优化
- [ ] 处理 LM Studio file block 问题（通过 middleware）
- [ ] 添加错误处理和重试机制
- [ ] 优化流式显示的用户体验

---

## 🐛 已知问题

### 1. LM Studio 不支持 file content blocks
**原因**: LM Studio 的 OpenAI 兼容 API 只支持 `text` 和 `image_url`，不支持 `file` 类型

**当前处理**: 前端 UI 在发送文件前预先处理（不发送 LangGraph Studio 的 file block）

**备选方案**: 如果需要 LangGraph Studio 上传文件，需要在后端添加 middleware 转换

### 2. NEXT_PUBLIC_LANGGRAPH_API_URL 默认值不正确
**原因**: `langserveChat.ts` 中的默认值是 `/api`，但应该是完整的 LangGraph Server URL

**解决**: 必须在 `.env.local` 中显式设置

---

## 📞 快速参考

### 前端关键文件
- `frontend/desktop/src/lib/api/langserveChat.ts` - LangGraph SDK 客户端
- `frontend/desktop/src/components/ChatComponents/MyRuntimeProvider.tsx` - 运行时配置
- `frontend/desktop/src/components/FullEditorV2.tsx` - 主编辑页面集成

### 后端关键文件
- `backend/engine/core/main_agent.py` - Agent 定义和导出
- `langgraph.json` - LangGraph Server 配置

### 后端启动命令
```bash
cd /Users/workspace/DevelopProjects/ccb-v0.378 && source .venv/bin/activate && langgraph dev
```

### 前端启动命令
```bash
cd /Users/workspace/DevelopProjects/ccb-v0.378/frontend/desktop && npm run dev
```

