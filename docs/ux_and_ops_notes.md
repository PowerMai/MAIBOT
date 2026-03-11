# 体验与运维说明（任务 / 知识库 / 联网 / 模式与技能）

本文档汇总产品中与「任务栏、知识库不可用、联网开关、模式与 Skills」相关的来源与行为，便于排查与优化。

---

## 1. 任务栏任务来源与可执行性

- **来源**：任务来自后端 `GET /tasks`（`backend/engine/tasks/task_service.py`）。每条任务对应一个 **thread_id**（会话），并带有 `metadata`（如 subject、task_status、priority、scene、mode 等）。
- **与 user/workspace/session 的关系**：
  - **User**：当前未按用户隔离任务列表，任务列表为当前后端实例下所有任务。
  - **Workspace**：任务创建时可带 `workspace_path`/工作区上下文；执行时依赖当前前端的「当前工作区」与「当前会话」。
  - **Session (Thread)**：任务与会话一一对应（`task.thread_id`）。只有存在 `thread_id` 的任务才能「打开对话」「查看产出」「继续执行」。
- **为何很多任务“不可执行”**：
  - 任务状态为 **completed / failed / cancelled** 时，通常不再执行，仅可查看产出或重试。
  - **无 thread_id** 的旧任务或异常任务无法关联到会话，前端会禁用「查看产出」「打开对话」等按钮（并提示「该任务未关联对话」）。
  - 可执行动作：**pending / running** 且带 **thread_id** 的任务可「打开对话」「在控制台查看」「继续执行」；completed 可「查看产出」。无 thread_id 时「在控制台查看」禁用并提示「该任务未关联对话，请先派发执行」；列表行 tooltip 会显示「未关联对话，派发执行后可打开对话」。
- **前端**：TaskListSidebar 中每条任务根据 `thread_id` 显示 row title 与下拉项「打开对话」（仅当有 thread_id 时显示）、「在控制台查看」在无 thread_id 时 disabled。派发执行时通过 `getDispatchExecuteDetail(task)` 单源构造 FILL_PROMPT 的 detail：有 `thread_id` 时附带 `threadId` 与 `autoSend: true`，否则仅 `prompt` 且 `autoSend: false`。Composer 收到后若当前会话与 `threadId` 不同会先派发 `SWITCH_TO_THREAD` 再在下一 tick 重新派发 `FILL_PROMPT`（带 `_deferred: true`）完成填词与发送；`_deferred` 标记用于防重入，避免快速连续操作导致重复切换或循环（对齐 Cursor 行为）。
- **与 OpenClaw/Cursor/Claude 的对照**：本项目的任务 = Thread + 元数据（主题、状态、优先级等），执行入口为「打开关联会话并发送消息或确认计划」。后续可增强：按工作区过滤（后端 `GET /tasks` 支持 `workspace_path` 或 `workspace_id` 过滤，前端 TaskListSidebar 传入当前 `maibot_workspace_path`）、按用户/租户隔离、与看板泳道状态同步。
- **坚韧性（不因延时简单中止）**：与 Cursor 一致，发送消息默认 4 次重试、后端工具/模型各 2 次重试、Agent 并发构建时等待预算 20s（可配），详见 [main_pipeline_and_middleware_rationality.md](main_pipeline_and_middleware_rationality.md) §十.2。

---

## 2. 知识库服务不可用（502 / 向量或 Embedding 不可用）

- **现象**：提示「知识检索暂时不可用（向量/Embedding 服务 502）」或类似。
- **原因**：`search_knowledge` 依赖向量检索；向量检索依赖 **Embedding 模型**（见 `backend/tools/base/embedding_tools.py`）。当：
  - Embedding 模型未配置或未启动（如 LM Studio 未开、端口错误），或
  - 调用 Embedding 的 HTTP 返回 502（Bad Gateway）
  则会退回并返回上述提示。
