# DeepAgent 原生能力完全指南

> **核心原则**：充分利用 DeepAgent 已有能力，不重复开发

本文档详细说明 DeepAgent 的所有原生能力，以及如何正确使用它们构建类似 Cursor/Claude 的优秀 Agent。

## 1. DeepAgent 架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                        DeepAgent                                 │
├─────────────────────────────────────────────────────────────────┤
│  Middleware Stack (自动应用)                                      │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ 1. TodoListMiddleware      → write_todos (任务跟踪)          ││
│  │ 2. FilesystemMiddleware    → ls, read_file, write_file, ... ││
│  │ 3. SubAgentMiddleware      → task (子代理委派)               ││
│  │ 4. SummarizationMiddleware → 自动上下文压缩                  ││
│  │ 5. HumanInTheLoopMiddleware → 人工确认中断                   ││
│  └─────────────────────────────────────────────────────────────┘│
├─────────────────────────────────────────────────────────────────┤
│  State Management                                                │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ state["messages"]  → 对话历史 (自动管理)                     ││
│  │ state["todos"]     → 任务列表 (TodoListMiddleware)           ││
│  │ state["files"]     → 虚拟文件系统 (FilesystemMiddleware)     ││
│  └─────────────────────────────────────────────────────────────┘│
├─────────────────────────────────────────────────────────────────┤
│  Backend Storage                                                 │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ StateBackend      → 临时存储 (会话内)                        ││
│  │ StoreBackend      → 持久存储 (跨会话)                        ││
│  │ FilesystemBackend → 真实文件系统                             ││
│  │ CompositeBackend  → 混合路由                                 ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

## 2. 中间件详解

### 2.1 TodoListMiddleware

**功能**: 任务跟踪和规划

**提供的工具**: `write_todos`

**状态字段**: `state["todos"]`

**使用场景**:
- 复杂多步骤任务 (3+ 步骤)
- 需要跟踪进度的任务
- 用户明确要求创建任务列表

**示例**:
```python
write_todos([
    {"content": "读取招标文件", "status": "in_progress"},
    {"content": "提取关键信息", "status": "pending"},
    {"content": "生成分析报告", "status": "pending"}
])
```

**状态值**:
- `pending`: 待处理
- `in_progress`: 进行中
- `completed`: 已完成

### 2.2 FilesystemMiddleware

**功能**: 文件系统操作

**提供的工具**:
| 工具 | 功能 |
|------|------|
| `ls` | 列出目录内容 |
| `read_file` | 读取文件 (支持 offset, limit) |
| `write_file` | 创建新文件 |
| `edit_file` | 编辑现有文件 |
| `glob` | 按模式查找文件 |
| `grep` | 搜索文件内容 |
| `execute` | 执行 shell 命令 (需要 SandboxBackend) |

**状态字段**: `state["files"]`

**关键参数**:
- `tool_token_limit_before_evict`: 大文件自动保存到文件系统，返回截断消息

**扩展方式**:
```python
from deepagents.backends import FilesystemBackend

class EnhancedFilesystemBackend(FilesystemBackend):
    def read(self, file_path: str, offset: int = 0, limit: int = 500) -> str:
        # 自定义读取逻辑 (如支持 DOCX/PDF)
        ...
```

### 2.3 SubAgentMiddleware

**功能**: 子代理委派

**提供的工具**: `task`

**参数**:
- `description`: 任务描述
- `subagent_type`: 子代理类型

**子代理隔离**:
- 每个子代理有独立的 `messages` 历史
- 共享 `state["files"]` 和其他状态
- 不共享 `state["todos"]`

**示例**:
```python
task(
    description="分析招标文件 /tmp/tender.docx，提取项目名称、预算、截止日期",
    subagent_type="executor-agent"
)
```

### 2.4 SummarizationMiddleware

**功能**: 自动上下文压缩

**触发条件**:
- `trigger=("fraction", 0.85)`: 达到模型最大输入的 85%
- `trigger=("tokens", 170000)`: 达到 170000 tokens
- `trigger=("messages", 100)`: 达到 100 条消息

**保留策略**:
- `keep=("fraction", 0.10)`: 保留 10% 的上下文
- `keep=("messages", 6)`: 保留最近 6 条消息

**工作原理**:
1. 检测到触发条件
2. 调用 LLM 生成摘要
3. 用摘要替换旧消息
4. 保留最近的消息

### 2.5 HumanInTheLoopMiddleware

**功能**: 人工确认中断

**配置**:
```python
interrupt_on = {
    "write_file": True,  # 所有决策都允许
    "execute": {
        "allowed_decisions": ["approve", "reject"],
        "description": "请确认是否执行此命令"
    }
}
```

