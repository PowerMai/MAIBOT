# ✅ LangGraph SDK 迁移检查清单

**开始时间**：2025-12-25  
**目标**：从旧 REST API 模式完全迁移到 LangGraph SDK 模式

---

## 📋 第一阶段：环境配置（必须）

- [ ] **创建/编辑前端环境文件**
  - [ ] 位置：`frontend/desktop/.env.local`
  - [ ] 添加：`NEXT_PUBLIC_LANGGRAPH_API_URL=http://localhost:2024`
  - [ ] 添加：`NEXT_PUBLIC_LANGGRAPH_ASSISTANT_ID=orchestrator`
  - [ ] 验证：没有 `VITE_API_BASE_URL=http://localhost:8000`

---

## 📋 第二阶段：后端配置（必须）

- [ ] **确认后端配置文件**
  - [ ] 文件：`langgraph.json` 存在
  - [ ] 内容：包含 `"orchestrator": { "path": "backend.engine.core.main_agent:agent" }`
  - [ ] 验证：没有错误的路径

- [ ] **确认后端代码**
  - [ ] 文件：`backend/engine/core/main_agent.py` 存在
  - [ ] 导出：末尾有 `__all__ = ["agent", "create_orchestrator_agent"]`
  - [ ] Agent 创建：使用 `create_deep_agent()` 创建
  - [ ] LLM：使用 `ChatOpenAI` 连接到 LM Studio

---

## 📋 第三阶段：前端代码集成（必须）

- [ ] **检查 SDK 客户端**
  - [ ] 文件：`frontend/desktop/src/lib/api/langserveChat.ts` 存在
  - [ ] 内容：使用 `@langchain/langgraph-sdk` 的 `Client`
  - [ ] 函数：有 `createThread()`, `sendMessage()`, `getThreadState()`

- [ ] **检查运行时配置**
  - [ ] 文件：`frontend/desktop/src/components/ChatComponents/MyRuntimeProvider.tsx` 存在
  - [ ] 内容：使用 `useLangGraphRuntime()` 钩子
  - [ ] 流程：正确实现 `stream()`, `create()`, `load()` 回调

- [ ] **检查 UI 组件**
  - [ ] 文件：`frontend/desktop/src/components/ChatComponents/Thread.tsx` 存在
  - [ ] 文件：`frontend/desktop/src/components/ChatComponents/attachment.tsx` 存在
  - [ ] 文件：`frontend/desktop/src/components/ChatComponents/markdown-text.tsx` 存在
  - [ ] 其他：其他 ChatComponents 文件都已复制

- [ ] **检查主编辑页面**
  - [ ] 文件：`frontend/desktop/src/components/FullEditorV2.tsx`
  - [ ] 行号 2629-2631：包含 `<MyRuntimeProvider><Thread /></MyRuntimeProvider>`
  - [ ] 导入：第 34 行有 `import { MyRuntimeProvider, Thread } from "./ChatComponents";`

---

## 📋 第四阶段：启动验证（必须）

### 后端启动

- [ ] **启动后端**
  ```bash
  cd /Users/workspace/DevelopProjects/ccb-v0.378
  source .venv/bin/activate
  langgraph dev
  ```

- [ ] **验证后端输出**
  - [ ] 显示 "✅ Listening on http://127.0.0.1:2024"
  - [ ] 显示 "✅ Orchestrator Agent created successfully"
  - [ ] 没有错误日志

- [ ] **健康检查**
  ```bash
  curl http://localhost:2024/ok
  # 应该返回 {"status":"ok"}
  ```

### 前端启动

- [ ] **清除缓存**
  ```bash
  cd /Users/workspace/DevelopProjects/ccb-v0.378/frontend/desktop
  rm -rf .next .dist dist
  ```

- [ ] **启动前端**
  ```bash
  npm run dev
  ```

- [ ] **验证前端输出**
  - [ ] 显示 "VITE v6.3.5 ready in XXX ms"
  - [ ] 显示 "Local: http://localhost:3000"
  - [ ] 没有构建错误

- [ ] **访问前端**
  - [ ] 打开 `http://localhost:3000` 成功
  - [ ] 页面加载无 404 或网络错误
  - [ ] 看到聊天界面

