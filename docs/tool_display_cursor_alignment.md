# 聊天区工具展示与 Cursor 对齐说明

## 0. 聊天区设计原则（与 Cursor/Claude 对齐）

- **聊天区的本质**：Agent 内有大量工具与动作；聊天区把这些**工具与动作做合理组合与表达**，呈现给用户。这就是聊天区的表现形式。
- **让聊天区「会说话」**：聊天区是在**替 LLM 说话**——展示 LLM 的思考、执行、产出与追问，而不是错误地组织一堆外壳逻辑。
- **充分释放 LLM**：聊天区提供**用户与 LLM 交互的平台**；**交互的内容 = 任务与信息**（当前在做什么、用了什么、得到什么、计划什么、需要用户什么）。
- **对标**：Claude / Cursor / OpenClaw 均按此设计——**一条连贯的叙事**（思考 → 工具 → 结果 → 总结/计划/结论 → 下一步 / ask_human），而非多套互不关联的 UI 壳。实现与迭代时须避免引入双源或重复壳，保持「一条消息一条叙事」。

### 0.1 叙事一致性复核结论

- **后端**：`content_parts` 仅在一处构造（`main_graph.py` 的 `_TokenStreamHandler._flush_run`），顺序为 reasoning → text → tool-calls，run 级累积后下发。
- **前端**：仅在一处用 `content_parts` 生成 content（patch 的 `contentPartsToMerged` + appendLangChainChunk）；`MessagePrimitive.Parts` 按该顺序渲染。
- **工具结果**：仅在一处写入 `part.result`（MyRuntimeProvider 的 `mergeToolResultsIntoAiMessages`，在 messages/complete 与 updates 时）；工具卡与「本消息依据」均读 part.result 或同一兜底。
- **结论**：整条链路上无破坏「一条消息一条叙事」的二次来源或顺序错乱；后续改动不得新增 content 或 result 的第二来源。

### 0.2 整体视觉与信息层次（Cursor 式）

消息区水平间距（用户消息 px-3、助理消息 mx-3 px-2.5、日期分隔 px-3）、正文字号行高（14px、leading-1.65）、Footer 状态行条件与样式（min-h-6、text-[11px]、violet/emerald）、回到底部按钮出现条件已按 [cursor_alignment_checklist.md](cursor_alignment_checklist.md) §2.1–2.3 落实；优化时仅做最小样式微调，不改双源与 drain 逻辑。

### 0.3 聊天区数据流与模块职责（单源、防拧麻花）

- **后端消息来源（二选一，不并存）**
  - **TokenStreamHandler（callback）**：LLM 流式 token 时 `on_llm_new_token` → `_flush_run` 发送 `messages_partial`，payload 含 `content_parts`（run 级累积：reasoning → text → tool-calls，多次 flush 会形成多段 text/reasoning）。
  - **Chunk fallback**：仅当 callback 从未发过 partial 时（`not _effectively_has_realtime`），astream 的 AIMessageChunk 经 chunk 路径发送 `messages_partial`，payload 含 `content_parts`（当前 chunk 的 reasoning + 当前累积 text + tool-calls）。同一 run 内只会有一种来源。
- **前端事件来源**
  - **Custom**：后端 writer 发出的 `messages_partial` 以 custom 事件到达；前端**必须保留** `content_parts` 并 yield 为 `messages/partial`，且**不能**因「主通道已 yield」而跳过（否则思考/正文被丢）。判定「必须展示」条件：`hasToolCalls || hasToolOrToolMessage || hasContentParts`。
  - **主通道**：LangGraph 的 `messages/partial` / `messages/complete`；partial 时前端用 `preparePartialChunkPayload` 剥离 `content_parts`，走 SDK 的 content + tool_call_chunks 追加分支。
- **前端单源约定**
  - **Merge**：仅 `mergeToolResultsIntoAiMessages` 一处逻辑负责把 ToolMessage 写入 AI 的 tool-call part.result；调用点：custom messages_partial、主通道 partial/complete、updates、loadWrapped。有 `msg.content_parts` 时优先用其生成 contentParts（保留 reasoning），否则从 content + tool_calls 生成。
  - **SDK**：`appendLangChainChunk` 收到 `curr.content_parts` 时用 `contentPartsToMerged` **替换**整条 content；`contentPartsToMerged` 内合并连续 text、连续 reasoning，避免断句与思考块割裂。
  - **Complete 保底**：若主通道 `messages/complete` 的 message 无 reasoning，用 `lastContentPartsByMessageIdRef` 缓存的 content_parts 恢复，避免终态覆盖丢失思考。
