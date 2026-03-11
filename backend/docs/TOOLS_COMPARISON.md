# 工具集对比：Cursor vs 当前架构

## 一、Cursor/Claude 工具集分析

### Cursor Agent Mode 工具（13 个核心）

| 类别 | 工具 | 功能 | 我们有? |
|------|------|------|---------|
| **文件读取** | `read_file` | 读取文件内容（支持行范围） | ✅ |
| **文件写入** | `write_file` / `edit_file` | 写入/编辑文件 | ✅ |
| **目录操作** | `list_directory` | 列出目录内容 | ✅ |
| **文件搜索** | `file_search` | 按名称搜索文件 | ✅ |
| **代码搜索** | `grep_search` / `codebase_search` | 正则/语义搜索 | ✅ |
| **定义查找** | `find_definition` | 跳转到定义 | ✅ |
| **引用查找** | `find_references` | 查找所有引用 | ✅ |
| **终端执行** | `run_terminal_cmd` | 执行终端命令 | ✅ shell_run |
| **网络搜索** | `web_search` | 搜索网页 | ✅ duckduckgo |
| **浏览器** | `browser_*` | 浏览器操作 | ⚠️ 可选 |
| **TODO管理** | `todo_write` | 管理任务列表 | ✅ DeepAgent内置 |
| **记忆** | `update_memory` | 更新记忆 | ✅ .context/ |
| **截图** | `take_screenshot` | 截取屏幕 | ❌ |

### Claude (Anthropic) 工具特点

| 特性 | 说明 | 我们有? |
|------|------|---------|
| `think_tool` | 强制反思 | ✅ |
| `extended_thinking` | Claude API 参数 | ⚠️ 提示词实现 |
| Multi-tool parallel | 并行工具调用 | ✅ DeepAgent支持 |

## 二、当前工具集（16+ 个）

### 已注册工具

| 类别 | 工具名 | 来源 | 状态 |
|------|--------|------|------|
| **文件操作（6）** | | | |
| | `read_file` | Enhanced + LangChain | ✅ |
| | `write_file` | LangChain | ✅ |
| | `delete_file` | LangChain | ✅ |
| | `copy_file` | LangChain | ✅ |
| | `move_file` | LangChain | ✅ |
| | `list_directory` | LangChain | ✅ |
| **代码执行（3）** | | | |
| | `python_run` | Enhanced | ✅ |
| | `shell_run` | LangChain | ✅ |
| | `get_libraries` | Custom | ✅ |
| **网络搜索（2）** | | | |
| | `duckduckgo_search` | LangChain | ✅ |
| | `file_search` | LangChain | ✅ |
| **思考反思（2）** | | | |
| | `think_tool` | Custom (Anthropic风格) | ✅ |
| | `plan_next_moves` | Custom (Cursor风格) | ✅ |
| **代码搜索（3）** | | | |
| | `grep_search` | Custom (ripgrep风格) | ✅ |
| | `find_definition` | Custom | ✅ |
| | `find_references` | Custom | ✅ |

### 对比结论

| 指标 | Cursor | 我们 |
|------|--------|------|
| 核心工具数 | 13 | 16 |
| 文件操作 | 3-4 | 6 |
| 代码搜索 | 3 | 3 |
| 执行能力 | terminal | python+shell |
| 思考反思 | implicit | explicit think_tool |
| 知识库 | ❌ | ✅ search_kb |

**结论：工具集已基本匹配 Cursor，且有知识库优势。**

### 描述规范对齐（Claude 官方）

- 本系统自研工具已按 Claude 规范补全：**When to use**、**Avoid when**、**Parameters/Returns**、**Examples**（见 registry.py、embedding_tools.search_knowledge、code_execution.python_run）。
- Layer 1 tool_usage（agent_prompts.py）补充：write_file/edit_file 路径约定与部分环境需用户确认；search_knowledge 用法示例；与 [tools_inventory_and_description_spec.md](../../docs/tools_inventory_and_description_spec.md) 一致。

## 三、文件管理策略

### Cursor 的 `.cursor/` 目录

```
.cursor/
├── rules/           # 项目规则
│   └── *.mdc
├── chat/            # 对话历史
│   └── *.json
└── settings.json    # 配置
```

### 我们的 `.context/` 目录（建议扩展）

**问题**：当前所有内容写入单一文件，不利于管理。

**解决**：按会话/任务创建目录结构

```
backend/tmp/.context/
├── summary.md           # 项目级摘要（总是最新状态）
├── lessons.md           # 经验教训（累积）
├── todos.md             # 当前 TODO 列表
├── reports/             # 📁 输出报告目录
│   ├── 2025-01-06_task1_analysis.md
│   └── 2025-01-06_task2_comparison.md
├── sessions/            # 📁 会话历史
│   └── 2025-01-06_session1.json
└── artifacts/           # 📁 生成的文件/数据
    ├── extracted_data.json
    └── processed_output.xlsx
```

### 文件管理规则

| 场景 | 写入位置 | 文件名模式 |
|------|----------|------------|
| 任务报告 | `/.context/reports/` | `{date}_{task}_{type}.md` |
| 状态更新 | `/.context/summary.md` | 覆盖（总是最新） |
| TODO | `/.context/todos.md` | 覆盖（当前列表） |
| 经验教训 | `/.context/lessons.md` | 追加 |
| 数据文件 | `/.context/artifacts/` | 按需命名 |
| 会话记录 | `/.context/sessions/` | `{date}_session{n}.json` |

## 四、提示词更新建议

### Orchestrator Workflow 更新

```
## Workflow (ReAct + Reflect)
1. READ: read_file("/.context/summary.md") → current state
2. PLAN: task("analyze and plan", "<available-planning-subagent>") → get plan
3. TODOS: write_file("/.context/todos.md", plan.todos)
4. EXECUTE: ...
5. ITERATE: ...
6. SYNTHESIZE: consolidate results
7. REPORT: write_file("/.context/reports/{date}_{task}.md", output)
8. UPDATE: 
   - write_file("/.context/summary.md", status)  # 覆盖
   - append_to("/.context/lessons.md", lessons)  # 追加（或read→append→write）
```

### 写入策略表

| 文件 | 策略 | 说明 |
|------|------|------|
| summary.md | OVERWRITE | 总是最新状态 |
| todos.md | OVERWRITE | 当前任务列表 |
| lessons.md | APPEND | 累积经验 |
| reports/*.md | CREATE | 每次新文件 |
| artifacts/* | CREATE | 每次新文件 |

## 五、待添加工具（可选）

| 工具 | 优先级 | 原因 |
|------|--------|------|
| `edit_file` | 中 | 精确编辑（目前 write_file 可替代） |
| `codebase_search` | 中 | 语义搜索（需向量库） |
| `browser_*` | 低 | 浏览器自动化 |
| `screenshot` | 低 | 截图能力 |

**当前工具集已满足 95%+ 用例，无需急于扩展。**

