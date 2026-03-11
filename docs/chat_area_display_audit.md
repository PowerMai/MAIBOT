# 聊天区内容显示审计报告

本文档逐项核对：**功能是否完善**、**样式是否完善**、**每个内容/模块/步骤是否已充分优化**。

---

## 一、整体结构（单源与数据流）

| 项 | 状态 | 说明 |
|----|------|------|
| 消息内容单源 | ✅ | content 仅来自 content_parts / content + tool_calls，无第二来源 |
| 工具结果单源 | ✅ | part.result 仅由 mergeToolResultsIntoAiMessages 写入，证据区与工具卡同源 |
| 思考展示单源 | ✅ | 有 content 内 reasoning part 时仅用 ReasoningBlock；无则 InlineThinkingBlock + 事件 |
| 顺序与穿插 | ✅ | 后端按 reasoning → text → tool-calls 顺序；前端 MessagePrimitive.Parts 按 part 顺序渲染 |

---

## 二、按模块逐项审计

### 2.1 正文与 Markdown

| 子项 | 功能 | 样式 | 备注 |
|------|------|------|------|
| 正文容器 | ✅ | ✅ | `text-[14px] leading-[1.65]`、`max-w-[min(65ch,100%)]`、px-0 py-0 |
| 段落/标题/列表 | ✅ | ✅ | prose 系列已配置（prose-p:leading-[1.65]、prose-headings 等） |
| 引用块 | ✅ | ✅ | prose-blockquote:border-l-primary、bg-muted/30 |
| **代码块** | ✅ | ✅ | `rounded-lg border border-border/50`、代码头栏（语言/路径/复制/应用）、折叠（>50 行）、rounded-t-none + rounded-b-lg |
| 行内代码 | ✅ | ✅ | `rounded px-1 py-0.5 bg-muted/60`、text-[13px] font-mono |
| 表格 | ✅ | ✅ | 横向滚动、prose-table 样式 |
| 图片 | ✅ | ✅ | rounded-lg border、max-w-full |
| Mermaid | ✅ | ✅ | 独立 wrapper、rounded-lg border、debounced 渲染 |

**结论**：正文与 Markdown 功能与样式已完善，代码块已按 Cursor 风格圆角+边框统一。

---

### 2.2 思考块（推理流）

| 子项 | 功能 | 样式 | 备注 |
|------|------|------|------|
| InlineThinkingBlock | ✅ | ✅ | 事件/解析思考块、折叠延迟 8s、`rounded-r-lg border-l-2 border-muted-foreground/20 bg-muted/10` |
| ReasoningBlock | ✅ | ✅ | 原生 reasoning part、与 InlineThinkingBlock 同款 containerClass、已思考 N 秒、Loader text-violet-500 |
| ReasoningGroupBlock | ✅ | ✅ | 多段 reasoning 折叠组、`role="region"`、`aria-label`、同款 border-l 样式 |
| 折叠/展开 | ✅ | ✅ | 按钮 `aria-expanded`、`aria-label`，用户可手动展开后不自动收起 |

**结论**：思考块功能与样式已统一，a11y 已覆盖。

---

### 2.3 工具卡容器与状态边框（TOOL_CARD_*）

**已统一套用** `TOOL_CARD_CONTAINER_BASE` + 状态 border（running/complete/error/cancelled）的组件：

- ToolFallback（通用未注册工具）
- ReadFileToolUI、BatchReadFilesToolUI
- AnalyzeDocumentToolUI
- SearchToolUI、GrepSearchToolUI、WebSearchToolUI
- PythonRunToolUI、ShellRunToolUI
- FileSearchToolUI
- WriteFileToolUI、EditFileToolUI
- WriteFileBinaryToolUI（需核对：当前为 `my-1.5` 未用常量）
- SearchKnowledgeToolUI（需核对：当前为 `my-1.5`）
- 部分 createSimpleToolUI 工厂产出（get_libraries、knowledge_graph 等为 `my-1.5` 简单容器）

**仍为 `my-1.5` 或自拟样式的工具卡（未用 TOOL_CARD_CONTAINER_BASE）**：

