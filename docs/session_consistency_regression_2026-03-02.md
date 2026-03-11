# 会话一致性回归清单（2026-03-02）

## 目标

- 确保线程 ID 与聊天模式写入走统一入口，避免多点写入导致的短暂状态分叉。
- 覆盖四条核心链路：切线程、新建线程、工作区切换、子窗口上下文回填。

## 自动化检查

- 前端会话状态收敛检查：`pnpm --dir frontend/desktop check:session-state`
  - 校验 `maibot_current_thread_id/maibot_active_thread` 仅允许在 `sessionState.ts` 写入。
  - 校验 `maibot_chat_mode` 与 `maibot_chat_mode_thread_*` 仅允许在 `chatModeState.ts` 写入。
- 前端构建检查：`pnpm --dir frontend/desktop build`

## 手工回归（必测）

- [ ] 新建线程后，`SESSION_CHANGED` 与 `SESSION_CREATED` 均触发，状态栏显示新线程标题。
- [ ] 从仪表盘继续历史任务时，线程切换到目标线程且模式与角色不串线。
- [ ] Settings 切换工作区后，自动建议新线程，旧上下文不污染新线程。
- [ ] Electron 子窗口注入 `threadId` 后，当前窗口会话绑定到该线程。
- [ ] Plan 确认执行后，模式可正确切回 `agent`（按设置开关）。

## 本轮改动关联文件

- `frontend/desktop/src/lib/sessionState.ts`
- `frontend/desktop/src/lib/chatModeState.ts`
- `frontend/desktop/src/components/ChatComponents/MyRuntimeProvider.tsx`
- `frontend/desktop/src/components/ChatComponents/thread.tsx`
- `frontend/desktop/src/components/ChatComponents/cursor-style-composer.tsx`
- `frontend/desktop/src/components/WorkspaceDashboard.tsx`
- `frontend/desktop/src/components/FullEditorV2Enhanced.tsx`
- `frontend/desktop/scripts/check-session-state-wiring.mjs`
