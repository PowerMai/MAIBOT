---
name: kb-entity-extract
description: Extract entities and relations from documents into structured records.
level: general
triggers: [实体抽取, 关系抽取, 结构化入库]
tools: [read_file, content_extract, ontology_extract, write_file, verify_ontology_entity]
---

# KB Entity Extract

## 核心规则
1. 按段抽取，单段信息必须可追溯到 source_location。
2. 未通过 schema 校验的实体不得直接入库。
3. 同名实体需要做去重与合并策略说明。
4. 关系必须双端存在，禁止孤立关系入库。
5. 对低置信度实体打 `pending_review` 标记。

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
- 建议：脚本就绪时使用 `run_skill_script` 执行 `scripts/verify_entities.py`、`scripts/verify_relations.py`，否则用 `python_run` 实现等价逻辑。
- 必检：`source_location`、`confidence`、关系两端引用

详细推理链、端到端示例见：`knowledge_base/skills/knowledge_engineering/reference.md`
