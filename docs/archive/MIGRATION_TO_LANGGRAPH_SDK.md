# 🚀 迁移到 LangGraph SDK 模式 - 行动计划

**目标**: 完全迁移到 LangGraph SDK 架构，移除旧的 REST API 代码

**时间线**: 立即执行

---

## 第一阶段：更新前端环境变量

### 1.1 更新 `.env` 或 `.env.local`

**原来的配置**：
```bash
VITE_API_BASE_URL=http://localhost:8000
VITE_WORKSPACE=/Users/workspace/DevelopProjects/ccb-v0.378/workspace
VITE_TOOL_SCOPE=local
```

**新配置**：
```bash
# LangGraph SDK 配置（覆盖旧配置）
NEXT_PUBLIC_LANGGRAPH_API_URL=http://localhost:2024
NEXT_PUBLIC_LANGGRAPH_ASSISTANT_ID=orchestrator

# 工作区（可选，保留用于本地文件管理）
VITE_WORKSPACE=/Users/workspace/DevelopProjects/ccb-v0.378/workspace
```

**说明**：
- 移除 `VITE_API_BASE_URL=http://localhost:8000`（不再需要旧 REST API）
- 添加 LangGraph SDK 的两个关键变量
- 这些使用 `NEXT_PUBLIC_` 前缀因为前端需要直接访问

---

## 第二阶段：验证前端代码集成

### 2.1 检查 FullEditorV2.tsx 集成

已完成 ✅（第 2629-2631 行）：
```typescript
<MyRuntimeProvider>
  <Thread />
</MyRuntimeProvider>
```

### 2.2 检查 MyRuntimeProvider 配置

已完成 ✅（`src/components/ChatComponents/MyRuntimeProvider.tsx`）：
- 使用 `useLangGraphRuntime` 官方钩子
- 调用 `langserveChat.ts` 中的 SDK 函数

### 2.3 检查 langserveChat.ts 配置

已完成 ✅（`src/lib/api/langserveChat.ts`）：
- 使用官方 LangGraph SDK Client
- 环境变量读取正确

---

## 第三阶段：清理旧代码（可选但推荐）

### 3.1 旧 API 文件列表（可删除或禁用）

以下文件是旧 REST API 的实现，在 SDK 模式下不再需要：

```
❌ frontend/desktop/src/lib/api/client.ts - 旧 API 客户端
❌ frontend/desktop/src/lib/api/chat.ts - 旧聊天 API
❌ frontend/desktop/src/lib/api/search.ts - 旧搜索 API
❌ frontend/desktop/src/lib/api/docmap.ts - 旧文档图谱 API
❌ frontend/desktop/src/lib/api/jobs.ts - 旧作业 API
... 其他旧 API 文件

✅ 保留必要的：
  - frontend/desktop/src/lib/api/langserveChat.ts - LangGraph SDK
  - frontend/desktop/src/components/ChatComponents/* - UI 组件
```

### 3.2 检查代码中是否还在使用旧 API

搜索以下关键词，看是否还有旧 API 调用：
```
api.chat.chat()
api.search.search()
api.docmap.*
apiClient.post()
VITE_API_BASE_URL
```

如果没有找到，表示已经完全迁移。

---

## 第四阶段：启动和测试

### 4.1 启动后端

```bash
cd /Users/workspace/DevelopProjects/ccb-v0.378
source .venv/bin/activate
langgraph dev

# 期望输出：
# ✅ Listening on http://127.0.0.1:2024
# ✅ Orchestrator Agent created successfully
```

### 4.2 启动前端

```bash
cd /Users/workspace/DevelopProjects/ccb-v0.378/frontend/desktop

# 清除缓存（重要！）
rm -rf .next .dist dist node_modules/.vite

# 重新启动
npm run dev

# 期望输出：
# VITE v6.3.5 ready in XXX ms
# ➜  Local: http://localhost:3000
```

### 4.3 测试流程

1. **打开浏览器**：访问 `http://localhost:3000`

2. **打开开发者工具**：按 `F12` → `Console` 标签

3. **发送消息**：在聊天区域输入 `你好` 并发送

4. **观察日志**：
   ```
   [langserveChat] Creating client with apiUrl: http://localhost:2024
   [langserveChat] Creating thread...
   [langserveChat] Thread created: {thread_id: "...", ...}
   [langserveChat] Sending message to thread: ...
   ```