**决策类型**:
- `approve`: 批准执行
- `edit`: 编辑参数后执行
- `reject`: 拒绝执行

## 3. 后端存储详解

### 3.1 StateBackend (默认)

**特点**:
- 临时存储，会话内有效
- 存储在 LangGraph state 中
- 自动 checkpoint

**适用场景**:
- 临时文件
- 会话内的中间结果

### 3.2 StoreBackend

**特点**:
- 持久存储，跨会话有效
- 使用 LangGraph Store
- 支持 namespace 隔离

**适用场景**:
- 用户记忆
- 长期知识库

### 3.3 FilesystemBackend

**特点**:
- 真实文件系统
- 支持 virtual_mode (虚拟路径映射)

**适用场景**:
- 读写真实文件
- 与外部系统交互

### 3.4 CompositeBackend

**特点**:
- 路由到不同后端
- 按路径前缀匹配

**示例**:
```python
backend = CompositeBackend(
    default=FilesystemBackend(root_dir="/workspace"),
    routes={
        "/memories/": StoreBackend(),  # 持久记忆
        "/tmp/": StateBackend(),       # 临时文件
    }
)
```

## 4. 记录驱动的工作流

### 4.1 核心理念

所有信息都被记录到正确的位置，确保后续步骤能获取需要的信息：

| 记录位置 | 内容 | 工具 |
|----------|------|------|
| `messages` | 对话历史、分析结果 | think_tool, plan_next_moves, record_result |
| `state["todos"]` | 任务进度跟踪 | write_todos |
| `state["files"]` | 文件内容 | read_file, write_file |

### 4.2 工作流程

```
用户输入 → 自动记录到 messages
    ↓
规划阶段 (planning-agent)
    - read_file → 结果记录到 messages
    - think_tool → 分析记录到 messages
    - 返回 JSON 计划 → 记录到 messages
    ↓
任务跟踪 (orchestrator)
    - write_todos → 任务记录到 state["todos"]
    ↓
执行阶段 (executor-agent)
    - python_run/write_file → 结果记录到 messages + state["files"]
    - record_result → 步骤结果记录到 messages
    ↓
评估阶段 (planning-agent)
    - 从 messages 读取之前的结果
    - 决定下一步或完成
    ↓
完成
    - 更新所有 todos 为 completed
    - 向用户返回最终结果
```

### 4.3 自定义记录工具

我们添加了以下记录工具来增强工作流：

| 工具 | 功能 | 记录到 |
|------|------|--------|
| `think_tool` | 记录分析和推理 | messages |
| `plan_next_moves` | 记录执行计划 | messages |
| `record_result` | 记录步骤结果 | messages |
| `ask_user` | 请求用户输入 | messages (中断) |

## 5. 与 Cursor/Claude 的对比

| 功能 | Cursor/Claude | DeepAgent 实现 |
|------|---------------|----------------|
| 任务跟踪 | TODO 列表 | `write_todos` (TodoListMiddleware) |
| 文件操作 | 直接操作 | `read_file`, `write_file` (FilesystemMiddleware) |
| 思考记录 | 内部推理 | `think_tool` (自定义工具) |
| 子任务委派 | 无 | `task` (SubAgentMiddleware) |
| 上下文管理 | 自动 | `SummarizationMiddleware` |
| 人工确认 | 无 | `HumanInTheLoopMiddleware` |
| 代码执行 | 沙箱 | `execute` / `python_run` |

## 6. 最佳实践

### 6.1 任务跟踪

```python
# ✅ 好的做法：具体、可操作的任务
write_todos([
    {"content": "读取招标文件 tender.docx", "status": "in_progress"},
    {"content": "提取项目名称、预算、截止日期", "status": "pending"},
    {"content": "分析资质要求", "status": "pending"},
])

# ❌ 不好的做法：太泛化
write_todos([
    {"content": "理解请求", "status": "in_progress"},
    {"content": "执行任务", "status": "pending"},
])
```

### 6.2 记录分析

```python
# ✅ 好的做法：结构化的思考
think_tool("""
GOAL: 分析招标文件，提取关键信息
FOUND: 项目名称=XX工程，预算=500万，截止日期=2024-03-15
GAP: 需要进一步分析资质要求
DECISION: 继续读取资质要求部分
""")

# ❌ 不好的做法：模糊的思考
think_tool("我需要分析这个文件")
```

### 6.3 子代理委派