- **排查**：
  1. 设置中确认「Embedding 能力」已配置且可用（如 `/system/capability` 或模型配置中的 embedding 模型）。
  2. 若使用本地 Embedding（如 LM Studio），确认服务已启动、端口与 Base URL 一致。
  3. 查看后端日志中 `[search_knowledge]` 或 embedding 相关报错。
- **前端**：知识库面板（KnowledgeBasePanel）在挂载时会请求 `GET /models/list`，若 `capability_models.embedding.available === false` 则展示红色提示条：「向量检索（Embedding）服务不可用，知识库搜索可能受限。请检查设置中的 Embedding 模型或本地推理服务。」

---

## 3. 联网开关有效性及缺信息时是否提示

- **开关**：前端的「联网」开关（Composer 旁 Globe 图标）对应 `maibot_web_search`（localStorage），并通过 `web_search_enabled` 传入后端；后端在请求上下文中使用 `web_search_enabled` 控制是否允许调用 `web_search` / `web_fetch`。
- **有效性**：当开关为「关」时，后端在创建 Orchestrator 工具列表时会移除 `web_search` 与 `web_fetch`，模型不会收到这两项工具，因此不会发起联网。为「开」或「深度研究」时可发起。
- **缺信息时主动提示**：系统提示词中当 `web_search_enabled` 为 false 时会注入 `<web_search_disabled>` 段，说明当前未开启联网、不可使用 web_search/web_fetch，并告知若用户需要最新或外部信息可点击输入框旁的「联网」开关。
- **合理性**：未打开联网时原则上不应使用互联网；若存在例外（如健康检查、必要重定向），应在产品上明确说明或限制为仅必要请求。

---

## 4. 多次会话后崩溃与日志

- **前端**：未捕获错误会通过 `window.onerror` / `window.onunhandledrejection` 上报到 `POST /log/frontend-error`，请求体包含 `message`、`source`、`lineno`、`colno`、`stack`、`thread_id`、`ts`。`thread_id` 为崩溃瞬间的当前会话 ID（通过 `getCurrentThreadIdFromStorage()` 读取，与 sessionState 单源一致），便于关联会话。
- **后端**：上报内容会追加到项目下的 `.cursor/frontend-error.log`（行式 JSON），便于崩溃后查看最近错误及对应 `thread_id`、堆栈。
- **开发环境**：最近若干条错误会保留在 `window.__DEV_ERRORS__`，控制台可查看。

---

## 5. 模式特色内容与 Skills 自动加载

- **模式**：不同模式（Agent / Plan / Ask / Debug / Review）在 `backend/engine/modes/mode_config.py` 中配置权限与认知框架；`agent_prompts.py` 中按模式注入不同系统提示与约束。可在此继续强化各模式的「特色说明」和针对性指引。
- **Skills**：Skills 由后端加载（如 `list_skills`、`match_skills`、`get_skill_info`）；流式运行时会根据角色/场景注入技能列表或 BUNDLE。前端在 Composer 工具栏中增加「技能随角色加载」简短文案，悬停 tooltip 为「技能随角色与场景自动加载，执行中可用 list_skills 查看已加载技能」。模式选择器悬停时展示当前模式的 `description`（来自 CHAT_MODES）。
- **知识库「用当前文档提问」**：左侧知识库面板在「知识库」结构树中选中文件时，显示「用当前文档提问」按钮；点击后打开聊天面板、将当前文档作为 context_item 填入 Composer、并填入默认提示词与聚焦输入框，便于基于该文档继续提问。
- **记忆可见性**：MemoryPanel 顶部展示简短说明「对话时 Agent 会按当前用户与工作区自动使用相关记忆」，便于用户理解记忆如何被使用（i18n：`memory.usageHint`）。

---

## 6. 文件上传与 Composer 上下文

