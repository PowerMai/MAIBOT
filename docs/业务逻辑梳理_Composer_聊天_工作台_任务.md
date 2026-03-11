# 业务逻辑梳理：Composer、聊天区、工作台、任务管理

本文档对四大模块的内部业务逻辑、数据流、用户使用路径做梳理，并评估合理性及优化方向。

---

## 1. Composer 相关所有模块

### 1.1 模块组成与职责

| 模块 | 文件 | 职责 |
|------|------|------|
| **CursorStyleComposer** | `cursor-style-composer.tsx` | 输入框 UI、模式/角色/技能选择、附件与上下文、发送/停止 |
| **MyRuntimeProvider** | `MyRuntimeProvider.tsx` | 对接 @assistant-ui/react + LangGraph，管理 thread/run、发送消息时组装 context/mode、流式响应、事件派发 |
| **ModelSelector** | `model-selector.tsx` | 模型选择，写 localStorage + 派发 `model_changed` |
| **CancelContext / OpenFilesContext** | 各自 context 文件 | 停止运行、打开文件列表，供 Composer 与 Thread 使用 |

Composer **不直接发 HTTP**，而是通过 `ComposerPrimitive.Send` 触发 assistant-ui 的提交；实际请求在 **MyRuntimeProvider** 的 runtime（useLangGraphRuntime）里完成。

### 1.2 核心数据流

```
用户输入 + 模式/角色/技能/联网/上下文
    → ComposerPrimitive（受控 input）
    → 点击发送 → runtime.append() / sendMessageWithRetry()
    → MyRuntimeProvider 从 ref 读取：contextItemsRef、modelIdRef、chatMode、skillProfile、webSearch
    → 组装 LangChain 消息（含 additional_kwargs.mode、skill_profile、context 等）
    → POST /threads/{id}/runs 流式
    → 流式事件 → toolStreamEventBus、RUN_SUMMARY_UPDATED、MESSAGE_SENT 等
```

- **模式（Agent/Ask/Plan/Debug/Review）**：存 `maibot_chat_mode` 或 `maibot_chat_mode_thread_{threadId}`，通过 `additional_kwargs.mode` 传给后端，决定是否只读、是否先出计划等。
- **角色**：存 `maibot_active_role` / 会话键，后端用角色绑定 system prompt 与技能档案。
- **技能档案（Skill profile）**：full/office/report 等，与角色可联动，影响路由与工具集。
- **联网/研究模式**：Globe 三态（关 → 联网 → 深度研究），`WEB_SEARCH_CHANGED`、localStorage 同步。
- **上下文项**：Composer 与 MyRuntimeProvider 共用 **CONTEXT_ITEMS_CHANGED**；发送前 Provider 从 ref 取，发送后 **MESSAGE_SENT** 触发 Composer 清空并派发清空，保证展示与发送一致。

### 1.3 用户如何合理使用

- **先选模式再输入**：不确定时用 Ask，要执行时用 Agent，复杂任务用 Plan 先看方案。
- **角色**：按当前工作类型选（如开发选 coding_engineer），会影响领域建议与第四位模式（Debug/Review）。
- **上下文**：拖拽/粘贴文件或图片、从「添加上下文」选打开的文件/文件夹/代码片段，发送前可在输入框上方看到列表，发送后会自动清空。
- **联网**：需要查最新信息时点 Globe 开启；深度研究会走更长链路。
- **从工作台/仪表盘填入**：工作台输入任务并提交会 `OPEN_TASK_IN_EDITOR` + `FILL_PROMPT`，只填输入框（默认不 autoSend），用户可改后再发。

### 1.4 合理性评估与优化建议

**已做得好的**

- 模式、角色、技能档案、联网均有持久化与事件同步，多 tab/多会话一致。
- 上下文与发送一致，发送后清空，避免重复带上轮上下文。
- FILL_PROMPT 支持 `threadId`、`autoSend`，方便工作台/编辑器预填并可选自动发送。

**可优化点**