```python
# ✅ 好的做法：完整的上下文
task("""
## 执行任务

### 目标
提取招标文件中的资质要求

### 输入
- 文件: /tmp/tender.docx
- 已提取信息: 项目名称=XX工程，预算=500万

### 期望输出
返回 JSON: {"requirements": [...], "mandatory": [...]}
""", "executor-agent")

# ❌ 不好的做法：缺少上下文
task("分析文件", "executor-agent")
```

## 7. 配置示例

### 7.1 基础配置

```python
from deepagents import create_deep_agent

agent = create_deep_agent(
    model="openai:gpt-4o",
    system_prompt="You are a helpful assistant.",
    tools=[...],
    subagents=[...],
)
```

### 7.2 高级配置（本项目使用）

```python
from deepagents import create_deep_agent
from deepagents.backends import CompositeBackend, FilesystemBackend, StoreBackend
from langgraph.store.memory import InMemoryStore
from langgraph.checkpoint.memory import MemorySaver

# ✅ 持久化记忆 (跨会话)
store = InMemoryStore()  # 生产环境可用 PostgresStore

# ✅ 会话恢复 (断点续传)
checkpointer = MemorySaver()  # 生产环境可用 PostgresSaver

# ✅ 混合后端 (路由到不同存储)
def create_backend(runtime):
    return CompositeBackend(
        default=EnhancedFilesystemBackend(root_dir="/workspace", virtual_mode=False),
        routes={
            "/memories/": StoreBackend(runtime),  # 持久记忆路由到 Store
        }
    )

# ✅ 人工确认配置 (可选)
interrupt_on = {
    "write_file": True,
    "execute": {"allowed_decisions": ["approve", "reject"]},
}

agent = create_deep_agent(
    model="openai:gpt-4o",
    system_prompt="...",
    tools=[...],
    subagents=[...],
    backend=create_backend,
    store=store,           # ✅ 启用持久记忆
    checkpointer=checkpointer,  # ✅ 启用会话恢复
    interrupt_on=interrupt_on,
    debug=True,
)
```

### 7.3 持久记忆使用

```python
# 保存用户偏好到持久记忆
write_file("/memories/preferences.json", json.dumps({
    "language": "zh-CN",
    "output_format": "markdown"
}))

# 读取持久记忆
preferences = read_file("/memories/preferences.json")

# 保存任务历史
write_file("/memories/task_history.json", json.dumps([
    {"task": "分析招标文件", "status": "completed", "date": "2024-01-08"}
]))
```

### 7.4 会话恢复

```python
# 使用 thread_id 恢复会话
config = {"configurable": {"thread_id": "user_123_session_456"}}

# 继续之前的对话
response = agent.invoke({"messages": [new_message]}, config)

# 获取会话历史
history = checkpointer.get(config)
```

## 8. 故障排除

### 8.1 工具循环

**问题**: Agent 反复调用同一个工具

**解决方案**:
1. 在 prompt 中添加 "NO LOOPS" 规则
2. 设置 `recursion_limit`
3. 工具返回值包含明确的下一步指示

### 8.2 上下文丢失

**问题**: Agent 忘记之前的分析结果

**解决方案**:
1. 使用 `think_tool` 记录分析
2. 使用 `record_result` 记录步骤结果
3. 检查 `SummarizationMiddleware` 是否过早触发

### 8.3 子代理不执行

**问题**: 子代理没有正确执行任务

**解决方案**:
1. 检查 `task` 调用的 `description` 是否完整
2. 确保子代理有正确的工具
3. 检查子代理的 prompt 是否清晰

## 9. 本项目配置总结

### 已启用的 DeepAgent 原生能力

| 能力 | 状态 | 配置 |
|------|------|------|
| TodoListMiddleware | ✅ 自动 | `write_todos` 工具 |
| FilesystemMiddleware | ✅ 自动 | `EnhancedFilesystemBackend` |
| SubAgentMiddleware | ✅ 自动 | 3 个 SubAgents |
| SummarizationMiddleware | ✅ 自动 | 默认配置 |
| Store (持久记忆) | ✅ 启用 | `InMemoryStore` |
| Checkpointer (会话恢复) | ✅ 启用 | `MemorySaver` |
| CompositeBackend | ✅ 启用 | `/memories/` → Store |

### 环境变量

```bash
# 启用/禁用持久化
ENABLE_STORE=true
ENABLE_CHECKPOINTER=true

# 调试模式
DEBUG=true
```

## 10. 更新日志

- 2026-01-08: 启用 Store + Checkpointer + CompositeBackend
- 2026-01-08: 添加 `record_result` 工具
- 2026-01-08: 重构为记录驱动架构
- 2026-01-08: 完善 agent prompts