- **上传方式**：Composer 支持 (1) 点击「+」→「添加文件」或「从工作区选择文件」；(2) 拖拽文件到输入区；(3) 工作区选择器内「从本地上传」。上传会带当前 `maibot_workspace_path`，文件落盘到该工作区的 `uploads/`，便于本轮对话中 read_file 解析。
- **「+」与从本地上传**：从工作区选择器点击「从本地上传」会先关闭弹窗再触发打开文件选择（约 150ms 延迟），避免 ref 未就绪；Composer 内「+」→「添加文件」直接打开系统文件选择。
- **发送前同步附件（Cursor 风格）**：点击发送或回车发送时，会先将当前 Composer 附件列表同步到 Runtime 的 ref（`CONTEXT_ITEMS_CHANGED`），再提交消息，避免「刚添加附件就发送」时 LLM 收不到附件。
- **发送后清空附件与 ref**：消息发送完成后会派发 `MESSAGE_SENT`，Composer 清空本地附件 state 并派发 `CONTEXT_ITEMS_CHANGED` 携带空数组，使 MyRuntimeProvider 的 `contextItemsRef` 同步清空，避免下一轮对话仍带上轮附件。
- **附件 chip 展示**：当前为一行多 chip（每项可删）；是否改为折叠式「已选 N 个文件」等布局**待产品以 Cursor 实际界面核对后定稿**，详见 `docs/cursor_alignment_checklist.md` §2.2。
- **上下文统计与「上下文太多」**：Composer 底部上下文统计为**总用量**（含系统提示、历史消息、附件、打开文件等），不仅限本栏显示的「N 个上下文」附件。若提示「对话上下文已超长」，表示整轮请求（历史+本轮）超模型上限，建议新开会话或减少附件/历史后再试；后端 ContextGuard 与 Summarization 的配置与排查见 `docs/ERROR_CODES_AND_TROUBLESHOOTING.md` §1.2 与 `docs/CONTEXT_AND_MEMORY_SYSTEM_DESIGN.md`。
- **生成文件落在哪（工作区 vs 项目根）**：后端以请求中的 `config.configurable.workspace_path` 为工作区根，产出写入该工作区下的 `outputs/`（及模式子目录 ask/plan/debug/review）。若前端未传或传了无效路径，后端回退到 **项目下的 tmp/**（不再回退到项目根），避免生成文件混入代码目录。要让生成文件落在你期望的文件夹，请先通过「打开文件夹」选择目标目录，确认当前工作区后再发消息；前端通过 `resolveWorkspacePath`（编辑器 > `maibot_workspace_path` > 后端 /config/list）将工作区路径作为 `workspace_path` 传入 configurable。
- **工作区路径解析一致性**：`resolveWorkspacePath` 优先用编辑器工作区 → 本地存储 `maibot_workspace_path` → 请求 `/config/list` 取后端 `workspace_root`。前端读取响应时使用 `data.workspace_root`（兼容 `data.config.workspace_root`），与后端返回字段一致，保证未选文件夹时前后端默认均为项目下 tmp。
- **附件上传 API（filesApi.uploadFile）**：聊天附件通过 `filesApi.uploadFile` 上传时也会附带当前 `maibot_workspace_path`，并校验响应 `ok` 与 `path`，失败时返回明确错误，行为与 Composer 内拖拽/「+」上传一致。
- **列表与上传目录一致**：`GET /files/list` 与 `POST /files/upload`、`POST /workspace/upload` 均按**当前工作区**（请求时 `get_workspace_root()`）的 `uploads/` 目录读写；切换工作区后列表与上传目标同步，无陈旧目录。`/workspace/upload` 支持可选 `workspace_path`，与 `/files/upload` 行为一致；未传时使用当前全局工作区。

### 文件系统与 API 基址（内部/外部资源一致）

- **API 基址单源**：前端所有请求后端（文件上传、列表、读写、工作区、知识库、聊天流等）统一使用 `getApiBase()`（`lib/api/langserveChat.ts`），来源为 `VITE_LANGGRAPH_API_URL` 或运行时注入 `window.__LANGGRAPH_API_URL__`，默认 `http://127.0.0.1:2024`。unifiedFileService、electronService（Web 降级）、workspace、filesApi、Composer 上传均使用该基址，设置页修改后全局生效。
- **文件接口鉴权**：`/files/*`、`/workspace/upload` 等需内部鉴权，前端通过 `getInternalAuthHeaders()`（X-Internal-Token / Authorization）携带，与后端 `verify_internal_token` 一致。
- **路径安全**：后端 `resolve_read_path` / `resolve_write_path` 限制在项目根或工作区根下；Agent 工具 `analyze_image` 等仅允许项目根或工作区下路径，不允许用户主目录等，符合最小权限。

### 文件系统前后端同步与 Cursor 对齐

- **工作区真源（与 Cursor 一致）**：切换工作区时**先**调用 `POST /workspace/switch`，成功后再写前端 `maibot_workspace_path` 并派发 `WORKSPACE_CONTEXT_CHANGED`；失败则 toast 不写本地，避免前后端分叉。入口：设置页、WorkspaceFileTree（Electron/Web 选文件夹）。见 domain-model.mdc、product_parity_claude_cursor_cowork.md。
- **Run 时工作区**：每次发送前前端用 `resolveWorkspacePath(editorContext?.workspacePath)`（编辑器 > `maibot_workspace_path` > 后端 `/config/list`）得到 `resolvedWorkspacePath`，写入 configurable.`workspace_path` / `workspace_id`。后端 `create_orchestrator_agent` 收到后：若路径有效则 `set_workspace_root(_ws_path)`，使后续 `get_workspace_root()` 与该 run 一致；`create_backend(runtime)` 使用请求级 `configurable.workspace_path` 作为 root_dir，不依赖全局，与 Cursor 的「请求级工作区」一致。
- **列表/上传与当前工作区**：`GET /files/list`、`POST /files/upload`、`POST /workspace/upload` 均基于 `get_workspace_root()`（即最后一次 `set_workspace_root`：来自 `/workspace/switch` 或某次 run 的 workspace_path）。单窗口或「最后操作即当前工作区」场景下，列表与上传目录与用户预期一致；多窗口单进程时以「最后切换或最后 run 的工作区」为准，建议新建对话或见 main_pipeline_and_middleware_rationality.md §缓存/向量库 key。
- **session_context 不含 workspace**：流式下发的 `session_context` 仅含 threadId、mode、roleId、modelId；工作区由前端单源维护，与 Cursor 一致（不依赖服务端回带 workspace）。

---

## 7. 输入与消息长度限制（与 Cursor 一致）

- **Composer 输入**：本地镜像有 80k 字符上限（`cursor-style-composer` 的 `setInputMirrorSafe`），避免超大粘贴导致内存/崩溃。
- **发送前兜底**：Runtime 在调用 `sendMessageWithRetry` 前会检查 `messageToSend.content`；若为字符串且超过 80k 会截断后再发送，避免请求体或上下文超限。
- **Run Summary 存储**：单条 run summary 序列化后超过 32KB 时会裁剪（`recentFailures`、`lastToolResult.result_preview`、`lastError` 等）；若裁剪后仍超 32KB 则放弃写入，避免占满 localStorage。
- **工具结果预览**：流式阶段用 `TOOL_RESULT_FOR_UI` 即时展示；与消息合并后以 messages 中的 tool 结果为最终值，live 仅补空。`stream_end` / `stream_error` 时清空当前会话的 live 预览，避免内存常驻。

---

## 8. 会话标题自动生成与当前会话标识

- **标题**：仅当**本轮发送中新建的会话**（`createdThreadInThisSend`）且为首条用户消息时，自动取首条内容前 50 字设为标题并调用 `updateThreadTitle`、派发 `SESSION_CHANGED`，避免覆盖已有会话的用户自定义标题。
- **当前会话**：会话列表中的「当前」会话通过 `activeThreadId` 与列表项 `threadId` 一致来判定；已通过左侧边框、背景与「当前」标签强化展示，并设置 `aria-selected` 与 `aria-label` 含「当前会话」以利无障碍。

---

## 9. 单源与去重（避免拧麻花与隐含 bug）

- **Run Summary 同步**：WorkspaceDashboard 与 FullEditorV2Enhanced 原先各自实现一套「订阅 RUN_SUMMARY_UPDATED / SESSION_CHANGED、按 threadId 过滤、解析 detail 写入 state」。已收敛为单源：`runSummaryState.normalizeRunSummaryDetail` + `useRunSummarySync`（`lib/hooks/useRunSummarySync.ts`）。两处仅调用 `useRunSummarySync(setter)` 或 `useRunSummarySync(callback, { listenStorage: true })`，逻辑与 threadId 校验统一，避免双份实现不同步。
- **会话存储写入**：凡写当前会话 ID 均**同时**写 `maibot_current_thread_id` 与 `maibot_active_thread`（通过 `sessionState` 的 `activateThreadSession`、`emitSessionCreated`、`applyCrossWindowSessionEvent` 等）；**清空**时（`clearActiveThreadSession`、跨窗口 `session_cleared`）同时清空两键，避免清空后 `getCurrentThreadIdFromStorage()` 仍读到旧值。ErrorBoundary 的「重置」已改为调用 `clearActiveThreadSession()` 而非直接 `removeStorageItem`，保证清空时派发 `SESSION_CHANGED` 与跨窗口同步。
- **读取**：当前会话 ID 的读取统一走 `getCurrentThreadIdFromStorage()`（实现位于 `session/sessionUtils.ts`，读两 key 的 fallback；由 `sessionState`、`roleIdentity`、`runSummaryState` 等 re-export），前端所有取「当前会话 ID」处均已收敛到该函数，避免多处重复实现或键名写错。
- **Run Summary 解析单源**：凡仅需「展示 / 恢复入口」的 run summary（lastError、linkedTaskId、linkedThreadId、linkedSubject、running、phaseLabel 等）应使用 `normalizeRunSummaryDetail(readRunSummary(threadId))` 或通过 `useRunSummarySync` 订阅；App 的 `readLastRunSummary`、CommandPalette 的 recovery 上下文已改为该单源，并统一订阅 `SESSION_CHANGED`（切换会话时 recovery 上下文随当前会话更新）。
- **maibot_* 存储抽象**：凡读写 `maibot_*` 的 key 应通过 `safeStorage`（`getStorageItem` / `setStorageItem` / `removeStorageItem`），便于窗口级/多标签隔离或 key 白名单一致生效。tool-fallback 中 `maibot_plan_confirmed_thread_*` 的读写与 `maibot_plan_confirm_switch_to_agent` 的读取已改为 safeStorage，与 thread 中的清除逻辑一致。会话级 key（`maibot_plan_confirmed_thread_*`）仅当 `validServerThreadIdOrUndefined(threadId)` 有值时写入或删除，避免占位 ID 污染。
- **Plan 确认双入口与等价性**：计划确认存在两种 UI 入口，行为一致、互为等价。（1）**中断区/InterruptDialog**：当后端发出 `plan_confirmation` 中断时，在聊天区 ViewportFooter 内联展示「等待确认」提示，用户点「批准」后调用 `resumeInterrupt(threadId, 'approve')`；若配置 `maibot_plan_confirm_switch_to_agent` 为 true（默认），批准成功后同步切换为 Agent 模式并派发 `CHAT_MODE_CHANGED`。（2）**计划卡片（PlanToolUI）**：在 tool-fallback 内计划卡上点「确认执行」时，若当前存在 plan_confirmation 中断则同样调用 `resumeInterrupt` 并切 Agent；若无中断则派发 `PLAN_CONFIRMED`，由 thread 监听后发确认消息，是否切 Agent 由同一配置项决定。两处均读取 `maibot_plan_confirm_switch_to_agent`，避免一处切、一处不切。详见 `backend/docs/FOUR_MODES_DESIGN.md` 与模式设计文档。
- **工作区路径**：当前工作区路径的**读取**已全面使用 `getCurrentWorkspacePathFromStorage()`（`sessionState`），与 session 单源约定一致（Composer 上传、thread 诊断、ArtifactPanel、WorkspaceFileTree、SettingsView、NotificationCenter、useWorkspacePath、BidWizard、langgraphApi、filesApi、sessionService 等均已收敛）；写入仍由设置页、工作区文件树、useWorkspacePath 等按产品入口调用 `setStorageItem("maibot_workspace_path", path)`。WorkspaceFileTree 内 Electron/Web 打开文件夹均**先**调 `switchWorkspaceByPath`（POST /workspace/switch），成功后再写 storage 并派发 WORKSPACE_CONTEXT_CHANGED，与 domain-model 一致。文件事件订阅中 `event.source === 'ai'` 分支已加 `event.path` 判空，避免 `event.path` 缺失时 `.split` 报错。
- **run_error 契约**：后端通过流事件 `run_error` 下发 `error_code`、`message`；前端统一用 `toolStreamEvents.parseRunErrorPayload(d)` 解析，并对 `error_code`/`message` 做防御性归一（有值则 `String(...)`，null/undefined 保持 undefined），便于 502、context_exceeded 等分支正确命中。错误码一览与排查见 `docs/ERROR_CODES_AND_TROUBLESHOOTING.md`。

### 前端（性能与刷新单源）

- **步骤时间线 / 思考区**：`steps_updated` 与 `CURRENT_RUN_REASONING_UPDATED` 的消费端均用 **requestAnimationFrame** 合并同帧更新，避免流式时每事件一次 setState；步骤在 thread 内订阅后从 `getStepsForThread(currentId)` 取最新再写 state，思考区在 useThreadStreamState 用 ref + RAF 节流后 setCurrentRunText。
- **工具流订阅**：凡只关心单一或少量事件类型的 UI，应使用 `toolStreamEventBus.on(eventType, handler)` 按类型订阅，避免 `onAll`；仅 runSummary（需处理 stream_start/stream_end/tool_result 等多种类型）保留 onAll + RAF 批处理。useAgentProgress、useNativeReasoningBlocks（reasoning 流）、tool-fallback 各工具卡、ArtifactPanel 已改为按类型订阅。
- **文件树刷新**：WorkspaceFileTree 内 `loadFileTree`（后端树）与本地树刷新均 **200ms 防抖**；`workspaceService.subscribe` 与两处 `fileEventBus.subscribe` 统一调用防抖函数，避免事件风暴下多次全量刷新。本地树刷新用 ref 持有最新 workspaceFolders/localWorkspacePath，防抖回调内再读 ref 调用 loadLocalFileTrees/loadLocalFileTree。
- **消息列表虚拟化**：消息数 ≥ 30 时使用 ProgressiveThreadMessages（虚拟列表），阈值常量 `VIRTUAL_LIST_MESSAGE_THRESHOLD` 在 thread.tsx。
- **非紧急 UI**：步骤时间线、思考区展示使用 `useDeferredValue`（thread 内 deferredExecutionSteps、AssistantMessage 内 deferredReasoningBlocks），减轻流式更新对输入/滚动的阻塞。新增高频展示状态时优先考虑 RAF/防抖或 useDeferredValue，避免拧麻花式「每事件 setState」。
- **Run Summary 与当前会话**：run summary 写入时 `payload.threadId` 与 `writeRunSummary(..., preferredThreadId)` 使用同一 `effectiveThreadId`（activeThreadId ?? getCurrentThreadIdFromStorage() ?? ""），避免存盘 key 与 payload 不一致。TOOL_RESULT_FOR_UI、TASK_PROGRESS 等按会话过滤时统一用「activeThreadIdRef + getCurrentThreadIdFromStorage 回退」判定当前会话，避免 ref 未同步时误判。
- **Composer 输入同步**：凡调用 `composerRuntime.setText(...)` 的地方须同步更新 `inputValueRef` 与 `setInputMirrorSafe`，保证 `composerText = inputMirror !== "" ? inputMirror : composerTextFromStore` 与真实输入一致。enqueue 后清空（Enter 发送到队列、队列按钮）已补全 `setInputMirrorSafe("")` 与 `inputValueRef.current = ""`，避免清空后界面仍显示旧内容。
- **Composer 附件派发防抖**：批量上传时 `CONTEXT_ITEMS_CHANGED` 使用 200ms 防抖（`scheduleContextItemsDispatch`），保留逐文件 `setContextItems` 以维持进度展示；发送前同步（flushContextBeforeSend）、清空（MESSAGE_SENT）仍立即派发。
- **工具卡已运行时长**：`useToolElapsedSeconds` 定时器间隔为 2s，减少多张工具卡时的定时器数量与回调频率。
- **文件树轮询**：WorkspaceFileTree 多文件夹与单文件夹轮询间隔均为 5s，降低 IO/CPU；指纹未变时不 setState。
- **Loading 延迟显示**：TaskListSidebar、thread-list 历史下拉、ThreadWelcome 欢迎语使用 200ms 延迟再显示 loading spinner（showLoadingSpinner），避免快速完成时闪烁；WorkspaceFileTree 已有同类逻辑。
- **已运行时长定时器统一 2s**：RunTracker ElapsedTimer、tool-fallback 内 TaskToolUI（subagent）的 elapsed 定时器与 useToolElapsedSeconds 一致为 2s，减少多卡片时的定时器数量。
- **多窗口列表轮询**：FullEditorV2Enhanced 内「多窗口」Popover 打开时轮询间隔为 5s（与文件树一致），降低 Electron 调用频率。
- **WorkspaceFileTree 卸载防护**：loadWorkspaces、loadFileTree、loadLocalFileTree、loadLocalFileTrees 及轮询回调中 setState/toast 前检查 `mountedRef.current`，避免卸载后 setState。
- **ArtifactPanel 批量更新**：收到 artifact 事件时用 `React.startTransition` 包裹 setItems + setActiveItemId + setOpen，减少连续三次 setState 导致的多次渲染。
- **空 catch 可观测**：MyRuntimeProvider TOOL_RESULT_FOR_UI 派发、MindmapViewer destroy 等空 catch 改为 DEV 下 `console.warn`，便于排查。
- **useNativeReasoningBlocks**：effect 内 `!effectiveThreadId` 时 early return 显式返回 `() => {}`，避免误读为缺少 cleanup。
- **Composer 发送前防抖取消**：flushContextBeforeSend 内先取消未执行完的 CONTEXT_ITEMS_CHANGED 防抖定时器，再派发最新 contextItemsRef，确保「刚添加附件就发送」时 runtime 收到最新附件。
- **异步 setState 卸载防护**：WorkspaceFileTree 的 loading 延迟 effect、Electron 选目录流程；MCPManager 的 fetchBackendMCP/fetchStatus/startServer/stopServer/stopAll/startTemplate；MemoryPanel 的 fetchEntries、profile 拉取、handleDelete/handleAdd/handleUpdateEntry/handleCleanup；AgentCapabilities 的 fetchProfile、listRoles；KnowledgeBasePanel 本体 Tab 的 load、stats 拉取；UpgradeControlCard 的 loadStatus/loadRuns/bootstrap/handleCheck/handleTrigger；KnowledgeGraphView 的 loadGraph。上述异步回调中 setState/toast 前均检查 `mountedRef.current`（或 ontologyMountedRef/stoppedRef），避免卸载后更新。

### 后端

- **configurable 只读防护**：`deep_agent.create_orchestrator_agent` 内对请求 `configurable` 做 `_cfg = configurable if isinstance(configurable, dict) else {}`，所有只读 `.get()`（如 `web_search_enabled`、`_tool_schema_deferred`、`skill_profile`、`workspace_path`）统一用 `_cfg`，避免 `configurable` 为 None 或非 dict 时 AttributeError；写入仍用原 `configurable`，调用方需保证传入可写 dict。
