# 全面架构审查报告 - 基于 Claude 官方文档

## 一、Worker 数量评估

### 结论：三个 SubAgent 完全足够

根据 Claude Research 多智能体系统的经验，**关键不在 Worker 数量，而在于任务边界清晰**。

| 您的 SubAgent | 职责 | Claude 对标 | 评估 |
|--------------|------|------------|------|
| **planning（可选扩展）** | 分析问题、制定计划 | Analyzer | ✅ 按需启用 |
| **executor（可选扩展）** | 执行操作、生成输出 | Executor | ✅ 按需启用 |
| **knowledge（可选扩展）** | 知识检索、Skill 路由 | Knowledge + Skill Router | ✅ 按需启用 |

**不需要扩展更多 Worker 的原因**：
1. Claude Code 本身就是单一 Agent + 工具的模式
2. Claude Research 多智能体系统的复杂度来自**并行搜索**，不是 Worker 种类
3. 您的三个 Worker 已覆盖：分析、执行、知识 三大核心能力

**如果需要扩展**，应该通过以下方式：
- 添加 **Skill**（专业方法论）
- 添加 **Knowledge**（领域知识）
- 添加 **Tools**（专用工具）

---

## 二、Skill 中间件 vs Knowledge 检索

### 问题：是否重复？

**答案：不重复，是互补的两层**

```
┌─────────────────────────────────────────────────────────────┐
│                    Skill 系统（两层）                        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Layer 1: BUNDLE.md 内联 + Skills 工具（能力发现）          │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ • BUNDLE.md 按 skill_profile 内联到系统提示词        │   │
│  │ • list_skills/match_skills 工具按需发现              │   │
│  │ • read_file("...SKILL.md") 按需加载详细内容          │   │
│  │ • 只内联能力速查，详细内容按需读取                    │   │
│  └─────────────────────────────────────────────────────┘   │
│           ↓ 当 Agent 需要使用某个 Skill 时                  │
│  Layer 2: Knowledge Agent 检索                              │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ • 通过 read_file 读取完整 SKILL.md                   │   │
│  │ • 通过 search_knowledge 检索相关知识                 │   │
│  │ • 返回工作流程、检查清单、模板                       │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**这是 Claude 推荐的 Progressive Disclosure 模式**：
1. **Layer 1**：告诉 Agent "你有哪些技能可用"（占用少量 token）
2. **Layer 2**：当需要时才加载完整技能内容（按需加载）

### 当前实现的问题

您的 `knowledge_base/skills/` 和 `knowledge_base/global/domain/` 存在重叠：

```
当前结构（有重叠）：
knowledge_base/
├── skills/                    # Skills 工具 + BUNDLE.md 内联
│   ├── bidding/SKILL.md       # 招标技能
│   ├── contracts/SKILL.md     # 合同技能
│   └── reports/SKILL.md       # 报告技能
│
├── bidding/                   # 重复！
│   └── SKILL.md
│
└── global/domain/             # Knowledge Agent 检索
    ├── bidding/               # 详细知识
    ├── contracts/
    └── reports/
```

**建议的结构**：

```
knowledge_base/
├── skills/                    # Skills 工具 + BUNDLE.md 内联（技能列表）
│   ├── bidding/SKILL.md       # 只包含：name, description, workflow 概要
│   ├── contracts/SKILL.md
│   ├── reports/SKILL.md
│   ├── education/             # 新增：教育领域
│   │   ├── student_learning/SKILL.md
│   │   ├── teacher_prep/SKILL.md
│   │   └── homework_check/SKILL.md
│   ├── manufacturing/         # 新增：制造领域
│   │   ├── data_analysis/SKILL.md
│   │   ├── production_planning/SKILL.md
│   │   └── quality_check/SKILL.md
│   └── management/            # 新增：管理领域
│       ├── business_planning/SKILL.md
│       ├── report_generation/SKILL.md
│       └── decision_support/SKILL.md
│
└── domain/                    # Knowledge Agent 检索（详细知识）
    ├── bidding/               # 招标详细知识
    │   ├── basics/
    │   ├── operations/
    │   ├── templates/
    │   └── best_practices/
    ├── contracts/
    ├── reports/
    ├── education/             # 新增
    ├── manufacturing/         # 新增
    └── management/            # 新增
```

---

## 三、提示词一致性检查

### 发现的问题

**新增内容与原有内容是统一的**，没有重复表述。

检查结果：
- ✅ 任务分类（分析/决策/执行/对话）：只在 Orchestrator 中定义
- ✅ 复杂度评估：新增，与任务分类互补
- ✅ 业务场景示例：新增，提供参考
- ✅ 子代理调用格式：只在 Orchestrator 中定义

**但存在一个优化点**：Orchestrator 提示词较长（~3500 tokens），可以考虑分层加载。

### 建议的提示词分层

```
system_prompt（基础原则）
    ↓