| 方面 | 现状 | 建议 |
|------|------|------|
| **功能/位置** | 模式与角色在同一栏，新用户易混淆「模式」与「角色」 | 用简短说明或 tooltip 区分：「模式=本次怎么跑」「角色=谁在跑」；或把角色收进「身份」下拉，模式保持显式按钮 |
| **表示方式** | 技能档案在领域下拉里，与角色联动但不够直观 | 角色切换时若带 skill_profile 可自动带出领域并 toast 提示「已切换至 xx 领域」 |
| **样式** | 附件/上下文多时输入区会变高，小屏易挤 | 上下文列表可折叠为「N 个上下文」+ 展开列表，或最大高度 + 滚动 |
| **联网三态** | 已优化：Globe 激活时在图标旁显示「联网」或「深度研究」，关闭时仅图标 | — |
| **创建任务入口** | Composer 内「创建任务」会先 boardApi.createTask 再 FILL_PROMPT 填「请帮我开始执行任务：xxx」 | 若希望「创建即执行」，可改为创建后 SWITCH_TO_THREAD(thread_id) + FILL_PROMPT + autoSend；当前是「创建 + 填入提示由用户手动发」 |
| **防重与 loading** | 已有 isCreatingTask、continueFiring 等 | 保持发送中禁用发送按钮、停止显示停止按钮，避免重复请求 |

---

## 2. 聊天区域和对话框

### 2.1 布局与组成

```
ChatAreaEnhanced
├── MyRuntimeProvider（包一层 runtime/thread 状态）
│   ├── ThreadList（标签栏：线程标签、新建、历史、关闭）
│   ├── context-strip（当前文件路径，有 editorPath 时显示）
│   ├── Thread（聊天主区）
│   │   ├── ThreadPrimitive.Viewport
│   │   │   ├── 空态 → ThreadWelcomeInline
│   │   │   ├── RunSummaryCard / TaskPanelHintStrip / AutonomousRunsStrip
│   │   │   ├── ThreadPrimitive.Messages（或 ProgressiveThreadMessages）
│   │   │   ├── PlanExecuteBar（Plan 模式确认/修改/取消）
│   │   │   ├── ThreadScrollToBottom
│   │   │   └── CursorStyleComposer（输入+发送+停止）
│   │   └── ArtifactPanel（右侧产物面板，可折叠）
│   ├── InterruptDialog（断线/中断确认）
│   └── CrystallizationToast（任务运行中结晶提示）
```

- **ThreadList**：线程标签、 pinned、搜索历史、删除、新建；切换线程发 **SWITCH_TO_THREAD**，MyRuntimeProvider 监听后切 thread 并加载状态。
- **Viewport**：`turnAnchor="bottom"` 控制流式时滚动；消息列表当前为 **ThreadPrimitive.Messages**，已有 **ProgressiveThreadMessages** 实现可替换为虚拟列表以优化长对话。
- **PlanExecuteBar**：仅在 Plan 模式且有待确认计划时显示，确认执行发 **PLAN_CONFIRMED**，修改/取消发相应事件，由 thread 内逻辑与后端门禁配合。

### 2.2 消息与对话流

- **消息来源**：用户从 Composer 发送；或 FILL_PROMPT（工作台/编辑器/命令面板）填入后用户点发送或 autoSend。
- **线程**：一个 threadId 对应一条对话；新建线程由 MyRuntimeProvider 的 createThread() 或列表「新对话」触发，然后 SWITCH_TO_THREAD。
- **运行状态**：ThreadPrimitive.If running 控制「发送中/流式中」显示停止按钮、禁用发送；RunSummaryCard 显示最近一次运行摘要（错误、重试、诊断等）。

### 2.3 对话框与弹层

- **InterruptDialog**：断线或需要用户确认时显示，按 threadId 作用当前会话。
- **CrystallizationToast**：任务运行中提示「可结晶为任务」等，与 workspaceId/taskRunning 联动。
- **Plan 确认/修改/取消**：PlanExecuteBar 内按钮，通过自定义事件与后端 plan 状态机配合。

### 2.4 合理性评估与优化建议

**已做得好的**

