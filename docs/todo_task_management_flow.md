# Todo 任务管理业务流程

## 1. 目标

- **有效执行**：Agent 对多步任务先规划（write_todos），再按步执行，每步完成及时更新 todo 状态。
- **正确反馈**：用户实时看到任务列表与进度（k/n、进行中/已完成）；**同一会话内 todo 跨 run 保留**，一次没执行完下次可继续，仅切换会话时清空、不串会话。

## 2. 端到端流程

```
用户发送消息
    → 后端 run 开始
    → Agent 若为多步任务则调用 write_todos(todos: [{id, content, status}, ...])
    → 后端在「见到 write_todos 的 tool_call」时立即推送 task_progress { data: { todos } }（规划即展示）
    → 工具执行返回后，后端再次推送 task_progress（便于状态更新，如某条 completed）
    → 前端 MyRuntimeProvider 收到 stream 中 type=task_progress、data.todos 时，带 threadId 派发 TASK_PROGRESS
    → 当前会话 thread 收到 TASK_PROGRESS（threadId 匹配且 run 未结束）→ setCurrentRunTodos(list)
    → Composer 上方展示：运行条 + Todo 摘要按钮（k/n + 进度条）+ 可展开列表
    → run 结束（stream_end / task_running false）→ 仅收起展开、置 streamJustEnded；**不清空 currentRunTodos**，steps 清空、运行条隐藏
    → **有遗留 todo 时**：未在运行也展示可折叠/展开的任务列表（RunTodoListCard variant=nested），用户始终可见 k/n 与列表，下次发送消息可继续执行
    → 切换会话（activeThreadId 变化）→ 当前会话 todo 写入 todosByThreadIdRef，再从 ref 恢复目标会话的 todo；各会话独立，互不串
```

## 3. 后端约定

| 环节 | 行为 |
|------|------|
| **write_todos 被调用时** | 在流式处理中，一旦看到 AI 消息里 tool_calls 含有 `write_todos` 且 `args.todos` 非空，立即 `writer({"type": "task_progress", "data": {"todos": payload, "tool_call_id": tc_id}})`，使用户立即看到规划。 |
| **write_todos 工具返回时** | 处理 ToolMessage 时，若对应 tool_call 为 write_todos，再次用 args.todos 推送 task_progress，便于后续「每步完成即更新」的多次 write_todos 都能把最新列表推到前端。 |
| **payload 结构** | `todos`: `[{ "id": string?, "content": string, "status": "pending"|"in_progress"|"completed" }]`，与 LangChain Todo 约定一致。 |

实现位置：`backend/engine/core/main_graph.py`  
- 见到 tool_call（AI 消息内）：在 `phase: "tool_call"` 的 task_progress 之后，若 `tc_name == "write_todos"` 则从 `tc_args` 取 todos 并推送。  
- 见到 ToolMessage：原有逻辑，从 parent tool_call 的 args 取 todos 并推送。

## 4. 前端约定

| 环节 | 行为 |
|------|------|
| **TASK_PROGRESS 派发** | MyRuntimeProvider 在消费 stream 时，收到 `task_progress` 且 `data.todos` 存在时，`flushTaskProgress` 将 payload 与 `currentThreadIdRef.current` 一并作为 `detail` 派发，保证 `detail.threadId` 始终存在。 |
| **会话过滤** | thread 内 TASK_PROGRESS 监听：仅当 `detail.threadId` 为空或等于当前 `activeThreadId` 时更新 `currentRunTodos`；run 已结束（`streamJustEndedRef.current`）时忽略，避免延迟事件把已结束 run 的 todo 再显示出来。 |
| **展示条件** | 运行中：运行条 + Todo 区（同上且 `currentRunTodos?.length > 0`）。**未运行但有遗留 todo**：单独展示可折叠任务列表（`RunTodoListCard` variant=nested），摘要在上、展开后列表在下，用户可随时查看并下次继续。 |
| **清理时机** | **各会话独立**：currentRunTodos 按 threadId 存于 todosByThreadIdRef；切换会话时写入当前会话列表并恢复目标会话列表，**不清空**。`stream_start` / `stream_end` / `task_running false` 仅收起展开、置 streamJustEnded，**不清空 currentRunTodos**。runtimeRunning 由 true→false 的 effect 仅 `setTodoExpanded(false)`，不调用 `setCurrentRunTodos`。run 结束后仍用 streamJustEndedRef 拒绝延迟 TASK_PROGRESS。 |

实现位置：  
- `frontend/desktop/src/components/ChatComponents/MyRuntimeProvider.tsx`：stream 处理、flushTaskProgress、threadId 注入。  
- `frontend/desktop/src/components/ChatComponents/thread.tsx`：TASK_PROGRESS 监听、currentRunTodos 更新与展示条件、stream 事件清理。  
- `frontend/desktop/src/components/ChatComponents/RunTracker.tsx`：RunTodoSummaryButton、RunTodoListCard（k/n、进度条、展开列表）。

## 5. 与主流 AI 工作流的对齐点

- **规划即展示**：Agent 一旦调用 write_todos，前端立即收到并展示任务列表，不等工具返回。  
- **进度实时更新**：Agent 每步完成后再次 write_todos 更新状态时，后端再次推送，前端用全量列表覆盖，展示最新 k/n 与 completed/in_progress。  
- **按会话隔离**：TASK_PROGRESS 带 threadId，仅当前会话更新；**各会话独立**，todo 按 threadId 持久在 ref，切换会话时恢复对应列表，不串会话。  
- **状态条与 Todo 一体**：运行中时状态条与 Todo 摘要/列表同区域展示；run 结束后运行条隐藏，**若有遗留 todo 则展示可折叠任务列表**（可展开查看 k/n 与明细），下次 run 同会话继续执行。

## 6. 相关文档

- 工具展示规范：`tool_display_cursor_alignment.md`  
- 对齐检查清单：`cursor_alignment_checklist.md`  
- write_todos 的 Prompt 与强制使用场景：`backend/engine/prompts/agent_prompts.py`（write_todos 相关段落）。