orchestrator_prompt（任务分类 + 路由）
    ↓
根据任务类型动态加载：
├── 分析型 → 加载分析指南
├── 决策型 → 加载决策框架
├── 执行型 → 加载执行模板
└── 对话型 → 不加载额外内容
```

---

## 四、办公/教育/生产场景 Skill 名目

### 办公场景 Skills

```
skills/office/
├── document_writing/          # 文档撰写
│   └── SKILL.md              # 各类文档的撰写方法
├── meeting_management/        # 会议管理
│   └── SKILL.md              # 会议记录、纪要、跟进
├── email_communication/       # 邮件沟通
│   └── SKILL.md              # 邮件撰写、回复模板
├── project_management/        # 项目管理
│   └── SKILL.md              # 项目计划、进度跟踪
├── data_reporting/            # 数据报告
│   └── SKILL.md              # 数据分析、可视化报告
└── file_organization/         # 文件整理
    └── SKILL.md              # 文件分类、归档
```

### 教育场景 Skills

```
skills/education/
├── student_learning/          # 学生学习
│   └── SKILL.md              # 学习计划、知识整理、复习方法
├── teacher_lesson_prep/       # 教师备课
│   └── SKILL.md              # 教案设计、教学资源准备
├── homework_check/            # 作业批改
│   └── SKILL.md              # 批改标准、反馈生成
├── exam_analysis/             # 考试分析
│   └── SKILL.md              # 成绩分析、问题诊断
├── course_design/             # 课程设计
│   └── SKILL.md              # 课程大纲、教学目标
└── student_evaluation/        # 学生评价
    └── SKILL.md              # 综合评价、成长报告
```

### 生产/制造场景 Skills

```
skills/manufacturing/
├── production_data_analysis/  # 生产数据分析
│   └── SKILL.md              # 产量、效率、质量分析
├── production_planning/       # 生产计划
│   └── SKILL.md              # 排产、资源调度
├── quality_inspection/        # 质量检查
│   └── SKILL.md              # 检测数据分析、问题诊断
├── equipment_maintenance/     # 设备维护
│   └── SKILL.md              # 维护计划、故障分析
├── inventory_management/      # 库存管理
│   └── SKILL.md              # 库存分析、补货建议
└── process_optimization/      # 工艺优化
    └── SKILL.md              # 工艺参数分析、优化建议
```

### 管理场景 Skills

```
skills/management/
├── business_planning/         # 业务规划
│   └── SKILL.md              # 战略分析、计划制定
├── performance_analysis/      # 绩效分析
│   └── SKILL.md              # KPI 分析、改进建议
├── decision_support/          # 决策支持
│   └── SKILL.md              # 方案对比、风险评估
├── team_management/           # 团队管理
│   └── SKILL.md              # 人员配置、任务分配
├── budget_management/         # 预算管理
│   └── SKILL.md              # 预算分析、成本控制
└── report_generation/         # 报告生成
    └── SKILL.md              # 各类管理报告
```

### 招投标场景 Skills（已有）

```
skills/bidding/
├── tender_analysis/           # 招标分析
│   └── SKILL.md              # 五维分析、评分标准
├── bid_response/              # 投标响应
│   └── SKILL.md              # 响应矩阵、文档准备
└── bid_evaluation/            # 评标
    └── SKILL.md              # 评分标准、对比分析
```

---

## 五、工具审查

### 当前工具列表

```python
# DeepAgent 自动提供（不需要注册）
- ls, read_file, write_file, edit_file, glob, grep, execute

# Planning Agent 工具
- python_run           # ✅ 必需：数据处理
- batch_read_files     # ✅ 效率优化
- think_tool           # ✅ 记录分析
- record_result        # ✅ 记录结果

# Executor Agent 工具
- python_run           # ✅ 必需：代码执行
- batch_read_files     # ✅ 效率优化
- think_tool           # ✅ 记录分析
- record_result        # ✅ 记录结果

