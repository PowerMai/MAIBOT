# SKILL.md 设计规范

## 一、Skills 加载机制（本项目自定义，DeepAgent 无 SkillsMiddleware）

### 加载流程

```
┌─────────────────────────────────────────────────────────────┐
│              Skills 工具 + BUNDLE.md 内联                    │
├─────────────────────────────────────────────────────────────┤
│ 1. BUNDLE.md 按 skill_profile 内联到系统提示词（能力速查）   │
│ 2. list_skills/match_skills/get_skill_info 工具按需发现      │
│ 3. read_file("...SKILL.md") 按需加载详细内容                 │
│ 4. SkillRegistry 提供查询/匹配功能                           │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                    系统提示词注入内容                         │
├─────────────────────────────────────────────────────────────┤
│ **Available Skills:**                                        │
│ - **bidding-analysis**: 招标文件分析与投标策略制定           │
│   -> Read `/knowledge_base/skills/bidding/SKILL.md`          │
│ - **contract-review**: 合同审查与风险分析                    │
│   -> Read `/knowledge_base/skills/contracts/SKILL.md`        │
└─────────────────────────────────────────────────────────────┘
```

### Progressive Disclosure（渐进式披露）

**关键概念**：Agent 只看到技能的 `name` 和 `description`，需要时才 `read_file` 获取完整内容

```
用户: "分析这份招标文件"
    ↓
Agent 看到: bidding-analysis - 招标文件分析与投标策略制定
    ↓
Agent 决定: read_file("/knowledge_base/skills/bidding/SKILL.md")
    ↓
Agent 获取: 完整的工作流程、输出格式、使用示例
    ↓
Agent 执行: 按照 SKILL.md 中的流程执行任务
```

### 配置位置

```python
# backend/engine/agent/deep_agent.py

# 1. Skills 路径配置
skills_paths = [
    "/knowledge_base/skills/bidding/",      # 招标分析技能
    "/knowledge_base/skills/contracts/",    # 合同审查技能
    "/knowledge_base/skills/reports/",      # 报告撰写技能
]

# 2. CompositeBackend 路由配置
# /knowledge_base/ 路由到 PROJECT_ROOT/knowledge_base/
routes = {
    "/knowledge_base/": knowledge_backend,  # 知识库后端
    "/memories/": store_backend,            # 持久化记忆
}
```

### 路径映射

```
skills_paths 中的路径          →  实际文件系统路径
/knowledge_base/skills/bidding/  →  PROJECT_ROOT/knowledge_base/skills/bidding/
/knowledge_base/skills/contracts/ → PROJECT_ROOT/knowledge_base/skills/contracts/
```

## 二、SKILL.md 的正确定位

### 定义
**SKILL = 工作方法 + 步骤说明 + 领域知识**

SKILL.md 是一个模块化的能力包，包含：
- 何时使用（触发条件）
- 如何使用（工作流程）
- 使用示例（输入→输出）
- 领域专业知识

### 格式要求（Agent Skills 规范）

| 字段 | 要求 | 说明 |
|------|------|------|
| `name` | 必须，≤64字符 | 小写字母+连字符，建议与目录名一致；例外见下条 |
| `description` | 必须，≤1024字符 | 技能描述，用于 Agent 判断是否使用 |
| `version` | 可选 | 版本号 |
| `triggers` | 可选 | 触发关键词列表 |
| `tools` | 可选 | 推荐使用的工具 |

**方法论类技能例外**：模式方法论技能目录为 `ask/`、`plan/`、`review/`、`debug/`，frontmatter 的 `name` 保留为 `ask-methodology`、`plan-methodology` 等，与文档和 mode_config 推荐一致；validate_skills 的「name 与目录名不匹配」可忽略。详见 `knowledge_base/skills/INDEX.md`。

**正文与引用**（与 Agent Skills 规范一致）：推荐 SKILL 正文不超过 500 行（约 5000 tokens），便于启动时渐进式披露；详细参考、表单、长说明可放在 `references/` 下，在正文中用相对路径引用（如 `references/REFERENCE.md`），引用深度建议一层。`compatibility` 可选字段用于说明环境要求（目标产品、系统依赖、网络等），仅在有明确要求时填写。

### 与知识库的区别

| 内容类型 | 放在 SKILL.md | 放在知识库 |
|---------|--------------|-----------|
| 工作流程 | ✅ | ❌ |
| 操作步骤 | ✅ | ❌ |
| 使用示例 | ✅ | ❌ |
| 输出格式 | ✅ | ❌ |
| 术语定义 | ❌ | ✅ |
| 背景资料 | ❌ | ✅ |
| 参考文档 | ❌ | ✅ |
| 案例研究 | ❌ | ✅ |

### 与提示词的关系

**提示词应该引用 SKILL.md，而不是重复其内容**

```
提示词（通用）
    ↓
Skills 工具 + BUNDLE.md 内联技能列表
    ↓
Agent read_file 获取 SKILL.md（领域专业）
    ↓
调用知识库（纯知识）
```

## 三、SKILL.md 结构规范

### 目录结构

