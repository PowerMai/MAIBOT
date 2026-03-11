---
name: reasoning
description: 结构化推理技能：假设验证、问题分解、方案对比与证据化结论。
level: foundation
triggers: [推理, 假设, 验证, 证据, 决策]
---

# Reasoning 方法论

## 适用场景
- 需要逻辑推理、证据链分析或复杂决策比较。
- 任务包含多步推导与关键分叉判断。

## 推理框架
1. 假设-验证：提出 2+ 假设并逐项验证。
2. 分解法：目标→约束→子问题→依赖→风险。
3. 对比法：统一维度比较多个方案并给推荐。

## 证据规则
- 每个结论至少绑定 1 条直接证据。
- 证据冲突时输出冲突报告，不强行得结论。
- `confidence=low` 时必须给后续验证步骤。

## 输出结构
- `conclusion`
- `confidence`
- `evidence`
- `alternatives_ruled_out`
- `next_steps`

## 质量门
- 置信度与证据强度一致（弱证据不得 high）。
- 至少说明一个被排除方案及理由。
- 下一步动作必须可执行、可验证。

详细 JSON 模板、证据分级、失败处理见：`knowledge_base/skills/methodology-reference.md`