- **展示单源**
  - **思考**：若 `message.content` 中已有 `type === "reasoning"` 的 part（来自 content_parts），仅由 `MessagePrimitive.Parts` 的 `Reasoning` 组件渲染，不展示 InlineThinkingBlock（事件思考块）；若无原生 reasoning part，才用 InlineThinkingBlock + 事件/解析思考块。
  - **正文与工具**：一律由 `MessagePrimitive.Parts` 按 content 顺序渲染（Text / Reasoning / ToolGroup）；工具结果来自 part.result（merge 写入）或 toolResultsByMessageId 兜底。

## 1. Cursor 的做法是否应该效仿？

**是的。** Cursor 对每个工具在聊天区的展示都做了针对性设计，目的是：

- **让用户清楚「用了什么」**：工具名 + 关键参数（路径、查询、命令等）在卡片标题或首行可见。
- **让用户清楚「结果如何」**：完成时显示结果摘要或关键信息，支持展开看完整输出。
- **状态与操作清晰**：运行中/成功/失败一目了然；支持复制、重试、打开文件等操作。

这样用户既能理解 AI 在做什么，也能在出错时快速定位并复现，符合「可解释、可操作」的体验目标。

**需审批工具（Cursor 一致）**：write_file、edit_file、delete_file、shell_run、python_run 等在需确认时于**聊天区**展示执行详情（文件类为 diff，命令/代码类为预览），并提供接受/拒绝按钮；不采用弹窗。配置 `autonomous.auto_accept_tools` 与自治等级（L0–L3）可控制默认接受策略。见 execution_policy_and_permissions.md §4、§6。

## 2. 本系统当前能力

- **按工具定制 UI**：已为多数工具注册专用组件（如 ReadFileToolUI、WriteFileToolUI、EditFileToolUI、WriteFileBinaryToolUI、PythonRunToolUI、WebSearchToolUI 等），在 `thread.tsx` 的 `ThreadPrimitive.Root` 下挂载；未注册工具走通用 `ToolFallback`。
- **展示层级（tier）**：`toolTier.ts` 将工具分为 hidden / process / action / interactive / result，用于控制是否在步骤条、证据摘要中展示。
- **通用 Fallback**：`ToolFallback` 已具备：工具名、关键参数摘要（keyInfo）、运行中 livePreview、结果摘要、展开/收起、复制/重试、错误分类与恢复提示。
- **过程工具合并**：`ProcessToolsSummary`、`ProcessToolInfoCard`、`MessageEvidenceSummary` 等对「过程型」工具做合并或单条摘要，避免刷屏。
- **计划/任务卡片 i18n**：计划卡片（制定计划、执行计划、复制计划、确认执行、修改计划、取消计划）与任务进度（任务进度、进行中、复制任务列表）等文案已接入 i18n（`toolCard.*`、`thread.plan*Failed`、`common.actionFailedRetry`），支持中英切换与 a11y 朗读一致。

## 3. 可优化方向

| 方向 | 说明 | 优先级 | 状态 |
|------|------|--------|------|
| **工具名友好化** | 所有在 tier 中出现的工具都应有 `getToolDisplayName` 映射；新工具名可用 snake_case → 可读短语兜底，避免裸展示 backend 名称。 | P1 | 已落实：tool-fallback.tsx 已覆盖 tier 内全部工具并兜底。 |
| **Fallback 关键参数统一** | 通用 Fallback 的 keyInfo 与 `getPartKeyInfo` 统一，支持 list_directory、doc_path、paths/file_paths、directory 等，保证「未注册工具」也能展示「用了什么」。 | P1 | 已落实：getPartKeyInfo 已覆盖上述字段。 |
| **后端工具名与前端对齐** | 若后端工具名与前端注册名不一致（如 file_read vs read_file），需在协议层或前端做 name 映射，确保专用 UI 能命中。 | P2 |
| **新工具 UI 清单** | 新增后端工具时，按清单检查：是否需专用 UI、是否加入 tier/displayName、Fallback 下 keyInfo 是否覆盖其 args。 | P2 |
| **结果区「打开/跳转」** | 对文件类、URL 类结果，在专用 UI 或 Fallback 中提供「在编辑器中打开」「复制路径」「新标签打开」等快捷操作。 | P3 |

