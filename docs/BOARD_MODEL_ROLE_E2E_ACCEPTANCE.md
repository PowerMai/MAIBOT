# 全链路业务逻辑完成定义（DoD）

本文档用于判定“任务分发 + 模型选择 + 角色联动”是否达到可发布状态。

## 1. 功能通过标准

- 任务创建后可见即时反馈：
  - `dispatch_state=dispatching` 显示“自动分发中”
  - `dispatch_state=waiting_human` 显示“等待人工检查”
- 创建后短轮询可推进状态，并在 `running + thread_id` 时自动跳转会话。
- 人工检查点通过后，任务从 `waiting_human` 自动回到分发/执行路径（不需要用户再次手动触发）。
- 多视图状态一致：`TaskListSidebar`、`TaskDetailView`、`WorkspaceDashboard` 使用统一状态语义。

## 2. 异常与幂等通过标准

- 重复触发 `dispatch_task_once(task_id)` 不导致重复启动或状态破坏。
- 无可用角色或无有效竞标时，接口返回可解释状态（如 `no_roles`、`no_bid_or_unresolved`），而不是 500。
- 进度接口非法输入返回 4xx（400/422），不得返回 500。

## 3. 性能通过标准

- `/board/tasks` 列表接口的本地验收基线：
  - p95 <= 500ms
  - 错误数 = 0
- 任务创建后的前端短轮询成本控制：
  - 单次创建轮询窗口 <= 20s
  - 轮询间隔 >= 1.2s（避免高频空轮询）

## 4. 模型与角色联动通过标准

- `/models/list` 包含 `auto` 与至少一个启用模型。
- 每个模型具备 `supports_images` 布尔字段。
- 模型切换 `/models/switch` 可切到 `auto` 与一个启用模型。
- `/roles/list` 非空，`/roles/{id}/activate` 后 `/agent/profile.active_role_id` 一致。
- 创建任务后可进入分发评估路径，任务快照状态在合法集合内：
  - `available | bidding | claimed | running | completed | failed | paused | cancelled`

## 5. 回归脚本

### 5.1 看板分发关键路径

```bash
uv run python backend/scripts/test_board_dispatch_regression.py
```

覆盖项：
- 创建后即时分发
- 检查点通过后自动分发
- `dispatch_task_once` 幂等
- 进度非法参数 4xx

### 5.2 模型-角色-分发联动

```bash
uv run python backend/scripts/test_model_role_dispatch_e2e.py
```

覆盖项：
- 模型列表/auto/切换
- 角色列表/激活
- 任务分发与角色认领链路

### 5.3 全链路统一验收入口（推荐）

```bash
uv run python backend/scripts/test_full_business_acceptance.py
```

输出：
- `backend/data/business_acceptance_report.json`
- 包含功能/异常/性能/一致性四类 DoD 子结论

## 6. 当前验收结论（本次实现）

- 两个回归脚本 + 统一验收入口脚本可用于发布前门禁。
- 前端任务创建入口已统一为“创建反馈 + 短轮询 + 自动跳转线程”策略。
- 状态语义已收敛到共享模块：
  - `frontend/desktop/src/lib/taskDispatchStage.ts`

判定：当前达到“核心业务链路可验收”状态，可作为后续扩展（性能压测、组织/公开 scope 场景）基线版本。
