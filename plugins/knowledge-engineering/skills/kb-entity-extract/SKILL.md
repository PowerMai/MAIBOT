---
name: kb-entity-extract
description: Extract entities and relations from documents into structured records.
---

# KB Entity Extract

## 核心规则
1. 按段抽取，单段信息必须可追溯到 source_location。
2. 未通过 schema 校验的实体不得直接入库。
3. 同名实体需要做去重与合并策略说明。
4. 关系必须双端存在，禁止孤立关系入库。
5. 对低置信度实体打 `pending_review` 标记。

## 推理链示范
Input: “从招标文件提取实体关系”
Step 1: [观察] 划分章节与关键段落。
Step 2: [定位] 确定目标实体类型和关系类型。
Step 3: [执行] 抽取并生成结构化条目。
Step 4: [验证] 校验实体合法性与关系引用完整性。

## 执行步骤
- 读取文档并按章节/段落切分。
- 定义目标实体与关系类型清单。
- 调用 `content_extract` 与 `ontology_extract` 生成初稿。
- 执行去重合并并补全引用字段。
- 运行校验并写入结构化结果文件。

## 交付模板
- 抽取范围（文件/章节）
- 实体数量与关系数量
- 去重前后差异
- 低置信度条目清单
- 校验结果与失败原因

## 验证
- 必跑：`scripts/verify_entities.py` 与 `scripts/verify_relations.py`
- 必检：`source_location`、`confidence`、关系两端引用

## 端到端示例
Input:
- 目标：从招标文件抽取“资质要求-评分项-交付件”关系
- 数据：`uploads/tender_2026_01.pdf`

工具调用序列:
1. `read_file`/`content_extract` 进行章节切分与段落抽取
2. `ontology_extract` 抽取候选实体与关系
3. `python_run` 做同名实体去重与 ID 合并
4. `write_file` 写入 `knowledge_base/learned/entities.jsonl` 与 `relations.jsonl`
5. `verify_ontology_entity` + `scripts/verify_relations.py` 做一致性校验

Output（示例）:
- 实体 214 条（去重后 168 条），关系 302 条
- 低置信度条目 17 条（均打 `pending_review`）
- 校验失败 3 条并输出修复建议
