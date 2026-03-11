# 产品与架构合理性分析（2026-03-04）

针对当前若干设计点的合理性分析与发展建议。

---

## 1. 为什么要有 ArtifactPanel？产成品放到工作区在编辑区显示是否更好？

### 现状

- **ArtifactPanel** 订阅 `toolStreamEventBus` 的 `type === "artifact"` 事件，展示后端流式推送的「产成品」（代码片段、Markdown、HTML、表格等）。
- 数据来源：**流式事件**（`ToolStreamEvent`），由 Agent 在运行过程中通过 custom stream 推送到前端，并非先落盘到工作区再被读取。
- 支持类型：code / document / markdown / html / table 等，带标题、类型、可复制/下载/全屏。

### 合理性分析

| 维度 | 结论 |
|------|------|
| **内容是否特殊** | 部分特殊：**实时流式产出**、**未持久化前的草稿**、**会话内多产物列表**（如一次对话生成多个代码块/表格）。若只放工作区，需要 Agent 先写文件、再通知前端打开，链路更长且与「边生成边看」的体验不一致。 |
| **与工作区关系** | 不矛盾：Artifact 可视为「会话内预览」；用户确认后可以**另存到工作区**（当前有复制/下载，可增强为「保存到工作区」按钮）。 |
| **编辑区显示** | 在编辑区用 Tab 打开文件更适合**已持久化、需长期编辑**的内容；ArtifactPanel 更适合**临时查看、多产物切换、不污染工作区**的场景。 |

**建议**：

- **保留 ArtifactPanel**，继续作为「会话内产成品预览」的专用区域。
- **增强**：增加「保存到工作区」入口（可选路径/文件名），把当前 Artifact 写入工作区并在编辑区打开，兼顾流式体验与持久化。
- **可选演进**：若未来 Agent 直接写工作区文件并返回路径，前端可根据路径在编辑区打开，此时 ArtifactPanel 可只保留「未保存」的流式产物，与「已保存」的编辑区文件形成清晰分工。

---

## 2. Composer 上「解释代码/重构优化/总结文档/任务拆解」等标签的含义与合理性

### 现状

- 定义在 `cursor-style-composer.tsx` 的 `PROMPT_TEMPLATES`：每个项为 **预设提示词模板**，带占位符如 `{{code}}`、`{{content}}`、`{{goal}}`。
- 用户点击标签后，将对应模板填入输入框（或替换占位符后发送），**不是**独立任务类型，而是**快捷输入/快捷指令**。

### 合理性分析

| 维度 | 结论 |
|------|------|
| **与 Cursor 的差异** | Cursor 没有这组「中文标签 + 模板」的快捷入口；本产品是**产品化增强**：降低表达门槛、统一常用句式，适合国内团队与中文场景。 |
| **是否算「任务」** | 本质是**对话内快捷方式**（prompt shortcuts），不是系统级任务；发送后仍是一条普通用户消息，由当前模式/角色处理。 |
| **设计是否合理** | 合理。等价于「常用提示词书签」，减少重复输入、提高一致性；与 Cursor 的「/命令」互补（/plan、/debug 等是模式/流程，这里是内容模板）。 |

**建议**：

- 保持现有定位，在 UI 上可注明为「快捷提示」或「常用指令」，避免与「任务/子任务」混淆。
- 可配置化：允许用户在设置中增删/编辑这些模板（与 Skills 或提示词库区分开），提升可扩展性。

---

## 3. 本地模型（qwen3.5-9B）与响应速度优化、云端并行与 Cursor 式 Auto 策略

### 现状与目标

- 本地：qwen3.5-9B（LM Studio），可开/关 thinking，262144 token 窗口，效果接近 35B 但内存更小，速度未明显提升。
- 目标：**不牺牲效果**的前提下，从「本系统 + LM Studio」两端优化速度，并引入云百炼做并行/更强模型，最终实现「先本地验证 → 云端并行加速 + Cursor 式按任务选模型以控本保质」。

### 合理性分析（分维度）

**本系统（ccb）**：

- **流式与首 token**：确保流式输出从第一个 chunk 就推送，避免缓冲整段再返回；检查 LangGraph/自定义 stream 是否有不必要的攒批。
- **上下文与 prompt 体积**：控制 system prompt / history 长度，对 9B 可适当压缩摘要、延迟加载非必要 Skills，减少每轮 token 数。
- **模型路由**：为「简单问答/补全」与「复杂规划/多步」区分路由（见下「Auto 策略」），简单请求走 9B，复杂走 35B 或云端。

