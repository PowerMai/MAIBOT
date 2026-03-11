# 联调阶段集成契约（禁止破坏性变更）

本文档集中列出联调阶段**不可 breaking 的契约**，供 CI/门禁引用与前后端对齐。与 [main_pipeline_and_middleware_rationality.md](main_pipeline_and_middleware_rationality.md)、[domain-model.mdc](../.cursor/rules/domain-model.mdc) 互补。

---

## 1. 入口与运行方式

| 契约项 | 约定 | 位置 |
|--------|------|------|
| 生产入口 | **LangGraph Server** 为唯一生产入口；通过 `langgraph dev` / `langgraph up` 启动。 | [langgraph.json](../langgraph.json) |
| 图入口 | `graphs.agent` → `backend.engine.core.main_graph:graph`。 | langgraph.json |
| HTTP 挂载 | 自定义 FastAPI 挂载于 `http.app` → `backend.api.app:app`。 | langgraph.json |
| 前端对接 | 前端仅通过 **LangGraph SDK**（`@langchain/langgraph-sdk`）连接，Base URL 默认 `http://127.0.0.1:2024`。 | [langserveChat.ts](../frontend/desktop/src/lib/api/langserveChat.ts) |
| Assistant ID | 与 `graphs.agent` 的 key 一致：`LANGGRAPH_ASSISTANT_ID = "agent"`（可被 `VITE_LANGGRAPH_ASSISTANT_ID` 覆盖）。 | langserveChat.ts |

---

## 2. 状态与 configurable

| 契约项 | 约定 | 位置 |
|--------|------|------|
| 主图状态 | `AgentState` 仅含 `messages: Annotated[list[AnyMessage], add_messages]`。 | [agent_state.py](../backend/engine/state/agent_state.py) |
| configurable 必含 | 后端 run 时 configurable 至少包含：`thread_id`、`mode`（默认 `"agent"`）、`role_id` 或 `active_role_id`、`workspace_path`。 | main_graph / domain-model.mdc |
| 前端传入 | 前端 sendMessage 时通过 config 传入上述字段；会话键优先于全局键（见 domain-model.mdc）。 | MyRuntimeProvider / sessionState |

### 2.1 configurable 扩展字段（Plan / 执行）

| 字段 | 说明 | 来源/用途 |
|------|------|-----------|
| `plan_phase` | `"planning"` \| `"execution"` | 图级 Plan 两阶段；与 agent 缓存 key 区分（见 deep_agent._build_orchestrator_cache_key）。 |
| `plan_confirmed` | boolean | Plan 模式是否已确认执行；与 mode_permission、editor_tool 门禁一致。 |
| `plan_file_path` | 计划文件绝对路径 | 执行阶段注入 \<plan_execution\> 提示；可由后端按约定 `.maibot/plans/{thread_id}.md` 解析补全。 |

必含校验见 [configurable_check.validate_configurable](backend/engine/core/configurable_check.py)；扩展字段由 main_graph / deep_agent 按需注入或解析，不参与必含校验。

### 2.2 记忆作用域（memory_scope）

主图在准备 agent config 时调用 [resolve_memory_scope](backend/config/memory_scope.py)，将 `workspace_id`、`user_id`、`memory_scope_mode`、`memory_shared_enabled` 写入 configurable，供 Store/langmem 长期记忆命名空间使用；前端需传 `workspace_path`（或 `workspace_id`），多用户场景可传 `user_id`/`langgraph_user_id`。详见 [memory-scope-contract_2026-03-02.md](memory-scope-contract_2026-03-02.md)。

---

## 3. 流式契约

### 3.1 session_context（每次 run 开始时一条）