- 会话级 thread、工作区级 workspace 清晰；ThreadList 与 SessionContext/EVENTS.SESSION_CHANGED 统一。
- 空态欢迎、运行摘要、任务提示条、自治运行条分区明确，不堆在一处。
- 计划模式有独立确认条，避免误触执行。

**可优化点**

| 方面 | 现状 | 建议 |
|------|------|------|
| **消息列表性能** | 长对话用 ThreadPrimitive.Messages 全量渲染 | 接入已有 ProgressiveThreadMessages，减少 100+ 条消息时的卡顿 |
| **时间戳** | 无 createdAt 时 fallback「刚刚」会误导历史消息 | 无时间戳则不显示或显示「时间未知」 |
| **复制/导出** | copy_table、copy_code、export_table_csv、download_code 等若只 toast 未真正写剪贴板/文件 | 实现真实 clipboard.writeText / Blob + 下载，并在失败时 toast.error |
| **流式滚动** | 曾因 scroll-smooth + turnAnchor 抖动 | 已去掉 scroll-smooth；若仍有抖动可考虑仅在新消息时 scrollIntoView 不加 smooth |
| **ArtifactPanel** | 最大宽度约 580px，不可拖拽调宽或最大化 | 增加拖拽调宽与「最大化」按钮（如 80vw 或全屏），见 P3 计划 |

---

## 3. 工作台（WorkspaceDashboard）

### 3.1 职责与数据流

工作台是「当前工作区」的入口页：简报、工作建议、快捷任务输入、命令面板、最近任务/线程、技能与配额等。

- **简报（briefing）**：`generateBriefing()`，展示今日优先级、建议等；存 **dashboardBriefingStore**。
- **工作建议（workSuggestions）**：`getWorkSuggestions()`，无活跃任务时展示「系统建议」卡片，点击填入输入框；与 briefing 同属 briefingStore，加载完成后 **workSuggestionsReady** 为 true（无论成功失败都应置 true，避免骨架屏卡死）。
- **看板任务**：**boardApi.getTasks("personal")**，结果进 **useTaskStore**，仪表盘从 store 取前 20 条展示；30s 轮询刷新，带 cancelled 守卫与 try/catch。
- **角色/特性/许可**：**dashboardMetaStore**（featureFlags、roles、activeRoleId、currentLicenseTier、releaseGate 等），与 Composer 通过 localStorage + EVENTS 同步。

### 3.2 用户路径

**说明**：工作台提交当前为**仅填输入框**，不自动创建 board 任务；若需创建看板任务请使用「创建看板任务」等入口。

1. **仅想发一条指令**：在工作台大输入框输入 → 点提交或 ⌘Enter → **onSubmitTask(prompt)**（由 FullEditor 传入）→ 打开右侧聊天 + **FILL_PROMPT**，默认 **autoSend: false**，用户可改后发送。
2. **想创建看板任务并打开详情**：输入描述 → 提交 → **handleCreateBoardTask** → **boardApi.createTask** → **OPEN_TASK_IN_EDITOR** + **TASK_PROGRESS** → 编辑区打开 TaskDetailView，任务列表/仪表盘刷新。
3. **⌘K 命令面板**：打开 CommandPalette，可搜索线程/任务/技能/命令等。
4. **⌘⇧V**：从剪贴板填入任务并触发 onNewProject（打开聊天等）。

### 3.3 与聊天/任务的联动

- **RUN_SUMMARY_UPDATED**：MyRuntimeProvider / 流式层派发，仪表盘监听后更新 lastRunSummary（阶段、工具、错误、linkedTaskId/linkedThreadId），用于「继续上次」等入口。
- **OPEN_TASK_IN_EDITOR**：由 FullEditor 监听，打开左侧任务详情（TaskDetailView）；仪表盘、Thread、通知中心、TaskListSidebar 均可发该事件。
- **SWITCH_TO_THREAD**：MyRuntimeProvider 监听，切到对应 thread；仪表盘「继续对话」等会发此事件。

### 3.4 合理性评估与优化建议

**已做得好的**

