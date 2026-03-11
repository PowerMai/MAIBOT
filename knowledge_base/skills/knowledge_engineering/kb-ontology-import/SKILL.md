---
name: kb-ontology-import
description: Import external ontology sources and map them into local schema.
level: general
triggers: [导入本体, wikidata, LOV, OWL]
tools: [search_lov, import_owl, import_schema_org, import_from_wikidata, verify_output]
---

# KB Ontology Import

## 核心规则
1. 先小规模导入验证结构，再扩大导入范围。
2. 外部字段必须映射到本地 schema，禁止原样混入。
3. 导入后必须产出映射说明和冲突清单。
4. 外部本体必须记录版本、来源时间与许可证信息。
5. 冲突字段不自动覆盖，先进入待确认清单。

## 执行步骤
- 读取本地 schema 与目标实体范围。
- 使用 `search_lov`、`import_from_wikidata` 发现候选本体。
- 对候选本体做字段映射与命名规范转换。
- 小批量导入并抽样校验关系正确性。
- 扩量导入并输出冲突与合并建议。

## 交付模板
- 导入来源与版本
- 映射关系表（外部字段 -> 本地字段）
- 冲突清单（字段/关系/命名）
- 兼容性影响与回滚方案
- 下一轮导入建议

## 验证
- 建议：脚本就绪时使用 `run_skill_script` 执行 `scripts/verify_schema.py`、`scripts/verify_relations.py`，否则用 `python_run` 实现等价逻辑。
- 必检：映射覆盖率、冲突处理策略、许可证记录

详细推理链、端到端示例见：`knowledge_base/skills/knowledge_engineering/reference.md`
