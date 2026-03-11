# 文档与版本管理约定

本文档约定「每次执行更新文档」的机制、编辑文件版本管理及用户级版本的策略，便于实现「好记性不如烂笔头」与可回退体验。

---

## 一、每次执行更新文档（Agent 机制）

### 1.1 职责归属

- **LLM**：能按指令产出或改写文档内容，但**不会自动持久化**到仓库或工作区。
- **Agent 实现**：需在**实现层**保证「执行后写文档」，例如：
  - 在 main_graph 的 after_agent 或任务完成回调中，调用 `write_file` / Store 写入约定路径；
  - 或由中间件在 run 结束时写入 `.context/summary.md`、`lessons.md` 等。

### 1.2 本系统已具备的「烂笔头」能力

| 类型 | 内容 | 管理方式 |
|------|------|----------|
| 短期 | 对话与 state | LangGraph Checkpointer；write_todos、工具调用由 DeepAgent 记录 |
| 长期 | 用户偏好、成功路径 | LangGraph Store；langmem（manage_memory / search_memory）；知识图谱 |
| 项目 | 规则、工作区结构 | `.context/CONTEXT.md`、project_rules、BUNDLE |

### 1.3 契约与实现

- **契约**：见 [execution_document_contract.md](execution_document_contract.md)。约定任务/会话结束写入 `.maibot/execution_summary.md`（及可选 `.maibot/lessons.md`）。
- **实现**：`backend/engine/tasks/execution_docs.py` 提供 `write_execution_summary` / `write_lesson`；`task_watcher` 在 `_set_task_completed` 后调用（开关 `ENABLE_EXECUTION_DOCS=true`）。CI 或人工可检查文档存在性/格式。

---

## 二、被编辑文件的版本管理

### 2.1 会话内版本（编辑器）

- **实现位置**：[FullEditorV2Enhanced.tsx](frontend/desktop/src/components/FullEditorV2Enhanced.tsx)
- **数据结构**：`fileVersions: Map<path, FileVersion[]>`，每文件最多 30 条；`FileVersion` 含 `timestamp`、`content`、`description`（自动保存/手动保存）。
- **写入时机**：`handleSaveFile` 时 push 新版本并截断保留最近 30 条。
- **语义**：**仅会话内、前端内存**；刷新或关闭 Tab 后版本数据丢失，**未持久化到后端或 Store**。
- **用户操作**：通过编辑区「历史版本」入口查看当前文件的历史列表，并可「恢复此版本」将内容写回编辑器（不自动保存，用户可再保存或放弃）。

### 2.2 用户级版本（已落地：Store 快照）

- **实现**：LangGraph Store 命名空间 `file_versions`（按 workspace_scope 隔离），key 格式 `path::timestamp_iso`。
- **API**：`POST /workspace/file-versions/snapshot`（path、content、description）、`GET /workspace/file-versions?path=`（列表）、`POST /workspace/file-versions/get`（按 key 取内容）、`POST /workspace/file-versions/restore`（按 key 写回工作区文件）。详见 [backend/engine/file_version_store.py](backend/engine/file_version_store.py)。
- **可选扩展**：工作区使用 Git 时可由工具封装 `git diff`/`git checkout` 作补充回退手段。

---

## 三、权威来源与变更

- 本文档为「文档与版本管理」约定的权威说明；变更时需同步更新本文件及涉及的前端/后端逻辑说明。
- 若引入「每次执行写文档」契约或用户级版本服务，应在本文档中补充路径、格式与验收条件。