| 契约项 | 约定 | 位置 |
|--------|------|------|
| 发送时机 | reasoning start 之后、首包前，通过 `writer({"type": "session_context", "data": { ... }})` 发送**一条** custom 事件。 | [main_graph.py](../backend/engine/core/main_graph.py) 流式入口 |
| data 形状 | `threadId`（configurable.thread_id，可为 null）、`mode`、`roleId`、`modelId`（本 run 实际使用的模型 id，便于前端展示「当前由哪台模型在服务」）。 | main_graph.py |
| 前端消费 | `event.event === 'custom'` 且 `d?.type === 'session_context'` 时解析 `d.data`；**仅当** `currentThreadIdRef.current === threadId` 时执行同步并广播 EVENTS。 | [MyRuntimeProvider.tsx](../frontend/desktop/src/components/ChatComponents/MyRuntimeProvider.tsx) |
| 单次应用 | 同一 run 内若收到多条 session_context，前端仅对**第一次**应用写存储与派发，避免重复派发（通过 run 开始时重置的 sessionContextAppliedForRunRef 标记）。 | MyRuntimeProvider.tsx |
| 校验 | 后端 `threadId` 为空时前端视为无效，不写存储、不派发事件。 | [toolStreamEvents.ts](../frontend/desktop/src/lib/events/toolStreamEvents.ts) `parseSessionContextPayload` |

### 3.2 流事件 payload 形状（custom）

- **session_context**：`{ type: "session_context", data: { threadId, mode, roleId, modelId? } }`（见上）。
- **run_error**：`{ type: "run_error", data: { error_code?, message? } }`；前端见 [toolStreamEvents.ts](../frontend/desktop/src/lib/events/toolStreamEvents.ts) `parseRunErrorPayload`。
- **first_llm_token**：含 `ttft_ms_since_run_start`、`ms_since_stream_open`、`run_id` 等（观测用）。
- **messages_partial** / **reasoning**：由 LangGraph SDK 与 assistant-ui 消费，形状以 SDK 为准。

### 3.3 流结束与工具结果汇总（前后端对接）

| 契约项 | 约定 | 位置 |
|--------|------|------|
| **stream_end** | 前端在 run 流正常/取消/异常结束时派发 `toolStreamEventBus.handleStreamEvent({ type: 'stream_end', threadId?, reason? })`；`reason === 'complete'` 表示正常结束。 | [MyRuntimeProvider.tsx](../frontend/desktop/src/components/ChatComponents/MyRuntimeProvider.tsx) runStreamCleanup、finally |
| **stream_end 消费** | 前端 thread 订阅 `stream_end`，仅当 `reason === 'complete'` 时写入 lastRunSummary（toolCount、errorCount、filePaths）并 toast。 | [thread.tsx](../frontend/desktop/src/components/ChatComponents/thread.tsx) |
| **tool_end** | 前端在每次收到类型为 `tool` 的消息（ToolMessage）时派发 `tool_end`，可选带 `path`（文件类工具）、`toolName`；**每条 ToolMessage 均派发**，保证 run 内工具计数与 RunSummaryCard 一致。 | MyRuntimeProvider.tsx（遍历 event.data 中的 msg.type === 'tool'） |
| **tool_end 消费** | 前端 thread 订阅 `tool_end`：runToolCountRef +1；若 ev.path 存在则 push 到 runFilePathsRef，供 lastRunSummary.filePaths 与「变更文件可点击打开」使用。 | thread.tsx |
| **content_parts 与 id 同源** | 后端 `content_parts` 中 tool-call 的 `id`、AIMessage.tool_calls[].id、对应 ToolMessage.tool_call_id 必须一致，前端 merge 与证据区按 part.id / tool_call_id 对齐 result。 | [main_graph.py](../backend/engine/core/main_graph.py)、[tool_display_cursor_alignment.md](tool_display_cursor_alignment.md) §7 |
| **custom messages_partial** | 后端通过 TokenStreamHandler 或 chunk 路径下发 `messages_partial` 时，payload 可含 `content_parts`（reasoning → text → tool-calls）；前端 custom 分支**必须保留** content_parts 并 yield，不得剥离，以便 SDK contentPartsToMerged 得到按步展示与连续合并。 | MyRuntimeProvider.tsx、tool_display_cursor_alignment.md §0.3 |

