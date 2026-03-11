# 推理型知识库架构

基于 LangChain/DeepAgent 框架的智能知识服务系统（Claude 风格优化）。

## 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│                    DeepAgent 中间件层                        │
│  （自动注入系统提示词，无需 Agent 干预）                      │
├─────────────────────────────────────────────────────────────┤
│ project_memory    → .context/CONTEXT.md, rules/*.md 拼入    │
│ Skills 工具       → list_skills/match_skills + BUNDLE.md    │
│ SummarizationMiddleware → 接近窗口限制时自动压缩            │
│ Checkpointer      → 会话状态自动持久化                      │
│ ToolRetryMiddleware → 工具调用失败自动重试 (max=2)          │
│ ModelRetryMiddleware → 模型调用失败自动重试 (max=2)         │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                    Orchestrator                              │
│  理解意图 → 协调子代理 → 验证结果                            │
├─────────────────────────────────────────────────────────────┤
│ Planning Agent    │ Executor Agent    │ Knowledge Agent     │
│ 分析 → 规划       │ 执行 → 输出       │ 检索 → 推理 → 学习  │
│ 32K tokens        │ 128K tokens       │ 32K tokens          │
└─────────────────────────────────────────────────────────────┘
```

## 信息闭环检查

### 1. 短期记忆（Thread 级）
| 组件 | 内容 | 管理方式 | 状态 |
|------|------|----------|------|
| Checkpointer | 当前对话上下文 | LangGraph 自动 | ✅ |
| state["messages"] | 消息历史 | 自动 | ✅ |
| state["todos"] | 任务列表 | write_todos | ✅ |

### 2. 长期记忆（Cross-thread 级）
| 组件 | 内容 | 管理方式 | 状态 |
|------|------|----------|------|
| Store | 用户偏好、成功路径 | LangGraph 自动 | ✅ |
| 知识图谱 | 实体、关系 | learn_from_doc | ✅ |
| lessons.md | 经验教训 | edit_file | ✅ |

### 3. 项目记忆（project_memory）
| 文件 | 内容 | 注入方式 | 状态 |
|------|------|----------|------|
| .context/CONTEXT.md | 项目规则、工作区结构 | deep_agent._load_memory_content() | ✅ |
| .context/rules/*.md | 领域规则 | deep_agent._load_memory_content() | ✅ |
| SKILL.md | 工作方法论 | Skills 工具 + BUNDLE.md 内联 | ✅ |

### 4. 工作区文件（Knowledge Agent 检索）
| 路径 | 内容 | 优先级 | 状态 |
|------|------|--------|------|
| uploads/ | 用户上传的项目文件 | 0.90 | ✅ |
| outputs/ | 过程文件和输出结果 | 0.85 | ✅ 新增 |
| knowledge_base/ | 专业知识 | 0.80 | ✅ |

## 上下文窗口管理

### DeepAgent SummarizationMiddleware
- **不管理 summary 文件**，而是在内存中压缩
- 当上下文接近 `max_input_tokens` 时自动触发
- 压缩后的摘要替代旧消息

### ContextEditingMiddleware
- 在 70% 窗口时清理旧工具调用结果
- 保留最近 5 个工具调用

### 窗口大小配置（按任务类型分级）

```python
# 环境变量配置
LLM_MAX_TOKENS=32768       # 默认窗口 (32K)
LLM_MAX_TOKENS_DOC=131072  # 文档处理 (128K)
LLM_MAX_TOKENS_FAST=8192   # 快速任务 (8K)

# 窗口大小计算（以 123KB 中文文档为例）
# - 文档内容: ~61,500 tokens
# - 系统提示词: ~2,000 tokens
# - 输出空间: ~8,000 tokens
# - 安全余量 (20%): ~12,000 tokens
# - 总需求: ~84,000 tokens → 推荐 128K 窗口
```

### 子代理独立 LLM 配置

```python
# 每个子代理可以使用不同的窗口大小
create_llm_for_agent("orchestrator")  # 32K 默认
create_llm_for_agent("planning")      # 32K 默认
create_llm_for_agent("executor")      # 128K 文档处理
create_llm_for_agent("knowledge")     # 32K 默认

# 也可以通过 config 动态指定
config = {"configurable": {"task_type": "doc"}}
create_llm(config=config)  # 使用 128K 窗口
```

### 性能说明

| 配置 | 窗口大小 | 适用场景 | 速度 |
|------|----------|----------|------|
| fast | 8K | 简单问答 | 最快 |
| default | 32K | 日常任务 | 快 |
| doc | 128K | 文档处理 | 较慢 |

**注意**：切换窗口大小不需要重新加载模型，LM Studio 支持动态调整 `max_tokens`。

## Knowledge Agent 工具优先级

1. **python_run** - 复杂分析、数据处理
2. **search_knowledge** - 语义检索
3. **grep** - 精确定位
4. **read_file** - 精确读取
5. **ls** - 目录探索

## 自我学习闭环

```
任务执行
    ↓
分析文档 → learn_from_doc → 提取实体/关系 → 知识图谱
    ↓
任务完成 → report_task_result → 更新置信度
    ↓
下次查询 → 使用积累的知识 → 更准确的结果
```

## 上下文传递（Agent 间）

```
Orchestrator
    │
    ├── task("Query: xxx", "<available-knowledge-subagent>")
    │   └── 返回: guide + kg_context + key_points
    │
    ├── task("Task: xxx\nContext: [knowledge结果]", "<available-planning-subagent>")
    │   └── 返回: goal + key_info + steps[]
    │
    └── task("Step: xxx\nKey_info: [planning结果]", "<available-execution-subagent>")
        └── 返回: result + evidence + for_next_step
```

## 与 Cursor/Claude 对比及优化方向

| 特性 | 本系统 | Cursor | Claude | 优化方向 |
|------|--------|--------|--------|----------|
| 项目文件检索 | ✅ uploads + outputs | ✅ codebase indexing | ✅ Projects | ✅ 已对齐 |
| 知识图谱 | ✅ 实体关系推理 | ❌ | ❌ | 🚀 超越 |
| 自我学习 | ✅ learn_from_doc | ❌ | ✅ Memory | ✅ 已对齐 |
| 上下文压缩 | ✅ SummarizationMiddleware | ✅ 文件卸载 | ✅ 自动 | ✅ 已对齐 |
| 工作区感知 | ✅ ls/read_file | ✅ @Files | ✅ Artifacts | ✅ 已对齐 |
| 动态窗口 | ✅ 按任务类型 | ❌ 固定 | ✅ 自动 | ✅ 已对齐 |
| 子代理独立配置 | ✅ 支持 | ❌ | ❌ | 🚀 超越 |

### Cursor 风格优化

1. **上下文卸载 (Context Offloading)**
   - 长工具输出写入文件，主上下文只保留路径
   - Knowledge Agent 返回摘要而非完整文档

2. **精确检索优先**
   - `grep` > `vector_search` 对于已知关键词
   - `python_run` 用于结构化数据分析

3. **Artifacts 模式**
   - 生成的文档保存到 outputs/
   - 主对话只显示摘要和路径

### Claude 风格优化

1. **Memory 系统**
   - lessons.md 记录经验教训
   - 知识图谱积累实体关系
   - Store 保存用户偏好

2. **Projects 模式**
   - uploads/ 作为项目文件夹
   - outputs/ 作为输出文件夹
   - outputs/.cache/ 作为中间数据缓存
   - 自动索引和检索

3. **自适应窗口**
   - 简单任务用小窗口（快）
   - 文档任务用大窗口（准）

## 工作区目录结构 (Claude Code 风格)

```
backend/tmp/
├── uploads/           # 用户上传的项目文件
├── outputs/           # 生成的输出文件
│   ├── reports/       # 分析报告
│   ├── charts/        # 图表
│   ├── documents/     # 文档
│   └── .cache/        # 中间数据缓存
│       ├── progress.json      # 任务进度快照
│       ├── extracted_data.json # 提取的数据
│       └── step_*.json        # 步骤输出
└── .context/          # 上下文文件 (类似 CLAUDE.md)
    ├── AGENTS.md      # 用户偏好（MemoryMiddleware 自动注入）
    ├── lessons.md     # 经验教训（MemoryMiddleware 自动注入）
    └── rules/         # 路径特定规则 (类似 .claude/rules/)
        ├── bidding.md       # 招标文件处理规则
        ├── large_file.md    # 大文件处理规则
        └── context_budget.md # 上下文预算管理
```

## 文件职责划分 (Claude/DeepAgent 标准)

### 职责定义

| 文件 | 中间件 | 职责 | 内容 |
|------|--------|------|------|
| .context/CONTEXT.md | project_memory | 项目规则 | 语言、格式、工作区结构 |
| .context/rules/*.md | project_memory | 领域规则 | 动态积累的经验与规则 |
| SKILL.md | Skills 工具 + BUNDLE.md | 领域方法论 | 五维分析、三层审查、四阶段模型 |

### DeepAgent 中间件 + 本项目扩展

| 组件 | 作用 | 加载时机 |
|------|------|----------|
| project_memory | .context/CONTEXT.md, rules/*.md | 系统提示词拼接时 |
| Skills 工具 + BUNDLE.md | SKILL.md 发现与内联 | registry.py 注册 + 提示词拼接 |
| SummarizationMiddleware | 上下文压缩 | 接近窗口限制时 |
| Checkpointer | 会话状态 | 自动持久化 |
| Store | 跨会话记忆 | 自动持久化 |

### 技能文件格式 (YAML 前置信息)

```yaml
---
name: bidding
description: 招投标专家。五维分析、响应矩阵、python_run批量提取。
---

# 技能内容（工作方法论）
...
```

### 目录结构

```
backend/tmp/.context/           # project_memory 加载
├── CONTEXT.md                  # 项目规则、工作区结构
└── rules/*.md                  # 领域规则

knowledge_base/skills/          # Skills 工具 + BUNDLE.md 内联
├── bidding/SKILL.md            # 五维分析、响应矩阵
├── contracts/SKILL.md          # 三层审查、风险评估
└── reports/SKILL.md            # 四阶段模型
```

### 禁止重复
- ❌ AGENTS.md 中不放领域方法论（应在 SKILL.md）
- ❌ SKILL.md 中不放用户偏好（应在 AGENTS.md）
- ❌ 提示词中不重复 SKILL.md 内容（自动注入）

## 上下文卸载策略

### 长输出处理
```python
# ❌ 错误：直接返回大量文本
return {"result": very_long_text}  # 会挤爆上下文

# ✅ 正确：写入文件，返回路径和摘要
write_file("outputs/analysis.md", very_long_text)
return {
    "result": "分析完成",
    "output": {"path": "outputs/analysis.md", "preview": very_long_text[:500]}
}
```

### 中间数据处理
```python
# 将中间数据保存到 .cache，供后续步骤使用
data = extract_data(file)
write_file("outputs/.cache/extracted_data.json", json.dumps(data))
return {"for_next_step": "数据已保存到 outputs/.cache/extracted_data.json"}
```

### 大文件分析
```python
# 不要一次读取整个大文件
# ✅ 使用 grep 定位 + read_file(offset, limit) 精确读取
positions = grep("评分标准", file)
content = read_file(file, offset=positions[0], limit=100)
```

## Claude 风格优化

### 1. Extended Thinking（深度思考）
```python
# 使用 extended_thinking 工具进行复杂问题分析
extended_thinking(
    problem="如何优化招标文件分析流程",
    constraints="时间限制、文档大小、准确性要求",
    approach="五维分析法 + 知识图谱增强",
    reasoning="1. 先提取关键实体... 2. 构建关系图谱...",
    conclusion="采用分层分析策略"
)
```

### 2. 原子性文件写入（数据一致性保护）
```python
# 使用临时文件 + os.replace 确保写入原子性
def _atomic_write(file_path, data):
    tmp_path = file_path.with_suffix('.tmp')
    tmp_path.write_text(data)
    os.replace(tmp_path, file_path)  # 原子操作
```

### 3. 错误恢复和重试机制
```python
# LangChain 官方中间件
additional_middleware = [
    ToolRetryMiddleware(max_retries=2),    # 工具调用失败自动重试
    ModelRetryMiddleware(max_retries=2),   # 模型调用失败自动重试
    ModelCallLimitMiddleware(run_limit=50), # 防止无限循环
    ToolCallLimitMiddleware(run_limit=100), # 防止工具滥用
]
```

### 4. 子代理独立 LLM 配置
| Agent | 窗口大小 | 用途 |
|-------|----------|------|
| Orchestrator | 32K | 协调任务、验证结果 |
| Planning | 32K | 分析任务、规划步骤 |
| Executor | 128K | 执行步骤、处理大文档 |
| Knowledge | 32K | 检索知识、推理增强 |

### 5. 工具清单（14 个补充工具）
| 类别 | 工具 | 用途 |
|------|------|------|
| 思考 | think_tool, extended_thinking | 记录分析、深度推理 |
| 交互 | ask_user, record_result | 用户交互、结果记录 |
| 执行 | python_run | 增强版 Python 执行 |
| 搜索 | duckduckgo_search, search_knowledge | 网络搜索、知识检索 |
| 知识图谱 | extract_entities, query_kg | 实体提取、图谱查询 |
| 学习 | learn_from_doc, report_task_result | 文档学习、任务反馈 |
| 统计 | get_learning_stats, get_similar_paths | 学习统计、相似路径 |
| 恢复 | record_failure | 失败记录 |
