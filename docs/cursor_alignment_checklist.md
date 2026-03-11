# Cursor 逐项对比结果

与「Cursor 差异检查与对齐」计划对应，记录聊天区与 Cursor 的逐项对比结论与修改点。以 Cursor 实际界面为基准核对时，更新本表。

## 2.1 Footer 运行条与 Todo（Composer 上方）

| 项 | 结论 | 修改点/备注 |
|----|------|-------------|
| 状态行显示条件 | 一致 | 已改为仅在有 steps 或 todos 时显示：`showRunStrip = runtimeRunning && taskRunningFromEvent !== false && (hasSteps \|\| hasTodos)`，避免无任务时显示空条。thread.tsx L1620-1621。 |
| 状态行样式 | 一致 | 高度 min-h-6、text-[11px]、Loader 为 violet-500，与 UI_CURSOR_STYLE_SPEC 一致。 |
| 状态色统一（running/completed） | 一致 | 全聊天区 running 统一为 violet（RunTracker 进度条/转圈、Plan 执行按钮、generative-ui 步骤、tool-fallback 执行中面板/任务进度）；completed 统一为 emerald。链接/文件语义仍用 blue。 |
| Todo 按钮与展开 | 一致 | 仅 hasTodos 时显示 RunTodoSummaryButton；展开时显示 RunTodoListCard，与 Composer 同卡内。 |

### Run 状态双源约定（勿删其一）

- **显示条件**：运行条与「运行中」状态依赖两源 **AND**：(1) SDK 源 `useRuntimeRunning()`（thread store `status?.type === "running"`）；(2) 事件源 `task_running` CustomEvent（MyRuntimeProvider 在 stream 入口派发 `running: true`，在 runStreamCleanup 中派发 `running: false`）。`showRunStrip = runtimeRunning && taskRunningFromEvent !== false && (hasSteps || hasTodos)`。
- **队列 drain 双路径**：运行结束时 (1) `runtimeRunning` 由 true→false 时触发 messageQueue 队首发送；(2) `taskRunningFromEvent === false` 且队列非空时，300ms 延迟再 drain 一次（防止 SDK 未及时清除导致排队消息永不发送）。两路径为刻意双保险，不得删其一。
- **若改为单源**：若未来仅保留 SDK 单源，须确认 SDK 在 stream 结束/取消时立即将 `status.type` 置为非 running，再移除 `task_running` 事件逻辑；否则会出现空闲仍显运行或队列不 drain。

## 2.2 Composer 输入区

| 项 | 结论 | 修改点/备注 |
|----|------|-------------|
| 占位符 | 已按 Cursor 核对并统一 | 改为单一句、i18n `composer.placeholder`（中/英），不轮换。cursor-style-composer.tsx。 |
| 发送/停止按钮 | 一致 | 输入框右侧、图标与禁用态已统一；aria-label 已配置。 |
| 附件/上下文芯片 | 待产品以 Cursor 核对后定稿 | 当前实现：Composer 内上下文为一行多 chip（ContextItemChip），每项可单独删除；支持文件/路径/选区/代码片段；附件区为 ComposerAttachments + ComposerAddAttachment（attachment.tsx）；有编辑器选区时显示「已选中 N 行代码」。待产品以 Cursor 实际界面核对后，若为折叠（如「已选 N 个文件」）或不同布局再调整。cursor-style-composer.tsx、attachment.tsx。 |
| 模式/角色/模型选择器 | 一致 | 输入框上方同一行，下拉样式已统一。 |
| 窄屏布局 | 一致 | min-w-0、overflow-hidden 已加，防止横向溢出。 |

### 附件/上下文芯片：当前实现与真机核对要点

- **组件**：ContextItemChip（单条 chip 展示与删除）、ComposerAttachments + ComposerAddAttachment（attachment.tsx）负责附件区与添加入口。
- **交互**：一行多 chip 平铺，每项可单独点击删除；有编辑器选区时展示「已选中 N 行代码」并可加入上下文。
- **类型**：支持文件、路径、选区、代码片段；与 Cursor 待核对是否一致。
- **与 Cursor 待核对**：布局为平铺多 chip 还是折叠「已选 N 个文件」、文案与删除/清空方式是否一致。