### 3.4 首包延迟说明（云端 35B 等）

- **谁在服务**：本 run 实际使用的模型由 `session_context.data.modelId` 下发，前端可据此展示「当前由哪台模型在服务」；配置缺省模型见 `backend/config/models.json` 的 `default_model`，运行时选模逻辑见 `model_manager.get_model_for_thread`（显式选择优先于会话绑定）。
- **为何要等**：从发送消息到首字出现可能包含两段耗时：（1）**执行引擎准备**：`get_agent()` 在线程池中执行（构建图、创建 LLM 等），期间会下发 `task_progress`（如「正在准备执行环境…」「执行引擎准备中（已等待 Xms）…」）；（2）**云端首 token**：云端 35B 等大模型的首 token 时间（TTFT）由厂商与负载决定，可能数秒至数十秒。若需缩短体感等待，可优先使用本地模型或厂商提供的低延迟端点。

---

## 4. 前端事件（EVENTS）

| 契约项 | 约定 | 位置 |
|--------|------|------|
| 事件名常量 | 统一使用 [constants.ts](../frontend/desktop/src/lib/constants.ts) 的 `EVENTS.*`，禁止硬编码字符串 `thread_changed`。 | domain-model.mdc |
| 会话相关 | `SESSION_CHANGED`（携带 threadId）、`SESSION_CREATED`、`ROLE_CHANGED`（携带 threadId, roleId）、`CHAT_MODE_CHANGED`（携带 threadId, mode）。 | constants.ts |
| 存储键 | 会话键优先于全局键；如 `maibot_active_role_thread_{threadId}`、`maibot_chat_mode_thread_{threadId}`；当前会话指针**单一真源**为 `maibot_current_thread_id`（写入仅更新该键），`maibot_active_thread` 仅作兼容读取并逐步废弃；工作区 `maibot_workspace_path`。 | domain-model.mdc、sessionState.ts |

---

## 5. 中间件链

| 契约项 | 约定 | 位置 |
|--------|------|------|
| 链配置唯一源 | 以 [middleware_chain.json](../backend/config/middleware_chain.json) 为链顺序唯一来源；新增中间件只改 JSON。 | deep_agent._load_middleware_chain |
| 链尾 | `streaming` 必须位于链尾，以正确注入 callbacks。 | middleware_chain.json _comment、main_pipeline_and_middleware_rationality.md |
| inject 合并 | 所有 inject_* 在运行时合并为**单次** `inject_runtime_context`。 | deep_agent._runtime_inject_legacy |

### 5.1 官方能力与自研中间件

- **框架内置（DeepAgent/LangChain）**：由 `deep_agent.create_orchestrator_agent` 通过 `additional_middleware` 等注入，**不在** middleware_chain.json 中重复列出。包括：Filesystem、Memory、Skills、SubAgent、Summarization、PatchToolCalls、TodoList 等。禁止在链中再次添加同名或同职责中间件。
- **自研业务中间件**（在 chain 中显式列出）：context_editing、human_in_the_loop、execution_trace、mode_permission、content_fix、ontology_context、cloud_call_gate、license_gate、reflection、llm_tool_selector、model_fallback、pii_redact、mcp、skill_evolution、self_improvement、distillation、scheduling_guard、model_call_limit、tool_call_limit、tool_retry、model_retry、inject_runtime_context、streaming。
- **链顺序原则**：content_fix 在 mode_permission 之后、ontology_context 之前（保证注入前消息已规范）；inject_runtime_context 在 retry 之后、streaming 之前（最后改 prompt、最后接流）。
- **链顺序回退**：middleware_chain.json 缺失或某 mode 链缺失时，使用 deep_agent._load_middleware_chain 的 default_chain（与 chains.ask 一致）。见 [test_middleware_chain_consistency](backend/tests/test_middleware_chain_consistency.py)。

