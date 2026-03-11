---
name: kb-schema-design
description: 为目标领域设计或扩展知识与本体 schema，保证可验证与可演进。
level: general
triggers: [schema设计, 本体扩展, 知识模型, 字段规范]
tools: [read_file, write_file, edit_file, search_knowledge, verify_output, python_run]
---

# KB Schema Design

## 核心规则
1. 先定义实体、关系、必填字段、证据字段，再允许采集入库。
2. schema 变更保持向后兼容，不直接删除已发布字段。
3. 必须包含 `source_url`、`evidence`、`confidence` 三类可追溯字段。
4. 字段命名统一蛇形命名，关系命名使用动词短语。
5. 任何破坏性变更都要给迁移策略和回滚方案。

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
- 建议：脚本就绪时使用 `run_skill_script` 执行 `scripts/verify_schema.py`，否则用 `python_run` 实现等价逻辑。
- 必检：字段完整性、类型一致性、兼容性说明齐全

详细推理链、端到端示例见：`knowledge_base/skills/knowledge_engineering/reference.md`
