# 🔧 前端消息未到达后端 - 问题诊断和解决方案

## 🔍 根本问题

前端有**两套不同的对接方式**在混用：

| 组件 | 对接方式 | 后端地址 | 状态 |
|------|--------|--------|------|
| **FullEditorV2** | LangGraph SDK + MyRuntimeProvider | `http://localhost:2024` | ✅ 正确 |
| **SidebarChatV2** | 旧 LangServe HTTP | `http://localhost:8000` | ❌ 错误 |
| **其他组件** | 混合模式 | 不确定 | ❌ 混乱 |

**问题**：
- `SidebarChatV2` 在调用 `streamChat()`，但这个函数指向 `http://localhost:8000`
- 后端现在运行在 `http://localhost:2024` (LangGraph Server)
- 所以消息无法到达

---

## 📊 前端架构现状

### 架构混乱
```
前端
├── FullEditorV2 (主编辑页面)
│   ├── MyRuntimeProvider ← 使用 LangGraph SDK ✅
│   └── Thread ← 官方组件 ✅
│
└── SidebarChatV2 (侧边栏)
    ├── streamChat() ← 指向 http://localhost:8000 ❌
    ├── invokeChat() ← 指向 http://localhost:8000 ❌
    └── controlAPI ← 旧 REST API ❌
```

### 问题根源
1. `chat.ts` 中的 `streamChat` 硬编码了 `http://localhost:8000`
2. `SidebarChatV2` 使用了 `streamChat`
3. 但后端现在运行在 `http://localhost:2024`

---

## ✅ 解决方案

### 方案 A：统一使用 LangGraph SDK（推荐）

**步骤 1**：更新 `frontend/desktop/src/lib/api/chat.ts`

修改硬编码的 URL：
```typescript
// 旧代码
const response = await fetch('http://localhost:8000/agent/stream', {

// 新代码
const apiUrl = (typeof window !== 'undefined' && (import.meta as any).env?.NEXT_PUBLIC_LANGGRAPH_API_URL) 
  || 'http://localhost:2024';
const response = await fetch(`${apiUrl}/threads/{threadId}/runs/{assistantId}/stream`, {
```

但更好的方法是**完全使用 LangGraph SDK**：

### 方案 B：删除 `chat.ts` 中的旧代码，使用 `langserveChat.ts`

**问题**：`chat.ts` 中的 `streamChat` 和 `invokeChat` 是针对旧 LangServe API 的

**解决**：
1. 删除 `frontend/desktop/src/lib/api/chat.ts` 中指向 8000 的代码
2. 所有组件都使用 `langserveChat.ts` (LangGraph SDK 方式)
3. 或者在 `chat.ts` 中导入 LangGraph SDK 的版本

---

##立即修复步骤

### 步骤 1：修复 `chat.ts` 的 URL

编辑 `frontend/desktop/src/lib/api/chat.ts`，第 71 和 218 行：

```diff
// 改之前
- const response = await fetch('http://localhost:8000/agent/stream', {

// 改之后
+ const apiUrl = (typeof window !== 'undefined' && (import.meta as any).env?.NEXT_PUBLIC_LANGGRAPH_API_URL) 
+   || 'http://localhost:2024';
+ const response = await fetch(`${apiUrl}/threads/${threadId}/runs/orchestrator/stream`, {
```

### 步骤 2：验证环境变量

确保前端有设置：
```bash
# frontend/desktop/.env.local
NEXT_PUBLIC_LANGGRAPH_API_URL=http://localhost:2024
NEXT_PUBLIC_LANGGRAPH_ASSISTANT_ID=orchestrator
```

### 步骤 3：清除缓存并重启

```bash
cd /Users/workspace/DevelopProjects/ccb-v0.378/frontend/desktop
rm -rf .next .dist dist node_modules/.vite
npm run dev
```

---

## 🎯 关于你的其他问题

### 1. **LLM 窗口大小 (Context Window)**

**问题**：32k 窗口配置应该在哪里生效？

**答案**：
```python
# 后端 (main_agent.py) 配置优先级：
1. ChatOpenAI 的 max_tokens 参数 ← 我们配置的
2. LM Studio 的模型设置
3. 模型本身的限制

# 当前配置
max_tokens=4096  # 这个是输出限制，不是输入窗口

# 正确做法
MAX_TOKENS = 32768  # 修改这个值（如果模型支持）
```

**修复**：在 `OrchestratorConfig` 中：
```python
class OrchestratorConfig:
    MAX_TOKENS = int(os.getenv("LM_STUDIO_MAX_TOKENS", "32768"))
    # 或直接设置
    MAX_TOKENS = 32768
```

然后启动：
```bash
LM_STUDIO_MAX_TOKENS=32768 langgraph dev
```

**优先级**：后端配置 > LM Studio UI 配置（后端覆盖）

### 2. **LangChain 基础工具**

Yes，LangChain 有很多官方工具：

```python
# 网络搜索
from langchain_community.tools import DuckDuckGoSearchRun, TavilySearchResults

# 文件操作
from langchain_community.tools import ReadFileToolLM, WriteFileTool

# 代码执行
from langchain.tools import PythonREPLTool

# Web 抓取
from langchain_community.tools import BrowserTool

# 数据库
from langchain_community.tools import SQLDatabaseTool
```

要启用，你需要在 `tools/__init__.py` 中添加。

### 3. **网络工具 API Key**

我可以帮你配置 Tavily API，但：
- 需要在 LangChain 中注册
- 添加到环境变量：`TAVILY_API_KEY`
- 在工具列表中启用

---

## 🚨 立即需要做的

### 优先级 1（阻塞）：修复前端消息未到达
1. 修改 `chat.ts` 的 URL
2. 重启前端
3. 测试消息是否到达

### 优先级 2（重要）：统一前端对接方式
1. 将 `SidebarChatV2` 也改为使用 LangGraph SDK
2. 删除旧的 `streamChat`/`invokeChat`
3. 统一用 `langserveChat.ts`

### 优先级 3（优化）：扩展工具库
1. 添加网络搜索工具
2. 添加更多基础工具
3. 配置 API Key

---

## 📝 快速修复清单

- [ ] 修改 `chat.ts` 第 71 行：改为 `http://localhost:2024`
- [ ] 修改 `chat.ts` 第 218 行：改为 `http://localhost:2024`
- [ ] 确保环境变量 `NEXT_PUBLIC_LANGGRAPH_API_URL=http://localhost:2024`
- [ ] 清除前端缓存：`rm -rf .next .dist dist`
- [ ] 重启前端：`npm run dev`
- [ ] 测试：发送消息看是否到达后端
- [ ] 修改 `MAX_TOKENS` 为 32768（如果需要）
- [ ] 重启后端：`langgraph dev`

---

## 验证方法

```bash
# 1. 检查后端是否运行在 2024
curl http://localhost:2024/ok

# 2. 检查前端环境变量
grep NEXT_PUBLIC_LANGGRAPH frontend/desktop/.env.local

# 3. 查看浏览器控制台
# 应该看到类似：
# [langserveChat] Sending message to thread: ...
```

完成上述修复后，消息应该能够正常到达后端！