5. **检查网络请求**：
   - 打开 `Network` 标签
   - 应该看到 `POST /threads` → 201
   - 应该看到 `POST /threads/.../runs/.../stream` → 200
   - 响应应该是 SSE 流式数据

6. **验证响应显示**：
   - AI 的回复应该在聊天区域显示
   - 消息应该流式显示（逐字出现）

---

## ✅ 迁移完成标准

迁移可视为完成，需要满足以下条件：

- [ ] 前端环境变量已更新为 LangGraph SDK 配置
- [ ] 后端 `langgraph dev` 可成功启动
- [ ] 前端 `npm run dev` 可成功启动
- [ ] 前端浏览器无 API 错误
- [ ] 可成功创建线程
- [ ] 可成功发送消息并收到回复
- [ ] 聊天消息在 UI 中正确显示
- [ ] 没有使用旧的 REST API 代码

---

## 🎯 后续步骤

### 立即（今天）
1. ✅ 更新环境变量
2. ✅ 重启前端（清除缓存）
3. ✅ 启动后端
4. ✅ 进行基本测试

### 短期（本周）
1. ⏳ 完整的文件上传功能（前端处理）
2. ⏳ 聊天历史持久化
3. ⏳ 错误处理和重试

### 中期（下周）
1. ⏳ 流式显示优化
2. ⏳ 性能优化
3. ⏳ 深度集成（工具调用、文件操作等）

### 长期
1. ⏳ LM Studio file block 适配（如需要）
2. ⏳ 多线程会话管理
3. ⏳ 生产环保部署

---

## 🔄 快速参考

### 环境变量（Vite + Electron）

**前端 `.env` 或 `.env.local`**：
```bash
# ✅ LangGraph SDK（新）
NEXT_PUBLIC_LANGGRAPH_API_URL=http://localhost:2024
NEXT_PUBLIC_LANGGRAPH_ASSISTANT_ID=orchestrator

# 可选
VITE_WORKSPACE=/Users/workspace/DevelopProjects/ccb-v0.378/workspace
```

### 启动命令

**后端**（Terminal 1）：
```bash
cd /Users/workspace/DevelopProjects/ccb-v0.378 && \
source .venv/bin/activate && \
langgraph dev
```

**前端**（Terminal 2）：
```bash
cd /Users/workspace/DevelopProjects/ccb-v0.378/frontend/desktop && \
npm run dev
```

### 核心文件

| 文件 | 用途 |
|------|------|
| `langgraph.json` | LangGraph Server 配置 ✅ |
| `backend/engine/core/main_agent.py` | 后端 Agent ✅ |
| `frontend/desktop/src/lib/api/langserveChat.ts` | LangGraph SDK 客户端 ✅ |
| `frontend/desktop/src/components/ChatComponents/MyRuntimeProvider.tsx` | 运行时配置 ✅ |
| `frontend/desktop/src/components/FullEditorV2.tsx` | 主编辑页面集成 ✅ |

### API 端点（后端）

| 端点 | 用途 |
|------|------|
| `GET /ok` | 健康检查 |
| `POST /threads` | 创建线程 |
| `GET /threads/{id}/state` | 获取状态 |
| `POST /threads/{id}/runs/{aid}/stream` | 流式执行 |

---

## 🚨 常见问题

**Q: 前端仍然报错 "Cannot connect to API"**  
A: 检查环境变量是否正确设置，是否清除了缓存，后端是否真的在 `2024` 运行。

**Q: 后端报 "Blocking call to os.getcwd"**  
A: 已修复在代码中，确保 `main_agent.py` 中有 `workspace_root = str(Path(...).parent...)`

**Q: 为什么聊天不显示消息？**  
A: 检查浏览器开发者工具中是否有 JavaScript 错误，网络标签中是否有 API 错误。

---

## 📝 下一个文档

完成以上步骤后，参考：
- `QUICK_START_GUIDE.md` - 快速启动指南
- `FRONTEND_BACKEND_LANGGRAPH_CHECKLIST.md` - 完整检查清单
- `FRONTEND_BACKEND_INTEGRATION_STATUS.md` - 详细状态报告

---

**准备好了吗？让我们开始！** 🚀