## 4. 与 a11y / 发布门禁的关系

- 工具卡片需满足 [a11y_checklist.md](a11y_checklist.md) 中「步骤条 / Process / 回复内容区 / 代码块复制」等项（已核对）。
- 新增或改版工具 UI 时，需保证：可聚焦、aria-label/aria-expanded 正确、键盘可操作。

## 5. 工具顺序与末尾空卡片（Cursor 式穿插）

- **顺序**：后端按执行顺序维护并下发 `content_parts`（先文本后工具，与 chunk 一致）；前端 SDK 在收到 `content_parts` 时优先用其作为消息 content，实现与 Cursor 一致的「正文与工具穿插」展示。
- **按步展示约定（Cursor 式一步一步）**：目标时间线为「步骤1（思考 → 工具 → 结果）→ 步骤2（思考 → 工具 → 结果）→ …」。已落实：后端在 run 内按顺序累积 `content_parts`（reasoning part 以 `type: "reasoning"` 先于本段文本与 tool-calls 写入），每次 flush 下发 `content_parts`；前端 patch 在 `contentPartsToMerged` 中保留 `type === "reasoning"` 的 part，消息区按 part 顺序渲染（ReasoningBlock → 正文 → 工具卡），实现「每步思考 → 该步工具 → 该步结果」的按步展示。
- **实现**：`main_graph.py` 的 `_TokenStreamHandler` 使用 `_run_ordered_parts` 按 run 累积 parts，`_flush_run` 中先追加本段 reasoning（若有）、再文本、再 tool-calls，写入 `payload["content_parts"]`；流结束在 `finally` 中调用 `clear_run_ordered_parts` 避免泄漏。前端通过 `patches/@assistant-ui+react-langgraph+*.patch` 在 `appendLangChainChunk` 的 `contentPartsToMerged` 中保留 reasoning part，并将**连续同类型 part 合并**（连续 text 拼成一段、连续 reasoning 用 `\n\n` 拼成一段），避免后端多次 flush 产生多段 text/reasoning 导致句子断裂或思考块割裂；`thread.tsx` 的 `_ASSISTANT_PARTS_COMPONENTS.Reasoning` 使用 `ReasoningBlock`（与 InlineThinkingBlock 一致的 8s 延迟折叠）。有 `content_parts` 时 SDK 用其生成 content 顺序，无则沿用原 content + tool_calls 合并逻辑。
- **Run 产出（lastRunSummary）**：stream_end 时写入 lastRunSummary（toolCount、errorCount、filePaths）；RunSummaryCard 或等价 UI 作为「本 run 的产出」应在 Footer/Composer 上方单一位置展示（本轮完成/共 N 个工具、失败数、变更文件），与消息内叙事同一上下文，不造成两套总结。见 cursor_alignment_checklist §2.5、RunTracker.tsx。
- **空卡片**：对「无 keyInfo、无 result、非 running」的 tool-call part，前端做降级：ToolFallback 渲染为单行「已执行 &lt;工具名&gt;」；ToolGroupBlock 不展示该步的步骤标题行，避免成串空白卡片。
- **末尾空卡片合并**：同一消息内末尾**连续**多个空卡片时，ToolGroupBlock 合并为一条展示「已执行 N 个工具：工具A、工具B、…」（i18n：`thread.sourcesSummary.executedCount`），不再逐条渲染多行「已执行 xxx」，与 Cursor 一致避免刷屏。
- **工具卡视觉**：非空工具卡使用 Cursor 式圆角卡片容器（rounded-lg、border border-border/20、bg-muted/5、px-2 py-1.5），与消息区风格一致。消息区水平间距（用户/助理容器 px-3、mx-3，日期分隔 px-3）与正文字号行高（14px、leading-1.65）已按 Cursor 在 cursor_alignment_checklist 中核对。

## 6. 搜索类 keyInfo / resultSummary 约定

