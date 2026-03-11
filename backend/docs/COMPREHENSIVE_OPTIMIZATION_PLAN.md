# 全面优化方案 - 基于 Claude 架构

## 一、当前 Graph 架构评估

### 1.1 当前架构

```
┌─────────────────────────────────────────────────────────────┐
│                      Main Graph                              │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  router_node (信息提取)                                      │
│       ↓                                                     │
│  route_decision() (路由决策)                                 │
│       ├─ "chatarea" → deepagent (Subgraph)                  │
│       ├─ "editor + complex" → deepagent                     │
│       ├─ "editor + tool_command" → editor_tool_node         │
│       └─ "system + file_sync" → editor_tool_node            │
│       ↓                                                     │
│      END                                                    │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 评估结论：**架构合理**

| 方面 | 评估 | 说明 |
|------|------|------|
| **分流设计** | ✅ 合理 | 对话给 DeepAgent，快速工具直接执行 |
| **DeepAgent 作为 Subgraph** | ✅ 正确 | 符合 LangGraph 官方模式 |
| **editor_tool_node** | ✅ 合理 | 无 LLM 调用，快速响应 |
| **路由逻辑** | ✅ 清晰 | 基于 source + request_type |

### 1.3 与 Claude 对比

Claude 的架构：
- **单一 Agent** + **多工具** 模式
- 没有显式的 router，而是 Agent 内部决策
- 快速工具通过 "strict tool use" 保证

您的架构：
- **Router + DeepAgent Subgraph** 模式
- 显式分流，减少不必要的 LLM 调用
- **这是更优的设计**（减少 token 消耗）

**结论：保持当前架构，无需修改**

---

## 二、未正确使用的函数检查

### 2.1 learning_middleware.py 中的函数

| 函数 | 是否使用 | 使用位置 |
|------|---------|---------|
| `get_learning_context_for_prompt()` | ✅ 已使用 | `main_graph.py` deepagent_node |
| `learn_from_success()` | ⚠️ 未使用 | 应在执行成功后调用 |
| `learn_from_failure()` | ⚠️ 未使用 | 应在执行失败后调用 |
| `feedback_knowledge()` | ⚠️ 未使用 | 应在用户反馈后调用 |
| `apply_decay()` | ⚠️ 未使用 | 应定期调用 |

### 2.2 建议：在 DeepAgent 执行后添加学习回调

```python
# 在 deepagent_node 中添加
async def deepagent_node(state, config=None):
    # ... 现有代码 ...
    
    # 执行完成后学习
    try:
        from backend.tools.base.learning_middleware import (
            learn_from_success, 
            learn_from_failure
        )
        
        # 判断执行结果
        if final_state and final_state.get("success", True):
            learn_from_success(
                task=query,
                steps=final_state.get("steps", []),
                result=final_state.get("output", "")
            )
        else:
            learn_from_failure(
                task=query,
                error=final_state.get("error", "Unknown error")
            )
    except Exception as e:
        logger.warning(f"学习回调失败: {e}")
```

---

## 三、知识库文件夹结构设计

### 3.1 当前问题

```
当前结构存在重叠：
- knowledge_base/skills/bidding/SKILL.md  (Skill 定义)
- knowledge_base/global/domain/bidding/02_operations/  (操作指南)
```

**问题**：`02_operations/` 中的内容与 SKILL.md 中的 workflow 重复

### 3.2 建议的结构（Claude 风格）

```
knowledge_base/
│
├── skills/                    # Skills 工具 + BUNDLE.md 内联（方法论）
│   └── [domain]/              # 领域
│       └── [skill]/           # 技能
│           └── SKILL.md       # 只包含：触发条件、工作流程、检查清单
│
└── domain/                    # Knowledge Agent 检索（详细知识）
    └── [domain]/              # 领域
        ├── concepts/          # 概念定义（替代 basics）
        ├── references/        # 参考资料（模板、案例、规则）
        └── data/              # 数据文件（可选）
