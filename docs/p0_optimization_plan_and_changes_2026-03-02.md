# P0 风险优化清单与实现（2026-03-02）

## P0-1 角色激活一致性（阻断业务验收）

- 风险：角色激活写入 `agent_profile.json` 后，`/agent/profile` 可能读取缓存旧值，导致 `active_role_id` 断言失败。
- 改动文件：`backend/engine/roles/role_manager.py`
- 最小改动点：
  - `apply_role()` 不再直接写文件，改为调用 `backend.engine.skills.skill_profiles.save_agent_profile()`。
  - 目的：统一写入路径，确保内存缓存与磁盘文件同步。
- 回归点：
  - `backend/scripts/test_model_role_dispatch_e2e.py` 通过。
  - `backend/scripts/test_full_business_acceptance.py` 中角色用例通过。
- 回滚策略：
  - 若出现副作用，恢复 `apply_role()` 原本的 `json.dump` 直接写文件实现。

## P0-2 任务可见性稳定性（列表遗漏）

- 风险：任务查询先走 `/threads` 再本地过滤，线程总量大时任务可能被截断导致“任务消失”。
- 改动文件：`backend/engine/tasks/task_service.py`
- 最小改动点：
  - `list_tasks()` 改为优先 `POST /threads/search`（metadata 过滤）。
  - 失败时回退 `GET /threads`；当结果不足时，再补拉一次 `/threads` 去重补齐。
- 回归点：
  - 创建多个任务后，`/tasks` 与 `/board/tasks` 可稳定看到最新任务。
- 回滚策略：
  - 恢复为原先单次请求 + 本地过滤逻辑。

## P0-3 任务状态回写竞态（状态漂移）

- 风险：`main_graph` 完成后异步回写任务状态，可能与 watcher 并发写入引发状态倒退。
- 改动文件：`backend/engine/tasks/task_service.py`
- 最小改动点：
  - 新增 `_TASK_STATUS_TRANSITIONS` 与 `_can_transition_task_status()`。
  - `update_task_status_sync()` 在写回前校验状态迁移合法性，拒绝非法倒退。
- 回归点：
  - 完成态任务不会被回写成运行态/待处理态。
- 回滚策略：
  - 去除迁移校验，恢复原先直接 `meta.update()` 写回。

## P0-4 工作区切换一致性（前后端分叉）

- 风险：设置页工作区切换调用后端失败时，前端仍先写本地状态并广播事件。
- 改动文件：`frontend/desktop/src/components/SettingsView.tsx`
- 最小改动点：
  - `onBlur` 改为 `async`；先 `await /workspace/switch` 成功后再写 `localStorage` 与事件广播。
  - 失败时给出 `toast.error`，避免前后端状态分叉。
- 回归点：
  - 输入不存在路径时，不再污染本地 `maibot_workspace_path`。
- 回滚策略：
  - 恢复 fire-and-forget 请求与本地先写逻辑。