| 组件 | 位置 | 建议 |
|------|------|------|
| createSimpleToolUI 工厂 | tool-fallback.tsx ~137 | 可选：外层加 TOOL_CARD_CONTAINER_BASE + borderAccent，与其它工具卡视觉统一 |
| WriteFileBinaryToolUI | ~2598 | 建议：加 TOOL_CARD_CONTAINER_BASE + border、Loader 改为 text-violet-500 |
| CriticReviewToolUI | ~4440/4453/4462 | 三分支（运行中/无结果/解析失败）为独立 div，建议：统一包在一个 TOOL_CARD_CONTAINER_BASE 内并加状态 border |
| SearchKnowledgeToolUI | ~5448 | 建议：加 TOOL_CARD_CONTAINER_BASE + border、Loader 改为 text-violet-500 |
| LearnFromDocToolUI | ~5614 | 建议：加 TOOL_CARD_CONTAINER_BASE + border、Loader 改为 text-violet-500 |
| CreateChartToolUI | ~5706 | 建议：加 TOOL_CARD_CONTAINER_BASE + border（已有 resultNotReturned） |
| PlanToolUI | ~3811/3827 | 已用 rounded-lg border，为规划专用样式，可保持 |
| TaskToolUI | ~4134 | 已用 rounded-lg border + 状态色，可保持 |
| AskUserToolUI | 内联 | 使用 border-primary/40 bg-primary/5，为交互专用，可保持 |

---

### 2.4 工具卡「无结果」与 Loader 统一

| 规则 | 状态 | 说明 |
|------|------|------|
| 完成且无 result 显示「结果未返回，请重试」 | ✅ | ToolFallback 不依赖 keyInfo 一律显示；ReadFile/BatchReadFiles/AnalyzeDocument/Search/Grep/WebSearch/PythonRun/ShellRun/FileSearch/SearchKnowledge/LearnFromDoc/CreateChart/Task 等均有 |
| WriteFile/EditFile 无结果提示 | ⚠️ | 代码中已预留逻辑，若未写入可补：`isComplete && !displayResult` 时显示 resultNotReturned |
| Loader 颜色统一为 violet | 大部分 ✅ | 已统一为 text-violet-500 的：ToolFallback、ReadFile、BatchReadFiles、PythonRun、ShellRun、FileSearch、WriteFile、EditFile、CreateChart 等；仍为 amber/indigo/green/purple 的：WriteFileBinary（amber）、CriticReview（indigo）、LearnFromDoc（green）、SearchKnowledge（purple）— 可逐步改为 text-violet-500 |

---

### 2.5 本消息依据（MessageEvidenceSummary）

| 子项 | 功能 | 样式 | 备注 |
|------|------|------|------|
| 数据来源 | ✅ | - | 所有非 hidden 的 tool-call part，与 part.result / toolResultsByMessageId 一致 |
| 每条展示 | ✅ | ✅ | 优先 resultSummary/resultPreview/keyInfo，无则「已执行」；resultPreview 有 extractResultPreview 或首行兜底 |
| 折叠区 | ✅ | ✅ | role="region"、aria-label、圆角边框 bg-muted/5 |
| hint 文案 | ✅ | - | 「以下为本条回复所依据的结果与来源…」 |
| 打开/复制 | ✅ | ✅ | filePath 时「在编辑器中打开」「复制路径」；url 时「复制链接」 |
| 展开更长预览 | ✅ | ✅ | resultPreviewLong、展开/收起单条 |

**结论**：本消息依据功能与样式已完善。

---

### 2.6 工具分组与空卡片（ToolGroupBlock）

| 子项 | 功能 | 样式 | 备注 |
|------|------|------|------|
| 按 part 顺序逐条 | ✅ | ✅ | 每步一行 label + 工具卡片，不折叠 process |
| 空卡片判定 | ✅ | - | 无 keyInfo、无 result、非 running |
| 末尾连续空卡片合并 | ✅ | ✅ | 合并为「已执行 N 个工具：A、B、…」、executedCount i18n |
| ask_user 高亮 | ✅ | ✅ | 运行中时 `rounded-lg border border-primary/40 bg-primary/5` |
| 步骤 label | ✅ | ✅ | getStepLabelForPart、text-[11px] text-muted-foreground |