**LM Studio**：

- **thinking**：若 9B 开 thinking 与 35B 效果相当，可保留；若关闭 thinking 仍可接受，可关以换速度。
- **批处理/并发**：LM Studio 侧是否有排队、是否可调 batch size / context 预分配，需看其文档与配置。
- **硬件**：确认 GPU/CPU 利用率、是否有不必要的同步点；量化与精度（如 4bit）在 9B 上对速度影响。

**云端（百炼）与并行**：

- **并行**：多轮独立子任务（如多文件分析）可并行调云模型，本系统需在编排层支持「多 run 并行」并汇总结果。
- **更强模型**：复杂规划、评审、高要求生成走云端大模型；简单、敏感或离线场景走本地 9B。

**Cursor 式 Auto 策略**：

- **按任务类型选模型**：例如「解释/补全/简单问答」→ 本地 9B；「计划/重构/多步推理」→ 本地 35B 或云端；「代码审查/深度分析」→ 云端。
- **成本与质量**：对每类任务设定质量门（如通过率、用户修正率），在保证质量前提下优先便宜/快模型，超标再升级。

**建议（落地顺序）**：

1. 本地验证：先在本系统 + LM Studio 上做「流式与上下文精简」优化，并区分配置 9B/35B（或 thinking 开/关），测量首 token 与整轮时延。
2. 云端打通：将百炼接入为可选模型端点，支持按 thread/task 选择本地 vs 云端。
3. 并行：在 Plan/Agent 流程中识别可并行子任务，对子任务并行调用云端（或本地多实例若可行）。
4. Auto 策略：在配置中为「任务类型 → 推荐模型」建表，运行时根据当前模式与任务描述选择模型，并记录质量指标用于后续调参。

---

## 4. Composer 上方任务栏的优化方向

### 现状

- Composer 上方有任务相关展示（当前会话内的任务/进度），与「系统级任务管理」（如 TaskListSidebar、看板）是**不同层级**：前者是**对话内任务**，后者是**全局任务**。

### 合理性分析

- **层级划分正确**：对话内任务 = 当前 thread 的执行单元与进度；系统任务 = 跨会话、可分配、可跟踪的工单。两者互补。
- **「无任务时隐藏」**：合理。无进行中任务时收起或隐藏该栏，可减少干扰、突出输入区。
- **有任务时合理展示**：展示当前任务标题、步骤进度、取消/重试等，并可与 ArtifactPanel、消息流联动（如点击步骤定位到对应消息或 Artifact）。

**建议**：

- 将「无任务时隐藏、有任务时展示」做成明确交互规则，并统一数据源（如从 toolStreamEventBus 的 task_progress 与 run 状态派生）。
- 增强：步骤可展开/折叠、支持「仅重试失败步骤」等，与后端 report_artifacts / report_blocked 语义对齐，形成**对话内任务管理**的闭环。

---

## 5. 欢迎页与工作区页：内容更真实、与业务和用户强关联

### 现状与目标

- 欢迎页、工作区页已有明显进步；希望内容**更真实、更与业务和用户关联**，真正**以用户为中心**。

### 合理性分析

- 当前若仍偏「通用话术」或静态示例，会显得与用户身份、项目、历史行为脱节。
- **以用户为中心** = 称呼/角色可配置、展示与当前用户/工作区相关的快捷入口、最近会话/任务、推荐能力（基于角色或 skill_profile）。

**建议**：

- **数据驱动**：欢迎页/工作区页从 `agent/profile`、`roles`、当前 workspace、最近 thread/task 拉数据，展示「当前角色」「当前工作区」「最近对话」「推荐操作」。
- **业务关联**：若有 skill_profile 或领域配置，展示与该领域相关的快捷任务与说明；若有任务看板，可展示「我的待办」或「进行中」摘要。
- **可配置副本**：关键文案（如标题、副标题、引导语）支持从配置或 i18n 读取，便于按团队/产品定制。

---

## 6. 底部状态栏：增强系统感知力

### 合理性分析

- 状态栏是**系统状态的外显**：连接状态、当前模型、当前角色/模式、工作区、可选显示 token/配额、后台任务数等。
- 增强「系统感知力」= 用户无需进设置或多级菜单即可感知「我在用什么、系统在做什么、有没有异常」。

**建议**：