### 5.2 ContentFix 职责与可选迁移

- **职责**：在每次模型调用前对 `state.messages` 做：content 为 None 时置为 `""`（避免本地模型 Jinja 模板报错）、系统消息去重与超限合并、移除空内容消息、超长 ToolMessage 截断。热路径上通过稳定签名（最后一条消息的 type+content 签名）在「消息列表未变」时跳过全量处理。
- **可选迁移**：若需进一步减延迟，可将「去重 + 截断」前移到图节点（如 deepagent_node 入口）每轮只做一次；ContentFix 可退化为仅做 None 兜底，或由 LM 侧模板使用 `message.content or ""` 兜底（本系统以 ContentFix 为单点保证）。

### 5.3 reflection / skill_evolution 与 ENABLE_SELF_LEARNING

- **reflection**：自研；LangChain/DeepAgent 无同名中间件。实现「每 N 次工具调用注入反思提醒、错误/需求覆盖/无进展收敛」等。可配置项：`REFLECTION_EVERY_N_TOOL_CALLS`（默认 5）、`ENABLE_REQUIREMENT_COVERAGE_GATE`、`NO_NEW_INFO_THRESHOLD`、`REQUIREMENT_GATE_COOLDOWN_TOOLS`、`NO_NEW_INFO_COOLDOWN_TOOLS`。不依赖 ENABLE_SELF_LEARNING。
- **skill_evolution**：自研；DeepAgent 仅有 SkillsMiddleware（加载技能），无「从使用中演化技能」。与 **ENABLE_SELF_LEARNING** 绑定：仅当 ENABLE_SELF_LEARNING=true 且在链中启用时执行统计与结晶；纯本地最小链或关闭学习时不加载。

### 5.4 云端模型列表契约（GET /v1/models，OpenAI 兼容）

- **cloud_endpoints** 中配置的端点会由后端请求 `GET /v1/models`（或 `{base_url}/models`）发现可用模型；发现的模型 id 同时用于前端展示与聊天请求的 `model` 参数。
- **单一 id 来源（业界常规）**：后端仅使用响应 `data[]` 中的 **`id`** 作为模型唯一标识（缺省时用 `name`）。该 id 原样用于 POST `/v1/chat/completions` 的 `model` 参数；本系统不做 id 映射。
- **规范 id（无拧麻花）**：云端动态发现的模型在系统内统一使用 **规范 id**：`id = "cloud/" + data[].id`（若 API 已返回 `cloud/` 前缀则不再重复）。列表、前端选择、请求体中的 `model`/`model_id` 均使用该规范 id；实际请求上游 API 时使用 `runtime_model_id`（即 API 原始 id）。配置中的云端模型 id 应与规范 id 一致，以便与发现列表去重、查找一致。
- **约定**：云端 GET /v1/models 的 `data[].id` 必须与 POST /v1/chat/completions 的 `model` 参数一致。后端对请求体中的 `model`（如 cloud/xxx）会做**兼容查找**：精确匹配失败时按「cloud/ 后缀 + 大小写不敏感」匹配发现列表，并始终以该条目的 `runtime_model_id`（即 API 原始 id）请求上游，避免前后端大小写不一致导致 400。
- **多源同 id**：多个 endpoint 返回相同 id 时，本系统合并为同一模型并维护 URL 候选列表（`url_candidates`），请求时使用候选列表。

### 5.5 业务中间件配置约定

- **license_gate**：依赖 `backend/config/license_tiers.json`（各 tier 的 `allow_tools` 等）与项目根下 `data/license.json`（当前授权层级）。前端展示的 tier 需与上述配置一致；修改 tier 或工具白名单后需确保两处一致。
- **cloud_call_gate**：依赖工作区内 `.maibot/settings.json` 的 `sensitive_paths`（字符串列表）。命中路径或关键词的对话内容在发往云端前会被脱敏/替换。生效范围仅限发往云端的 payload，本地模型不受影响。`sensitive_paths` 支持 glob 风格子串匹配（如 `*secret*`）。

