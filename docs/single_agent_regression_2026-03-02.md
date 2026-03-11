# 单体 Agent 回归清单（2026-03-02）

## 目标

- 将单体阶段 DoD 转为可执行回归：`Plan 图级确认`、`HITL 扩展`、`blocked 恢复`、`artifacts 审计`、`可靠性指标`。
- 确保前后端链路一致：状态机、调度门控、UI 展示、API 端点和工具能力无断层。

## 自动化检查

- 单体阶段关键链路就绪检查：
  - `pnpm --dir frontend/desktop check:single-agent`
  - 重点校验：
    - Plan 图级中断与 `awaiting_plan_confirm`
    - `report_blocked` / `report_artifacts`
    - `delegate` / `skip` 扩展决策
    - watcher 对 `awaiting_plan_confirm/blocked` 调度门控
    - TaskDetailView 阻塞与交付审计展示
- 后端接口验收回归：
  - `backend/.venv/bin/python backend/scripts/test_single_agent_api_acceptance.py`
  - 覆盖：`/board/tasks`、`/board/tasks/{id}/blocked`、`/board/tasks/{id}/artifacts`、`/board/tasks/{id}/human-review`、`/board/metrics/reliability`
- 后端契约负例守卫：
  - `backend/.venv/bin/python backend/scripts/check_board_contracts.py`
  - 覆盖：非法状态迁移拒绝（4xx）、非法人审决策拒绝（400）、blocked 请求体校验（4xx）
- 可靠性 SLO 检查：
  - `backend/.venv/bin/python backend/scripts/check_reliability_slo.py`
  - 输出 `backend/data/reliability_slo_history.jsonl` 快照并按阈值给出 `pass/warn/fail`
- 会话状态一致性检查：
  - `pnpm --dir frontend/desktop check:session-state`
- 前端构建检查：
  - `pnpm --dir frontend/desktop build`

## 手工回归（必测）

- [ ] Plan 模式输出计划后进入 `plan_confirmation` 中断，未确认前任务状态为 `awaiting_plan_confirm`。
- [ ] 点击“确认执行”后进入执行阶段，状态迁移为 `running`，进度持续刷新。
- [ ] 人类检查点可见 `delegate` / `skip`（当 checkpoint 配置提供 options）。
- [ ] 当任务信息不足时，可上报 `blocked_reason` 与 `missing_information` 并在任务详情可见。
- [ ] 任务完成后展示 `deliverables`、`changed_files`、`rollback_hint`。
- [ ] `GET /board/metrics/reliability` 返回成功率、blocked 恢复率、人类干预率、交付有效率。

## 关键文件

- `backend/engine/core/main_graph.py`
- `backend/engine/tasks/task_watcher.py`
- `backend/tools/base/task_board_tools.py`
- `backend/tools/base/human_checkpoint.py`
- `backend/api/app.py`
- `backend/engine/agent/deep_agent.py`
- `backend/engine/prompts/agent_prompts.py`
- `frontend/desktop/src/lib/taskDispatchStage.ts`
- `frontend/desktop/src/lib/api/langserveChat.ts`
- `frontend/desktop/src/lib/api/boardApi.ts`
- `frontend/desktop/src/components/ChatComponents/InterruptDialog.tsx`
- `frontend/desktop/src/components/TaskDetailView.tsx`

## 本轮执行结果（自动化）

- `pnpm --dir frontend/desktop check:single-agent`：通过
- `pnpm --dir frontend/desktop check:session-state`：通过
- `backend/.venv/bin/python backend/scripts/test_single_agent_api_acceptance.py`：通过
- `backend/.venv/bin/python backend/scripts/check_board_contracts.py`：通过
  - plan_task: `83993ecd-f1b0-45fa-979b-e1777a8b5c8a`
  - human_task: `fa7907b0-eee4-417b-9ca1-d9c7b022595f`
  - metrics.task_count: `380`
  - metrics.human_intervened_count: `53`