---

## 📋 第五阶段：功能测试（必须）

### 浏览器开发者工具测试

- [ ] **打开开发者工具**
  - [ ] 按 `F12` 或 `Cmd+Option+J` (Mac)
  - [ ] 切换到 `Console` 标签
  - [ ] 切换到 `Network` 标签（新标签页）

### 消息测试

- [ ] **发送测试消息**
  - [ ] 在聊天框输入：`你好`
  - [ ] 点击发送

- [ ] **检查控制台日志**
  - [ ] 看到 `[langserveChat] Creating client with apiUrl: http://localhost:2024`
  - [ ] 看到 `[langserveChat] Creating thread...`
  - [ ] 看到 `[langserveChat] Thread created: {thread_id: "...", ...}`
  - [ ] 看到 `[langserveChat] Sending message to thread: ...`
  - [ ] 没有错误日志（Error 或 Exception）

- [ ] **检查网络请求**（Network 标签）
  - [ ] 看到 `POST /threads` - 状态 201 或 200
  - [ ] 看到 `POST /threads/.../runs/.../stream` - 状态 200
  - [ ] 响应类型是 `json` 或 `text/event-stream`
  - [ ] 没有 404 或 5xx 错误

### 消息显示测试

- [ ] **验证响应显示**
  - [ ] AI 的回复出现在聊天区域
  - [ ] 消息格式正确（不是乱码或错误）
  - [ ] 消息可能逐字流式显示

- [ ] **验证无错误**
  - [ ] 控制台没有 JavaScript 错误
  - [ ] 没有 "Cannot read property" 错误
  - [ ] 没有 CORS 错误

---

## 📋 第六阶段：清理旧代码（可选）

- [ ] **禁用旧 API 代码**（或删除）
  - [ ] 检查 `frontend/desktop/src/lib/api/` 目录
  - [ ] 列出旧 API 文件：`client.ts`, `chat.ts`, `search.ts` 等
  - [ ] 确认没有代码引用这些文件

- [ ] **搜索旧 API 调用**
  ```
  搜索关键词：
  - api.chat.chat()
  - api.search.search()
  - apiClient.
  - VITE_API_BASE_URL
  - http://localhost:8000
  ```
  - [ ] 搜索结果为空或都在旧文件中

---

## 📋 第七阶段：文档更新（建议）

- [ ] **创建迁移记录**
  - [ ] 文件：`MIGRATION_TO_LANGGRAPH_SDK.md` ✅
  - [ ] 内容：记录迁移日期和步骤

- [ ] **更新项目 README**
  - [ ] 说明：现在使用 LangGraph SDK
  - [ ] 说明：后端地址是 `http://localhost:2024`

---

## 🎯 完成标准

✅ 当满足以下所有条件时，迁移完成：

1. ✅ 环境变量已正确设置
2. ✅ 后端 `langgraph dev` 启动成功
3. ✅ 前端 `npm run dev` 启动成功
4. ✅ 前端可以访问无错误
5. ✅ 浏览器控制台看到成功的 SDK 日志
6. ✅ 网络标签看到正确的 API 请求和响应
7. ✅ 可以发送消息并收到回复
8. ✅ 聊天消息正确显示在 UI 中
9. ✅ 没有 JavaScript 错误
10. ✅ 没有使用旧 REST API 代码

---

## ⏱️ 预计时间

- 第一阶段（环境配置）：5 分钟
- 第二阶段（后端配置）：5 分钟（验证）
- 第三阶段（前端集成）：10 分钟（检查）
- 第四阶段（启动验证）：10 分钟
- 第五阶段（功能测试）：15 分钟
- 第六阶段（代码清理）：10 分钟（可选）
- 第七阶段（文档）：5 分钟

**总计**：约 1 小时

---

## 🚀 立即开始

1. 更新环境变量
2. 清除前端缓存：`rm -rf .next .dist dist`
3. 启动后端：`langgraph dev`
4. 启动前端：`npm run dev`
5. 测试：打开 `http://localhost:3000` 并发送消息

**准备好了吗？** ✨

