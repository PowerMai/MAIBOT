# Cursor / Claude / Cowork 行为对标分析

本文档为「先对标分析再完善」的 Phase 0 产出：梳理 Cursor/Claude/Cowork 在可靠编辑与 Agent OS 上的**实际行为**，并对照本系统实现写出差距与建议改法。Phase 1 的代码修复以本文档的「差距与建议改法」为单一事实来源。

**索引**：对标总览见 [product_parity_claude_cursor_cowork.md](product_parity_claude_cursor_cowork.md)；逐项对比见 [cursor_alignment_checklist.md](cursor_alignment_checklist.md)；工具展示与 Diff 见 [tool_display_cursor_alignment.md](tool_display_cursor_alignment.md)；执行策略见 [execution_policy_and_permissions.md](execution_policy_and_permissions.md)。

---

## 1. Diff（内联 / 编辑区 / 聊天区）

### 1.1 Cursor（及 Claude/Cowork 若适用）行为描述

- **内联 diff**：工具卡内可展示修改前后对比；从聊天「在编辑器中打开 (diff)」可跳转到编辑区并带 diff 状态。
- **接受/拒绝粒度**：整文件接受/拒绝为主；部分产品支持逐段/逐行（待人工核对）。
- **来源**：本仓库 [tool_display_cursor_alignment.md](tool_display_cursor_alignment.md)、[cursor_alignment_checklist.md](cursor_alignment_checklist.md) §2.9；Cursor 官方/社区文档待补。

### 1.2 本系统当前实现

- **InlineDiffView**：聊天区工具卡内 diff 展示；WriteFileToolUI/EditFileToolUI 支持「在编辑器中打开 (diff)」并派发 `OPEN_FILE_IN_EDITOR`（path、showDiff、diffOriginal、diffContent）。
- **FullEditorV2Enhanced / MonacoEditorEnhanced**：编辑区接收 `OPEN_FILE_IN_EDITOR` 的 detail，展示 diff 与接受/拒绝；支持 path + showDiff + diffOriginal + diffContent，文件已打开时用 diffContent 与当前 buffer 做对比。
- **Apply**：generative-ui CodeUI handleApply 与 markdown 代码块 Apply 一致：Apply 前 readFile 取原内容，writeFile 后派发 OPEN_FILE_IN_EDITOR（showDiff: true、diffOriginal、diffContent: 新内容），便于编辑区在文件已打开时正确展示「原 vs 新」对比。
- **编辑区接受即写盘**：编辑区「接受」按钮在清除 diff 状态后调用 handleSaveFile，将当前内容写入磁盘并 toast；拒绝仅恢复 diffOriginal 到缓冲区、不写盘。与 checklist §2.9「编辑区 diff 接受并保存」一致。

### 1.3 差距与建议改法

- **差距**：从聊天「在编辑器中打开 (diff)」到编辑区的跳转与接受/拒绝是否回写 run 状态，文档已写明为「接受即写盘、不涉及 run 回写」；整文件 vs 行/段粒度需产品在真机核对后补全（**当前实现**：仅整文件接受/拒绝，见 [高可靠副驾驶对标检查结果_2026-03-09.md](高可靠副驾驶对标检查结果_2026-03-09.md) 5.4 其他待人工核对项）。
- **建议**：保持现有 InlineDiffView、OPEN_FILE_IN_EDITOR、编辑区 diff + 接受并保存链路；若需「编辑区接受/拒绝回写 run」，需在后端约定事件或 API，再在前端接流。
- **若要对齐所需能力**：当前编辑区接受 = 写盘 + toast、不通知 run，拒绝 = 恢复缓冲区。若 Cursor 有回写 run：需约定后端「编辑区结果」事件或 API（如 run_id、accept/reject、file path），前端在 FullEditorV2Enhanced 接受/拒绝回调中调用并接流；MyRuntimeProvider 或 run 状态需消费该结果并更新工具卡/消息状态。涉及：FullEditorV2Enhanced.tsx（接受/拒绝回调）、langserveChat 或新 CustomEvent、后端 run 状态/stream 协议。

---

## 2. 工具确认（暂停确认 vs 先执行再确认）

### 2.1 Cursor（及 Claude/Cowork 若适用）行为描述

