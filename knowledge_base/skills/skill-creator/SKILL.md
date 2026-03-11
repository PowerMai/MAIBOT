---
name: skill-creator
description: 设计与产出高质量 Skill，确保触发条件、流程和验收门清晰。
level: general
triggers: [技能, 创建, SKILL, 规范]
---

# Skill Creator

## 目标
- 用统一规范创建可执行、可维护的技能资产。
- 避免技能重叠、无验收标准、不可复用。

## 执行步骤
1. 明确技能边界：场景、输入输出、依赖工具。
2. 编写 `SKILL.md`：触发条件、执行步骤、质量门。
3. 补充 `reference.md`：长示例、异常处理、模板。
4. 验证技能与现有技能不冲突并可被匹配。

## 质量门
- 必须有清晰触发条件与禁止项。
- 必须有可执行验收标准与失败回退策略。
- 文档精简：`SKILL.md` 负责入口，细节下沉 `reference.md`。

详细规范见：`knowledge_base/skills/integration-reference.md`
