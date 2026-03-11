# Skills 目录索引

本目录为数字员工技能体系中的**内置 Skills** 根目录，与 `plugins/sales/skills/`（招投标能力包）、`backend/config/skills_market.json`（市场）共同构成三源。

- **分层与角色映射**：见项目根目录 [docs/数字员工技能体系.md](../../docs/数字员工技能体系.md)。
- **市场与规划**：见 [docs/技能体系规划.md](../../docs/技能体系规划.md)。
- **与 Claude 对齐说明**：见 [docs/skills_claude_alignment.md](../../docs/skills_claude_alignment.md)。

当前内置技能按 L1–L5 归类：L1（reasoning、ask）、L2（plan、debug、review、self-learning、self-evolution、auto-discovery）、L3（pdf、docx、xlsx、pptx）、L4（skill-creator、mcp-builder、knowledge_engineering 下 7 个）、L5（bidding）。

**方法论类技能 name 与目录约定**：模式方法论技能目录名为 `ask/`、`plan/`、`review/`、`debug/`，frontmatter 的 `name` 保留为 `ask-methodology`、`plan-methodology`、`review-methodology`、`debug-methodology`，以便与文档和 mode_config 推荐一致；validate_skills 的「name 与目录名不匹配」警告可忽略。