| 核对要点 | 本系统当前 | Cursor 真机核对（勾选后填结论） |
|----------|------------|--------------------------------|
| 布局 | 一行多 chip 平铺 | □ 一致 / □ 折叠「已选 N 个文件」等，需改：____ |
| 文案 | 「已选中 N 行代码」 | □ 一致 / □ 不同表述，需改：____ |
| 删除/清空 | 每 chip 可单独删除 | □ 一致 / □ 整组清空等，需改：____ |
| 类型支持 | 文件 / 路径 / 选区 / 代码片段 | □ 一致 / □ 有差异，需改：____ |

## 2.3 消息区

| 项 | 结论 | 修改点/备注 |
|----|------|-------------|
| 聊天内容显示与交互 | 已核对 | 业务逻辑：流式 content_parts 先文后工具、messages/complete 合并 ToolMessage 进 part.result；UI：消息间距/正文/代码块/思考块/工具卡/本消息依据/操作栏与滚动已对齐，详见本表下列项。 |
| 思考块样式 | 一致 | 左侧竖线、圆角、展开/收起箭头；「已思考 N 秒」；思考中仅 InlineThinkingBlock 内 Loader2Icon（violet）。 |
| 推理流展示 | 一致 | 后端 reasoning phase=start/content/end；前端 store + CURRENT_RUN_REASONING_UPDATED → useNativeReasoningBlocks → InlineThinkingBlock；session_context threadId 兜底、流开始/phase=start 清空；模型需提供 additional_kwargs.reasoning_content（或 reasoning/thinking）。见 tool_display_cursor_alignment.md §8。 |
| 工具卡片顺序 | 一致 | 后端下发 content_parts（按执行顺序），前端 SDK 优先用其生成 content，实现正文与工具穿插；ToolGroupBlock 按 part 顺序逐条展示。 |
| 按步展示（思考→工具→结果） | 已落实 | reasoning 以 content part（type: "reasoning"）进入 content_parts，run 级累积、flush 时与文本/tool-calls 同序下发；前端 patch 保留 reasoning part，消息区按 part 顺序渲染（ReasoningBlock 与 InlineThinkingBlock 一致 8s 延迟折叠），实现「步骤1（思考→工具→结果）→ 步骤2（…）」与 Cursor 一致。 |
| 消息完成时 result 合并 | 一致 | messages/complete 与 **updates** 时 MyRuntimeProvider 均对 messages 调用 mergeToolResultsIntoAiMessages，将 ToolMessage 按 tool_call_id 合并进上一条 AI 的 tool-call part.result；SDK 以 updates 收尾时工具卡与证据区也能拿到 result（修复「搜索/知识库无内容」）。 |
| 聊天区「先文后工具」穿插 | 一致 | 由后端 content_parts 顺序 + 前端 merge 后 content 统一为 parts 数组保证，无拧麻花。 |
| 工具卡与证据区 result 单源 | 一致 | merge 写入 part.result，SDK 与证据区均从 part/兜底（next.result ?? next.content）读取，无第二套来源。 |
| 空工具卡 | 一致 | 无 keyInfo、无 result、非 running 时 ToolFallback 显示「已执行 &lt;工具名&gt;」（isEmptyCard）。 |
| 末尾空卡片合并 | 一致 | 同一消息末尾连续多个空卡片时 ToolGroupBlock 合并为一条「已执行 N 个工具：工具A、工具B、…」（thread.sourcesSummary.executedCount），避免成片「已执行 xxx」。thread.tsx ToolGroupBlock。 |
| 代码块复制 | 一致 | 右上角 hover、aria-label 已满足 a11y_checklist。 |
| 日期分隔 | 已按 Cursor 核对并统一 | Today/Yesterday + `thread.dateShort`（中文「M月D日」、英文「Mar 7」），i18n 已配。thread.tsx getDateLabel、i18n。 |
| 消息区水平间距与对齐 | 已微调 | 用户消息容器 px-3、助理消息 mx-3 px-2.5、日期分隔 px-3，与 Cursor 对称一致。thread.tsx UserMessage/AssistantMessage/DateDivider。 |
| 回到底部按钮出现条件 | 已核对 | 使用 ThreadPrimitive.ScrollToBottom + badgeCount，仅在有新消息且用户未在底部时显示。thread.tsx ThreadScrollToBottom 约 L1896-1924。 |
| 断行修复 | 已落实 | 后端 _flush_run 将 content_str 合并到最后一个 text part 而非每次追加新 part，避免多 text part 导致前端断行。main_graph.py。 |
| 流式光标唯一 | 已落实 | 光标选择器限制为 .aui-assistant-message-content .aui-md:last-of-type，仅最后一块正文显示 ▋；工具卡内 PythonRunRender 改为「...」执行中提示。globals.css、tool-fallback.tsx。 |
| 工具卡进度条 | 已落实 | 去掉 ToolFallback 与任务工具内条状进度（w-2/5、elapsedSec 条），仅保留步骤点/点点/spinner，与 Cursor 一致。tool-fallback.tsx。 |
| Interrupt 与 ask_user 单入口 | 一致 | 有 ask_user 进行中时不展示 InterruptDialog，避免「聊天区内联 Ask + 弹窗」双入口；聊天区使用 InterruptDialogGuard variant="inline」。AskUserToolUI 提交时调用 resumeInterrupt + INTERRUPT_RESOLVED 接流续显，见 cursor_claude_cowork_behavior_analysis.md §3。InterruptDialogGuard.tsx、tool-fallback.tsx。 |

