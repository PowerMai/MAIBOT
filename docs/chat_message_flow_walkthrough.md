# 聊天消息流代码走读：从用户输入到 LM Studio 再到聊天面板

## 1. 「点击发送却出现停止」说明

- **现象**：输入后点击发送按钮，界面很快显示「停止」按钮。
- **原因**：这是**预期行为**。流程是：
  1. 用户点击 **发送** → `ComposerPrimitive.Send` 触发 `api.composer().send()`（与 `onClick={pushInputHistory}` 通过 `composeEventHandlers` 一起执行）。
  2. adapter 的 `sendMessage` 被调用，创建 `client.runs.stream(...)` 的 generator 并进入 `for await (const event of generator)`。
  3. **一进入流循环**即发出 `stream_start`（本次已加），`toolStreamEventBus` 通知 thread；thread 中 `runSummary.running = true`，Composer 根据 `ThreadPrimitive.If running` 显示**停止**按钮。
  4. 因此「出现停止」只表示**流已开始、正在等后端**，不代表已有 LLM 回复。
- **无回复时的表现**：会一直停在「停止」状态，直到超时 tost 或用户点停止。要区分的是：**首包何时到、是否曾收到 `messages_partial`**。

---

## 2. 数据流总览（用户输入 → LM Studio → 聊天面板）

```
用户输入
  → Composer (cursor-style-composer.tsx)
  → api.composer().send() [@assistant-ui]
  → adapter.sendMessage (MyRuntimeProvider)
  → sendMessageWithRetry → client.runs.stream(threadId, assistantId, { input, config, streamMode: ["messages","custom"], streamSubgraphs: true })
  → LangGraph API (e.g. :2024) POST /threads/{id}/runs stream
  → 后端 main_graph deepagent_node
  → get_agent(config) → agent.astream(state, config, stream_mode="messages")
  → 内层图调用 LLM (LM Studio)
  → on_llm_new_token → _TokenStreamHandler._flush_run → writer({"type":"messages_partial", "data":[...]})
  → LangGraph 将 custom 事件推到前端流
  → 前端 for await (event of generator) 收到 event.event === 'custom', event.data.type === 'messages_partial'
  → yield { event: 'messages/partial', data: filteredNormalized }
  → @assistant-ui/react-langgraph 更新消息列表
  → 聊天面板展示
```

---

## 3. 前端关键节点（含耗时打点）

| 节点 | 位置 | 说明 / 日志 |
|------|------|-------------|
| 用户点击发送 | cursor-style-composer.tsx | `ComposerPrimitive.Send` + `pushInputHistory` |
| adapter 收到 send | MyRuntimeProvider.tsx | 构建 config、调用 `sendMessageWithRetry` |
| 进入流循环 | MyRuntimeProvider.tsx | 发出 `stream_start`，DEV 下打点：`流循环已进入，等待首包 (T0)` |
| 首包到达 | MyRuntimeProvider.tsx | DEV：`首包到达 +Xms`，event.event |
| custom 类型 | MyRuntimeProvider.tsx | DEV：`custom event type: session_context|task_progress|messages_partial|reasoning|...` |
| 首条 messages/partial yield | MyRuntimeProvider.tsx | DEV：`首条 messages/partial 已 yield，距流开始 +Xms` |
| running 状态 | thread.tsx | `toolStreamEventBus.onAll` → `RUN_STATUS_EVENT_START.has(type)` → `runSummary.running = true` → Composer 显示停止 |

- **若长时间无回复**：看控制台是否有「首包到达」、是否有「custom event type: messages_partial」和「首条 messages/partial 已 yield」。若只有 session_context/task_progress/reasoning 而无 messages_partial，问题在后端或 LLM 回调；若已有 messages_partial 但界面无内容，问题在前端展示或通道逻辑。

---

## 4. 后端关键节点（含已有日志）

| 节点 | 位置 | 说明 / 日志 |
|------|------|-------------|
| 请求进入 | LangGraph API | POST /threads/{id}/runs，stream_mode=["messages","custom"] |
| deepagent_node 开始 | main_graph.py | writer(reasoning phase=start), session_context, task_progress |
| 等待引擎 | main_graph.py | `DeepAgent 等待引擎创建（get_agent）…` |
| 引擎就绪 | main_graph.py | `DeepAgent 引擎已就绪，准备耗时 X.Xs` |
| 首 chunk（astream） | main_graph.py | `DeepAgent astream 首 chunk 已收到（距建立流 X.Xs）` |
| LLM 首 token | main_graph.py | `LLM 首 token 回调已触发 run_id=... chunk_type=...` |
| 写出 messages_partial | main_graph.py | DEBUG：`messages_partial emitted run_id=... content_len=...` |
| chunk 无 .message | main_graph.py | DEBUG：`TokenStreamHandler: on_llm_new_token chunk 无 .message 且非 message 对象` |

- **若 200s 无回复**：看是否卡在「等待引擎创建」、是否出现「引擎已就绪」、是否出现「LLM 首 token 回调」和「messages_partial emitted」。可据此判断卡在 get_agent、图执行，还是 LLM 回调/写出。

