# 自动生成 Skills 草稿目录

此目录用于存放**自动生成的 SKILL 草稿**，供 Agent 按 skill_profile 加载（如招投标场景会加载本目录）。

## 来源

- **任务学习**：从成功执行的任务中归纳出的固定流程，生成 SKILL.md 草稿。
- **知识学习**：`KnowledgeLearner.scan_and_learn()` 等产出的领域技能。
- **用户指令**：如「把刚才的流程存成技能」时，由后端解析最近步骤生成的占位 SKILL。

## 规范

- 每个技能一个子目录，内含 `SKILL.md`（格式见 [SKILL_DESIGN.md](../../backend/docs/SKILL_DESIGN.md)）。
- 草稿可由用户或后续编辑完善后，再迁入 `knowledge_base/skills/` 对应领域目录正式使用。

## 与 skill_profiles 的关系

- `backend/config/skill_profiles.json` 中部分 profile（如 `bidding`）的 `paths` 包含 `knowledge_base/learned/skills/`。
- 本目录中的 SKILL 会与 `knowledge_base/skills/` 一起被 list_skills/match_skills 发现并内联到能力速查。