- **getPartKeyInfo**：支持 `query`、`pattern`、`search_query`、`q`；对 web_search 若有 `url`/`website`/`source` 拼成「关键词 · 网站/主机」，若有 `num_results`/`max_results` 可带「最多 N 条」；对 search_knowledge 若有 `doc_path`/`source` 拼成「查询 · 文件名」；对 grep_search 支持 `pattern` 与 `path`；对 file_search 支持 `path`/`directory`。另支持：python_run/execute_python_code 的 `code`/`script`（首行或「N 行代码」）、plan_next_moves 的 `goal`、`command`（shell_run）、`paths`/`file_paths`（「N 个文件」）、`question`/`description`，保证思考/工具/搜索/读文件/写文件/编辑/代码运行等环节均有关键参数展示。
- **extractResultSummary**：web_search 为「N 个结果」+ 首条标题或 URL；search_knowledge/grep 为「N 个结果」+ 首行摘要；write_file/edit_file 为「文件已保存」；analyze_document 为首行摘要或「已分析」；file_search 为「找到 N 个结果」或「无匹配」；read_file 为「N 行」；python_run/shell_run 为输出行数或退出码；list_directory/glob 为「N 项」。ToolFallback 在有 displayResult 时至少展示首行摘要兜底，保证各环节均有充分内容显示。
- **extractResultPreview**：从 result 取首行或前 120 字（统一），供本消息依据展开时的「依据片段」展示；web_search 文本格式时取首条非 URL 行或首条 URL。错误/策略 JSON 时优先取 reason_text 作为预览。
- **搜索首屏与默认展开**：WebSearchToolUI 完成时首行可显示「首条：标题/snippet」；结果 ≤5 条时默认展开；无 result 时显示「结果未返回，请重试」。SearchKnowledgeToolUI 同理，有结果时默认展开并显示首行摘要。

## 7. 本消息依据展示规范

- **折叠**：标题「本消息依据」+ 数量。
- **展开**：每项为「工具名 · keyInfo · resultSummary」一行，可选第二行「依据片段」（resultPreview，约 120 字，line-clamp-3 允许 2～3 行）。与 Cursor Sources 区一致：工具名 · 关键参数 · 结果摘要 · 依据片段。当 result 存在但 extractResultSummary 为空时，用 result 首行或前 60 字作为 resultSummary 兜底，避免依据项空白。
- **数据流单源（工具结果唯一来源）**：messages/complete 与 **updates** 时 MyRuntimeProvider 均对 messages 调用 mergeToolResultsIntoAiMessages，将每条 ToolMessage 按 tool_call_id 合并进上一条 AI 的对应 tool-call part.result；合并后的 AI 消息的 content 与 content_parts 设为同一份 parts 数组，SDK 仅用 content 即可得到正文与工具穿插顺序及 result（updates 收尾时工具卡与证据区也能拿到 result），避免 UI 与业务「拧麻花」。
- **result 来源**：优先用 part.result（来自上述合并）；若无则用 thread 内从同条 assistant 后续 tool 消息构建的 toolResultsByMessageId 兜底（兼容 next.result / next.content），保证证据区与工具卡同源。convertLangChainMessages 与 appendLangChainChunk 的 contentPartsToMerged 已透传 result。
- **兜底 map 识别一致**：toolResultsByMessageId 的 AI/Tool 识别与 merge、SDK 一致，避免 store 形态差异导致兜底失效：AI 消息用 `role === "assistant" || type === "ai"`，Tool 消息用 `role === "tool" || type === "tool"`；id 键统一用 `toolCallId ?? tool_call_id`。见 thread.tsx 构建 toolResultsByMessageId 处；merge 内对仅含 role 无 type 的消息也做兼容（role === "assistant" / "tool"）。
- **part id 与 tool_call_id 约定（三处同源）**：后端必须保证同一 tool call 的标识在三处一致：`content_parts` 中 tool-call 的 `id`、`AIMessage.tool_calls[].id`、对应 `ToolMessage.tool_call_id`。均由 backend 保证同源（flush 时 part.id 取自 tool_calls[].id，ToolMessage 由 LangGraph/中间件使用同一 id）；否则前端 merge 与证据区会错位。

### 7.2 工具 result 单源与兜底约定（不拧麻花）

