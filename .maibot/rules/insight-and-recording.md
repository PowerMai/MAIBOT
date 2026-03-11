# 洞察与记录（如何记录、如何查询）

与系统提示词中的 `<insight_and_recording>` 对齐，供用户项目定制。

## 如何记录

- 项目记忆：`.maibot/MAIBOT.md`
- 规则与洞察：`.maibot/rules/{{topic}}.md`
- 学习产出：`knowledge_base/learned/` 或 `data/ontology`
- 执行过程：由 execution_logger 写入，Agent 不直接写

## 如何查询

- 理解当前项目：先读 `.maibot/MAIBOT.md`，再按需读 `.maibot/rules/*.md`
- 领域知识：`search_knowledge` + `knowledge_base` 索引
- 历史运行：按 thread_id 查 execution_logs 或 checkpoint
