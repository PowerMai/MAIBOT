# Backend Route Boundary Policy

目标：限制 `backend/api/app.py` 的持续膨胀，新增功能遵循“路由薄层 + 领域模块”。

## 1. 路由层职责

- 仅负责参数校验、鉴权、错误映射、响应序列化。
- 不在路由函数内直接实现复杂业务编排。
- 不在路由层引入跨领域状态写入（例如同时写 board + thread + ledger）。

## 2. 领域模块职责

新增功能优先落到对应领域模块：

- 任务调度：`backend/engine/tasks/*`
- 组织协作：`backend/engine/organization/*`
- 自治控制：`backend/engine/autonomy/*`
- 空闲循环：`backend/engine/idle/*`

路由仅调用领域模块入口，并返回结构化结果。

## 3. 新增 API 约束

- 新增端点前先定义：
  - 输入 schema
  - 输出 schema
  - 状态写入位置
  - 失败回滚策略
- 若逻辑超过 30 行，必须抽离到领域函数。
- 任何跨模块写入都需包含结构化日志字段：
  - `task_id` / `thread_id` / `scope` / `reason`

## 4. 兼容与迁移

- 历史端点保留兼容，不做一次性大迁移。
- 新端点与新逻辑按本规范执行，逐步替换旧路径。
- 迁移优先级：先读层统一，再写层收敛。

## 5. 验收清单

- 新功能 PR 中，`app.py` 变更主要为路由映射。
- 业务核心逻辑可在对应 `engine/*` 文件中独立测试。
- 关键路径有结构化日志可追溯。