- **先暂停再执行**：写文件/执行命令前暂停 → 展示 diff/预览 → 用户接受/拒绝 → 再执行（或跳过）。
- **先执行再确认**：部分场景下先执行，再在工具卡上接受/拒绝以保留或回退（待人工核对具体操作类型）。
- **来源**：本仓库 [execution_policy_and_permissions.md](execution_policy_and_permissions.md) §4、§6；[cursor_alignment_checklist.md](cursor_alignment_checklist.md) §2.4、§2.9。

### 2.2 本系统当前实现

- **human_in_the_loop_interrupt_tools**（core_tools.json）与 **DiffAwareHumanInTheLoopMiddleware**：写文件/编辑/删除/shell_run/python_run 等可配置为「先暂停、展示 diff/预览、用户接受后再执行」。
- **自治等级 L0–L3** 与 **auto_accept_tools**：控制默认接受策略；L0/L1 下需确认，L2/L3 下文件类可默认不中断。
- **前端**：InterruptDialog tool_diff_approval 在聊天区内联展示 diff 与接受/拒绝；工具卡内 WriteFile/EditFile 同样展示 diff 与按钮，InterruptStateContext 单源。

### 2.3 差距与建议改法

- **差距**：「先执行再确认」的可选策略在本系统中未明确实现；若 Cursor 对部分操作采用该模式，需在分析文档中标注「待人工核对」后，再约定后端「已执行 + 可回退」状态及前端接受/拒绝与回退（如写回原内容）。
- **建议**：当前以「先暂停再执行」为主；若产品确认需要「先执行再确认」，再扩展 DiffAwareHumanInTheLoopMiddleware 与前端工具卡状态（已执行/可回退）。
- **若要对齐的扩展点**：当前 DiffAwareHumanInTheLoopMiddleware + human_in_the_loop_interrupt_tools 仅支持「先暂停 → 展示 diff → 接受/拒绝 → 执行」。若 Cursor 部分操作为先执行再确认：(1) 后端需可选策略（如 per-tool 或 per-run 配置「执行后可回退」）、执行后写入「可回退」状态与回退 API（如写回原内容）；(2) 前端工具卡需状态「已执行 · 可接受/拒绝」及拒绝时触发回退请求。涉及：DiffAwareHumanInTheLoopMiddleware、core_tools 配置、WriteFileToolUI/EditFileToolUI 等工具卡 UI 状态扩展。

---

## 3. Ask 用户（问题展示与提交协议）

### 3.1 Cursor（及 Claude/Cowork 若适用）行为描述

- **展示位置**：问题可在聊天内展示（工具卡或内联），部分产品另有弹窗（待人工核对）。
- **提交协议**：用户输入后需通过 **resume** 将用户文本送回后端，run 继续；而非仅发新消息。
- **来源**：本仓库 [reflection.py](backend/tools/base/reflection.py)（ask_user 使用 `interrupt(question)`）；Cursor/Claude 公开说明待补。

### 3.2 本系统当前实现（已修复）

- **后端**：`ask_user` 使用 `interrupt(question)`，run 暂停；resume 时 payload 为用户回复字符串，图继续执行。
- **前端**：
  - **AskUserToolUI**（tool-fallback.tsx）：提交时调用 `resumeInterrupt(threadId, value.trim())`，收到 `run_id` 后派发 `INTERRUPT_RESOLVED`（detail: threadId, run_id），并调用 `addResult` 更新本地结果；保证用户输入送达后端、run 接流续显。
  - **parseInterruptValue**（langserveChat.ts）：当 interrupt 的 value 为**纯字符串**时，识别为 `interruptType: 'input_required'`，供 InterruptDialog 展示问题与输入框。
  - **InterruptDialog**：对 `input_required` 类型展示问题与输入框，确认时调用 `resumeInterrupt(threadId, userInput.trim() || 'yes')` 并 onResolved(run_id)。
  - **InterruptDialogGuard**：当当前线程存在进行中的 ask_user 工具时不展示 InterruptDialog，避免双入口；聊天区使用 variant="inline"。
- **MyRuntimeProvider**：监听 `INTERRUPT_RESOLVED`，若 threadId 匹配则 resolve resumeRunResolverRef 并接流续显。

### 3.3 差距与建议改法