```
knowledge_base/skills/           # ← skills_paths 指向这里
├── bidding/                     # 目录名 = skill name
│   ├── SKILL.md                 # 必须，技能定义
│   ├── examples/                # 可选，示例文件
│   └── templates/               # 可选，输出模板
├── contracts/
│   └── SKILL.md
└── reports/
    └── SKILL.md
```

### SKILL.md 格式

```markdown
---
name: bidding-analysis
description: 招标文件分析与投标策略制定
version: "1.0"
triggers: [招标, 投标, 评分, 资质]
tools: [read_file, python_run, write_file]
---

# 招标文件分析技能

## 何时使用
- 用户上传招标文件
- 用户询问投标相关问题
- 关键词：招标、投标、评分、资质、废标

## 工作流程

### Phase 1: 文档解析
1. read_file 读取招标文件
2. 识别文档结构（目录、章节）
3. 定位关键章节位置

### Phase 2: 信息提取
1. 提取项目基本信息
2. 提取资格要求
3. 提取评分标准
4. 提取技术要求

### Phase 3: 分析评估
1. 符合性分析
2. 风险识别
3. 得分策略

### Phase 4: 输出生成
1. 生成分析报告
2. 生成对比表格
3. 生成建议清单

## 输出格式

### 项目信息
```json
{
  "name": "项目名称",
  "number": "项目编号",
  "budget": {"amount": 500, "unit": "万元"},
  "deadline": "2025-02-15"
}
```

### 评分标准
```json
{
  "total": 100,
  "sections": [
    {"name": "技术", "weight": 60},
    {"name": "商务", "weight": 30},
    {"name": "价格", "weight": 10}
  ]
}
```

## 使用示例

### 输入
"请分析这份招标文件，提取评分标准"

### 输出
1. 评分标准对比表格（Markdown）
2. 得分策略建议
3. 风险提示

## 注意事项
- 所有结论必须有证据（原文引用）
- 废标条件需要特别标注
- 评分规则需要完整提取
```

## 四、知识库重新定位

### 知识库只保留纯知识

```
knowledge_base/
├── bidding/
│   ├── glossary.md           # 术语定义
│   ├── regulations.md        # 法规政策
│   ├── industry_standards.md # 行业标准
│   └── case_studies/         # 案例研究
├── contracts/
│   └── ...
└── reports/
    └── ...
```

### 知识库内容示例

```markdown
# 招标术语表

## 废标
指投标文件因不符合招标文件要求而被否决的情况。

常见废标原因：
- 未按要求密封
- 未提供有效资质证明
- 报价超出预算
- ...

## 综合评分法
一种评标方法，综合考虑技术、商务、价格等因素...
```

## 五、提示词简化

### 当前问题
提示词中包含了大量应该在 SKILL.md 中的内容

### 改进方案
提示词只定义：
- Agent 角色
- 通用工作流程
- 工具使用原则
- 输出质量要求

领域专业内容由 SKILL.md 提供

### 简化后的提示词示例

```python
PLANNING_PROMPT = """# Planning Agent

## 角色
分析任务，制定执行计划。

## 工作流程
1. 理解任务目标
2. 识别所需技能（系统自动加载相关 SKILL.md）
3. 规划执行步骤
4. 输出 JSON 计划

## 输出格式
{
  "goal": "目标",
  "skill": "所需技能",
  "steps": [...]
}

## 原则
- 快速规划，详细执行交给 Executor
- 利用 SKILL.md 中的工作流程
"""
```

## 六、实施计划

### Step 1: 重构 SKILL.md
- 将操作指南内容移入 SKILL.md
- 精简为标准格式
- 添加工作流程和示例

### Step 2: 精简知识库
- 移除操作说明
- 只保留纯知识内容
- 重新组织目录结构

### Step 3: 简化提示词
- 移除与 SKILL.md 重复的内容
- 只保留通用规则
- 添加对 SKILL.md 的引用

### Step 4: 测试验证
- 验证 Skills 工具和 BUNDLE.md 正确加载
- 验证工作流程执行
- 验证输出质量

## 七、总结

| 组件 | 职责 | 内容 |
|------|------|------|
| **SKILL.md** | 工作方法 | 流程、步骤、示例、格式 |
| **知识库** | 纯知识 | 术语、法规、案例 |
| **提示词** | 通用规则 | 角色、原则、质量要求 |

## 八、技能管理 API 与前端

- **按 profile 列表**：`GET /skills/profiles` 返回所有可用业务场景（id、label、description）；`GET /skills/by-profile?profile_id=xxx` 返回该 profile 的 paths 所覆盖的 Skills 列表（含 path、kb_relative_path 供打开/删除）。
- **技能管理页**：前端知识库面板「技能」Tab：领域下拉由 profiles API 驱动，列出当前领域下的 Skills，支持「打开」（读文件并在展示区编辑）、「删除」（调用知识库删除接口）。
- **自动生成草稿**：`POST /skills/generate-draft` 接受 name、description、steps_summary、thread_id，在 `knowledge_base/learned/skills/{name}/SKILL.md` 写入占位草稿，供用户完善后迁入 `knowledge_base/skills/`。前端「生成草稿」入口在技能 Tab 内，填写名称与描述即可生成。
