# 恢复单路径验收清单

与 [ux_recovery_single_path_design_2026-03-02.md](ux_recovery_single_path_design_2026-03-02.md) 对应，用于人工或自动化验收「失败后恢复」单主入口与存储约定。

## 1. 存储

- [ ] 运行摘要按 thread 存储，键为 `maibot_run_summary_thread_{threadId}`（见 [runSummaryState.ts](../frontend/desktop/src/lib/runSummaryState.ts)）；无全局覆盖。
- [ ] 切换会话后，runSummary 与 currentRunTodos 从 `readRunSummary(activeThreadId)` 恢复，不读其他 thread 的数据。

## 2. Dashboard

- [ ] WorkspaceDashboard 展示恢复状态时，仅使用 `getCurrentThreadIdFromStorage()` 取当前活动 thread，再调用 `readRunSummary(threadId)`；不读全局 run summary 键。

## 3. TaskDetail → Thread

- [ ] 任务详情页「继续」「恢复」等操作通过 `EVENTS.SWITCH_TO_THREAD`（或等价事件）跳转到 Thread，并携带 threadId；主恢复入口在 Thread 的 RunSummaryCard（停止/重试/打开任务等）。

## 4. 体验指标

- [ ] 失败后到「可重试」点击路径 ≤ 2 步（例如：Thread 顶部 RunSummaryCard 直接显示重试/打开任务）。
- [ ] 切换 thread 后，恢复建议与 runSummary 对应当前 thread，无错配。

## 5. 可选

- 恢复成功时写简单日志或前端埋点，便于后续看「恢复成功率」趋势（与设计文档指标一致）。

## 参考

- [ux_recovery_single_path_design_2026-03-02.md](ux_recovery_single_path_design_2026-03-02.md)
- [domain-model.mdc](../.cursor/rules/domain-model.mdc) 会话/工作区归属与事件协议
