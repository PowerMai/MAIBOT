# 工作区路径与流事件安全约定

## 工作区路径校验

- **原则**：所有使用 `get_workspace_root()` 或 `configurable.workspace_path` 的读写工具，必须确保解析后的路径位于工作区根目录之下，不得静默降级到 `Path.cwd()` 或允许路径逃逸。
- **已落地**：`backend/engine/nodes/editor_tool_node.py` 中 `_resolve_workspace_path` 在 `get_workspace_root()` 失败时返回 `(None, "工作区根目录获取失败，无法解析路径")` 并打 `logger.warning`，不降级到 cwd。
- **建议**：其他工具（如 file_ops、code_execution 等）在解析用户传入路径时，应调用统一校验（如 `paths` 模块提供 `resolve_under_workspace(path) -> Path | None`），非法或越界时返回明确错误，避免静默越权。

## 工作区切换（先成功后写入）

- **原则**：切换工作区时先调后端切换，成功后再写前端 `maibot_workspace_path` 并派发 `EVENTS.WORKSPACE_CONTEXT_CHANGED`，避免前后端分叉。
- **已落地**：`WorkspaceFileTree.tsx` 中「打开文件夹」/切换工作区流程：先 `workspaceAPI.switchWorkspace`（或等价后端），成功后再 `setStorageItem('maibot_workspace_path', ...)` 并 `dispatchEvent(WORKSPACE_CONTEXT_CHANGED)`。
- **Electron 与 Web**：上述逻辑在 Electron 与 Web 下一致；当前均未实现「先确认后写入」（如进行中的流或未保存状态时弹窗确认），由后续迭代按需实现。
- **Web / 可选增强**：若需「先确认后写入」（例如存在进行中的流或未保存状态时提示用户），可在写入 storage 前增加确认步骤，由后续迭代按需实现。

## 无工作区时的会话列表

- **前端**：`listThreads` 在未选工作区时 `metadata` 不传或 `workspace_path` 为空，后端返回的列表由后端约定（通常为「全部会话」或「未绑定工作区的会话」）。
- **展示**：前端按 `metadata.workspace_path` 过滤与当前 `maibot_workspace_path` 一致的会话；无工作区时不过滤，展示后端返回的完整列表，即**无工作区 = 显示全部会话**。UI 文案与状态栏工作区显示保持一致。

## 复制诊断与 run_id

- **RunTracker 复制诊断**：用户点击「复制诊断」时，剪贴板内容由 `formatDiagnosticsClipboard` 生成，包含 `thread_id`、`run_id`、`lastError`、`recentFailures` 摘要、`mode`、`workspacePath`、`phaseLabel`、`activeTool`、`elapsedSec` 等，便于后端根据 run_id/thread_id 排查。
- **run_id 来源**：来自流式 `onRunCreated` 回调，写入 `runSummary.runId`，复制时一并输出。

## 流事件契约

- **后端**：写入 custom 事件（如 `run_error`、`session_context`）时，应保证必填字段存在；`run_error` 需含 `error_code`、`message`，`session_context` 需含 `threadId`。
- **前端**：使用 `toolStreamEvents.ts` 中的 `parseRunErrorPayload(d)`、`parseSessionContextPayload(d)` 做防御性解析；畸形 payload 返回 `null`，分支内打 DEV 日志便于排查。参见 `MyRuntimeProvider.tsx` 的 custom 事件分支。

## 测试与可观测

- **后端**：`backend/tests/test_editor_tool_path.py` 覆盖 `_resolve_workspace_path` 在 `get_workspace_root()` 失败时返回错误、不降级 cwd。其他用例见 `Makefile` 中 `BACKEND_CORE_TESTS`。
- **前端**：已引入项目级 Vitest（`frontend/desktop/vitest.config.ts`），并新增 `src/lib/events/toolStreamEvents.test.ts` 覆盖 `parseRunErrorPayload`、`parseSessionContextPayload` 的防御性解析。运行：`cd frontend/desktop && pnpm install && pnpm test:run`。后续可扩展覆盖 `sessionState`、`runSummaryState` 等。
