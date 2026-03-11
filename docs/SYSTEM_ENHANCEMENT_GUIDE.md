# 系统增强指南

## 当前已实现的增强功能

### 1. 统一流式输出模块 ✅

所有工具现在使用统一的 `streaming.py` 模块，消除了重复实现：

```python
# backend/tools/base/streaming.py
from .streaming import get_tool_stream_writer, emit_tool_event, ToolStreamContext

# 简单使用
stream_writer = get_tool_stream_writer()
emit_tool_event(stream_writer, "search_start", pattern="test")

# 上下文管理器使用
with ToolStreamContext("read_file") as ctx:
    ctx.emit("start", file_path=path)
    ctx.emit("progress", bytes_read=1000)
    ctx.emit("complete", status="success")
```

### 2. LangGraph 流式模式配置 ✅

```typescript
// frontend/desktop/src/lib/api/langserveChat.ts
// 可配置的流式模式
type StreamMode = "messages" | "custom" | "updates" | "values" | "debug";

// 默认配置
streamMode: ["messages", "custom"],  // 消息流式 + 自定义事件

// 调试模式
streamMode: ["messages", "custom", "updates", "debug"],  // 完整调试信息

streamSubgraphs: true,               // 子图流式输出
```

### 3. 已启用的 LangGraph 原生能力 ✅

| 能力 | 配置 | 说明 |
|------|------|------|
| Store | `InMemoryStore` | 持久化记忆（跨会话） |
| Checkpointer | `MemorySaver` | 会话恢复（断点续传） |
| recursion_limit | 50 | 防止无限循环 |
| configurable | thread_id, model_id | 动态配置 |
| MAX_PARALLEL | 2 | 并行执行（可调整） |
| PERFORMANCE_MODE | BALANCED | 性能模式 |

### 4. 线程生命周期管理 ✅

```typescript
// frontend/desktop/src/lib/api/langserveChat.ts

// 创建线程（自动添加元数据）
const thread = await createThread({ user_id: "xxx" });

// 列出线程
const threads = await listThreads({ limit: 100 });

// 删除线程
await deleteThread(threadId);

// 清理过期线程（TTL 机制）
const deletedCount = await cleanupExpiredThreads(7); // 7天

// 更新活跃时间
await touchThread(threadId);
```

### 5. Human-in-the-Loop 支持 ✅

```typescript
// 检测中断状态
const { interrupted, interruptType, interruptData } = await getInterruptState(threadId);

// 恢复中断（人工确认后）
await resumeInterrupt(threadId, true, "用户已确认");
```

### 6. Store 操作（持久化记忆）✅

```typescript
// 获取用户记忆
const memories = await getUserMemories(userId, 'memories');

// 保存记忆
await saveUserMemory(userId, 'preference', { theme: 'dark' });

// 删除记忆
await deleteUserMemory(userId, 'preference');
```

### 7. 工作区生命周期管理 ✅

```typescript
// frontend/desktop/src/lib/api/workspace.ts

// 最近打开的工作区
const recent = workspaceService.getRecentWorkspaces();

// 工作区设置持久化
workspaceService.saveWorkspaceSettings({ theme: 'dark' });
const settings = workspaceService.getWorkspaceSettings();

// 展开文件夹状态持久化
workspaceService.saveExpandedFolders(['src', 'lib']);
const expanded = workspaceService.getExpandedFolders();

// 清理无效数据
const cleaned = await workspaceService.cleanupInvalidData();

// 关闭工作区
workspaceService.closeWorkspace();
```

---

## 可进一步增强的功能

### 1. 更多流式模式组合

LangGraph 支持 5 种流式模式，可根据需求组合：

| 模式 | 说明 | 适用场景 |
|------|------|----------|
| `messages` | LLM token 级流式 | 实时显示 AI 回复 |
| `custom` | 工具自定义事件 | 工具执行进度 |
| `updates` | 状态更新 | 调试、监控 |
| `values` | 完整状态值 | 状态快照 |
| `debug` | 详细调试信息 | 开发调试 |