```

### 3.3 职责划分

| 层级 | 位置 | 内容 | 加载方式 |
|------|------|------|---------|
| **Skill** | `skills/[domain]/[skill]/SKILL.md` | 工作流程、检查清单、触发条件 | Skills 工具 + BUNDLE.md 内联 |
| **Concepts** | `domain/[domain]/concepts/` | 术语定义、基础概念 | read_file 按需读取 |
| **References** | `domain/[domain]/references/` | 模板、案例、规则 | search_knowledge 检索 |

### 3.4 招投标领域示例

```
knowledge_base/
├── skills/
│   └── procurement/           # 采购领域
│       ├── bidding_analysis/  # 招标分析 Skill
│       │   └── SKILL.md       # 工作流程：分析招标文件
│       ├── proposal_writing/  # 投标撰写 Skill
│       │   └── SKILL.md       # 工作流程：撰写投标文件
│       └── contract_review/   # 合同审查 Skill
│           └── SKILL.md       # 工作流程：审查合同
│
└── domain/
    └── procurement/           # 采购领域知识
        ├── concepts/          # 概念
        │   ├── terminology.md # 招投标术语
        │   ├── process.md     # 招投标流程
        │   └── regulations.md # 法规要求
        └── references/        # 参考
            ├── templates/     # 模板
            ├── cases/         # 案例
            └── rules/         # 规则
```

---

## 四、Claude MCP 工具对照

### 4.1 Claude 官方 MCP 工具

| MCP Server | 功能 | 您的实现 | 状态 |
|------------|------|---------|------|
| **filesystem** | 文件读写 | DeepAgent FilesystemMiddleware | ✅ 已有 |
| **brave-search** | 网络搜索 | duckduckgo_search | ✅ 等效 |
| **memory** | 长期记忆 | LangGraph Store + MemoryMiddleware | ✅ 已有 |
| **puppeteer** | 网页自动化 | ❌ 缺失 | 可选 |
| **sqlite** | 数据库操作 | python_run 可实现 | ✅ 等效 |
| **slack/github** | 集成服务 | ❌ 缺失 | 可选 |

### 4.2 需要补充的工具

```python
# 建议添加到 registry.py

# 1. 网页自动化（可选，用于爬取招标网站）
# 使用 MCP puppeteer 或 playwright

# 2. 数据库操作（增强版）
# 当前 python_run 可以实现，但可以添加专用工具

# 3. 图表生成（增强版）
# 当前 python_run + matplotlib 可以实现
```

### 4.3 Claude 工具使用方式对照

| Claude 用法 | 您的实现 |
|------------|---------|
| `Read file` | `read_file` (DeepAgent) |
| `Write file` | `write_file` (DeepAgent) |
| `Edit file` | `edit_file` (DeepAgent) |
| `Bash command` | `execute` (DeepAgent) |
| `Search files` | `glob` + `grep` (DeepAgent) |
| `Web search` | `duckduckgo_search` |
| `Think` | `think_tool` |
| `Ask user` | `ask_user` |
| `Python` | `python_run` |

**结论：工具集已与 Claude 基本一致**

---

## 五、分层 Skill 体系设计

### 5.1 层级架构（人类社会运转方式）

```
┌─────────────────────────────────────────────────────────────┐
│                    Skill 层级体系                           │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Level 0: 基础能力 (Foundation)                             │
│  ├── 文件处理 (file_handling)                               │
│  ├── 数据操作 (data_operations)                             │
│  └── 系统交互 (system_interaction)                          │
│                                                             │
│  Level 1: 通用能力 (General)                                │
│  ├── 文本分析 (text_analysis)                               │
│  ├── 数据分析 (data_analysis)                               │
│  ├── 文档生成 (document_generation)                         │
│  └── 信息检索 (information_retrieval)                       │
│                                                             │
│  Level 2: 领域能力 (Domain)                                 │
│  ├── 教育 (education)                                       │
│  │   ├── 学习辅助 (learning_assistant)                      │
│  │   ├── 教学支持 (teaching_support)                        │
│  │   └── 评估反馈 (assessment_feedback)                     │
│  ├── 制造 (manufacturing)                                   │
│  │   ├── 生产管理 (production_management)                   │
│  │   ├── 质量控制 (quality_control)                         │
│  │   └── 设备维护 (equipment_maintenance)                   │
│  ├── 管理 (management)                                      │
│  │   ├── 战略规划 (strategic_planning)                      │
│  │   ├── 运营管理 (operations_management)                   │
│  │   └── 人力资源 (human_resources)                         │
│  ├── 市场营销 (marketing)                                   │
│  │   ├── 招投标 (bidding)                                   │
│  │   ├── 销售支持 (sales_support)                           │
│  │   └── 客户关系 (customer_relations)                      │
│  ├── 财务 (finance)                                         │
│  │   ├── 预算管理 (budget_management)                       │
│  │   ├── 成本分析 (cost_analysis)                           │
│  │   └── 财务报告 (financial_reporting)                     │
│  └── 法务 (legal)                                           │
│      ├── 合同管理 (contract_management)                     │
│      ├── 合规审查 (compliance_review)                       │
│      └── 风险评估 (risk_assessment)                         │
│                                                             │
│  Level 3: 复合能力 (Complex)                                │
│  ├── 跨部门协作 (cross_department)                          │
│  ├── 项目管理 (project_management)                          │
│  └── 决策支持 (decision_support)                            │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 5.2 目录结构

