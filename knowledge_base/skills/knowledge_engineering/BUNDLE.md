# Knowledge Engineering Bundle

该能力包聚合知识工程闭环所需的 7 个核心技能：

1. `kb-schema-design`
2. `kb-web-harvest`
3. `kb-ontology-import`
4. `kb-entity-extract`
5. `kb-user-ingest`
6. `kb-quality-audit`
7. `kb-gap-analysis`

执行建议顺序：

1. 先做 schema 设计与本体映射；
2. 再进行互联网采集与实体关系抽取；
3. 用户资料摄入用于风格/模板学习；
4. 最后跑质量审计与缺口分析，驱动下一轮任务。
# 知识工程能力速查

用途：为知识工程师提供“采集-抽取-验证-入库-补缺”闭环。

## 任务入口

| 用户意图 | 使用 Skill |
| --- | --- |
| 设计领域 schema / 扩展本体 | `kb-schema-design` |
| 批量采集互联网知识 | `kb-web-harvest` |
| 导入公开本体（LOV/Wikidata/OWL） | `kb-ontology-import` |
| 文档抽取实体关系 | `kb-entity-extract` |
| 摄入用户文档风格模板 | `kb-user-ingest` |
| 知识质量审计 | `kb-quality-audit` |
| 发现缺口并生成补齐建议 | `kb-gap-analysis` |

## 标准流程

1. `kb-schema-design`：先明确实体类型、关系类型和必填字段。
2. `kb-web-harvest` + `kb-ontology-import`：采集互联网来源与外部本体。
3. `kb-entity-extract`：结构化抽取并写入候选数据。
4. `kb-user-ingest`：叠加用户资料中的格式风格偏好。
5. `kb-quality-audit`：执行验证脚本和覆盖率审计。
6. `kb-gap-analysis`：输出缺口报告并创建后续任务。

## 质量门

- 每条知识必须有 `source_url`、`evidence`、`confidence`。
- 本体实体必须通过 `verify_ontology_entity` 或 `verify_entities.py`。
- 输出中必须包含下一轮可执行动作（补采集、补抽取、补映射）。
