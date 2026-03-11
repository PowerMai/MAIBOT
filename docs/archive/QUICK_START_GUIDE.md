# 🔧 前端-后端对接快速启动指南（基于 LangGraph SDK Lite）

## 第一步：配置前端环境变量

**文件位置**：`frontend/desktop/.env.local`

**必须添加以下内容**：

```bash
# LangGraph Server Lite API 配置
NEXT_PUBLIC_LANGGRAPH_API_URL=http://localhost:2024
NEXT_PUBLIC_LANGGRAPH_ASSISTANT_ID=orchestrator

# （可选）LM Studio 配置参考
# 后端连接的 LM Studio 地址
NEXT_PUBLIC_LM_STUDIO_URL=http://localhost:1234
```

**说明**：
- `NEXT_PUBLIC_LANGGRAPH_API_URL`: LangGraph Server Lite 的 API 地址（本地开发环境）
- `NEXT_PUBLIC_LANGGRAPH_ASSISTANT_ID`: 后端 `langgraph.json` 中定义的图 ID（必须是 `orchestrator`）
- 这两个环境变量都以 `NEXT_PUBLIC_` 开头，因此会被嵌入到前端 JavaScript 代码中

---

## 第二步：启动后端服务

### 2.1 启动 LM Studio（如果未运行）

```bash
# 在 LM Studio 桌面应用中启动模型
# 确保运行在 http://localhost:1234
# 检查 Server 标签页，应该显示 "Running on http://0.0.0.0:1234"
```

### 2.2 启动 LangGraph Server Lite

```bash
cd /Users/workspace/DevelopProjects/ccb-v0.378

# 激活虚拟环境
source .venv/bin/activate

# 启动 LangGraph Server
langgraph dev

# 期望输出：
# ✅ Listening on http://127.0.0.1:2024
# ✅ Orchestrator Agent created successfully
```

**检查项**：
- [ ] 终端显示 "Listening on http://127.0.0.1:2024"
- [ ] 没有错误日志
- [ ] 显示 "✅ Orchestrator Agent created successfully"

---

## 第三步：启动前端开发服务器

```bash
cd /Users/workspace/DevelopProjects/ccb-v0.378/frontend/desktop

# 安装依赖（如果尚未安装）
npm install

# 启动开发服务器
npm run dev

# 期望输出：
# ✓ built in 2.34s
# ➜  Local:   http://localhost:3000
```

**检查项**：
- [ ] 编译成功，无错误
- [ ] 显示 "Local: http://localhost:3000"
- [ ] 前端应用可访问

---

## 第四步：测试前后端对接

### 4.1 打开前端应用

访问 `http://localhost:3000`

### 4.2 打开浏览器开发者工具

按 `F12` 打开开发者工具，选择 `Console` 标签

### 4.3 在聊天区域输入消息

输入一条简单的问候，例如：`你好`

### 4.4 观察控制台日志

应该看到以下日志序列：

```javascript
// 1. 客户端创建
[langserveChat] Creating client with apiUrl: http://localhost:2024

// 2. 创建线程
[langserveChat] Creating thread...
[langserveChat] Thread created: {thread_id: "...", created_at: "...", ...}

// 3. 发送消息
[langserveChat] Sending message to thread: abc123...
[langserveChat] Messages: [{role: "user", content: "你好"}]

// 4. 流式接收响应
// （可能看到多个流式事件）
```

### 4.5 检查网络请求

在开发者工具的 `Network` 标签中：

1. 应该看到请求到以下端点：
   - `POST /threads` - 创建线程
   - `POST /threads/{thread_id}/runs/{assistant_id}/stream` - 流式执行

2. 响应状态应该是 `200` 或 `201`

3. 响应体应该包含流式的 SSE 数据

---

## ✅ 验证清单

### 后端验证

运行以下命令验证后端是否正常：

```bash
# 检查后端日志中是否有错误
# 在启动后端的终端中查看输出

# 期望看到：
✅ Orchestrator Agent created successfully
   LLM: transformers@4bit
   Sub-agents: document-agent
```

### 前端验证

```bash
# 1. 检查环境变量是否正确加载
# 在浏览器控制台输入：
const apiUrl = new URL("/api", window.location.href).href
console.log("API URL:", apiUrl) // 应该输出后端 URL

# 2. 尝试创建线程（在浏览器控制台）
fetch('http://localhost:2024/threads', { method: 'POST' })
  .then(r => r.json())
  .then(d => console.log('Thread created:', d))

# 期望输出：
# Thread created: {thread_id: "...", created_at: "...", ...}
```