- 在现有基础上增加：**当前模型**（本地 9B/35B 或云端）、**当前角色/模式**、**连接/认证状态**（如 401 时提示配置 token）。
- 可选：**轻量通知**（如「模型已切换」「任务已完成」）在状态栏短暂提示，避免弹窗打断。

---

## 7. 系统人性化：可配置名字（设置 + 用户输入）

### 合理性分析

- 将 Agent 视为「助理」时，可配置名字能增强归属感与辨识度（如团队内「小美」「项目助手」）。
- **配置页**：全局默认名字（存于 agent profile 或设置）。
- **用户输入**：在对话中支持「叫你 XX」等自然语言，解析后更新当前会话或全局称呼（需与 agent_profile.name 或 persona 联动）。

**建议**：

- 在 `agent/profile` 或 persona 中已有/扩展 `name` 字段，设置页提供「助理名称」配置项。
- 对话解析：若识别到更名意图，可调用 `PATCH /agent/profile` 或 persona 更新 name，并提示「好的，之后你可以叫我 XX」。

---

## 8. 角色与 Skills 的关系（Claude 逻辑：通用 Agent + Skills）

### 现状（来自 agent-system-design.mdc）

- **Layer 3 角色层**：role_persona / role_cognitive_style / role_interaction / role_quality / role_drive（来自 roles.json）。
- **Layer 4 业务能力层**：use_skills、knowledge_graph、BUNDLE、project_memory。
- **Skills**：方法论（怎么做）→ 自定义工具 + BUNDLE 内联；**Knowledge**：知道什么 → search_knowledge / knowledge-agent。

### 合理性分析

- **Claude 思路**：通用 Agent + 技能集，少用「固定人设」，多用「能力组合」与「任务上下文」。与本项目的「角色 + Skills」可对齐为：
  - **角色** = 人格与交互风格（如何说话、如何决策、如何与人协作），偏「谁在跟我说话」。
  - **Skills** = 能力与流程（会做什么、按什么步骤做），偏「能做什么事」。
- **关系**：一个角色可以绑定一组默认 Skills（或 skill_profile）；一次会话既有「当前角色」也有「当前可用 Skills」。这样既保留角色的人性化，又避免把「能力」写死在角色里，便于 Skills 独立演进（更多代码、更确定、更专业）。

### 建议

- **保留「角色」概念**，但明确为**人格/风格层**（Layer 3），不承载具体工具或流程实现。
- **Skills 作为能力层**（Layer 4）：由代码与 BUNDLE 表示，可版本化、可测试、可复用；角色通过「推荐/默认 Skills」或 skill_profile 关联，而非硬编码能力。
- **后续 Skills 发展**：更多用代码表示能力、更多领域 Skill、更确定性与专业性时，**角色**仍只负责「用什么风格、什么领域偏好」，**具体怎么做**完全由 Skills + 工具 + 知识库承担。这样与「通用 Agent + Skills」的路线一致，且便于扩展。

---

## 9. 错误与告警的优化（含 401、CSP、无活动线程等）

### 9.1 GET /agent/profile 401 (Unauthorized)

**原因**：  
- 后端 `/agent/profile` 使用 `verify_internal_token`，只校验请求头 **`X-Internal-Token`** 与环境变量 **`INTERNAL_API_TOKEN`** 是否一致。  
- 前端 `apiClient` 仅发送 **`Authorization: Bearer <localAgentToken>`**（来自 `VITE_LOCAL_AGENT_TOKEN`），**未发送** `X-Internal-Token`。  
- 若后端未配置 `INTERNAL_API_TOKEN`，或前端未传与之一致的 token，就会 401。

**修复方向**（已实现方案 A）：

- **方案 A（已做）**：后端 `verify_internal_token` 已扩展为同时接受 **`X-Internal-Token`** 或 **`Authorization: Bearer <token>`**，当与 `INTERNAL_API_TOKEN` 一致时通过。前端继续使用 `Authorization: Bearer <localAgentToken>` 即可。
- **配置**：将后端的 **`INTERNAL_API_TOKEN`** 设置为与前端 **`VITE_LOCAL_AGENT_TOKEN`** 相同的值（或反之），即可消除 401。

### 9.2 Electron Security Warning (Insecure Content-Security-Policy)