# Knowledge Agent 工具
- search_knowledge     # ✅ 知识检索（可选）
- extract_entities     # ⚠️ 可选：知识图谱
- query_kg             # ⚠️ 可选：知识图谱
- learn_from_doc       # ⚠️ 可选：自我学习
- duckduckgo_search    # ✅ 网络搜索
- think_tool           # ✅ 记录分析
- record_result        # ✅ 记录结果
```

### 与 Claude 对比

| Claude 工具 | 您的实现 | 状态 |
|------------|---------|------|
| `Read` | `read_file` + `batch_read_files` | ✅ 完整 |
| `Write` | `write_file` | ✅ 完整 |
| `Edit` | `edit_file` | ✅ 完整 |
| `Bash` | `execute` | ✅ 完整 |
| `Glob` | `glob` | ✅ 完整 |
| `Grep` | `grep` | ✅ 完整 |
| `LS` | `ls` | ✅ 完整 |
| `WebSearch` | `duckduckgo_search` | ✅ 完整 |
| `Think` | `think_tool` | ✅ 完整 |
| `AskUser` | `ask_user` | ✅ 完整 |

### 建议的调整

**可以移除的工具**（减少复杂度）：
- `extract_entities`：知识图谱构建可以用 `python_run` 实现
- `query_kg`：知识图谱查询可以用 `python_run` 实现
- `learn_from_doc`：自我学习可以通过 MemoryMiddleware 实现

**保留的核心工具**：
```python
# 核心工具（所有 Agent 共享）
CORE_TOOLS = [
    "python_run",           # 代码执行（最重要）
    "batch_read_files",     # 批量读取
    "think_tool",           # 思考记录
    "record_result",        # 结果记录
    "ask_user",             # 用户交互
]

# Knowledge 专用工具
KNOWLEDGE_TOOLS = CORE_TOOLS + [
    "search_knowledge",     # 知识检索
    "duckduckgo_search",    # 网络搜索
]
```

---

## 六、架构和文件夹结构检查

### 当前结构评估

```
backend/
├── api/                       # ✅ API 层
├── config/                    # ✅ 配置
├── docs/                      # ✅ 文档
├── engine/                    # ✅ 核心引擎
│   ├── agent/                 # ✅ Agent 定义
│   ├── backends/              # ✅ 文件系统后端
│   ├── core/                  # ⚠️ 只有 main_graph.py
│   ├── middleware/            # ⚠️ 只有 content_fix
│   ├── nodes/                 # ⚠️ 可能不需要
│   ├── prompts/               # ✅ 提示词
│   ├── state/                 # ✅ 状态定义
│   └── utils/                 # ✅ 工具函数
├── knowledge_base/            # ⚠️ 与根目录重复
├── memory/                    # ✅ 记忆管理
├── tools/                     # ✅ 工具注册
│   ├── base/                  # ✅ 核心工具
│   ├── internal/              # ⚠️ 可能不需要
│   ├── mcp/                   # ✅ MCP 扩展
│   └── skills/                # ⚠️ 与 knowledge_base/skills 重复
└── tmp/                       # ✅ 工作区
```

### 建议的清理

1. **移除重复**：
   - `backend/knowledge_base/` → 使用根目录的 `knowledge_base/`
   - `backend/tools/skills/` → 使用 `knowledge_base/skills/`

2. **简化结构**：
   - `engine/nodes/` → 如果只用 DeepAgent，可能不需要
   - `engine/core/` → 可以合并到 `engine/agent/`
   - `tools/internal/` → 合并到 `tools/base/`

---

## 七、核心架构完整性检查

### DeepAgent 能力使用情况

| DeepAgent 能力 | 配置位置 | 使用状态 |
|---------------|---------|---------|
| FilesystemMiddleware | `create_backend()` | ✅ 已配置 |
| SubAgentMiddleware | `create_subagent_configs()` | ✅ 已配置 |
| TodoListMiddleware | 自动 | ✅ 自动启用 |
| Skills 工具 + BUNDLE.md | registry.py 自定义注册 | ✅ 已实现 |
| project_memory | deep_agent._load_memory_content() | ✅ 已实现 |
| SummarizationMiddleware | 自动 | ✅ 自动启用 |
| Store | `langgraph.json` | ✅ 已配置 |
| Checkpointer | `langgraph.json` | ✅ 已配置 |

### 结论：核心架构已完整

**您可以开始优化工具了**，因为：
1. ✅ DeepAgent 核心能力已正确配置
2. ✅ 三个 SubAgent 分工明确
3. ✅ Skill 系统已就位
4. ✅ 知识库结构已建立
5. ✅ 提示词系统已完善

---

## 八、下一步优化建议

### 立即可做

1. **清理重复文件夹**：
   - 删除 `backend/knowledge_base/`
   - 删除 `backend/tools/skills/`
   - 删除 `knowledge_base/bidding/`（使用 `skills/bidding/`）

2. **精简工具列表**：
   - 移除 `extract_entities`、`query_kg`、`learn_from_doc`
   - 统一使用 `python_run` 实现复杂功能

3. **创建 Skill 目录结构**：
   - 按照第四节的名目创建目录
   - 每个 Skill 只需要 SKILL.md 文件

### 中期优化

1. **提示词分层加载**：
   - 基础提示词保持精简
   - 根据任务类型动态加载扩展

2. **Knowledge Agent 增强**：
   - 添加 Skill 智能路由
   - 优化知识检索效率

### 长期演进

1. **前端生成式 UI**
2. **更多业务 Skill**
3. **领域知识积累**
