# Knowledge Engineering Reference

本文件承载知识工程技能的详细推理链与长示例，`SKILL.md` 仅保留入口规则与验收门。

## 通用执行序列

1. 明确目标领域与验收标准（schema、覆盖率、追溯字段）。
2. 按 `schema -> 采集 -> 抽取 -> 验证 -> 入库 -> 缺口分析` 闭环执行。
3. 所有输出必须包含 `source_url`、`evidence`、`confidence`。
4. 结果不达标时只允许进入补采集/补抽取/补映射流程，不允许直接标记完成。

## 技能级补充说明

- `kb-schema-design`: 优先增量扩展，保留兼容与回滚策略。
- `kb-web-harvest`: 先来源分级再抓取，至少两源交叉验证同主题结论。
- `kb-ontology-import`: 外部字段必须映射本地 schema，冲突进入待确认清单。
- `kb-entity-extract`: 关系两端必须可解析到实体 ID，低置信度打 `pending_review`。
- `kb-user-ingest`: 用户资料用于风格模板，不覆盖行业事实知识。
- `kb-quality-audit`: 输出 blocker/warning/info 分级和对应修复任务。
- `kb-gap-analysis`: 缺口必须量化并可直接转任务（task_type/priority/owner）。

## 推荐脚本链路

1. `scripts/verify_schema.py`
2. `scripts/verify_entities.py`
3. `scripts/verify_relations.py`
4. `scripts/audit_coverage.py`
5. `scripts/detect_gaps.py`