**推荐配置**：
```typescript
// 生产环境
streamMode: ["messages", "custom"]

// 开发/调试环境
streamMode: ["messages", "custom", "updates", "debug"]
```

### 2. Human-in-the-Loop (人工确认)

DeepAgent 支持在关键操作前请求人工确认：

```python
# backend/engine/agent/deep_agent.py
interrupt_on = {
    "write_file": True,           # 写文件前确认
    "execute": {                  # 执行命令前确认
        "allowed_decisions": ["approve", "reject"]
    },
    "delete_file": True,          # 删除文件前确认
}

agent = create_deep_agent(
    ...
    interrupt_on=interrupt_on,
)
```

**前端处理**：
```typescript
// 检测中断状态
const state = await getThreadState(threadId);
if (state.tasks?.[0]?.interrupts?.length > 0) {
    // 显示确认对话框
    const userDecision = await showConfirmDialog(state.tasks[0].interrupts);
    // 继续执行
    await updateState(threadId, { decision: userDecision });
}
```

### 3. 持久化存储升级

当前使用内存存储，生产环境建议升级：

```python
# 选项 1: PostgreSQL (推荐)
from langgraph.checkpoint.postgres import PostgresSaver
checkpointer = PostgresSaver(connection_string)

# 选项 2: SQLite (轻量级)
from langgraph.checkpoint.sqlite import SqliteSaver
checkpointer = SqliteSaver("checkpoints.db")

# 选项 3: Redis (高性能)
from langgraph.store.redis import RedisStore
store = RedisStore(redis_url)
```

### 4. 并行执行优化

```python
# backend/engine/agent/deep_agent.py
Config.MAX_PARALLEL = int(os.getenv("MAX_PARALLEL_AGENTS", "2"))

# 在 Orchestrator 提示词中强调并行
"""
ParallelExecution:
- Independent steps → parallel task() calls
- Dependent steps → sequential execution
- Max parallel: {max_parallel}
"""
```

### 5. 上下文窗口优化

```python
# 配置 SummarizationMiddleware
llm.profile = {"max_input_tokens": 65536}  # 触发压缩阈值

# 或手动配置
from deepagents.middleware import SummarizationMiddleware
summarization = SummarizationMiddleware(
    trigger=("fraction", 0.85),  # 85% 时触发压缩
    model=llm,
)
```

### 6. 错误恢复与重试

```python
# 配置重试策略
from langchain_core.runnables import RunnableConfig

config = RunnableConfig(
    max_retries=3,
    retry_delay=1.0,
    retry_on_exception=True,
)

# 在工具中使用
@tool
def my_tool(input: str) -> str:
    try:
        return process(input)
    except TransientError:
        raise  # 会自动重试
    except PermanentError as e:
        return f"Error: {e}"  # 不重试
```

### 7. 可观察性与调试

```python
# 集成 LangSmith
import os
os.environ["LANGCHAIN_TRACING_V2"] = "true"
os.environ["LANGCHAIN_API_KEY"] = "your-key"
os.environ["LANGCHAIN_PROJECT"] = "ccb-agent"

# 或使用本地日志
import logging
logging.getLogger("langgraph").setLevel(logging.DEBUG)
```

---

## 性能优化建议

### 1. KV Cache 优化

```python
# 提示词结构优化（静态内容在前）
PROMPT = """
# 静态规则（会被缓存）
{static_rules}

# 动态内容（每次变化）
{dynamic_context}
"""
```

### 2. 批量工具调用

```python
# 不推荐：多次单独调用
for file in files:
    read_file(file)

# 推荐：使用 python_run 批量处理
python_run("""
files = ['a.txt', 'b.txt', 'c.txt']
results = {}
for f in files:
    results[f] = read_file.invoke({"path": f})
print(json.dumps(results))
""")
```

### 3. 缓存策略

```python
# LLM 缓存（已实现）
_llm_cache: dict[str, any] = {}

# Agent 缓存（已实现）
_agent_cache: dict[str, any] = {}

# 模型列表缓存（已实现）
_MODEL_LIST_CACHE_TTL = 300.0  # 5 分钟
```

