# 本体 / 知识图谱

- **schema.json**：根 schema（默认）；领域 schema 放在 `domain/{领域}/schema.json`（如 `domain/bidding/schema.json`）。
- **entities.json / relations.json**：当前实体与关系数据（与 knowledge_api 兼容）。
- **backups/**：每次保存前自动备份，保留最近 10 份。
- **changelog.md**：变更日志。

Schema-Driven 提取：知识管理师或 API 指定 `domain` 时，`EntityRelationExtractor.extract_with_llm(..., domain="bidding")` 会加载对应 schema 并注入 LLM 提示词，提取结果中未在 schema 内的类型会标记为待审核。

**导入与聚焦**：优先导入与当前 domain 直接相关的本体；entities/relations 可能含 web_cache 等来源的宽泛或无关类型（如通用 requirement、非招标文本片段），导入或使用时按 domain 过滤、仅保留 schema 内 entity_types/relation_types，可减少污染并保持本体聚焦。
