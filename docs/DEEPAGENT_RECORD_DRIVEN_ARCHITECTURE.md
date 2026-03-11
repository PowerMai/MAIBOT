# DeepAgent 记录驱动架构设计

## 核心理念

整个业务流围绕"记录"进行，所有信息都被正确记录并在后续步骤中可访问：

```
用户输入 → 记录到 messages
    ↓
查找资料 → 记录到 state["files"] / messages
    ↓
思考分析 → 记录到 messages (think_tool)
    ↓
制定计划 → 记录到 state["todos"] (write_todos)
    ↓
执行行动 → 记录到 state["files"] / messages
    ↓
评估结果 → 记录到 messages
    ↓
下一步骤 → 从 state["todos"] 读取
```

## DeepAgent 中间件全面分析

### 1. 核心中间件

| 中间件 | 状态字段 | 提供的工具 | 作用 |
|--------|----------|-----------|------|
| **TodoListMiddleware** | `state["todos"]` | `write_todos` | 任务跟踪和规划 |
| **FilesystemMiddleware** | `state["files"]` | `ls`, `read_file`, `write_file`, `edit_file`, `glob`, `grep`, `execute` | 文件系统操作 |
| **SubAgentMiddleware** | 隔离的子状态 | `task` | 子代理委派 |
| **SummarizationMiddleware** | 消息历史 | 无（自动触发） | 上下文压缩 |
| **HumanInTheLoopMiddleware** | 中断状态 | 无（拦截工具调用） | 人机交互中断 |

### 2. 后端存储

| 后端 | 持久性 | 跨线程 | 用途 |
|------|--------|--------|------|
| **StateBackend** | 临时 | 否 | 会话内文件（默认） |
| **StoreBackend** | 持久 | 是 | 跨会话记忆/知识 |
| **FilesystemBackend** | 持久 | 是 | 真实文件系统 |
| **CompositeBackend** | 混合 | 混合 | 路由到不同后端 |

### 3. 状态管理

```python
# DeepAgent 状态结构
state = {
    "messages": [HumanMessage, AIMessage, ToolMessage, ...],  # 对话历史
    "todos": [{"content": "...", "status": "pending|in_progress|completed"}],  # 任务列表
    "files": {"/path/to/file": FileData},  # 虚拟文件系统
}
```

## 记录驱动的工作流

### 阶段 1: 接收输入

```
用户消息 → 自动记录到 state["messages"]
```

### 阶段 2: 理解和规划 (Planning Agent)

```python
# 1. 读取相关文件 → 结果自动记录到 messages
read_file("/path/to/file.docx")

# 2. 思考分析 → 结果记录到 messages
think_tool("GOAL: 分析招标文件\nFOUND: 项目名称、预算...\nGAP: 需要提取资质要求\nDECISION: 继续分析")

# 3. 返回计划 → 结果记录到 messages
return {"goal": "...", "steps": [...], "done": false}
```

### 阶段 3: 任务跟踪 (Orchestrator)

```python
# 基于计划创建 TODO → 记录到 state["todos"]
write_todos([
    {"content": "读取招标文件", "status": "completed"},
    {"content": "提取关键信息", "status": "in_progress"},
    {"content": "生成分析报告", "status": "pending"}
])
```

### 阶段 4: 执行任务 (Executor Agent)

```python
# 1. 执行任务 → 结果记录到 messages
python_run("...")

# 2. 写入文件 → 记录到 state["files"]
write_file("/output/report.md", content)

# 3. 返回结果 → 记录到 messages
return {"status": "success", "result": "...", "output": "..."}
```

### 阶段 5: 评估和迭代 (Planning Agent)

```python
# 从 messages 历史中读取之前的结果
# 评估进度，决定下一步
return {"done": true, "assessment": "任务完成"}
```

### 阶段 6: 完成

```python
# 更新所有 TODO 为完成
write_todos([
    {"content": "读取招标文件", "status": "completed"},
    {"content": "提取关键信息", "status": "completed"},
    {"content": "生成分析报告", "status": "completed"}
])

# 向用户返回最终结果
```

## 关键设计原则

### 1. 工具返回值必须包含输入内容

```python
@tool
def think_tool(thinking: str) -> str:
    # 关键：返回用户输入的内容，确保 LLM 能在后续步骤中看到自己的分析
    return f"""[思考已记录]

{thinking}

→ 现在执行下一步"""
```

### 2. 使用 write_todos 而非自定义记录

DeepAgent 的 `TodoListMiddleware` 已经提供了完善的任务跟踪：
- 自动持久化到 `state["todos"]`
- 支持 `pending`, `in_progress`, `completed` 状态
- 自动注入系统提示词指导使用

### 3. 使用 FilesystemMiddleware 的虚拟文件系统

```python
# 写入过程文件
write_file("/.context/plan.json", json.dumps(plan))
write_file("/.context/results.md", results)

# 后续步骤可以读取
read_file("/.context/plan.json")
```

### 4. 利用 SummarizationMiddleware 自动压缩

当消息历史过长时，自动触发摘要，保留关键信息。

### 5. 使用 HumanInTheLoopMiddleware 实现断点续传

```python
# 配置需要人工确认的工具
interrupt_on = {
    "write_file": True,  # 写文件前确认
    "execute": {"allowed_decisions": ["approve", "reject"]}  # 执行命令前确认
}
```

## 与 Cursor/Claude 的对比

| 功能 | Cursor/Claude | DeepAgent 实现 |
|------|---------------|----------------|
| 任务跟踪 | TODO 列表 | `write_todos` (TodoListMiddleware) |
| 文件操作 | 直接操作 | `read_file`, `write_file` (FilesystemMiddleware) |
| 思考记录 | 内部推理 | `think_tool` (自定义工具) |
| 子任务委派 | 无 | `task` (SubAgentMiddleware) |
| 上下文管理 | 自动 | `SummarizationMiddleware` |
| 人工确认 | 无 | `HumanInTheLoopMiddleware` |

## 推荐的后端配置

```python
from deepagents.backends import CompositeBackend, FilesystemBackend, StoreBackend

# 混合后端：
# - 默认使用真实文件系统
# - /memories/ 路径使用持久化存储
backend = CompositeBackend(
    default=FilesystemBackend(root_dir="/workspace", virtual_mode=False),
    routes={
        "/memories/": StoreBackend(),  # 跨会话记忆
    }
)
```

## 下一步优化

1. **重新设计 think_tool**: 使其成为真正的"记录"工具，而非"执行"工具
2. **优化 plan_next_moves**: 从 `state["todos"]` 读取当前进度，返回下一步
3. **完善 agent prompts**: 明确每个 agent 如何使用记录系统
4. **实现 CompositeBackend**: 支持混合存储策略