- **已落实**：Ask 用户提交走 resume + INTERRUPT_RESOLVED，与「interrupt 后必须通过 resume(threadId, userInput) + INTERRUPT_RESOLVED(run_id) 接流」一致；纯字符串 interrupt 识别为 input_required，InterruptDialog 与 AskUserToolUI 二选一展示（Guard 有 ask_user 时仅工具卡展示）。
- **可选**：产品在 Cursor/Claude 真机核对「问题展示位置（仅聊天内 vs 弹窗）」后，可再微调 InterruptDialog 展示策略。

---

## 4. Composer / 聊天 / 编辑区联动

### 4.1 Cursor（及 Claude/Cowork 若适用）行为描述

- **联动**：从 Composer 发送 → 聊天区流式 + 工具卡 → 可从聊天「在编辑器中打开 (diff)」到编辑区；编辑区接受/拒绝是否回写 run 待人工核对（多数为仅影响缓冲区）。
- **来源**：本仓库 [cursor_alignment_checklist.md](cursor_alignment_checklist.md) §2.1–2.5、§2.9。

### 4.2 本系统当前实现

- **cursor-style-composer**、**thread**、**FullEditorV2Enhanced**：Composer 发送后聊天区流式展示与工具卡；OPEN_FILE_IN_EDITOR 携带 showDiff/diffOriginal/diffContent，编辑区展示 diff 与接受/拒绝。
- **会话与 run 状态**：session_context 下发 threadId、mode、roleId；INTERRUPT_RESOLVED 携带 threadId、run_id，接流续显；编辑区接受/拒绝不自动回写 run，与 checklist 一致。

### 4.3 差距与建议改法

- **差距**：编辑区接受/拒绝若需回写 run，需额外协议（当前未实现）。
- **建议**：维持「编辑区仅影响缓冲区」；若产品要求回写 run，再在行为分析中补「对方产品行为」并在后端/前端扩展。

---

## 5. 即时反馈与结果汇总

### 5.1 Cursor（及 Claude/Cowork 若适用）行为描述

- **工具完成**：除工具卡外可有轻量通知（如 Toast）（待人工核对）。
- **Run 结束**：可有汇总报告（工具数、成功/失败、变更文件列表等），出现在 Footer/Toast/RunSummaryCard 或独立汇总块（待人工核对）。
- **来源**：本仓库 [cursor_alignment_checklist.md](cursor_alignment_checklist.md)、[RunTracker.tsx](frontend/desktop/src/components/ChatComponents/RunTracker.tsx) 行为描述。

### 5.2 本系统当前实现（已落实）

- **RunTracker**：运行条、步骤条、Todo 展开；run 状态与 task_running 双源约定。
- **RunSummaryCard**：非 nested 场景下展示 lastError 与打开任务/重试/诊断入口；**有 lastRunSummary 时保持可见**，展示「本轮：N 个工具」或「本轮完成」、失败数（errorCount）、变更文件数（filePaths.length）。
- **stream_end (reason=complete)**：thread 订阅 stream_start/tool_end/tool_error/stream_end；正常结束时 toast「本轮完成」或「本轮完成，共 N 个工具」，并写入 lastRunSummary（toolCount、errorCount、filePaths）；RunSummaryCard 展示该汇总行，与 checklist §2.5 一致。

### 5.3 差距与建议改法

- **已落实**：Run 结束后的结果汇总（工具数、失败数、变更文件列表）已在 stream_end 时写入 lastRunSummary，RunSummaryCard 在存在 lastRunSummary 时保持可见并展示汇总行；tool_error 计入 errorCount。
- **可选**：产品在 Cursor 真机核对「工具完成时除工具卡外是否有轻量 Toast」后，可按需增加单次 tool_end 的轻量通知。**当前实现**：仅 stream_end 时 toast，无单次 tool_end 轻量通知；已在高可靠报告 5.4「其他待人工核对项」注明。

---

## 6. 实施顺序与文档维护

- **Phase 1 执行顺序**：3.1 Ask 用户（高优先级）→ 3.2 Diff 全覆盖 → 3.3 工具确认策略 → 3.4 即时反馈与汇总 → 3.5 Composer/聊天/编辑区联动。
- **本文档维护**：结论尽量标注来源（文档链接或「待人工核对」）；真机核对后更新「对方产品行为」并刷新「差距与建议改法」；与 cursor_alignment_checklist、tool_display_cursor_alignment、execution_policy_and_permissions 交叉引用，避免重复造表。
