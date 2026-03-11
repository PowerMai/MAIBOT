# Skills 完善性审计报告

依据 Skills 完善与增强规划 与 [INDEX.md](../knowledge_base/skills/INDEX.md)、[技能体系规划.md](技能体系规划.md) 生成。

## 1. 全量 SKILL 审计表

| 路径 | name | level(fm) | domain(路径) | triggers | has_scripts | 文档引用脚本 | 缺口说明 |
|------|------|------------|--------------|----------|-------------|--------------|----------|
| bidding/SKILL.md | bidding | domain | bidding | 有 | 是 | parse_tender.py、compliance_check.py | 无 |
| pptx/SKILL.md | pptx | - | pptx | - | 是 | 有 | 无 |
| plan/SKILL.md | plan-methodology | - | plan | - | 是 | 有 | 建议补 level=modes, triggers |
| skill-creator/SKILL.md | skill-creator | - | skill-creator | - | 是 | 有 | 建议补 level, triggers |
| mcp-builder/SKILL.md | mcp-builder | - | mcp-builder | - | 是 | 有 | 建议补 level, triggers |
| xlsx/SKILL.md | xlsx | - | xlsx | - | 否 | 无 | 建议补 level, triggers |
| pdf/SKILL.md | pdf | - | pdf | - | 是 | 有 | 建议补 level, triggers |
| docx/SKILL.md | docx | - | docx | - | 是 | 有 | 建议补 level, triggers |
| self-learning/SKILL.md | self-learning | - | self-learning | - | 否 | 无 | 建议补 level, triggers |
| auto-discovery/SKILL.md | auto-discovery | - | auto-discovery | 否 | 是 | 有 | 建议补 level, triggers |
| reasoning/SKILL.md | reasoning | - | reasoning | - | 否 | 无 | 建议补 level=foundation, triggers |
| review/SKILL.md | review-methodology | - | review | - | 否 | 无 | 建议补 level=modes, triggers |
| debug/SKILL.md | debug-methodology | - | debug | - | 是 | 有 | 建议补 level=modes, triggers |
| ask/SKILL.md | ask-methodology | - | ask | - | 否 | 无 | 建议补 level=modes, triggers |
| knowledge_engineering/kb-user-ingest/SKILL.md | kb-user-ingest | - | knowledge_engineering | - | 否 | 必跑 verify_schema.py | 脚本缺失 |
| knowledge_engineering/kb-entity-extract/SKILL.md | kb-entity-extract | - | knowledge_engineering | - | 否 | 必跑 verify_entities/relations | 脚本缺失 |
| knowledge_engineering/kb-ontology-import/SKILL.md | kb-ontology-import | - | knowledge_engineering | - | 否 | 必跑 verify_schema+relations | 脚本缺失 |
| knowledge_engineering/kb-web-harvest/SKILL.md | kb-web-harvest | - | knowledge_engineering | - | 否 | - | 建议补 triggers |
| knowledge_engineering/kb-schema-design/SKILL.md | kb-schema-design | - | knowledge_engineering | - | 否 | 必跑 verify_schema | 脚本缺失 |
| knowledge_engineering/kb-gap-analysis/SKILL.md | kb-gap-analysis | - | knowledge_engineering | - | 是 | detect_gaps.py | 无 |
| knowledge_engineering/kb-quality-audit/SKILL.md | kb-quality-audit | - | knowledge_engineering | - | 否 | 必跑 audit_coverage+verify_entities | 脚本缺失 |
| self-evolution/SKILL.md | self-evolution | - | self-evolution | - | 否 | 无 | 建议补 level, triggers |

说明：level(fm) 为 frontmatter 中的 level，缺则由 registry 从路径推断；domain 由路径首段决定。

## 2. 脚本与可执行性缺口汇总

- **bidding**：已补齐 scripts/（parse_tender.py、compliance_check.py），见 SKILL.md「可用脚本」节。
- **knowledge_engineering**：kb-gap-analysis 已提供 scripts/detect_gaps.py；其余 6 个（kb-user-ingest、kb-entity-extract、kb-ontology-import、kb-web-harvest、kb-schema-design、kb-quality-audit）文档中「必跑」引用 verify_schema/verify_entities/audit_coverage 等，仓库中对应 scripts 仍缺失，采用「文档降级为建议」或后续补齐。

## 3. 审计结论与后续动作

- **Frontmatter 补齐**：为缺 level/triggers 的 SKILL 按 INDEX 与规划补全。
- **内容与指导**：多数已有「适用场景」或「何时使用」；bidding 已含五阶段与质量门；部分可补输出模板（随脚本落地补充）。
- **脚本**：阶段三实施招投标自研脚本；knowledge_engineering 采用「文档降级为建议 + 最小可用 detect_gaps 占位」或后续补齐。

本报告随实施更新。validate_skill_scripts（检查文档提及的 scripts 是否存在于 scripts/）已实现于 skill_registry.validate_skill_scripts，可供 CI 或健康检查调用。