## 2.4 工具展示与命名

| 项 | 结论 | 修改点/备注 |
|----|------|-------------|
| getToolDisplayName | 一致 | tier 内工具已全覆盖，未知工具 snake_case 兜底。tool-fallback.tsx、tool_display_cursor_alignment.md 已标已落实。 |
| getPartKeyInfo | 一致 | 已覆盖 list_directory、doc_path、paths、file_paths、directory、query、pattern、search_query、q、url、website、source、command、code/script（python_run）、goal（plan）、question、description 等；grep_search 支持 pattern+path；web_search 可选 num_results/max_results「最多 N 条」。与 Fallback 统一，思考/工具/搜索/读写/编辑/代码运行等环节均有关键参数展示。 |
| 搜索/检索详情 | 一致 | WebSearchToolUI 首行「搜索 · 关键词 · 网站」+ 完成时「N 条结果」；SearchKnowledgeToolUI/GrepSearchUI 首行「查询/pattern · 范围」+ 结果条数/首条摘要；extractResultSummary 对 web_search 取首条非 URL 行+URL、search_knowledge/grep 条数+首行摘要。 |
| 本消息依据详细内容 | 一致 | MessageEvidenceSummary 展开项含 toolDisplayName、keyInfo、resultSummary、resultPreview（约 120 字，允许 2～3 行）；空项显示「已执行」。result 存在但 resultSummary 为空时用首行/前 60 字兜底。extractResultSummary 已覆盖 write_file/edit_file、analyze_document、file_search 及 ToolFallback 首行兜底，保证各环节有充分内容显示。result 来源：messages/complete 与 updates 时均已合并进 part.result，ToolResultsByMessageIdContext 兜底。thread.tsx、tool_display_cursor_alignment.md §7。 |
| 工具卡样式 | 已微调 | ToolFallback 非空卡使用 rounded-lg、border/20、bg-muted/5，与 Cursor 卡片风格一致。tool-fallback.tsx。 |
| 证据区错误与策略 | 已落实 | extractResultSummary/extractResultPreview 解析错误/策略 JSON 与纯文本；证据项展示「未通过：reason_text」；证据项可展开本条更长预览。thread.tsx、tool-fallback.tsx。 |
| 工具失败分类与标签 | 已落实 | failureClassifier 增加 policy 类（permission_denied、被拦截、LicenseGate、MCPPermission 等）；解析 reason_text 作为 hint；工具卡错误态显示「策略限制」「权限限制」标签。tool-fallback.tsx、i18n。 |
| 搜索/检索首屏与默认展开 | 已落实 | WebSearchToolUI 首行「首条：标题/snippet」、≤5 条默认展开、无 result 时「结果未返回，请重试」；SearchKnowledgeToolUI 首行摘要、有结果时默认展开。tool-fallback.tsx。 |
| 未知工具与步骤条命名 | 已落实 | getToolDisplayName 对 mcp_ 前缀返回「MCP · 可读名」；步骤条 label 用 getToolDisplayName(toolName) 统一。tool-fallback.tsx、MyRuntimeProvider.tsx。 |
| 工具结果展示单源与兜底一致 | 已落实、已复核 | 主路径 part.result（仅 MyRuntimeProvider.mergeToolResultsIntoAiMessages 在 messages/complete 与 updates 时写入）；证据区与工具卡读取 part.result，缺省时用 toolResultsByMessageId（由同 store 的 threadMessages 按 AI+Tool 顺序构建，与 merge 识别一致）。无第二套 result 来源。后端三处 id 同源见 tool_display_cursor_alignment.md §7。 |
| 工具审批（diff+接受/拒绝） | 一致 | 需确认工具（write_file、edit_file、delete_file、shell_run、python_run）在聊天区内联展示 diff/预览及接受/拒绝按钮（InterruptDialog tool_diff_approval）；不采用弹窗。自治等级与 auto_accept_tools 见 execution_policy_and_permissions.md §6、设置页「自治等级」与「默认接受以下工具」。 |

