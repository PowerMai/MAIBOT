# Ask 模式硬边界验收（L2）

## 目标

确保 Ask 模式为“只读顾问”且具备运行时硬约束，不依赖提示词软约束。

## 已实现约束

- 权限单源：`backend/engine/modes/mode_config.py`
- 运行时门控：`backend/engine/middleware/mode_permission_middleware.py`
  - Ask 下 `task` 必须 `readonly=true`
  - Ask 下 `task.subagent_type` 仅允许 `explore` / `generalPurpose`

## 回归用例

- `backend/tests/test_mode_permission_plan_no_block.py`
  - `test_ask_mode_blocks_task_when_not_readonly`
  - `test_ask_mode_allows_task_when_readonly`

## 验收标准

- Ask 模式触发 `task(readonly=false)` 必须返回 `ModePermission` error。
- Ask 模式触发 `task(readonly=true, subagent_type=explore)` 必须允许通过。
- 不影响 Plan 模式既有“可执行”能力。