- 简报/建议/看板任务/元数据分 store，减少无关重渲染。
- 任务创建与「在编辑区打开任务」统一走 OPEN_TASK_IN_EDITOR，单一路径。
- 工作台与 Composer 偏好（角色、模式）通过事件与 storage 同步，一致性好。

**可优化点**

| 方面 | 现状 | 建议 |
|------|------|------|
| **onSubmitTask 语义** | 当前为「打开聊天 + 填入 prompt」，不创建 board 任务 | 若产品希望「工作台提交=创建任务+填对话」，可改为先 boardApi.createTask 再 FILL_PROMPT + 可选 SWITCH_TO_THREAD(thread_id)；否则保持「仅填输入框」并文档说明 |
| **工作建议点击** | 点击即填入输入框，但聊天可能未打开 | 填入时若右侧未打开可先 OPEN_CHAT_PANEL 或 setShowRightPanel(true)，再 FILL_PROMPT |
| **命令面板** | ⌘K 全局，与编辑器 Cmd+K 可能冲突 | 已通过 OPEN_COMMAND_PALETTE / OPEN_EDITOR_COMMAND_PALETTE 区分；保持并确保快捷键帮助中写清 |
| **骨架屏** | 加载中用 Spinner | 用 Skeleton 占位（简报卡、建议卡、任务列表）提升感知性能 |

---

## 4. 任务管理

### 4.1 两套 API 与概念区分

| 概念 | API/Store | 用途 |
|------|-----------|------|
| **Board 任务（看板任务）** | **boardApi**（createTask、getTasks、updateTask、cancelAutonomousRun 等） | 产品侧「任务」：有 subject、status、thread_id、execution 等，用于仪表盘、TaskListSidebar、TaskDetailView、通知 |
| **Tasks（LangGraph 侧）** | **tasksApi**（/tasks、create、list、get、update、cancel） | 后端执行侧任务（可与 thread 关联），TaskDetailView「开始执行」时用 tasksApi.create 拉起 run |

关系：一个 **Board 任务** 可关联一个 **thread_id**；执行时可能再创建 **tasksApi** 的 task 并得到 run_id。仪表盘/侧边栏展示和状态更新以 **boardApi** 为准；**TaskDetailView** 内「开始执行」会调 **tasksApi.create**，并将执行状态反馈到 board/thread。

### 4.2 任务列表（TaskListSidebar）

- **数据**：**boardApi.getTasks("personal", statusFilter)**，本地 state 存 tasks，支持搜索、状态筛选、排序。
- **操作**：停止（cancelAutonomousRun）、取消/归档（updateTask status cancelled）、完成（updateTask status completed）、删除（同取消）、新建（**createTaskWithDispatchFeedback**：创建后轮询直到 running/waiting_human/completed 等，并 **onOpenTask** 打开详情）。
- **新建**：弹窗输入 subject/description/priority，创建后轮询看板并可选打开任务详情；Enter 需防重（`!creating`）。

### 4.3 任务详情（TaskDetailView）

- **数据**：**useTaskStore** 的 tasksById[taskId]，不足时 **boardApi.getTask(taskId)** 拉取；有 **requestTaskRefresh** 防抖与版本号防陈旧响应。
- **操作**：暂停/继续/取消/重新开始（**boardApi.updateTask**）、checkpoint 确认/拒绝、保存描述、**「开始执行」**（**tasksApi.create** 并跳转/关联 thread）。
- **「查看产出」**：若有 **thread_id** 则 **onOpenThread(thread_id)** + **SWITCH_TO_THREAD**；无则宜 **disabled + title 提示** 或 toast「任务尚未关联对话」。

### 4.4 事件与联动

- **OPEN_TASK_IN_EDITOR**：携带 taskId、subject、可选 focusSection；FullEditor 监听后 **handleOpenTaskInEditor**，在编辑区展示 TaskDetailView。
- **TASK_PROGRESS**：任务状态/进度更新时派发，TaskDetailView、仪表盘等可刷新任务数据或轮询。
- **RUN_SUMMARY_UPDATED**：含 linkedTaskId/linkedThreadId 时，仪表盘展示「继续任务/对话」入口。

