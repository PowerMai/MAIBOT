---
name: kb-schema-design
description: 为目标领域设计或扩展知识与本体 schema，保证可验证与可演进。
---

# KB Schema Design

## 核心规则
1. 先定义实体、关系、必填字段、证据字段，再允许采集入库。
2. schema 变更保持向后兼容，不直接删除已发布字段。
3. 必须包含 `source_url`、`evidence`、`confidence` 三类可追溯字段。
4. 字段命名统一蛇形命名，关系命名使用动词短语。
5. 任何破坏性变更都要给迁移策略和回滚方案。

## 推理链示范
Input: “为办公模板知识库设计 schema”
Step 1 [观察]: 读取现有 schema 与目标知识范围。
Step 2 [定位]: 标出缺失实体类型、关系类型、必填字段。
Step 3 [决策]: 选择扩展而非重写，避免影响历史数据。
Step 4 [执行]: 更新 schema 文件并补示例数据。
Step 5 [验证]: 运行 `scripts/verify_schema.py`，输出差异与兼容性结论。

## 执行步骤
- 读取目标领域已有 schema 与样本数据。
- 输出「实体-关系-字段」三层草案。
- 明确字段类型、是否必填、默认值和验证规则。
- 写入 schema 并附最小样例。
- 运行验证脚本并记录结果。

## 交付模板
- schema 路径
- 变更摘要（新增/修改/废弃）
- 兼容性影响
- 验证结果
- 回滚策略

## 验证
- 必跑：`scripts/verify_schema.py`
- 必检：字段完整性、类型一致性、兼容性说明齐全

## 端到端示例
Input:
- 目标：为“办公模板知识库”扩展 schema（不破坏旧字段）
- 基础：现有 `knowledge_base/schema/knowledge.schema.json`

工具调用序列:
1. `read_file` 读取现有 schema 与样本数据
2. `search_knowledge` 对齐领域术语与实体边界
3. `edit_file`/`write_file` 增加实体、关系、必填字段定义
4. `python_run` 执行 `scripts/verify_schema.py`
5. `verify_output` 产出兼容性与迁移报告

Output（示例）:
- 新增实体类型 4 个，关系类型 6 个
- 新增必填字段 9 个（含 `source_url/evidence/confidence`）
- 验证通过并输出 `schema_migration_notes.md`
