# 错误码与排查说明

后端通过流事件 `run_error` 下发 `error_code` 与 `message`，前端据此展示 toast 或内联提示。收到 run_error 后前端会结束消费循环并清除 isStreamingRef，用户可再次发送。

**前端**：`MyRuntimeProvider` 消费 `run_error`，使用 `toolStreamEvents.parseRunErrorPayload(d)` 解析（对 `error_code`/`message` 做防御性归一）。`context_exceeded`、`502`、`400`（资源包/不支持该模型）、`bad_request`/`400` 有专用 toast；其余展示 `message` 或 `errors.generic`。详见 `ux_and_ops_notes.md` §9 run_error 契约。

---

## 1. 错误码一览

| error_code | 含义 | 常见原因 | 建议处理 |
|------------|------|----------|----------|
| 502 | 网关错误 | 推理服务（LM Studio/云 35B）未启动、崩溃或返回 502 | 检查推理服务与端口；云端点检查网络与 API Key |
| unknown | 未分类错误 | 其它异常（含网络、序列化、超时未归类等） | 查后端日志与堆栈；必要时归类为 timeout/connection |
| context_exceeded | 上下文超长 | 会话+本轮超过模型 context 限制 | 前端 toast 带「新开会话」按钮与建议文案（减少附件/历史）；新开会话或清历史；可开 ENABLE_CONTEXT_GUARD、调低 SUMMARIZATION_TRIGGER_RATIO（如 0.6） |
| timeout | 模型响应超时 | 推理时间超过 stream_timeout_seconds | 换小模型或加资源；或适当调大超时 |
| connection | 连接失败 | 无法连到推理服务 | 确认 LM Studio/端点地址与端口 |
| model_not_found | 模型未找到 | 模型 id/lm_studio_id 与 LM Studio 不一致 | 刷新模型列表，对齐 models.json |
| model_crash | 模型崩溃 | 推理进程崩溃 | 重载模型或换小模型 |
| bad_request / bad_response_status_code | 请求格式不符合 API 要求 | 例如「System message must be at the beginning」：消息列表中 system 不在首条 | 后端已在调用 agent 前对 messages 做「system 置前」规范化，若仍出现请检查是否有多处注入 SystemMessage 且未经过 main_graph 的 _normalize_messages_system_first |

### 1.1 400 / 「System message must be at the beginning」与 content_fix 中间件

- **原因**：部分模型 API 要求消息列表中至多一条 System 且必须在首位；对话中插入的 loop_guidance、done_verifier 等会生成中间的 SystemMessage，导致 400。
- **后端处理**：`backend/engine/middleware/content_fix_middleware.py` 的 ContentFixMiddleware 在模型调用前：
  - **前导 System 合并**：将 `request.messages` 前若干条 SystemMessage 全部合并到 `request.system_message` 并移除，保证发往 API 的 messages 不以 System 开头；
  - **content 归一**：将前导 System 及 `request.system_message` 中 content 为 list（content_blocks/多模态）的转为字符串（`_content_blocks_to_string`），避免「No schema matches」类 400。
- **排查**：若仍出现 400，检查中间件链顺序（content_fix 应在 license_gate 之后）、以及是否有其它路径在 content_fix 之后再次注入 SystemMessage。

若仍「不响应」，需查是否未收到 run_error（例如连接直接断开）或存在其它占住流的路径。

**流空闲超时**：若连续 5 分钟内未收到任何服务端事件，前端会自动结束消费并清除 isStreamingRef，用户可再次发送；避免因后端挂起或连接静默断开导致一直无法发送。

后端在 `main_graph.py` 中根据异常类型与消息子串归类为 timeout/connection/502 等，以减少 unknown；超时类（含 asyncio.timeout、read timed out）、连接类（含 econnreset、econnaborted、failed to fetch）会优先归入对应 error_code。

### 1.2 context_exceeded 与上下文防护

- **系统级防护**：启用 `ENABLE_CONTEXT_GUARD=true`（默认开）时，ContextGuardMiddleware 在模型调用前按 `SUMMARIZATION_TRIGGER_RATIO`（默认 0.75）估算 token，超则用 LangChain `trim_messages` 预防性裁剪，降低触及服务端硬限制的概率。
- **更早压缩**：若仍偶发超长，可将 `SUMMARIZATION_TRIGGER_RATIO=0.6` 使 DeepAgent 内置 Summarization 更早触发；详见 `docs/CONTEXT_AND_MEMORY_SYSTEM_DESIGN.md`。

---

## 2. 权限（license）配置说明

此处「权限」指产品授权档位（tier）及由此控制的能力边界，不是 OS 或文件权限。

| 配置 | 路径 | 作用 |
|------|------|------|
| 当前授权档位 | `data/license.json`（项目根下 data 目录） | 记录当前 tier（如 free、pro、max、enterprise）；由 `/license/status`、`/license/activate` 读写。 |
| 档位能力定义 | `backend/config/license_tiers.json` | 定义各 tier 的 limits（如 cloud_model_requests_daily、max_custom_skills、parallel_agents）、allow_*、max_autonomy_level。 |