### 4.5 合理性评估与优化建议

**已做得好的**

- Board 与 Tasks API 职责清晰：展示与生命周期用 board，执行拉起用 tasks。
- 创建任务后通过 createTaskWithDispatchFeedback 轮询并打开详情，体验连贯。
- TaskDetailView 防抖与版本号避免请求风暴与陈旧覆盖。

**可优化点**

| 方面 | 现状 | 建议 |
|------|------|------|
| **开始执行** | 动态 import("tasksApi") 后 then 里 setOpLoading，import 失败时 start 永不释放 | import().catch 里 toast.error + finally 里 setOpLoading({ start: false }) |
| **完成/取消/归档** | 操作后仅 toast.success | 可加 Undo Toast（5s 内撤销并反向 API），提升误操作可恢复性 |
| **任务列表底部统计** | 有筛选时仍显示 tasks.length | 有筛选时显示「filtered.length / tasks.length 个任务」 |
| **删除线程后搜索列表** | recentThreadsForSearch 未过滤已删线程 | 删除成功后 setRecentThreadsForSearch(prev => prev.filter(t => t.id !== deleteTargetId)) |

---

## 5. 总体数据流简图

```
                    ┌─────────────────────────────────────────────────────────┐
                    │                    FullEditorV2Enhanced                    │
                    │  (布局、OPEN_TASK_IN_EDITOR、FILL_PROMPT、命令面板等)       │
                    └───────────────────────┬───────────────────────────────────┘
                                            │
         ┌──────────────────────────────────┼──────────────────────────────────┐
         │                                  │                                  │
         ▼                                  ▼                                  ▼
┌─────────────────┐              ┌─────────────────────┐              ┌─────────────────┐
│ WorkspaceDashboard│              │   ChatAreaEnhanced   │              │ TaskDetailView  │
│ 简报/建议/看板任务  │              │  ThreadList + Thread  │              │ 任务详情/操作   │
│ onSubmitTask →   │──────────────▶│  CursorStyleComposer │◀────────────│ 开始执行 →      │
│ FILL_PROMPT      │   OPEN_CHAT   │  FILL_PROMPT/发送    │   OPEN_THREAD│ tasksApi.create │
│ OPEN_TASK_IN_EDITOR│              │  SWITCH_TO_THREAD   │              │ OPEN_TASK_IN_   │
└────────┬────────┘              └──────────┬──────────┘              │ EDITOR          │
         │                                  │                          └────────┬────────┘
         │                                  │                                   │
         │                    ┌─────────────▼─────────────┐                     │
         └───────────────────▶│   MyRuntimeProvider       │◀────────────────────┘
                              │  thread/run、sendMessage、 │
                              │  contextItemsRef、mode 等  │
                              └─────────────┬─────────────┘
                                            │
                              ┌─────────────▼─────────────┐
                              │  LangGraph / 后端 API      │
                              │  /threads, /runs, /tasks  │
                              └───────────────────────────┘
```

---

## 6. 小结

- **Composer**：与 MyRuntimeProvider 通过 ref + 事件协同，模式/角色/上下文/联网语义清晰；可优化文案与布局区分「模式 vs 角色」、联网三态提示、上下文折叠。
- **聊天区**：Thread + ThreadList + Viewport + PlanExecuteBar 分工明确；建议接入虚拟消息列表、修复时间戳与复制/下载实现、ArtifactPanel 可调宽与最大化。
- **工作台**：简报与建议、看板任务、命令面板、与聊天/任务的事件联动完整；可明确 onSubmitTask 是「仅填输入框」还是「创建任务+填对话」、工作建议点击时保证聊天已打开、骨架屏替代 Spinner。
- **任务管理**：Board 与 Tasks API 分离合理；TaskListSidebar 与 TaskDetailView 的防重与错误处理可再加强，并增加 Undo Toast、筛选后统计、删除线程后搜索列表过滤等细节。

以上梳理可作为产品说明与后续迭代（含 P0/P1/P2/P3 计划）的对照依据，如需对某一条做实现级修改，可再针对具体文件与行号细化。
