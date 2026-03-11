# 提示词与上下文装配检查报告

## 一、系统提示词装配顺序（稳定 → 动态）

### 1. 创建 Agent 时（deep_agent.create_orchestrator_agent）

| 顺序 | 段落来源 | 说明 |
|------|----------|------|
| 1 | `get_orchestrator_prompt()` | 核心身份、行为规则、工具策略、think_tool/extended_thinking 指导 |
| 2 | `_load_memory_content()` | 项目记忆 .maibot/MAIBOT.md + .maibot/rules/*.md |
| 3 | `get_rules_for_context()` | .cursor/rules 按需规则 |
| 4 | plan_execution | Plan 执行阶段时引用落盘计划文件 |
| 5 | deferred_tools / activated_tools | 扩展工具描述 |
| 6 | scene_context | skill_profile 非 general/full 时的场景身份 |
| 7 | review_policy / human_checkpoints / BUNDLE / skills_catalog | 按配置追加 |
| 8 | `assemble_system_prompt(_prompt_segments)` | 拼接 + 长度保护（默认 400k 字符） |

最终 `system_prompt` 传入 `create_deep_agent(system_prompt=...)`，成为**初始** `request.system_message`。

### 2. 运行时中间件对 system_message / messages 的修改（wrap_model_call 链）

链顺序以 `backend/config/middleware_chain.json` 为准，同一模式内顺序固定。

| 中间件 | 行为 | 可能重复/冲突 |
|--------|------|----------------|
| **ontology_context** | `request.override(system_message=current + block)` 追加本体 schema 块 | 仅追加，不重复 |
| **license_gate** | `before_model` 返回 `{"messages": [SystemMessage(license), *messages]}`，在 **state.messages 前**插入一条 System | 与下面 content_fix 配合：content_fix 会剥掉前导 System 并合并到 system_message |
| **content_fix** | ① `_fix_state_messages`：合并前导 System、修 content 为 None、去重 System；② `_merge_leading_system_into_request`：把所有前导 SystemMessage 合并进 `request.system_message`，并从 **request.messages** 中移除（必须 override(messages=rest)，否则框架用 request.messages 发 API 会仍带两条 system） | 解决「两条 system 导致 400」和「前导空 System 未剥干净」 |
| **reflection** | `request.override(system_message=current + suffix)` 追加反思类后缀 | 仅追加，不重复 |
| **inject_runtime_context** | `@dynamic_prompt`：在 **当前 request.system_prompt** 上追加 user_context、persona、WAL/learnings 提醒、上下文预算等 | 每次调用时追加一段，不覆盖前文；与 ontology/reflection 同为「尾部追加」 |

结论：**无重复段落**；冲突点已通过 content_fix 的「前导 System 合并 + messages 覆盖」消除。若仍出现 400，多为 **request.messages 中某条消息的 content 类型**（如 list）不符合云端 API 的 schema。

---

## 二、第一次 vs 第二次执行的差异（运行状态）

### 2.1 状态来源

- **第一次**：`state.messages` 通常为 `[HumanMessage(用户首条)]`，无 checkpoint 或新建 thread。
- **第二次**：从 checkpoint 加载，`state.messages` 为 `[HumanMessage, AIMessage, HumanMessage]`；若 license_gate 的 `before_model` 已执行，则变为 `[SystemMessage(license), HumanMessage, AIMessage, HumanMessage]`。

### 2.2 上下文装配差异

| 项目 | 第一次 | 第二次 |
|------|--------|--------|
| 消息条数 | 1 条 Human | 3+ 条（含 AI、工具等） |
| 前导 System | 无或仅 license | license + 归一化后的合并 System（若有） |
| AIMessage 形态 | 无 | 可能有 `tool_calls`、`content` 为 str 或 list（content_blocks） |
| inject_runtime_context | 同逻辑 | 同逻辑；`human_count` 等会变化，提醒块可能不同 |

### 2.3 导致 400 / No schema matches 的常见原因（第二次）

1. **request.messages 中某条 content 为 list**  
   部分云端 API 只接受 `content: string`；若 AIMessage 为 content_blocks（list），会触发 "No schema matches"。  
   **建议**：在 content_fix 中，对即将通过 `request.override(messages=rest)` 传出的每条消息，若 `content` 为 list 则归一为字符串（例如拼接 text 块），再传出。

2. **前导 System 未剥干净**  
   已通过「按条数剥掉所有前导 SystemMessage + override(messages=rest)」修复；若仍有空 content 的 System 被误留，需保证 `leading_system_count` 包含空 content 的 System。

3. **合并后 system_message 为空**  
   已通过「仅当 merged 非空时 override(system_message=...)」避免写入 `SystemMessage(content="")`。

---

## 三、思考流（Reasoning Stream）为何可能不显示

### 3.1 提示词是否要求思考

- **是**。`agent_prompts.get_orchestrator_prompt` 中：
  - **非推理型模型**：`think_tool` 段落要求使用 think_tool 记录推理过程。
  - **推理型模型**：说明可使用 `extended_thinking` 输出深度思考，前端会单独展示。
- 因此「没有思考流」通常**不是**因为提示词没要求，而是**模型未返回**或**前端未收到/未匹配**。

### 3.2 数据流（简要）

1. **模型**：流式 delta 中提供 `reasoning_content` / `thinking` / `reasoning` 或 `<think>...</think>`。
2. **后端**：`model_manager._patch_reasoning_content_on_chunk` 将推理写入 `AIMessageChunk.additional_kwargs["reasoning_content"]`；main_graph 的 TokenStreamHandler 拼成 `reasoning_parts`，通过 `writer({"type": "reasoning", "data": {"phase": "content", "msg_id": ..., "content": ...}})` 下发。
3. **前端**：MyRuntimeProvider 收到 `type === 'reasoning'` 且 `phase === 'content'` 时调用 `enqueueReasoningChunk`；thread 侧 `useNativeReasoningBlocks` 订阅并展示思考块。

### 3.3 无思考流时的排查顺序

| 层级 | 检查项 |
|------|--------|
| **模型配置** | `backend/config/models.json` 中该模型是否 `is_reasoning_model: true`；云端是否在 delta 中返回 reasoning_content/thinking/<think> |
| **后端** | 流式响应中是否发出 `type: "reasoning", phase: "content"`（可抓 LangGraph stream 或打日志） |
| **前端** | 是否进入 `d?.type === 'reasoning'` 分支并调用 `enqueueReasoningChunk`；`msg_id` 是否与当前消息一致（isRunning 时已放宽匹配） |
| **UI** | `useNativeReasoningBlocks` 的 `mergedThinkingBlocks` 是否有数据；思考块是否被正确渲染（见 thread.tsx InlineThinkingBlock / ReasoningBlock） |

若模型本身不在 delta 中返回推理内容，则无论提示词如何要求，都不会有思考流；此时可依赖 **think_tool**（非推理型模型）把推理写入对话历史，前端通过工具调用结果展示。

---

## 四、建议改动汇总

1. **content_fix 加固**：对 `_merge_leading_system_into_request` 中得到的 `rest`，在 `request.override(messages=...)` 前，将每条消息的 `content` 若为 list 则转为单一字符串（仅对发 API 的副本做，避免破坏原始 state 的 content_blocks 如需他用）。
2. **保留当前中间件顺序**：license_gate → content_fix → reflection → inject_runtime_context，无需调整。
3. **思考流**：确认当前使用模型的 `is_reasoning_model` 与云端 delta 契约；若无原生 reasoning 字段，依赖 think_tool 的调用结果在 UI 中展示。
