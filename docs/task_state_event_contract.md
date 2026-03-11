# Task State And Event Contract

本文件定义任务状态机与事件字典，作为 `task_id / thread_id / run_id` 的统一读写契约。

## 1. ID 关系定义

- `task_id`：任务业务主键（看板与运营视图主索引）。
- `thread_id`：执行会话主键（聊天执行轨迹、线程切换）。
- `run_id`：单次执行实例主键（同一 `thread_id` 下可能多次运行）。

约束：

- 一个 `task_id` 在任一时刻最多绑定一个活跃 `thread_id`。
- 一个 `thread_id` 可承载多个 `run_id`（重试、继续、恢复）。
- `thread_id` 作为执行投影，不作为任务主事实源。

## 2. 任务状态机

状态集合（看板）：

- `available`：可分发
- `pending`：待调度（可选过渡态）
- `claimed`：已认领，待执行
- `running`：执行中
- `waiting_human`：等待人工检查点
- `paused`：暂停
- `completed`：完成
- `failed`：失败
- `cancelled`：取消

允许迁移（核心）：

- `available -> claimed -> running -> completed|failed`
- `running -> waiting_human -> available|paused|running`
- `running -> paused -> running`
- `running|paused|waiting_human -> cancelled`
- `failed|cancelled|paused|waiting_human -> available`（重置）

## 3. 关键事件字典（前端总线）

- `TASK_PROGRESS`
  - 用途：刷新任务列表/详情进度、协作统计轻刷新。
  - 最小载荷：`{ taskId?: string, source?: string }`

- `OPEN_TASK_IN_EDITOR`
  - 用途：在编辑区打开任务详情 tab。
  - 最小载荷：`{ taskId: string, subject?: string }`

- `SWITCH_TO_THREAD`
  - 用途：切换到执行线程（聊天区）。
  - 最小载荷：`{ threadId: string }`

- `ROLE_CHANGED` / `CHAT_MODE_CHANGED` / `COMPOSER_PREFS_CHANGED`
  - 用途：角色与会话偏好同步，保障任务创建上下文一致。

## 4. 写入责任划分（单一真源）

- **状态唯一写入口**：当 `TASK_SINGLE_SOURCE_ENABLED=true`（默认）时，任务状态变更**仅**通过 `project_board_task_status`（[task_bidding.py](backend/engine/tasks/task_bidding.py)）写入；`/board/tasks` PATCH、watcher、report_blocked、sync_board_task_by_thread_id 等均经此路径，无直写 Store 的状态分支。
- 看板状态主写入：`/board/tasks` 与 watcher 调度链路（均调用 `project_board_task_status`）。
- 线程执行主写入：`/tasks` 线程运行接口与 runtime provider；执行结果通过 `sync_board_task_by_thread_id` 投影回看板。
- 同步原则：以 `task_id` 主状态为准，`thread_id/run_id` 作为执行投影；验收时同一任务在 `/tasks`、`/board/tasks`、执行日志三处状态一致。

## 5. 读层一致性建议（轻量版）

- 页面展示默认读看板状态。
- 线程状态仅用于执行态细节（运行中、取消中、日志）。
- 展示冲突时优先级：`task.status` > thread metadata > 本地估算。