- **license.json**：可通过 API 或直接改文件修改当前 tier（需保证格式正确）；生产一般通过「激活」流程写入。
- **license_tiers.json**：定义各 tier 的能力上限与白名单，可按产品需求修改（如调大 free 的 cloud 配额、或增加新 tier）。
- 云端模型是否可用由 model_manager 的 `_is_model_allowed_by_license` 判断：当前 tier 允许且未超每日配额即可用；否则报「无授权」或不可用。

---

## 3. 常见 401 与内部接口

- **GET /agent/crystallization-suggestion 返回 401**：该接口受 `verify_internal_token` 保护。若后端配置了 `INTERNAL_API_TOKEN`，前端请求必须携带 `X-Internal-Token` 或 `Authorization: Bearer <token>`。前端已对 CrystallizationToast 的请求注入 `getInternalAuthHeaders()`；请确保前端环境变量 `VITE_INTERNAL_API_TOKEN`（或 `VITE_LOCAL_AGENT_TOKEN`）与后端 `INTERNAL_API_TOKEN` 一致，或后端不配置该变量时仅从本机（127.0.0.1）访问。

---

## 4. 云端模型无思考流

若使用云端推理模型（如 cloud/qwen3.5-35b-a3b）时界面未显示思考块，请依次检查：

- **模型配置**：该模型在 `backend/config/models.json` 中是否 `is_reasoning_model: true`、`config.enable_thinking` 是否开启（建议显式设为 `true`）。
- **云端返回**：云端流式 SSE 的 `choices[0].delta` 是否包含 `reasoning_content` / `thinking` / `reasoning` 字段，或 `<think>...</think>` 包裹内容。
- **前端事件**：LangGraph stream 中是否收到 `type: "reasoning"`, `phase: "content"`；可于浏览器 Network 面板查看。

详见 [思考流验证说明](thinking_stream_verification.md)。

---

## 5. 前端 Vite 预构建与 @assistant-ui/react-langgraph

若 dev 或构建时出现以下错误，与 Vite 依赖预构建及 CJS 互操作有关，请勿将 `@assistant-ui/react-langgraph` 放入 `optimizeDeps.exclude`，并保持当前配置。**若修改过配置或仍报错，请先执行 `rm -rf frontend/desktop/node_modules/.vite` 后重启 dev**，确保预构建使用当前配置。

- **Uncaught SyntaxError: Unexpected token 'const'**（堆栈涉及 `@assistant-ui/react-langgraph` 或 `chunk-67YZ2VUF.js`）：esbuild 预构建时误删 `if` 块花括号。处理：保持 `optimizeDeps.esbuildOptions.minify: false`，且不要将 `@assistant-ui/react-langgraph` 放入 `exclude`。
- **The requested module '...secure-json-parse...' does not provide an export named 'default'**（或涉及 `parse-partial-json-object.js`）：排除 react-langgraph 后其依赖链走 node_modules，CJS 包无 default 导出。处理：不要排除 `@assistant-ui/react-langgraph`，保证整链被预构建；必要时执行 `rm -rf frontend/desktop/node_modules/.vite` 后重启 dev。

**会话/工作区状态**：若切换工作区或会话后角色/模式未同步，请确认流式收到的 session_context 的 threadId 与当前激活会话一致（前端仅在此一致时写存储并派发 ROLE_CHANGED/CHAT_MODE_CHANGED）；工作区由 `maibot_workspace_path` 管理，切换工作区后建议新建会话，避免跨工作区上下文污染（见 domain-model.mdc）。流式处理中工具结果、步骤与 stream_end 已按「本 run 所属 threadId」派发与清理（与 Cursor 一致），避免用户中途切换会话时状态错绑。

---

## 6. 待跟进改进（需单独排查/优化）

| 问题 | 说明 | 建议方向 |
|------|------|----------|
| 云端模型访问时快时慢 | 可能与前端/后端请求队列、流式消费或网络有关 | 查 backend 请求耗时、前端 stream 消费是否阻塞；可加简单耗时打点 |
| 工具结果不显示 | 已通过 TOOL_RESULT_FOR_UI 即时推送 result_preview 到工具卡片兜底；stream_end 时清空 live 预览，最终以 messages 中 tool 结果为准 | 若仍不显示，检查 threadId 一致性与 ToolResultsByMessageIdContext 合并逻辑 |
| 多次会话后崩溃 / inputTextMirror | 前端内存或 Composer 输入组件泄漏 | 已加 Composer 输入 80k 字符上限（cursor-style-composer setInputMirrorSafe）；若仍崩溃可做会话上限或虚拟列表 |
| 本体在多模式中未明显提升效果 | 本体注入在 OntologyContextMiddleware | 已在 resource_awareness 与 search_knowledge 策略中加入「领域内优先 search_knowledge/本体」说明 |
| 联网搜索能力弱 | 依赖 web_search / web_fetch 工具与提示词 | 已在 tool_usage 中强化 web_search 使用场景（最新信息、实时数据、政策/行情）与引用要求 |
