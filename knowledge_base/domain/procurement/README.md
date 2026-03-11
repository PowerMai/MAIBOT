# 招投标领域知识库（结构化）

本目录为招投标场景的**结构化知识**，供 Agent 通过 `search_knowledge` 或 `read_file` 检索使用。与 `knowledge_base/global/domain/bidding/`（原始资料、PDF 等）互补。

## 目录结构

| 路径 | 内容 |
|------|------|
| `bidding_guide.md` | 招投标文件处理指南、关键要素、投标建议、常见风险与技巧 |
| `chapter_scoring_mapping.md` | 章节与评分映射 |
| `concepts/` | 概念与术语 |
| `concepts/bidding_process.md` | 招投标流程 |
| `concepts/key_terminology.md` | 关键术语 |
| `concepts/project_types.md` | 项目类型 |
| `references/` | 参考材料 |
| `references/cases/` | 成功/失败案例（success_case_*.md, failure_case_*.md） |
| `references/rules/` | 合规、资格、评分、提交等规则（compliance_rules, qualification_rules, scoring_rules, submission_rules） |
| `references/templates/` | 分析报告、成本、标书大纲、报告模板、需求清单、风险矩阵等模板 |
| `references/commercial_terms.md` | 商务条款 |
| `references/communication.md` | 沟通要点 |
| `references/pricing_strategy.md` | 报价策略 |
| `references/technical_proposals.md` | 技术方案要点 |

## 使用建议

- **检索**：`search_knowledge("评分办法 废标条款 响应矩阵 技术方案 报价策略")` 可命中本目录及 global 下索引内容。
- **按需读取**：需要完整模板或规则时，直接 `read_file("knowledge_base/domain/procurement/references/templates/xxx.md")` 等。
- **与 SKILL 配合**：执行指引与输出规范见 `knowledge_base/skills/marketing/bidding/BUNDLE.md` 及各子能力 SKILL.md。
