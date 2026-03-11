# 思考流（Reasoning Stream）验证说明

## 数据流

1. **LLM 流式输出**：Cloud/Local API 在 SSE 的 `choices[0].delta` 中返回内容。
2. **后端注入**：`backend/engine/agent/model_manager.py` 的 `create_llm` 对 `is_reasoning_model: true` 且 `thinking_enabled` 的模型 patch `_convert_chunk_to_generation_chunk`，将推理内容写入 `AIMessageChunk.additional_kwargs["reasoning_content"]`。本地 tier 下，若模型为 `is_reasoning_model: true` 则默认 `enable_thinking=True`（可于 config 中设 `enable_thinking: false` 关闭）；`task_type == "fast"` 时强制关闭思考流。
3. **main_graph**：`TokenStreamHandler.on_llm_new_token` 读取 `chunk.message.additional_kwargs["reasoning_content"]`，拼入 `reasoning_parts`，在 `_flush_run` 中通过 `writer({"type": "reasoning", "data": {"phase": "content", "msg_id": ..., "content": ...}})` 下发。
4. **前端**：`MyRuntimeProvider` 收到 `type: "reasoning"`, `phase: "content"` 后调用 `enqueueReasoningChunk`；`thread.tsx` 的 `useNativeReasoningBlocks` 订阅 `toolStreamEventBus` 展示思考块。

## 路径 A / B 适用条件

- **路径 A**：服务端在 delta 中已拆分推理字段，直接透传。支持的 delta 字段名（取第一个非空）：
  - `reasoning_content`（LM Studio / vLLM 常见）
  - `thinking`（部分云端 API）
  - `reasoning`（部分云端 API）
- **路径 B**：服务端未拆分，推理与正文混在 `delta.content` 中，且使用 `<think>...</think>` 包裹。由本地状态机解析并拆入 `reasoning_content`。

## 云端与本地同一数据流

**云端与本地使用同一数据流与展示逻辑**，不区分 tier。云端模型要在界面显示思考流，须同时满足：

1. **模型配置**：在 `backend/config/models.json` 中该模型 `is_reasoning_model: true`，且开启思考（如 `config.enable_thinking: true`；云端默认 True，建议显式写出便于排查）。
2. **API 契约**：云端流式 SSE 在**同一条消息流**的 `choices[0].delta` 中提供推理内容（路径 A 或 B，见下）。

若云端网关**不以** `choices[0].delta` 返回思考（例如用独立 SSE 事件类型如 `event: reasoning_chunk`），当前实现不会解析；若需支持，需在 main_graph 或流式层增加对「独立 reasoning 事件」的解析并统一转为现有 `type: "reasoning"`, `phase: "content"` 事件（后续扩展）。

## 云端 API 要求（路径 A/B）

- 若需前端展示思考流，云端流式 SSE 的 `choices[0].delta` 须包含以下之一：
  - 单独字段：`reasoning_content` / `thinking` / `reasoning`（字符串），或
  - 在 `content` 中输出 `<think>...</think>` 包裹的推理内容。
- 在 `backend/config/models.json` 中该模型须设置 `is_reasoning_model: true`，否则不会走 reasoning 注入逻辑。

## 验证步骤

1. **后端**：用当前 `create_llm` 请求目标模型，打印 stream 每块 `delta` 的 keys 及是否存在 `reasoning_content`/`thinking`/`reasoning` 或 `<think>`。
2. **端到端**：选择推理模型（或 auto 选到云 35B），发送需多步推理的问题，在浏览器 Network 中查看 LangGraph stream 是否出现 `type: "reasoning"`, `phase: "content"`。
3. **前端**：确认 `enqueueReasoningChunk` 被调用且 `useNativeReasoningBlocks` 的 `mergedThinkingBlocks` 有内容；若仍无展示，检查 `msg_id` 与当前消息是否一致（isRunning 时已放宽匹配）。

---

## 草稿模型（可选）

`backend/config/models.json` 中提供占位配置：

- `use_local_draft_for_cloud`: 是否在调用云端主模型前，先用本地小模型生成草稿（默认 false）。
- `draft_model_id`: 本地草稿模型 ID（如 `qwen/qwen2.5-0.5b`）。

两段式 pipeline（先 draft 再 refine）尚未在编排层实现；启用时需在 main_graph 或单独 middleware 中：先调用 `draft_model_id` 得到草稿，再将「用户消息 + 草稿」交给云端主模型润色。

---

## 排查清单（无思考流时）

- **模型配置**：当前会话所用模型在 `models.json` 中是否设置 `is_reasoning_model: true`；本地模型为推理模型时默认开启思考流（`enable_thinking` 默认 True），可在 config 中设 `enable_thinking: false` 关闭。
- **fast 任务**：`task_type == "fast"` 时思考流强制关闭，属当前设计；若需在快速任务下也展示思考流，需在 model_manager 中按需放宽。
- **云端返回**：云端流式 SSE 的 `choices[0].delta` 是否包含 `reasoning_content` / `thinking` / `reasoning` 字段或 `<think>...</think>` 包裹内容。
- **前端事件**：LangGraph stream 中是否收到 `type: "reasoning"`, `phase: "content"` 的 chunk；可于 Network 面板查看。
- **msg_id 一致**：下发的 `msg_id` 是否与当前展示消息一致（isRunning 时已放宽匹配，仍无展示时可检查此处）。
- **调试**：开启 `ENABLE_MAIN_GRAPH_DEBUG_LOG=1` 时，首 token 若无 `reasoning_content` 会写一条 debug 日志，便于确认 API 是否未返回推理字段。

**本机访问云端**：若感觉响应慢而 curl 测云端很快，可优先检查思考流是否未展示（推理内容在流中但未渲染会让人误以为卡住），按上列排查项逐项确认。