---

## 前端增强建议

### 1. 工具进度可视化

```typescript
// 已实现：toolStreamEventBus
toolStreamEventBus.onAll((event) => {
    switch (event.type) {
        case 'python_output':
            // 实时显示输出
            break;
        case 'search_progress':
            // 显示搜索进度条
            break;
    }
});
```

### 2. 取消任务

```typescript
// 已实现：cancelRun
await cancelRun(threadId, runId);
```

### 3. 状态恢复

```typescript
// 从检查点恢复
const state = await getThreadState(threadId);
// 显示历史消息
setMessages(state.values.messages);
```

---

## 总结

| 功能 | 状态 | 说明 |
|------|------|------|
| 统一流式输出 | ✅ 已实现 | 所有工具使用 streaming.py |
| 工具进度显示 | ✅ 已实现 | toolStreamEventBus |
| 消息流式输出 | ✅ 已实现 | streamMode: messages |
| 子图流式输出 | ✅ 已实现 | streamSubgraphs: true |
| Store 持久化 | ✅ 已实现 | InMemoryStore |
| Checkpointer | ✅ 已实现 | MemorySaver |
| 取消任务 | ✅ 已实现 | cancelRun API |
| Human-in-the-Loop | ✅ 已实现 | getInterruptState/resumeInterrupt |
| 线程生命周期 | ✅ 已实现 | TTL 清理、活跃时间更新 |
| 工作区生命周期 | ✅ 已实现 | 最近列表、设置持久化 |
| Store 操作 API | ✅ 已实现 | getUserMemories/saveUserMemory |
| 调试模式 | ✅ 已实现 | streamMode: debug |
| PostgreSQL 持久化 | 🔲 可选 | 生产环境推荐 |
| LangSmith 集成 | 🔲 可选 | 可观察性 |

---

## LangGraph Server 数据管理说明

### 数据存储位置

LangGraph Server 的数据存储在以下位置：

1. **线程数据 (Threads)**：
   - 存储在 Checkpointer 中（当前为 MemorySaver，内存存储）
   - 包含：消息历史、状态快照、检查点

2. **持久化记忆 (Store)**：
   - 存储在 Store 中（当前为 InMemoryStore，内存存储）
   - 包含：用户偏好、学习到的模式、跨会话记忆

3. **文件 (Files)**：
   - 存储在 FilesystemBackend 指定的目录
   - 默认：项目根目录

### 数据生命周期

| 数据类型 | 生命周期 | 清理机制 |
|----------|----------|----------|
| 线程 | 服务重启后丢失（内存） | TTL 清理 API |
| 记忆 | 服务重启后丢失（内存） | 手动删除 API |
| 文件 | 永久（文件系统） | 手动删除 |

### 数据管理 API

```typescript
// 线程管理
await listThreads();                    // 列出所有线程
await deleteThread(threadId);           // 删除线程
await cleanupExpiredThreads(7);         // 清理 7 天前的线程

// 记忆管理
await getUserMemories(userId);          // 获取用户记忆
await saveUserMemory(userId, key, val); // 保存记忆
await deleteUserMemory(userId, key);    // 删除记忆
```

### 生产环境建议

1. **使用持久化存储**：
   ```python
   # PostgreSQL Checkpointer
   from langgraph.checkpoint.postgres import PostgresSaver
   checkpointer = PostgresSaver(connection_string)
   
   # Redis Store
   from langgraph.store.redis import RedisStore
   store = RedisStore(redis_url)
   ```

2. **配置 TTL**：
   ```python
   # 线程 TTL（7 天）
   THREAD_TTL_DAYS = 7
   
   # 记忆 TTL（30 天）
   MEMORY_TTL_DAYS = 30
   ```

3. **定期清理**：
   ```typescript
   // 每天运行一次
   await cleanupExpiredThreads(7);
   ```

---

系统当前已具备完整的流式输出能力和生命周期管理，核心功能已全部实现。上述可选功能可根据实际需求逐步添加。