### 5.6 学习与蒸馏闭环（路径与格式约定）

| 约定项 | 说明 |
|--------|------|
| **蒸馏样本路径** | `knowledge_base/learned/distillation_samples.jsonl`（由 [DistillationMiddleware](backend/engine/middleware/distillation_middleware.py) 写入；(compressed_input, strong_output) 风格 JSONL）。路径以 `paths.KB_PATH` 或项目根为基准，与 [paths.py](backend/tools/base/paths.py) 一致。 |
| **ReasoningPath 存储** | 学习数据目录由 `paths.LEARNING_PATH`（工作区 `.memory/learning`）提供；`reasoning_paths.json` 等由 [learning_middleware](backend/tools/base/learning_middleware.py) 读写。 |
| **export_for_finetuning** | 通过 `python_run` 调用 `from backend.tools.base.learning_middleware import export_for_finetuning; export_for_finetuning(min_confidence=0.7, format="jsonl")`；返回 `List[Dict]`（每条含 `messages` + `metadata`）。落盘需调用方写入，或使用 `save_finetuning_dataset(output_path)`；推荐输出路径 `knowledge_base/learned/distillation_samples.jsonl` 或与评测脚本约定一致。 |
| **评测/升级脚本** | `export_distillation_samples.py`、`evaluate_distillation_ab` 等脚本的输入路径与 JSONL 形状需与上述路径及 DistillationMiddleware 产出格式一致，避免断链。 |

### 5.7 联网能力与 web 开关

- **web_search / web_fetch**：由 registry 注册；Tavily 优先、DuckDuckGo fallback。**开关**：`configurable.web_search_enabled` 为 true 时保留；为 false 时 deep_agent 在绑定工具前移除二者。前端传 config 时需与用户「联网」偏好一致。

---

## 6. 发布前门禁（联调/发布阶段）

- **UI 门禁**：每次发布前按 [UI_RELEASE_QUALITY_GATE.md](UI_RELEASE_QUALITY_GATE.md) 执行 1–5 类门禁并记录结果。
- **P1 可靠性**：按 [p1_reliability_improvement_backlog_2026-03-02.md](p1_reliability_improvement_backlog_2026-03-02.md) 节奏执行 `make check-reliability-slo`，发布时附证据。
- **a11y/i18n**：按 [a11y_checklist.md](a11y_checklist.md) 做关键路径可访问性与 i18n 扫尾，避免硬编码用户可见文案。

## 7. 引用与门禁

- CI 或发布门禁在修改以下内容时需确认无破坏上述契约：
  - `langgraph.json`、`backend.engine.core.main_graph`、`backend.engine.agent.deep_agent` 的链组装与 writer 调用；
  - `frontend/desktop/src/lib/api/langserveChat.ts`、`MyRuntimeProvider` 的 custom 分支与 EVENTS 消费；
  - `backend/engine/state/agent_state.py`、configurable 字段含义；
  - `backend/config/middleware_chain.json` 的链顺序与 streaming 位置。

---

## 8. 模块职责与变更影响

### 8.1 主图与 Agent 子图迭代（无循环 / 条件边）

- **主图（main_graph）无循环**：主图结构为 `router` → 条件边 `_route_decision_with_plan_phase` → `deepagent_plan` | `deepagent_execute` | `editor_tool` | `error` → **END**。每条请求只走一次路由、一次目标节点后结束；`deepagent_node` 内部仅调用一次 `agent.astream(...)`。
- **多轮模型调用在 Agent 子图内实现**：由 **LangGraph** 在子图内通过**条件边**形成图级循环：`model` →（根据是否有 tool_calls）→ `tools` 或 `exit`；`tools` 执行后根据条件回到 `model` 或 `exit`。因此多次模型迭代 = 同一次 `astream()` 执行中，子图反复执行「model → tools → model → …」直到某条边到 exit，**不是** main_graph 中的 Python `while` 循环。main_graph 中用于等待 `agent_future`/`guardrails_future` 的 `while True` 仅作准备阶段轮询，与多轮模型调用无关。

