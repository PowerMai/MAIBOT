# Orchestrator + SubAgents 架构

## 设计原则

综合 LangChain DeepAgent + Claude 最佳实践：
1. **Orchestrator 是项目经理** - 路由决策、任务分解、结果综合
2. **SubAgent 是专家** - 隔离上下文执行，专注单一任务
3. **上下文隔离** - 避免污染主上下文，提高调用质量

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│                    ORCHESTRATOR（项目经理）                   │
│  - 路由决策：并行/串行/直接执行                              │
│  - 任务分解：拆分为 SubAgent 可执行的子任务                  │
│  - 结果综合：整合 SubAgent 返回的结果                        │
├─────────────────────────────────────────────────────────────┤
│    ↓ task()       ↓ task()       ↓ task()       ↓ task()    │
├─────────────────────────────────────────────────────────────┤
│  EXPLORE        KNOWLEDGE      PLANNING       EXECUTOR       │
│  文件搜索专家    本地知识库      任务规划专家   执行专家       │
│  "用什么"       "知道什么"      执行计划       最终产出       │
│  ┌─────────┐    ┌─────────┐    ┌─────────┐   ┌─────────┐    │
│  │ls,glob  │    │search_kb│    │python_  │   │python_  │    │
│  │grep     │    │read_file│    │run      │   │run      │    │
│  │read_file│    │         │    │read_file│   │write_   │    │
│  └─────────┘    └─────────┘    └─────────┘   │file     │    │
│                                              └─────────┘    │
└─────────────────────────────────────────────────────────────┘

Skills vs Knowledge（关键区分）：
- Skills（方法论）：怎么做 → 自定义工具 + BUNDLE.md 内联
- Knowledge（本地知识）：知道什么 → 可用知识检索子代理检索

协作流程：explore → knowledge → planning → executor
路由规则：并行（独立任务）/ 串行（有依赖）/ 直接执行（简单任务）
```

## 工具总览 (16 个) - 对标 Cursor

| 类别 | 工具 | Cursor 对应 | 状态 |
|------|------|-------------|------|
| **文件操作** | read_file, write_file, delete_file, copy_file, move_file, list_directory | read/write/edit_file | ✅ |
| **代码执行** | python_run, shell_run, get_libraries | run_terminal_cmd | ✅ |
| **网络搜索** | duckduckgo_search, file_search | web_search, file_search | ✅ |
| **思考反思** | think_tool, plan_next_moves | (implicit) | ✅+ |
| **代码搜索** | grep_search, find_definition, find_references | grep, codebase_search | ✅ |
| **知识库** | search_knowledge_base, hybrid_search | (无) | ✅+ |

**优势**：知识库工具 + 显式思考工具

## think_tool - 反思机制

每个 Sub-Agent 在执行后调用 `think_tool` 进行反思：

```
think_tool("
Found: [key findings]
Goal: [objective]
Progress: [X% or status]
Gap: [what's missing]
Decision: [continue|try_alt|return_result]
")
```

这确保：
- 思考被记录到 messages
- 影响后续决策
- 实现真正的迭代而非简单循环

## 项目上下文 (.context/) - Cursor 风格

```
backend/tmp/.context/
├── summary.md           # 当前状态（OVERWRITE - 总是最新）
├── todos.md             # TODO 列表（OVERWRITE - 当前任务）
├── lessons.md           # 经验教训（APPEND - 累积记忆）
├── reports/             # 📁 输出报告（CREATE - 每次新文件）
│   └── 2025-01-06_task1_analysis.md
├── sessions/            # 📁 会话历史
│   └── 2025-01-06_session1.json
└── artifacts/           # 📁 数据文件（提取的数据等）
    └── extracted_data.json
```

### 文件策略

| 文件 | 策略 | 说明 |
|------|------|------|
| summary.md | OVERWRITE | 总是最新状态 |
| todos.md | OVERWRITE | 当前任务列表 |
| lessons.md | APPEND | read→add→write |
| reports/*.md | CREATE | `{date}_{task}.md` |
| artifacts/* | CREATE | 按需命名 |

## Workflow (ReAct + Reflect)

```
1. READ: read_file("/.context/summary.md") → 当前状态
2. PLAN: task("analyze and plan", "<available-planning-subagent>") → 获取计划
3. TODOS: write_file("/.context/todos.md", plan.todos)
4. EXECUTE: for step in plan:
   - knowledge → task(q, "<available-knowledge-subagent>")
   - execute → task(instr, "<available-execution-subagent>")
   - parallel: task(A) || task(B)
5. ITERATE: after each task():
   - success → update todo, continue
   - fail → retry OR replan
   - new_info → evaluate replan
6. SYNTHESIZE: consolidate results
7. REPORT: write_file("/.context/reports/{date}_{task}.md", output)
8. UPDATE: write_file("/.context/summary.md", status)
```

## Token 效率

| Agent | Tokens | think_tool | grep_search |
|-------|--------|------------|-------------|
| Orchestrator | ~459 | ❌ (Sub-agents 反思) | ❌ |
| Planning | ~368 | ✅ | ✅ |
| Executor | ~382 | ✅ | ✅ |
| Knowledge | ~454 | ✅ | ✅ |
| **总计** | **~1663** | | |

## 使用

```python
from backend.engine.agent.deep_agent import agent

# 执行任务
result = agent.invoke({
    "messages": [{"role": "user", "content": "分析这份招标文档..."}]
})
```
