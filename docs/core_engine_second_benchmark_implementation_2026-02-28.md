# 核心引擎二次对标实施记录（2026-02-28）

## 已落地改造

- P0 状态单一写入口：`PATCH /board/tasks/{task_id}` 在包含 `status` 时改为仅通过 `project_board_task_status` 原子提交，不再先直写再投影。
- P0 并发抢写保护：`accept-bid` 在 `claimed` 状态追加 `only_when_claimed_by` 条件，降低竞态改派风险。
- P0 单一真源一致性：`blocked` API 在单一真源模式下移除回退直写分支，投影失败直接返回冲突。
- P0 Plan 单状态机：移除基于文本正则的“确认执行计划”兜底，Plan 阶段确认仅依赖明确状态字段与图级中断恢复。
- P1 线程模型绑定闭环：后端在请求准备阶段读取 thread metadata 并回灌 `thread_model/pinned_model`，避免同线程漂移。
- P1 中间件兼容收敛：老的 `inject_*` 名称统一映射到 `inject_runtime_context`，确保历史配置仍生效。
- P1 模式契约收敛：Prompt 侧不再把 `debug` 视作默认写入执行模式。
- P1 Model Auto 场景补齐：新增 `deep_research/research/office/coding/debugging` 等任务类型映射与 `workspace_domain` 回退策略。

## 对标口径（Claude/Cursor/Cowork 等价目标）

- 先规划后执行：Plan 使用图级 interrupt 做确认，不依赖隐式前端本地标记。
- 运行时门禁优先于提示词：状态迁移、模式权限、并发条件以后端规则为准。
- 会话一致性优先于短期自由切模：同线程优先绑定模型，显式新开线程再切模型。
- 可观测优先：路由解释中补充 `workspace_domain` 与标准化 `task_type`。

## 阶段验收清单

### 阶段1（正确性）

- [x] `board_update_task` 状态写入冲突率可观测（GET /board/metrics/reliability 含 status_projection_attempts/conflicts/conflict_rate）。
- [x] `accept-bid` 并发测试通过（同任务多请求仅 1 个成功；project_board_task_status 按 task 加锁 + tests/test_accept_bid_concurrency.py）。
- [x] `blocked` 在单一真源模式下不再出现“投影失败但写入成功”（board_api 仅投影、失败即 409；回归见 test_blocked_single_source_projection_failure_no_write）。

### 阶段2（质量与记忆）

- [ ] 历史 `inject_*` 配置在 agent/plan/debug/ask 均能稳定注入运行时上下文。
- [ ] Debug 模式输出不再默认引导写操作（仅在用户确认后执行）。

### 阶段3（Auto 路由）

- [ ] 办公/代码/研究三类请求可稳定映射到预期 task_type。
- [ ] 同一线程跨多轮请求 `resolved_model_id` 不漂移（除非显式新建线程）。

## 建议追加的观测指标

- `thread_model_drift_rate`: 同 `thread_id` 出现多个 `resolved_model_id` 的比率。
- `status_projection_conflict_rate`: 状态投影冲突占比。
- `accept_bid_race_reject_rate`: 并发竞态被拒绝占比（409）。
- `task_type_normalization_distribution`: 各业务域归一化后 task_type 分布。