## 2.5 错误与重试

| 项 | 结论 | 修改点/备注 |
|----|------|-------------|
| 消息内错误 MessageError | 一致 | inline、可展开详情、复制、重试/诊断按钮已具备。 |
| Composer 上方 ErrorToast | 一致 | 出现时机与关闭方式；文案建议保持「原因 + 建议下一步」结构。 |
| Run 失败 RunSummaryCard | 一致 | lastError 与打开任务/重试/诊断入口；Footer 为精简状态行，RunSummaryCard 用于非 nested 场景。 |
| Run 完成结果汇总 | 已落实 | stream_end (reason=complete) 时 toast「本轮完成」/「共 N 个工具」，写入 lastRunSummary（toolCount、errorCount、filePaths）；RunSummaryCard 有 lastRunSummary 时保持可见并展示汇总行；切换会话时清除。见 cursor_claude_cowork_behavior_analysis.md §5、thread.tsx、RunTracker.tsx。 |

## 2.6 会话/线程与状态同步

| 项 | 结论 | 修改点/备注 |
|----|------|-------------|
| 切换会话后状态 | 一致 | steps/todos 按 threadId 从 getStepsForThread 恢复；Footer、Composer 随当前 thread 展示。domain-model.mdc 会话键优先已约定。切换会话时 executionSteps 从 getStepsForThread(effectiveThreadId) 恢复；runSummary 从存储恢复且归属校验失败时重置为默认态，避免显示它会话状态。 |
| 多会话 run 绑定 | 一致 | 当前 run 的 steps/reasoning 与 threadId 绑定，无串线。 |

### 会话状态写入契约（审计结论）

- **写入点**：`maibot_current_thread_id` / `maibot_active_thread` 仅在 sessionState（activateThreadSession、emitSessionCreated、clearActiveThreadSession、applyCrossWindowSessionEvent）中写入，均使用传入的 threadId 或清空为 ""。
- **SWITCH_TO_THREAD 乐观同步**：收到 `SWITCH_TO_THREAD` 时 MyRuntimeProvider 立即调用 `activateThread(threadId)`，写入存储并派发 `SESSION_CHANGED`，不等待 SDK `load(threadId)` 完成，保证仪表盘/侧栏/Composer 等依赖会话键的 UI 与当前线程一致。
- **会话键**：`maibot_chat_mode_thread_*`、`maibot_active_role_thread_*` 通过 setScopedChatMode / setScopedActiveRoleIdInStorage 写入；两函数均使用 `preferredThreadId ?? getCurrentThreadIdFromStorage()`，保证写的是「当前会话」或显式传入的 threadId。
- **session_context**：MyRuntimeProvider 仅在 `currentThreadIdRef.current === threadId` 时写 setScopedChatMode / setScopedActiveRoleIdInStorage，避免误写它会话。
- **结论**：所有写入口均在「已知当前或目标 threadId」下写对应会话键或全局默认键，无未校验 threadId 写它会话键的情况；多入口写同一会话（如 session_context 与 Composer 同时写 mode）使用同一 threadId，结果一致。

## 2.7 提示词动态加载与 token 效率