```
knowledge_base/skills/
│
├── foundation/                # Level 0: 基础能力
│   ├── file_handling/
│   ├── data_operations/
│   └── system_interaction/
│
├── general/                   # Level 1: 通用能力
│   ├── text_analysis/
│   ├── data_analysis/
│   ├── document_generation/
│   └── information_retrieval/
│
├── education/                 # Level 2: 教育领域
│   ├── learning_assistant/
│   ├── teaching_support/
│   └── assessment_feedback/
│
├── manufacturing/             # Level 2: 制造领域
│   ├── production_management/
│   ├── quality_control/
│   └── equipment_maintenance/
│
├── management/                # Level 2: 管理领域
│   ├── strategic_planning/
│   ├── operations_management/
│   └── human_resources/
│
├── marketing/                 # Level 2: 市场营销领域
│   ├── bidding/               # 招投标
│   ├── sales_support/
│   └── customer_relations/
│
├── finance/                   # Level 2: 财务领域
│   ├── budget_management/
│   ├── cost_analysis/
│   └── financial_reporting/
│
├── legal/                     # Level 2: 法务领域
│   ├── contract_management/
│   ├── compliance_review/
│   └── risk_assessment/
│
└── complex/                   # Level 3: 复合能力
    ├── cross_department/
    ├── project_management/
    └── decision_support/
```

---

## 六、上下文信息密度优化

### 6.1 当前问题

- 提示词信息密度不够高
- 缺少有效性优化
- 上下文中存在冗余信息

### 6.2 优化策略（Claude 风格）

#### 策略 1：分层加载

```
基础层（始终加载）：
├── 角色定义（20 tokens）
├── 核心约束（30 tokens）
└── 输出格式（20 tokens）

任务层（按需加载）：
├── 任务类型特定指南（100-200 tokens）
└── 相关 Skill 摘要（50-100 tokens）

上下文层（动态注入）：
├── 学习上下文（50-100 tokens）
├── 文件上下文（路径，非内容）
└── 历史上下文（摘要，非原文）
```

#### 策略 2：信息压缩

```
原始（低密度）：
"请你分析这个招标文件，找出其中的技术要求、商务条款、评分标准，
并识别可能存在的风险点，最后给出投标建议。"

优化（高密度）：
"分析招标文件：
- 提取：技术要求、商务条款、评分标准
- 识别：风险点
- 输出：投标建议"
```

#### 策略 3：结构化上下文

```json
{
  "task": "招标文件分析",
  "input": {"file": "招标文件.pdf", "type": "招标公告"},
  "focus": ["技术要求", "评分标准", "资格条件"],
  "output": {"format": "分析报告", "sections": ["摘要", "风险", "建议"]}
}
```

---

## 七、执行计划

### Phase 1：立即执行（今天）

1. ✅ 确认 Graph 架构合理
2. 重组知识库目录结构
3. 创建高质量 Skill 模板
4. 创建招投标专业示例

### Phase 2：短期（本周）

1. 补充学习回调函数
2. 优化提示词信息密度
3. 完善 Skill 目录结构

### Phase 3：中期（下周）

1. 添加更多领域 Skill
2. 优化上下文管理
3. 前端生成式 UI
