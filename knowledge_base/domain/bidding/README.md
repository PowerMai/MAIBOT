# 招投标领域知识库

本目录为招投标场景的结构化知识，供 Agent 通过 `search_knowledge` 或 `read_file` 检索。与 `knowledge_base/domain/procurement/` 互补，侧重法规摘要、评标标准、废标条款与行业方案模板。

## 目录结构

| 路径 | 内容 |
|------|------|
| `regulations/` | 招投标法规摘要（招标投标法、政府采购法、实施条例要点） |
| `scoring/` | 评标标准（综合评分法、最低价法、性价比法） |
| `disqualification/` | 常见废标条款与检查要点 |
| `templates/` | 行业解决方案模板（IT、建筑、咨询等方案框架） |

## 使用建议

- 检索：`search_knowledge("评分办法 废标条款 招标法规 技术方案模板")` 可命中本目录及 domain/procurement 内容。
- 与 SKILL 配合：执行指引见 `knowledge_base/skills/marketing/bidding/BUNDLE.md`。