| 项 | 结论 | 修改点/备注 |
|----|------|-------------|
| module_loader 工作区来源 | 已落实 | prompt_cfg.workspace 使用请求级 configurable.workspace_path 解析，deep_agent 中 _ws_root 优先 _request_ws，避免并发错用。 |
| Ask 模式减负 | 已落实 | _dispatch_layer4_budget 在 mode=ask 时 skills_ratio=0.15，减少 Layer 4 skills 占比以省 token。 |
| prompt_assembly 默认行为 | 已落实 | 工作区无 .maibot/prompt_assembly.json 时使用空配置、不加载扩展模块；module_loader.assemble 文档字符串已说明，可从仓库 .maibot/prompt_assembly.json 复制到工作区获得完整行为。 |

## 2.8 编辑区与工作区

| 项 | 结论 | 修改点/备注 |
|----|------|-------------|
| prompt_cfg.workspace 请求级 | 已落实 | deep_agent 中 _ws_root 优先从 configurable.workspace_path 解析（_request_ws），无有效值时再回退 get_workspace_root()，与 create_backend 一致。 |
| Backend root_dir 请求级（工作区并发） | 已落实 | create_backend(runtime) 优先从 runtime.config.configurable.workspace_path 取工作区根；缺失或无效时使用闭包 _ws_root（创建 Agent 时解析），不再调用 get_workspace_root()，避免并发请求下文件工具用错工作区。deep_agent.py。 |
| 工作区切换后 run 归属 | 一致 | WORKSPACE_CONTEXT_CHANGED 时 MyRuntimeProvider 派发 NEW_THREAD_REQUEST 并 toast 建议新建对话；thread-list 按 metadata.workspace_path 过滤。 |
| 文件树与后端 scope | 已落实 | 文档 execution_policy_and_permissions.md §8 明确：所有编辑区/工作区文件操作以当前工作区为根；文件树与后端 API 均以 maibot_workspace_path 为 scope。 |
| 文件系统前后端同步 | 已落实 | 工作区切换先 POST /workspace/switch 再写前端；run 时 configurable.workspace_path 由 resolveWorkspacePath 传入，后端 set_workspace_root + create_backend 请求级 root；/files/list、上传用 get_workspace_root() 与之一致。详见 ux_and_ops_notes.md §6「文件系统前后端同步与 Cursor 对齐」。 |

## 2.9 五模式与 Diff

| 项 | 结论 | 修改点/备注 |
|----|------|-------------|
| Plan 确认单一路径 | 已落实 | PlanToolUI「确认执行」优先检测 getInterruptState；若为 plan_confirmation 则 resumeInterrupt(approve) + setScopedChatMode('agent')；否则派发 PLAN_CONFIRMED 走发新消息回退。tool-fallback.tsx。 |
| 确认执行消息与 plan_file_path | 已落实 | deepagent_execute_node 内不论 mode：最后一条人类消息含「确认执行」且 execute_config 仍无 plan_file_path 时，用 _resolve_plan_path_for_thread 解析并合并 plan_phase/plan_confirmed/plan_file_path，保证路径 B 回退时执行阶段也能拿到计划。main_graph.py。 |
| Slash /ask | 已落实 | MyRuntimeProvider 中 /ask 与 /plan、/debug、/review 对称：switchModeFromSlash('ask') + 改写内容；executeBackendSlash 支持 switch_mode.mode===ask；cursor-style-composer 的 slash 建议列表增加 `/ask`。 |
| Apply 与 diff 统一 | 已落实 | generative-ui CodeUI handleApply：Apply 前 readFile 取原内容，writeFile 后派发 OPEN_FILE_IN_EDITOR（path、showDiff: true、diffOriginal、diffContent: 新内容），便于编辑区在文件已打开时展示「原 vs 新」对比；与 markdown-text 代码块 Apply 一致。generative-ui.tsx。 |
| EditFile 在编辑器中打开带 diff | 已落实 | EditFileToolUI「在编辑器中打开 (diff)」：有 old/new 时派发 OPEN_FILE_IN_EDITOR（path、showDiff、diffOriginal、diffContent），无 diff 时仅 fileEventBus.openFile。tool-fallback.tsx。 |
| session_context 与模式展示 | 一致 | run 开始时后端下发 session_context（threadId、mode、roleId）；前端仅当 threadId 与当前会话一致时 setScopedChatMode 并派发 CHAT_MODE_CHANGED，模式角标与 Composer 随会话同步。MyRuntimeProvider.tsx。 |
| 4 种 vs 5 种模式 | 已注明 | Cursor 常见 4 种（Agent/Ask/Plan/Edit），本系统 5 种（扩展 Debug、Review）；行为上 Ask 只读、Plan 先规划后执行、Agent 全量执行与 Cursor 一致。详见 mode_vs_command_parity.md「模式数量」节。 |
| 确认在聊天内（会话内继续） | 已落实 | 确认发生在聊天 UI 内部：plan_confirmation 时 Footer 仅简短提示（thread.waitingConfirmation*），主操作在 Plan 卡内；tool_diff_approval 时 Footer 仅简短提示，WriteFile/EditFile 工具卡内展示 diff + 接受/拒绝。InterruptStateContext 单源：Thread 持 state+setState，InterruptDialog 为唯一轮询方并写回 Context，工具卡只读 ctx.state，无重复轮询。等待确认 = 本次回复未结束、确认后继续（HITL 机制为同一 run 内 resume）。可选「已写入再确认」见 plan。 |
| 编辑区 diff 接受并保存 | 已落实 | 编辑区「接受」按钮：清除 diff 状态后调用 handleSaveFile(activeFile.id)，将当前内容写入磁盘并 toast；拒绝仍仅恢复 diffOriginal 到缓冲区、不写盘。FullEditorV2Enhanced.tsx。 |