- **单源**：工具结果展示的主数据源 = 合并后的 AI 消息 `content` 中 tool-call part 的 `result`；本消息依据与工具卡均优先读 part.result。
- **兜底仅用于展示**：当 part.result 为空时，工具卡与证据区使用**同一套**兜底：按 messageId + part.id（或 toolCallId）从 thread 内 Tool 消息取 content，作为「展示用 result」；兜底不写回 store，不引入第二套「谁为准」逻辑。
- **实现位置**：ToolFallback、WebSearchToolUI、SearchKnowledgeToolUI 内通过 useMessage 取当前 messageId、useContext(ToolResultsByMessageIdContext) 取 map，计算 displayResult = result ?? fallbackResult，所有展示与复制使用 displayResult；证据区 evidenceItems 已使用 p.result ?? fallbackResult（thread.tsx），与工具卡同源。
- **合并唯一**：仅在 MyRuntimeProvider 的 messages/complete、updates、loadWrapped 及 custom messages_partial 四处做 mergeToolResultsIntoAiMessages，不在别处再拼 ToolMessage。

### 7.3 搜索/知识库 Cursor 式展示检查项

- **首行必显**：完成态首行展示「搜索/知识检索 · 关键词 · 网站或范围」+ **结果条数或首条摘要**；有 result/displayResult 时必显条数或摘要，不只有进度点。
- **完成态无结果**：isComplete 且无 result/displayResult 时，按钮旁与按钮下均显「结果未返回，请重试」（i18n：toolCard.resultNotReturned），不空白、不只有几个点。
- **展开区**：有 result 时支持展开查看每条（标题/来源 + 片段）；≤5 条可默认展开；无 result 时展开区不显示或显「结果未返回」。
- **运行中**：可保留简短进度文案（如「检索中…」或 ProgressDots），完成后必须切到「结果条数 + 摘要」或「结果未返回」。
- **自检**：同一轮对话中，搜索/知识库工具卡与「本消息依据」均能展示一致、可读的结果摘要或「结果未返回」提示。

### 7.3.1 判断、计划、执行结果与发现的问题（Cursor 式）

为让用户清晰知道「查看了什么、做出了什么判断、计划、执行结果、发现的问题」：

- **分析文档（analyze_document）**：首行展示结果摘要（或「结果未返回」）；使用 displayResult + 兜底；支持展开查看 UserFriendlyResult（发现/证据等）。
- **结构化审查（critic_review）**：使用 displayResult + 兜底；完成但无结果时显示「结果未返回」；结果无法解析时显示「结果无法解析，可复制查看」+ 复制按钮；解析成功时展示审查结论、待补证断言、待验证计算、修订建议等。
- **计划（plan_next_moves）**：展示目标（goal）、理解/背景（understanding，若有）、步骤列表（steps）、确认执行/修改计划/取消。
- **任务（task）**：使用 displayResult + 兜底；展示执行阶段、步骤列表、结果摘要或错误片段；完成但无结果时显示「结果未返回」。
- **本消息依据**：展开时显示说明文案（thread.sourcesSummary.hint），便于用户理解该区为「参考了以下工具与结果」。

### 7.3.2 所有工具 UI 执行信息展示（Cursor 式）

为达成「通过工具充分向用户展示执行信息」的目标，所有工具 UI 统一遵循：