- 开发阶段 renderer 使用 `unsafe-eval` 或未设置 CSP 会触发警告；文档已说明打包后可能不再显示。
- **已做**：在 Electron main 中，生产构建（`NODE_ENV !== 'development'`）时通过 `session.defaultSession.webRequest.onHeadersReceived` 注入严格 CSP（`script-src 'self'`，不含 `unsafe-eval`）；开发环境不注入，以保留 Vite HMR。参见 `frontend/desktop/src/electron/main.js` 中 `setupProductionCSP`。
- **取舍**：开发环境需保留宽松 CSP 或关闭警告以支持 HMR；生产打包后 CSP 收紧，控制台警告不再出现。

### 9.3 「没有活动线程，无法取消」

- 在无活动 thread 时触发了取消生成，后端或前端判断「无活动 run」后返回该提示。
- **建议**：前端在无活动线程时禁用或隐藏「停止生成」按钮，或点击时给出友好提示（如「当前没有正在进行的生成」），避免用户困惑。

### 9.4 其他

- **React DevTools 提示**：开发期提示，可忽略或按需安装。
- **FileSyncManager / Vite HMR**：属正常日志，可按需降级为 debug。

### 9.5 INTERNAL_API_TOKEN 配置说明与 localhost 放行

**何时必须配置**：

- 需要调用**写类内部 API**（云端端点 GET/PUT、模型切换、模型增删改、配置读写、技能/插件、文件操作等）时，若请求**非来自 loopback**，后端要求请求头带与 `INTERNAL_API_TOKEN` 一致的 `X-Internal-Token` 或 `Authorization: Bearer <token>`。
- 因此：**后端监听 0.0.0.0 或请求经反向代理/跨机访问时**，必须在后端配置 `INTERNAL_API_TOKEN`，并在前端配置 `VITE_INTERNAL_API_TOKEN` 或 `VITE_LOCAL_AGENT_TOKEN` 为同一值，否则上述写接口会 401。

**令牌可选（零配置本地开发）**：

- 当 **`INTERNAL_API_TOKEN` 未设置** 时，`verify_internal_token` 仅允许来源为 **loopback**（`127.0.0.1`、`::1`）的请求通过，其它来源一律 401。
- 这样在「后端仅本机访问、前端直连 127.0.0.1」的本地/开发场景下，**可不配置任何 token** 即可使用所有内部 API。

**适用场景与风险**：

- **适用**：本机开发、Electron 桌面端仅连本地后端、后端只监听 127.0.0.1。
- **风险**：未配置 token 且请求来自 loopback 时，**不区分调用方**，同机其它进程或恶意页面（若与前端同源且能访问 127.0.0.1）也可调用写接口。若需防护同机/同源滥用，应设置 `INTERNAL_API_TOKEN` 并在前端注入同一 token。

---

## 实现建议汇总

1. **401 修复**：后端 `verify_internal_token` 支持 `Authorization: Bearer` 与 `INTERNAL_API_TOKEN` 一致时通过；或前端对 internal 接口增加 `X-Internal-Token`。
2. **产成品约定**：产成品优先写入消息体（tool result），在聊天区内联展示；仅当未作为 tool result 内联时才发 `type: "artifact"` 流事件，避免聊天区与 ArtifactPanel 双重展示（见 backend/tools/base/streaming.py 约定）；Plan 结果区「确认执行」为执行计划唯一入口。
3. **UI 单入口与去重**：`getAgentProfile` 已在 boardApi 内做缓存与 in-flight 合并，多组件调用不会重复请求；打开对话/打开任务/执行计划等统一通过 `EVENTS`（如 `OPEN_CHAT_PANEL`、`OPEN_TASK_IN_EDITOR`、`PLAN_CONFIRMED`）由单一入口触发；RunSummaryCard / TaskPanelHintStrip / AutonomousRunsStrip 均已在无任务或无 run 时隐藏（返回 null 或条件渲染）。
4. **ArtifactPanel**：保留；增加「保存到工作区」能力。
5. **Composer 标签**：保持为快捷提示模板；可配置化。
6. **任务栏**：无任务时隐藏，有任务时结构化展示并与进度/步骤联动。
7. **欢迎/工作区页**：用 agent/profile、workspace、最近会话与任务驱动内容，并支持称呼与业务关联配置。
8. **状态栏**：展示模型、角色/模式、连接与认证状态。
9. **助理名字**：配置页 + 对话内解析更新 name（与 agent profile/persona 一致）。
10. **角色与 Skills**：角色 = 人格/风格；Skills = 能力/流程；Skills 用代码与 BUNDLE 持续演进。

以上为对当前 9 个问题的集中分析与建议，可直接作为产品与迭代的参考。
