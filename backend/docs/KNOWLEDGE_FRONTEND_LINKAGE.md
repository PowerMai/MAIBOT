# 知识库与前端联动说明

本文档简述知识库、本体、执行日志与前端（输入区、聊天区、展示区）的联动方式。详细设计见 [KNOWLEDGE_ARCHITECTURE.md](KNOWLEDGE_ARCHITECTURE.md)、[SKILL_DESIGN.md](SKILL_DESIGN.md)、[FOUR_MODES_DESIGN.md](FOUR_MODES_DESIGN.md)。

## 一、后端 API 摘要

| API | 用途 |
|-----|------|
| `GET /knowledge/metadata` | 各 scope 文档数、本体 entity_count/relation_count，供前端统计与本体管理入口展示 |
| `GET/POST/PUT/DELETE /knowledge/ontology/entities` | 本体实体 CRUD |
| `GET/POST /knowledge/ontology/relations`、`DELETE /knowledge/ontology/relations/{index}` | 本体关系 CRUD |
| `GET /execution-logs?thread_id=&limit=&status=` | Debug 模式拉取指定 thread 的执行日志 |
| `GET /skills/profiles` | 领域（profile）列表，驱动输入区「专业领域」与技能管理「领域」下拉 |
| `GET /skills/by-profile?profile_id=` | 按领域返回该 profile 下的 Skills 列表 |
| `POST /skills/generate-draft` | 生成 SKILL 草稿到 learned/skills/ |

## 二、前端联动行为

- **输入区**：专业领域由 `/skills/profiles` 驱动；「从知识库引用」入口（添加上下文菜单）：输入知识库路径后作为 context_items 传入本轮，后端 inject 使用。
- **聊天区**：`search_knowledge`/`query_kg` 结果差异化样式、「来自知识库」标签、「在展示区查看」按钮（派发 `open_knowledge_ref`）；顶部「执行日志」按钮打开当前 thread 的 /execution-logs 对话框，无 thread 时提示先发消息。
- **展示区**：监听 `open_knowledge_ref`，用虚拟 Tab 打开引用内容。
- **知识库面板**：scope 筛选（个人/团队/全局）、本体管理（实体与关系 CRUD）、技能 Tab（按领域列出、打开/删除、生成草稿；生成草稿可带当前 thread_id 供后端标注来源）。

## 三、数据流概览

```
用户选择领域 → config.skill_profile → 后端按 profile paths 加载 Skills
用户发送消息（含 context_items/知识库引用）→ 后端 inject 或检索
Agent 调用 search_knowledge/query_kg → 结果在消息中带引用 → 前端可「在展示区查看」
Debug 模式 → 前端请求 /execution-logs → 展示步骤与日志
```