- **单源 + 兜底**：展示用 `displayResult = result ?? fallbackResult`，其中 `fallbackResult` 来自 `ToolResultsByMessageIdContext`（按 messageId + toolCallId 取同条消息内 Tool 结果），与证据区同源。
- **完成态无结果**：`isComplete && !displayResult` 时显示「结果未返回，请重试」（`toolCard.resultNotReturned`），不留空白。
- **已落实范围**：  
  - **ToolFallback**（未注册工具）：keyInfo + resultSummary + displayResult；完成且无 result 时显 resultNotReturned。  
  - **搜索/文件类**：WebSearchToolUI、SearchKnowledgeToolUI、SearchToolUI、GrepSearchToolUI、FileSearchToolUI — 均使用 displayResult + fallback + resultNotReturned。  
  - **文件读写**：ReadFileToolUI、BatchReadFilesToolUI、WriteFileToolUI、EditFileToolUI、WriteFileBinaryToolUI — 读写类用 displayResult/fallback；完成无结果时显 resultNotReturned（ReadFile/BatchReadFiles）；WriteFileBinaryToolUI 完成时提供「在编辑区对比并保存」入口。  
  - **执行类**：PythonRunToolUI、ShellRunToolUI（含 execute）— displayResult + fallback + resultNotReturned。  
  - **createSimpleToolUI**（get_libraries、knowledge_graph、extract_entities、query_kg、get_learning_stats 等）：工厂内统一使用 displayResult + fallback + resultNotReturned。  
  - **其他专用**：LearnFromDocToolUI、CreateChartToolUI — displayResult + fallback + resultNotReturned。
  - **分析与审查**：AnalyzeDocumentToolUI、CriticReviewToolUI — displayResult + fallback + resultNotReturned 或解析失败提示；分析文档首行摘要、审查结论/问题明细均可见。
  - **计划与任务**：PlanToolUI 展示 goal + understanding + steps；TaskToolUI — displayResult + fallback + resultNotReturned，执行阶段与结果摘要可见。

### 7.4 确认在聊天内（会话内继续、不中断）

- **语义**：等待确认 = 本次回复未结束，确认后将继续；HITL 为同一 run 内 resume，非新开会话。
- **Plan**：Footer 仅展示简短提示（thread.waitingConfirmation + waitingConfirmationPlan）；主操作在 Plan 工具卡内「确认执行/暂不执行」。
- **文件工具（write_file / edit_file）**：Footer 仅简短提示（waitingConfirmationTools）；对应工具卡内通过 InterruptStateContext + action_requests 匹配展示 diff + 接受/拒绝，resume 时按 action_requests 顺序传 decisions。详见 cursor_alignment_checklist 2.9。

## 7.1 知识库与 Cursor @ 引用对应

- **Cursor**：@file / @docs 将文件或文档加入上下文，模型优先使用这些内容。
- **本系统**：**当前文件/选中** → config 传 `editor_path`、`editor_content`（截断 8k）、`selected_text`；**多文件/片段** → `context_items`（path 或 code+content），在 _format_user_context 中作为「用户附件」注入；`open_files` / `recently_viewed_files` 同样注入。行为与 Cursor「先代码库/再文档」一致：agent_prompts resource_awareness 中已注明「先文件后知识库：已知路径或当前打开/附件文件用 read_file；需跨文档领域知识时再用 search_knowledge」。

## 8. 推理流（思考过程展示）

- **单源约定**：思考展示以 **content_parts** 为准，不拧麻花。后端在 flush 时把 reasoning 写入 `content_parts`（`type: "reasoning"`），**不再**同时发送 `reasoning`、`phase=content` 事件；前端有 `content` 内 reasoning part 时仅用 `MessagePrimitive.Parts`（ReasoningBlock）展示，不合并事件思考块（`mergedThinkingBlocks` 在有 `hasNativeReasoningParts` 时仅用 `parsedThinking.thinkingBlocks`）。
- **后端协议**：流开始时发送 `reasoning` 且 `phase=start`；TokenStreamHandler 与 chunk 路径从 `AIMessageChunk.additional_kwargs` 读取思考内容，支持 `reasoning_content`、`reasoning`、`thinking` 三种键，flush 时仅将 reasoning 追加进 `content_parts` 并随 `messages_partial` 下发，流结束时发送 `phase=end`。首 token 时若开启 DEBUG 会打 `additional_kwargs` 键列表。
- **前端**：有 `s.content` 中 `type === "reasoning"` 时 `hasNativeReasoningParts` 为 true，仅渲染 content 内 ReasoningBlock；无原生 reasoning part 时（如仅 <think> 在正文）用 `useNativeReasoningBlocks` + `InlineThinkingBlock`。`phase=start`/`phase=end` 仍用于步骤条「思考」状态，不再用于推送思考内容。
- **模型约定**：35B 等提供推理流的模型需在 LLM 绑定层将思考内容写入 `AIMessageChunk.additional_kwargs["reasoning_content"]`（或 `reasoning`/`thinking`，后端已兼容），否则前端不会收到推理流。

## 9. 前端 SDK 扩展（content_parts）