## 回归

- 修改后执行 E2E 3.1.1（运行状态与步骤展示）、7.4（思考/流式/工具/UI），确保已有通过项不倒退。
- 本表与 [E2E_FUNCTIONAL_TEST_PLAN.md](E2E_FUNCTIONAL_TEST_PLAN.md)、[a11y_checklist.md](a11y_checklist.md)、[tool_display_cursor_alignment.md](tool_display_cursor_alignment.md) 同步更新。
- **全系统 Cursor 业务逻辑对齐检查**：按「全系统 Cursor 业务逻辑对齐检查计划」执行门禁脚本（check:events/session-state/session-flow/role-mode-contract/slash-mode/task-entry）及后端 test_middleware_chain_consistency、test_reasoning_stream_contract；2.1–2.11 逐区代码核对通过。仅 2.2 附件/上下文芯片仍为「待产品以 Cursor 核对后定稿」（当前实现说明已写入本表）。对标 Claude/Cowork：/suggestions/work 动态化（mode/thread_id）、插件命令冲突提示与命名规范已落实，见 product_parity_claude_cursor_cowork.md、claude_cowork_parity_scorecard。
- **全面检查与优化（2026-03-06）**：按「Cursor Claude Cowork 全面检查与优化」计划执行审计。审计结论：Composer/消息区/Footer/编辑区/工作区均与 checklist 一致（EVENTS.MESSAGE_SENT、showRunStrip、drain 双保险、SESSION_CHANGED/maibot_workspace_path、无 thread_changed 字面量）；无新增必做修复项。P1 已落实：WorkspaceFileTree 关键路径静默 catch 收敛——`loadFileTree` 与 `loadWorkspaces` 失败时增加 toast（workspace.fileTreeLoadFailed / workspace.listLoadFailed），i18n 中英已配。
- **全面对齐计划实施**：Run 状态双源与 drain 双路径约定、工作区 Web 路径先后端后写入、会话状态写入契约审计、工具 result 单源复核已写入本表；Composer 角色列表加载失败增加 toast（composer.rolesLoadFailed），i18n 中英已配。

## 与 Cursor 剩余差距汇总

便于产品与真机核对的差距清单（逐项说明与建议）见 [高可靠副驾驶对标检查结果_2026-03-09.md](高可靠副驾驶对标检查结果_2026-03-09.md) **五、进一步优化检查结果** 之 **5.3 与 Cursor 差距清单**。汇总类型包括：待产品定稿（附件/上下文芯片 §2.2）、待人工核对（编辑区回写 run、先执行再确认）、已知差异可接受（4 vs 5 模式、命令即模式等价）。**真机核对检查表**（可勾选核对要点与结论栏）见同报告 **5.4 与 Cursor 真机核对检查表**。