**结论**：工具分组与空卡片处理已完善。

---

### 2.7 Footer 与 RunSummaryCard

| 子项 | 功能 | 样式 | 备注 |
|------|------|------|------|
| 显示条件 | ✅ | ✅ | 有 steps/todos 或 lastRunSummary 或 running/error/linkedTask 等 |
| 状态点 | ✅ | ✅ | running 时 violet 动画、否则 muted |
| 阶段/工具标签 | ✅ | ✅ | phaseAndTool、队列数、ElapsedTimer、首 token 可选 |
| lastRunSummary | ✅ | ✅ | 工具数/失败数/变更文件数；变更文件为可点击（fileEventBus.openFile）、最多 5 个 + N |
| 主操作按钮 | ✅ | ✅ | 诊断/重试/打开任务/打开会话等，aria-label |

**结论**：Footer 与 RunSummaryCard 功能与样式已完善。

---

### 2.8 步骤条（MessageStepStrip）

| 子项 | 功能 | 样式 | 备注 |
|------|------|------|------|
| 步骤列表 | ✅ | ✅ | 思考·步骤1·…·回答，text-[11px] text-muted-foreground |
| 当前高亮 | ✅ | - | currentIndex 对应步骤 |
| a11y | ✅ | ✅ | role="progressbar"、aria-valuenow/min/max、aria-label |

**结论**：步骤条已完善。

---

### 2.9 操作栏与时间戳

| 子项 | 功能 | 样式 | 备注 |
|------|------|------|------|
| AssistantActionBar | ✅ | ✅ | 复制/分支等，悬停显 |
| MessageTimestamp | ✅ | ✅ | text-[11px] text-muted-foreground/50、group-hover 显 |
| BranchPicker | ✅ | - | 按项目逻辑 |

**结论**：操作栏与时间戳已具备。

---

## 三、尚未完善或可选优化汇总

1. **工具卡视觉统一（可选）**  
   WriteFileBinary、SearchKnowledge、LearnFromDoc、CreateChart、CriticReview、createSimpleToolUI 工厂：可套用 `TOOL_CARD_CONTAINER_BASE` + 状态 border，Loader 统一为 `text-violet-500`。

2. **WriteFile/EditFile 无结果提示（建议）**  
   在完成且无 `displayResult` 时增加一行「结果未返回，请重试」，与其它工具卡一致。

3. **附件/上下文芯片（待产品）**  
   见 cursor_alignment_checklist §2.2，待与 Cursor 真机定稿。

4. **RunSummaryCard 展示位**  
   若需在 ViewportFooter 内显式挂载或与 runSummary 状态强绑定，需在 thread 或父级传入 summary 并接 onStop；当前逻辑与文档一致，按产品需求即可。

5. **a11y 回归**  
   与 a11y_checklist 中「步骤条/回复内容区/代码块复制」等项做一次回归即可。

---

## 四、结论表（按「内容/模块/步骤」）

| 维度 | 功能完善 | 样式完善 | 已充分优化 |
|------|----------|----------|------------|
| 正文与 Markdown（含代码块） | ✅ | ✅ | ✅ |
| 思考块（Inline/Reasoning/Group） | ✅ | ✅ | ✅ |
| 工具卡（已套用 TOOL_CARD_* 的 10+ 类） | ✅ | ✅ | ✅ |
| 工具卡（未套用的 6 类） | ✅ | ⚠️ 可统一 | ⚠️ 可选 |
| 本消息依据 | ✅ | ✅ | ✅ |
| 工具分组与空卡片合并 | ✅ | ✅ | ✅ |
| Footer / RunSummaryCard | ✅ | ✅ | ✅ |
| 步骤条 | ✅ | ✅ | ✅ |
| 操作栏/时间戳 | ✅ | ✅ | ✅ |

**总结**：聊天区**功能已完善**；**样式在绝大部分模块已完善**，仅少数工具卡未套用统一容器与 Loader 色，属可选优化；**每个内容和步骤的显示**在单源、顺序、证据区、无结果提示、Footer 汇总上均已落实，后续可按上表逐项收尾（统一 6 类工具卡样式、补 WriteFile/EditFile 无结果提示、附件芯片与 a11y 回归）。
