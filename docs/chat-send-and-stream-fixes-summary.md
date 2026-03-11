# 聊天发送与流式修复总结

本文档汇总为解决「消息发送失败」、前端探活超时、以及后端/模型错误展示所做的修改。

## 1. 后端与健康检查对齐

| 位置 | 修改 |
|------|------|
| `frontend/desktop/src/lib/api/langserveChat.ts` | 健康检查由 `/ok` 改为 `/health`，与 `scripts/start.sh` 探活一致 |
| `backend/api/app.py` | `/health` 响应增加 `assistant_id: "agent"`，与 `langgraph.json` 对齐 |

## 2. LangGraph SDK 与接口对齐

| 位置 | 修改 |
|------|------|
| `langserveChat.ts` | 统一 `LANGGRAPH_ASSISTANT_ID`（与 langgraph.json graphs.agent 一致），`sendMessage` / `resumeRun` 均使用该常量 |
| `langserveChat.ts` | 导出 `invalidateLangGraphClient()`，设置页修改 base URL 后清空 Client 缓存 |
| `SettingsView.tsx` | 保存设置时调用 `invalidateLangGraphClient()`，保证下次请求使用新地址 |

## 3. 发送前确保线程存在

| 位置 | 修改 |
|------|------|
| `MyRuntimeProvider.tsx` | 在调用 `sendMessageWithRetry` 前，若 `externalId` 非本次创建，先 `getThreadState(externalId)`；若抛错则 `createAndActivateThread()` 并用新 thread_id 发送，避免 404 |

## 4. 启动脚本与前端探活

| 位置 | 修改 |
|------|------|
| `scripts/start.sh` | 新增 `wait_for_frontend`：90 秒超时，每轮同时探 `http://127.0.0.1:3000` 与 `http://localhost:3000` |
| `frontend/desktop/vite.config.ts` | `server.host: true`，便于探活与 Electron 连接 |

## 5. 流式错误与重试

| 位置 | 修改 |
|------|------|
| `langserveChat.ts` | 当 SDK 报错含 `Content-Type` / `event-stream` 时，抛出明确提示：请查看 Network 中「runs/stream」的 Response Headers |
| `langserveChat.ts` | `sendMessageWithRetry` 最终失败时，对 404 线程不存在、以及流式格式异常分别给出可操作提示 |
| `MyRuntimeProvider.tsx` | 流式发送 `maxRetries` 从 0 改为 1，`retryDelay` 800ms，偶发/冷启动可自动重试一次 |

## 6. 模型加载失败 / 资源不足（400）

| 位置 | 修改 |
|------|------|
| `frontend/desktop/src/lib/utils/formatApiError.ts` | 识别 "Failed to load model"、"insufficient system resources"、"model loading was stopped" 等，映射为「当前模型加载失败（显存/内存不足）」 |
| `MyRuntimeProvider.tsx` `buildSendFailureGuidance` | 对上述错误建议：「请在设置中切换为更小模型（如 7B/8B）或关闭其他占用内存的应用后重试」 |
| `MyRuntimeProvider.tsx` 流式 `error` 事件 | 当后端通过流返回错误且内容含模型/资源相关关键词时，toast 标题为「模型加载失败」，描述为「显存/内存不足，请在设置中切换为更小模型（如 7B/8B）后重试」 |

## 7. 错误抛出方式简化

- `sendMessageWithRetry` 不再包装复杂文案，最终直接 `throw lastError`（或针对 404 / Content-Type 的明确错误），便于控制台与 UI 看到真实原因。
- 线程不存在时单独抛出「当前会话在后端不存在…请新建会话后重试」。

## 8. 子图流式与 primaryMessageChannel

前端请求流时使用 `streamSubgraphs: true`，实际执行在子图节点（如 `deepagent_execute`）时，事件名会带命名空间，例如 `custom|deepagent_execute:run_id`、`messages/complete|deepagent_execute:run_id`。

- **primaryMessageChannel**：运行时在「主图 messages 通道」与「custom（get_stream_writer 的 messages_partial）」之间二选一为主通道，避免两路同时 yield 导致重复或乱序。一旦主图先发了一条 `messages/partial`，会把通道设为 `"messages"`。
- **修复（P0）**：此前当 `primaryMessageChannel === "messages"` 时，**所有** custom 的 `messages_partial` 都会被跳过。子图真实内容是通过 `custom|deepagent_execute:...` 下发的，因此会被误判丢弃，表现为「有返回但内容不对、显示格式不对」。现改为：仅当当前事件是**根 custom**（`event.event === 'custom'`，无 `|`）且通道已是 `"messages"` 时才跳过；**子图 custom**（`event.event.startsWith('custom|')`）的 `messages_partial` 始终 yield，保证子图 token 流进入 SDK。
- **DEV 调试（P1）**：开发环境下首次收到子图 custom 且带 `event.data` 时，会打一条 log：`[MyRuntimeProvider] 子图 custom event.data 结构`，含 `event.event`、`type`、`keys`、`data` 预览（不打印大 content），用于确认与根 custom 的 `{ type: "messages_partial", data: [...] }` 一致；若结构不同可再在前端做兼容解析。
- **去重（qwen3-coder 重复提示词）**：当 `primaryMessageChannel === "custom"` 时，**跳过 root 的 messages/complete**（`event.event === 'messages/complete'` 且无 `|`），只保留子图 custom 的 token 流与子图 complete，避免主图 final state 与子图内容同时展示造成重复。
- **流内 error 时聊天区有信息（qwen3.5-35b 等）**：SDK 仅在「已有最后一条 AI 消息」时把 error 事件挂到该消息上；若流中先收到 error、此前未 yield 过任何 messages/partial 或 messages/complete，聊天区会空白。现逻辑：收到 `event.event === 'error'` 且 `!seenValidPayload` 时，先 yield 一条占位 AI 消息（`messages/complete`，内容为模型加载失败或原始错误摘要，带 `status.incomplete/error`），再 yield 原 error 事件，保证聊天区始终有错误信息可看。

---

## 排查建议

- **发送失败且控制台有报错**：看报错内容；若含 "Content-Type" / "event-stream"，检查 Network 里 `runs/stream` 的 Response Headers 是否为 `text/event-stream`。
- **后端 200 但流式异常**：同上，并确认后端未在流式前返回 JSON 错误体。
- **400 模型加载失败**：在设置中切换为更小模型（如 7B/8B），或增加本机资源/关闭其他占内存应用。
- **有返回但内容不对 / 显示格式不对**：多为子图流式被主通道屏蔽。确认前端已合入「子图 custom 始终 yield」的修改；DEV 下看控制台是否有 `子图 custom event.data 结构`，确认 `type === "messages_partial"` 且 `data` 为数组。若服务端对子图 custom 的 `event.data` 做了额外包装，需在 MyRuntimeProvider 的 custom 分支里对 `custom|` 事件做一层兼容解析（从嵌套字段取 `type`/`data`）。