---

## 🐛 常见问题排查

### 问题 1: 前端显示 "Cannot connect to API"

**原因**：LangGraph Server 未运行或 API URL 错误

**解决**：
```bash
# 检查后端是否运行
curl http://localhost:2024/ok

# 期望输出：
# {"status":"ok"}

# 如果失败，检查：
# 1. 是否运行了 `langgraph dev`
# 2. API URL 是否正确设置在 .env.local
```

### 问题 2: 浏览器控制台显示 "NEXT_PUBLIC_LANGGRAPH_ASSISTANT_ID not set"

**原因**：环境变量未设置

**解决**：
```bash
# 1. 确认 .env.local 中有：
NEXT_PUBLIC_LANGGRAPH_ASSISTANT_ID=orchestrator

# 2. 清空前端缓存并重新启动
cd frontend/desktop
rm -rf .next node_modules/.cache
npm run dev
```

### 问题 3: 网络请求返回 404

**原因**：后端图 ID 与前端设置不匹配

**解决**：
```bash
# 1. 检查 langgraph.json 中的图 ID
cat langgraph.json
# 应该看到：
# "graphs": {
#   "orchestrator": { ... }
# }

# 2. 确认前端 .env.local 中的 ASSISTANT_ID 匹配
NEXT_PUBLIC_LANGGRAPH_ASSISTANT_ID=orchestrator
```

### 问题 4: 后端启动失败，显示 "Blocking call to os.getcwd"

**原因**：`FilesystemBackend` 配置不正确

**解决**：已在代码中修复，确保 `main_agent.py` 中有：
```python
workspace_root = str(Path(__file__).parent.parent.parent.parent)
def backend_factory(runtime):
    return FilesystemBackend(root_dir=workspace_root)
```

### 问题 5: LM Studio 返回 400 错误，提示 "Invalid 'content'"

**原因**：发送了 LangGraph Studio 的 file block，LM Studio 不支持

**解决**：使用前端 UI 而不是 LangGraph Studio 上传文件
- 前端 UI 会在发送前预先处理文件
- 避免发送 LangGraph 的 file content block

---

## 📊 系统架构验证

```
┌─────────────────────────────────────────────────────────────┐
│                        前端（Next.js）                       │
│  http://localhost:3000                                      │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ MyRuntimeProvider + Thread + ChatComponents         │   │
│  │ - 使用 @langchain/langgraph-sdk Client             │   │
│  │ - 连接到后端 API: http://localhost:2024            │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                            ↓ HTTP/SSE
┌─────────────────────────────────────────────────────────────┐
│                  LangGraph Server Lite                       │
│  http://localhost:2024                                      │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ /threads, /runs, /state 等 API 端点                │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                            ↓ 调用
┌─────────────────────────────────────────────────────────────┐
│              后端 DeepAgent 核心                             │
│  backend.engine.core.main_agent:agent                       │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Orchestrator Agent                                  │   │
│  │ - 使用 ChatOpenAI 连接到 LM Studio                 │   │
│  │ - Document Agent (Sub-agent)                       │   │
│  │ - FilesystemBackend 用于文件操作                   │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                            ↓ HTTP
┌─────────────────────────────────────────────────────────────┐
│                  LM Studio（模型推理）                       │
│  http://localhost:1234                                      │
│  - 提供 OpenAI 兼容的聊天完成 API                           │
│  - 支持 text 和 image_url 内容（不支持 file）              │
└─────────────────────────────────────────────────────────────┘
```

---

## 🚀 完整启动脚本

如果要一键启动，可以创建启动脚本：

**启动后端**（`start_backend.sh`）：
```bash
#!/bin/bash
cd /Users/workspace/DevelopProjects/ccb-v0.378
source .venv/bin/activate
langgraph dev
```

**启动前端**（`start_frontend.sh`）：
```bash
#!/bin/bash
cd /Users/workspace/DevelopProjects/ccb-v0.378/frontend/desktop
npm run dev
```

**使用方法**：
```bash
# 终端 1 - 后端
./start_backend.sh

# 终端 2 - 前端
./start_frontend.sh

# 终端 3 - LM Studio（如果在命令行启动）
lm-studio
```

---

## 📝 下一步计划

1. ✅ 验证前后端对接
2. ⏳ 实现文件上传功能（前端处理，避免 file block）
3. ⏳ 测试聊天流式显示
4. ⏳ 优化性能和用户体验
5. ⏳ 处理 LM Studio file block 问题（如需要通过 LangGraph Studio）

