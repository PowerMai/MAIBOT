---
name: plan-methodology
description: 复杂任务的规划方法，先设计方案与风险，再等待确认执行。
level: modes
triggers: [规划, 方案, 风险, 步骤, 确认]
---

# Plan 方法论

## 适用场景
- 任务复杂、方案不唯一、存在重要技术取舍。
- 需要先确认范围、约束、验收标准再实施。

## 执行步骤
1. 研究（Research）：优先收集上下文，使用 `read_file`、`grep`、`glob`、`search_knowledge`、`python_run`、`shell_run` 获取事实与约束。
2. 澄清（Clarify）：补齐目标、成功标准、约束、未决项；关键歧义控制在 1-3 个问题内。
3. 方案设计（Design）：最多 3 套方案并给推荐理由；多方案场景使用对比表（收益/成本/风险/适用条件）。
4. 风险评估（Risk）：给出可能性、影响、缓解措施与回滚策略。
5. 任务分解（Plan）：形成可执行步骤，显式依赖关系与验收方式，等待用户确认后进入执行。

## 质量门
- 每一步都有可验证产出（文件/接口/测试/指标）。
- 依赖关系清晰、无循环、关键路径可解释。
- 未确认前不执行写入、安装、发布等修改动作。
- 计划须能直接转为执行输入，避免“描述性但不可执行”的步骤。

## 输出要求
- 结构化计划至少包含：`goal`、`constraints`、`steps`、`dependencies`、`verification`、`acceptance`、`risks`、`deliverables`。
- 给出 `clarification_needed`（如有）与推荐执行顺序。
- 每个 step 建议采用统一模板：`input -> action -> output -> verification`。

详细规划模板、风险矩阵、失败处理见：`knowledge_base/skills/methodology-reference.md`
