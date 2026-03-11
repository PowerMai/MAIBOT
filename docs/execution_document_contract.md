# 每次执行写文档契约

本文档约定「任务/会话结束」时由实现层写入的文档类型、路径与格式，便于可追溯与 CI/人工检查。

---

## 一、触发时机

- **任务完成**：看板任务执行成功并调用 `_set_task_completed` 之后（如 task_watcher 自治任务）。
- **会话结束**（可选）：主图 run 正常结束且存在会话级摘要时，可由 after_agent 或图尾节点写入。

实现层在**任务完成回调**中写入即可覆盖「每次执行写文档」的契约；会话级为可选扩展。

---

## 二、文档类型与路径

均相对于**工作区根**（`config.configurable.workspace_path` 或 `get_workspace_root()`）。

| 文档 | 路径 | 说明 |
|------|------|------|
| 执行摘要 | `.maibot/execution_summary.md` | 每次任务成功结束时追加一条：时间、task_id、thread_id、摘要。 |
| 经验教训（可选） | `.maibot/lessons.md` | 失败或需留痕时追加；格式与摘要类似，可含 error 或建议。 |

目录 `.maibot/` 已由系统使用；若不存在则实现层创建。

---

## 三、格式约定

### execution_summary.md

- 每次**追加**一行或一块，避免覆盖历史。
- 建议块格式（Markdown）：

```markdown
## YYYY-MM-DD HH:MM
- task_id: xxx
- thread_id: xxx
- summary: （result_summary 内容，可多行）
```

- 单行简化格式也可接受：`[YYYY-MM-DD HH:MM] task_id=xxx thread_id=xxx summary=...`

### lessons.md

- 追加格式同 execution_summary，可增加 `error:` 或 `suggestion:` 行。
- 实现层可按需限制文件最大行数或轮转归档。

---

## 四、实现入口

- **推荐调用点**：`backend/engine/tasks/task_watcher.py` 中，在 `_set_task_completed(scope, task_id, result_summary, thread_id)` 之后、同一任务流程内，调用 `write_execution_summary(workspace_path, task_id, thread_id, result_summary)`。
- **实现模块**：`backend/engine/tasks/execution_docs.py`，提供 `write_execution_summary(...)`，内部写入 `.maibot/execution_summary.md`；可选 `write_lesson(...)` 写入 `.maibot/lessons.md`。
- **开关**：可通过环境变量 `ENABLE_EXECUTION_DOCS=true`（默认可为 false 以保持兼容）或配置项控制是否写入；未传 workspace_path 时使用 `get_workspace_root()`。

---

## 五、验收与检查

- **人工**：查看工作区 `.maibot/execution_summary.md` 是否存在且在任务成功后追加。
- **CI**（可选）：流水线中检查某次 run 后该文件是否新增对应 task_id/thread_id 条目。

本文档为「每次执行写文档」的权威约定；变更时需同步 [doc_and_version_management_convention.md](doc_and_version_management_convention.md)。