为支持后端下发的 `content_parts` 穿插顺序，已对 `@assistant-ui/react-langgraph` 做本地扩展（不改包版本，仅改 dist 与 Vite 预构建产物）：

- **appendLangChainChunk**：当 `curr.content_parts` 存在且为数组时，用 contentPartsToMerged 生成合并后的 `content`（含 reasoning + text + tool-call 顺序，含 part.result）；contentPartsToMerged 中对 `p?.type === "reasoning"` 返回 `{ type: "reasoning", text: p.text ?? "" }` 以保留思考块，并清空 `tool_calls`，保证单源顺序与按步展示。
- **convertLangChainMessages**：当 `message.content` 中已含 `type === "tool-call"` 的 part 时，直接按该数组输出 UI content（含 result），不再做「先 contentToParts 再拼 toolCallParts」。

修改位置：`node_modules/.../react-langgraph/dist/appendLangChainChunk.js`、`dist/convertLangChainMessages.js`，以及 `node_modules/.vite/deps/@assistant-ui_react-langgraph.js`。若执行 `pnpm install` 后行为回退，需重新应用上述逻辑或使用 `pnpm patch` 固化。

## 9.1 聊天区 Cursor 样式逐项优化清单

按模块与工具类型核对，实施后勾选：

- [x] **Footer**：显示条件（有 steps/todos）、状态色 violet/emerald、RunSummaryCard 展示工具数/失败数/变更文件且变更文件可点击打开
- [x] **思考块**：InlineThinkingBlock / ReasoningBlock / ReasoningGroupBlock 统一 `rounded-r-lg border-l-2 border-muted-foreground/20 bg-muted/10`
- [x] **工具卡容器**：非空工具卡统一 `TOOL_CARD_CONTAINER_BASE` + 状态 border-l（violet/emerald/red/amber）；ToolFallback / ReadFile / AnalyzeDocument / Search / GrepSearch / WebSearch 已套用
- [x] **工具卡无结果**：完成且无 result 时均显「结果未返回，请重试」（ToolFallback 不依赖 keyInfo；各专用 UI 已具备）
- [x] **本消息依据**：所有非 hidden 工具；每条优先 resultSummary/resultPreview/keyInfo；resultPreview/resultPreviewLong 兜底（首行/120/400 字）
- [x] **RunSummaryCard**：lastRunSummary 行下变更文件为可点击打开（fileEventBus.openFile）
- [ ] **附件/上下文芯片**：待产品与 Cursor 真机定稿（见 cursor_alignment_checklist §2.2）

## 9.2 后续可完善（可选）

- **Cursor 真机核对**：与 Cursor 实际界面对比时，可逐项核对 [cursor_alignment_checklist.md](cursor_alignment_checklist.md) §2.1–2.9；重点包括思考块竖线/圆角、工具卡首行 keyInfo+结果、步骤条与 Todo 的 violet/emerald、Interrupt 内联样式、回到底部出现时机。
- **a11y**：思考块按钮已提供 `aria-label`、`aria-expanded`；「本消息依据」折叠区外层已加 `role="region"`、`aria-label`（`thread.sourcesSummary.title`），与 [a11y_checklist.md](a11y_checklist.md) 中「步骤条 / 回复内容区」等项一并回归即可。
- **RunSummaryCard 展示位**：若 RunSummaryCard 需在聊天区 ViewportFooter 内显式挂载（与 runSummary 状态同步），需在 thread 或父级传入 summary 并渲染，且需提供 `onStop`（可从 `CancelContext.cancelRun` 接入）；当前 runSummary 状态已在 thread 内维护并用于 stripLabel/phase 等，lastRunSummary 通过 stream_end 写入，展示方式以产品为准。

## 10. 参考

- 专用组件与 Fallback 实现：`frontend/desktop/src/components/ChatComponents/tool-fallback.tsx`
- 工具 tier 与注册：`toolTier.ts`、`thread.tsx`（`ThreadPrimitive.Root` 下各 `*ToolUI`）
- 聊天区 Cursor 逐项对比： [cursor_alignment_checklist.md](cursor_alignment_checklist.md)
- 执行策略与权限（Python/Shell、文件工作区边界、自治等级）：[execution_policy_and_permissions.md](execution_policy_and_permissions.md)
