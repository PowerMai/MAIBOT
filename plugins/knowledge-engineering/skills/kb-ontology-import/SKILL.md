---
name: kb-ontology-import
description: Import external ontology sources and map them into local schema.
---

# KB Ontology Import

## 核心规则
1. 先小规模导入验证结构，再扩大导入范围。
2. 外部字段必须映射到本地 schema，禁止原样混入。
3. 导入后必须产出映射说明和冲突清单。
4. 外部本体必须记录版本、来源时间与许可证信息。
5. 冲突字段不自动覆盖，先进入待确认清单。

## 推理链示范
Input: “导入政府采购相关本体”
Step 1: [观察] 确认本地 schema 目标实体。
Step 2: [定位] 搜索 LOV/Wikidata 候选。
Step 3: [执行] 导入并转换为本地可用格式。
Step 4: [验证] 检查映射完整性和字段冲突。

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
- 必跑：`scripts/verify_schema.py` + `scripts/verify_relations.py`
- 必检：映射覆盖率、冲突处理策略、许可证记录

## 端到端示例
Input:
- 目标：导入政府采购相关外部本体并映射本地 schema
- 来源：Wikidata + LOV 候选集

工具调用序列:
1. `search_lov` 检索候选词表与类定义
2. `import_from_wikidata` 拉取实体与关系定义
3. `python_run` 生成字段映射表并转换命名规范
4. `verify_output` 校验映射覆盖率与冲突字段
5. `python_run` 执行 `scripts/verify_schema.py` / `scripts/verify_relations.py`

Output（示例）:
- 导入候选 3 份，本地映射覆盖率 91%
- 冲突字段 12 个（均进入待确认清单）
- 生成 `ontology_mapping_report.json` 与回滚步骤说明
