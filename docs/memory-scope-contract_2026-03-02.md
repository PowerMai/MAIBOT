# Memory Scope Contract（workspace 隔离优先）

## 作用域模型

- `thread`：会话运行态（短期），用于当前对话上下文与 UI 会话偏好，不作为长期记忆主键。
- `workspace`：默认隔离边界；长期记忆默认按工作区分区，避免跨项目串扰。
- `user`：同一工作区内的长期用户记忆聚合维度。
- `shared`：可选跨工作区共享维度，仅在显式开启时使用。

## 优先级与回退

- 长期记忆命名空间：`("memories", "{workspace_id}", "{user_id}")`
- 可选共享命名空间：`("memories_shared", "{user_id}")`
- `workspace_id` 解析优先级：
  1. `configurable.workspace_id`
  2. `configurable.memory_workspace_id`
  3. `configurable.workspace_path` 归一化
  4. `default`
- `user_id` 解析优先级：
  1. `configurable.user_id`
  2. `configurable.langgraph_user_id`
  3. `MAIBOT_USER_ID` 环境变量
  4. `default_user`

## 注入点

- 主图 [main_graph.py](../backend/engine/core/main_graph.py) 在准备 agent config 时调用 `resolve_memory_scope(configurable)`，将 `workspace_id`、`user_id` 等写入 configurable，LangGraph Store / langmem 工具据此解析命名空间占位符。

## 约束

- 禁止将 `thread_id` 作为长期记忆 `user_id` 回退值。
- 会话级状态与长期记忆主权源分离：thread metadata 仅承载会话态，不反向覆盖长期记忆。
- 默认 `workspace_isolated`，共享必须显式开关 `memory_shared_enabled=true`。