| 模块 | 职责 | 依赖契约 |
|------|------|----------|
| **main_graph** | 主图入口；router → deepagent_plan / deepagent_execute / editor_tool / error；Plan 两阶段；流式 writer | AgentState、configurable、session_context 下发 |
| **deep_agent** | create_orchestrator_agent、提示词组装（orchestrator_prompt_assembly 拼接与截断）、中间件链（middleware_chain.json）、SubAgent 配置、Agent 缓存 | 链顺序、inject_runtime_context、BUNDLE/project_memory |
| **app** | FastAPI 应用、中间件、子路由挂载（knowledge、board、files 等）、上传/工作区/模型/技能等内联路由 | langgraph.json http.app、INTEGRATION_CONTRACTS §1–5 |
| **backend.api.routers** | 按领域拆分的 REST 路由（如 board_api、files_api）；减少 app 单文件体积 | deps.verify_internal_token、common 路径/错误工具 |
| **backend.api.common** | 路径解析（resolve_read_path/resolve_write_path）、safe_error_detail、SENSITIVE_FILENAME_RULES | backend.tools.base.paths |
| **tools / registry** | 工具注册、core vs extension、tier；与 mode_config、license_gate 一致 | tools_inventory_and_description_spec、mode_config |
| **前端 MyRuntimeProvider** | LangGraph SDK stream、session_context 消费、EVENTS 派发、threadId 校验 | §3 session_context、§4 EVENTS、domain-model |
| **前端 thread** | 会话 UI、消息列表、Composer、角色/模式展示 | 会话键优先、EVENTS 监听 |

**变更影响清单**（改以下内容时需同步检查）：

- **主图/节点**：main_graph.py、route_decision（已抽至 engine/nodes/router_node）、deepagent 节点（仍内联，后续可抽至 engine/nodes 或 core 子模块）→ 契约 §1、§3（流式）、文档 main_pipeline_and_middleware_rationality.md
- **中间件/链顺序**：middleware_chain.json、deep_agent 链组装 → 契约 §5、§5.1
- **configurable 形状**：run 入口、前端 sendMessage config → 契约 §2、domain-model、前端 MyRuntimeProvider
- **REST 路由**：app 或 routers 新增/修改 → [api_error_convention.md](api_error_convention.md)（新接口一律 4xx/5xx）、deps/common 复用

### 9. 开发规范（P3 持续对齐）

- **新增能力前检查生态**：新增中间件、工具或 REST API 前，先查 LangChain / DeepAgent 是否已有能力；若有则复用或扩展现有组件，禁止重复造轮子（与 .cursor/rules/ccb-project.mdc 一致）。建议在 PR 描述或开发流程中自检。
- **configurable 校验**：开发/测试环境（APP_ENV=development 或 pytest）下，run 入口在 router_node 会调用 [configurable_check.validate_configurable](backend/engine/core/configurable_check.py)；缺必含字段（thread_id、mode、role_id/active_role_id、workspace_path）时打 log warning，不阻断请求。
- **链顺序一致性**：middleware_chain.json 为链顺序唯一来源；deep_agent 中 default_chain 为 JSON 缺失时的兜底，应与 JSON 的 `chains.ask` 一致。CI 中 [test_middleware_chain_consistency](backend/tests/test_middleware_chain_consistency.py) 做断言；若有意例外需在测试中文档化并放宽断言。
- **环境变量与超时**：超时、连接、资源相关环境变量见 [timeouts_and_env_reference.md](timeouts_and_env_reference.md)；流式首 token、压缩等见 [main_pipeline_and_middleware_rationality.md](main_pipeline_and_middleware_rationality.md) 第七节。
