# 400 No schema matches 根因分析

## 1. 错误来源（非本机 FastAPI）

- 报错 **不是** 本后端 FastAPI 返回的，而是 **上游 LLM 服务**（如云端网关）在收到我们的 chat completions 请求后，对 **请求体做 JSON schema 校验** 失败返回的。
- 调用链：前端 → 本后端 LangGraph/DeepAgent → `agent.astream()` → LangChain `init_chat_model`（OpenAI 兼容客户端）→ HTTP POST 到 `base_url/chat/completions` → **上游返回 400**，错误信息里带 `Validation error for body application/json: No schema matches`。

## 2. “No schema matches” 的含义

- 上游网关用**严格 JSON schema** 校验请求体，请求里出现了：
  - 不在 schema 里的**字段**（如 `extra_body`、某些 `model_kwargs`、或 tools 里的自定义字段），或
  - 某字段**类型/结构**不符合（如 `messages[].content` 要求 string，我们发了 array；或 `tools` 里某个 tool 的 schema 不符合其约定），  
  就会返回该校验错误。

## 3. 本后端已做的与请求体相关的控制

- **model_manager**（`backend/engine/agent/model_manager.py`）  
  - 云端模型：`extra_body = {}`，不往请求体塞额外字段。  
  - 若模型配置里 `strict_openai_schema: true`，会进一步把 `model_kwargs` 只保留 `temperature, max_tokens, top_p, presence_penalty, frequency_penalty, stream, n, stop`。
- **content_fix_middleware**（`backend/engine/middleware/content_fix_middleware.py`）  
  - 在请求真正发往 LLM 前，把消息列表里的 `content` 为 `None` 或 **非字符串（如 list）** 统一修成字符串，避免因 `content` 类型不符合导致上游拒收。  
  - 不修改 `tool_calls` 结构（曾尝试在此做 tool_calls 规范化，导致**首次用户输入就 400**，已回滚）。

## 4. 为何会出现「第一次用户输入就 400」

- **可能原因一：上游或环境变化**  
  - 同一模型/同一 URL 的上游网关**升级了校验规则**，或换了网关，对请求体要求更严（例如对 `tools`、对某字段的格式更挑剔）。  
  - 本后端未改、前端未改，只是上游更严了，就会出现「以前第一次能过，现在第一次就 400」。
- **可能原因二：本后端改动影响了首包请求体**  
  - 例如在 content_fix 里对 **所有** AIMessage（包括首轮没有 tool_calls 的消息）做替换或对 tool_calls 做“规范化”，若新结构不符合 LangChain/OpenAI 客户端或上游的预期，就会首包就 400。  
  - 这类改动已回滚，当前逻辑应恢复为「首轮仅做 content 归一化，不碰 tool_calls」。
- **可能原因三：tools 绑定与序列化**  
  - 首轮请求里通常就带有 **tools**（DeepAgent 会 bind_tools）。若上游对 `tools[].function.parameters`（或整体 tool schema）的格式非常严格（例如不允许某些 JSON Schema 关键字），也会在第一次请求就报 No schema matches。  
  - 需要对比：同一模型、同一网关，**无 tools** 的请求是否仍 400；若去掉 tools 就正常，则根因在 tools 的 schema。

## 5. 建议的排查步骤（定位根本原因）

1. **确认当前 400 是否仍为「第一次用户输入」就出现**  
   - 若是，说明与「中途停止后再发」无关，而是**首包请求体**就不符合上游 schema。
2. **看后端日志里「上游 API 返回 400」的完整响应**  
   - 有的网关会在 body 里附带 `details` 或 `path`，指明是哪个字段不匹配，便于针对性改。
3. **临时打开请求体日志（仅调试环境）**  
   - 在发起 chat completions 的路径（LangChain OpenAI 客户端侧，或本后端在调用 LLM 前）对请求体做一次 log（可脱敏），保存：  
     - `model`、`messages` 条数、每条 `role` 和 `content` 类型（string/list/other）、是否有 `tools`、`tools` 条数。  
   - 用这份真实请求体与上游文档/OpenAI 官方 schema 对比，看多/少/错在哪些字段。
4. **对比同一网关的“无 tools”请求**  
   - 若能在同一环境用同一模型、同一 URL 发一个**不带 tools** 的简单 chat 请求且成功，而带 tools 就 400，则根因在 **tools 的序列化或 schema**；再收窄到是某个/某几个 tool 的 parameters 导致。
5. **确认模型与 URL**  
   - 确认当前使用的 `model_id` 和实际请求的 `base_url`，排除配错模型或网关导致 schema 不一致。

## 6. 小结

- **根本原因**：上游 LLM 网关对 **我们发过去的请求体** 做严格 schema 校验时认为「没有一条 schema 能匹配当前 body」，于是返回 400 No schema matches。  
- **根因在对方校验 + 我们发出的 body 内容**，需通过**真实请求体日志 + 上游文档/错误详情**确定是：messages 格式、tools 格式、还是顶层/模型相关字段。  
- 本后端已回滚对 `tool_calls` 的“规范化”修改，避免首轮请求被误改导致 400；后续若再动请求体，建议在测试环境先验证「第一次用户输入」是否仍正常。

## 7. 本系统修复与举一反三（记录）

- **诊断**：环境变量 `DEBUG_400_REQUEST=1` 时，ContentFix 在捕获到 400 类异常时会打一条请求体形状日志（消息条数、各条 role 与 content 类型、是否带 tools），便于与 OpenAI 规范对比。main_graph 的 400 分支日志中提示可设该变量。
- **加固**：云端默认模型 `cloud/qwen3.5-35b-a3b` 的 config 已增加 `strict_openai_schema: true`，使 model_manager 仅向请求体传入白名单参数（temperature、max_tokens、top_p 等），避免误带非标准字段。
- **举一反三**：
  - 所有经 `model_manager.create_llm()` 的调用（主对话、SubAgent、registry 的 critic_review、app 仪表盘简报、蒸馏/自进化/技能演化等）在云端时均走同一套逻辑：`extra_body={}`，`strict_openai_schema` 按模型 config 可选。非主对话路径若使用云端模型，同样受控，一般无需单独改。
  - 仅主对话流经 ContentFix 中间件做 messages 的 content 归一化；其他路径多为 prompt + invoke，消息多为字符串，若未来有路径向云端直接传 list content，需在调用前归一或确认 LangChain 序列化为合规格式。
  - 其他修改 request 的中间件（reflection、ontology）仅追加 system_message 字符串，不引入非标准结构。
- **带 @ 附件时 400**：用户通过 @ 添加工作区文件后发送，请求体中的用户消息可能为 `content` 数组（如 `[{ type: "text", text: "..." }, { type: "file", ... }]`），云端仅接受 string，会报 No schema matches。修复：ContentFix 的 `_content_blocks_to_string` 已扩展，对 `file`、`image`、`image_url` 等块统一转为占位文案（如 `[附件: 文件名]`、`[图片]`），且对 dict 形式消息在 `_fix_message` 与 `_normalize_rest_content_to_string` 中归一为 LangChain 消息并 content 为 string，确保发往云端的 messages 中 content 全为 string。