---

## 5. 可能丢消息或格式错误的点

1. **config 未传到 LLM**  
   `config_with_mode` 含 `_TokenStreamHandler`，需在 agent.astream 时传入；内层图节点调用 LLM 时必须带上该 config，否则 `on_llm_new_token` 不会被调用，不会产生 messages_partial。

2. **chunk 形状与 msg 提取**  
   `on_llm_new_token` 中 `msg = getattr(chunk, "message", None)`；部分运行时 chunk 即 AIMessageChunk，已做兼容：若无 `.message` 但有 `.content` 或 `additional_kwargs` 则 `msg = chunk`。

3. **前端 primaryMessageChannel**  
   若先收到主图空的 `messages/partial`，会设 `primaryMessageChannel = "messages"`，后续根图 custom 的 messages_partial 会被 `if (primaryMessageChannel === "messages" && !custom|...) continue` 丢掉。子图 custom（`custom|node:...`）不会丢。首 token 优化旨在避免空 partial 抢先锁定主通道。

4. **ALLOWED_MSG_TYPES 过滤**  
   `filteredNormalized = normalized.filter(msg => ALLOWED_MSG_TYPES.has(msg.type))`；若后端发的 type 不在白名单（如小写 `aimessagechunk`），会被滤掉导致 `filteredNormalized.length === 0` 而 continue，不 yield。

5. **stream_mode 与 writer**  
   前端请求需带 `streamMode: ["messages", "custom"]`，服务端需以支持 custom 的 stream 运行，否则 `get_stream_writer()` 写出的 custom 不会推到前端。

---

## 6. 建议排查顺序（无回复时）

1. **前端**：发一条消息，不点停止，看 DEV 控制台：  
   - 是否有「流循环已进入」「首包到达 +Xms」？  
   - 后续是否有「custom event type: messages_partial」和「首条 messages/partial 已 yield」？
2. **后端**：同一时刻看日志：  
   - 是否出现「引擎已就绪」？若长时间无，卡在 get_agent。  
   - 是否出现「LLM 首 token 回调」？若无，卡在未调 LLM 或 callback 未传递。  
   - DEBUG 下是否有「messages_partial emitted」？若无，说明未写 messages_partial（content 始终为空或未进 on_llm_new_token）。
3. 若后端有 messages_partial 而前端没有「custom event type: messages_partial」：检查 LangGraph 服务是否以 custom stream 转发、网络是否中断。
4. 若前端有「首条 messages/partial 已 yield」但界面无内容：检查 assistant-ui 的 messages 更新与 ALLOWED_MSG_TYPES/primaryMessageChannel 逻辑。

---

## 7. 无回复时运维检查清单（config / chunk）

当出现「发送后长时间无回复、仅显示停止按钮」时，可按以下清单逐项确认：

### 7.1 config 传递

- [ ] **请求体**：前端 `client.runs.stream(..., { input, config, streamMode: ["messages","custom"], ... })` 是否携带了 `config`（含 `configurable` 等）？
- [ ] **后端入口**：LangGraph 运行 `astream` 时是否把请求里的 config 原样传入（如 `agent.astream(state, config)`）？
- [ ] **TokenStreamHandler**：`config` 中是否包含 `_TokenStreamHandler` 实例？若内层图节点调用 LLM 时未使用该 config，则 `on_llm_new_token` 不会被调用，不会产生 `messages_partial`。
- [ ] **stream_mode**：服务端是否以支持 custom 的 stream 运行？否则 `get_stream_writer()` 写出的 custom 不会推到前端。

### 7.2 chunk 形状与写出

- [ ] **on_llm_new_token**：后端是否收到 LLM 的 token 回调？日志中是否有「LLM 首 token 回调」「messages_partial emitted」？
- [ ] **chunk 结构**：`msg = getattr(chunk, "message", None)`；若 chunk 无 `.message`，是否已兼容为使用 `chunk.content` 或 `chunk.additional_kwargs`（即 `msg = chunk`）？
- [ ] **写出 payload**：写出的 `messages_partial` 中每条消息是否包含可识别的 `type`（如 `ai`、`AIMessageChunk`）？前端 `ALLOWED_MSG_TYPES` 对 type 做大小写不敏感匹配，但 type 缺失或异常仍可能导致被过滤。
- [ ] **空 partial**：是否避免在无实质内容时抢先写出空的 `messages/partial`？空 partial 可能让前端锁定 `primaryMessageChannel = "messages"`，导致后续根图 custom 的 messages_partial 被忽略。

### 7.3 前端通道与过滤

- [ ] **primaryMessageChannel**：仅当本次 payload 有实质内容（如含 `tool_calls` 或非空 `content`）时才设为 `"messages"`。
- [ ] **ALLOWED_MSG_TYPES**：前端对 `msg.type` 做大小写不敏感判断；确认后端发出的 type 与白名单一致或可匹配。
