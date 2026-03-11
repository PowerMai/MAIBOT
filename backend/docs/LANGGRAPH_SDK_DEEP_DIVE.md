# LangGraph SDK 深度分析与能力利用

本文档基于对 [main_graph.py](../engine/core/main_graph.py)、task_watcher、Store/Checkpointer 及 LangGraph 官方能力的梳理，说明当前用法与可进一步发挥的 SDK 功能。

## 一、当前已使用的 LangGraph 能力

| 能力 | 位置与用法 | 说明 |
|------|------------|------|
| **StateGraph + AgentState** | `StateGraph(AgentState)`，`messages: Annotated[..., add_messages]` | 单一 messages 通道，符合官方推荐；reducer 由 LangGraph 在每步自动合并。 |
| **持久化 (Persistence)** | `workflow.compile(checkpointer=..., store=...)` | Checkpointer 按 thread_id 保存每 super-step 状态；Store 用于看板/任务等业务 KV。支持 `langgraph_checkpoint_sqlite` 与 `langgraph.checkpoint.sqlite` 双导入路径，降级 MemorySaver。 |
| **Human-in-the-loop (Interrupt)** | `deepagent_plan_node` 内 `interrupt({...})`，捕获 `NodeInterrupt` | Plan 阶段完成后暂停，将 `plan_confirmation` 等 payload 返回给调用方；恢复时由前端/LangGraph API 携带 `Command(resume=...)` 继续执行。 |
| **子图流式 (Streaming)** | 节点内 `agent.astream(..., stream_mode="messages")` + `get_stream_writer()` | 因 DeepAgent 为子图，外层 `stream_mode="messages"` 不会自动收到子图 token；在节点内显式 `get_stream_writer()` 将自定义 event（含 message chunk）写出，与官方「子图需主动转发」一致。 |
| **Configurable 传递** | `config.configurable` 含 thread_id、mode、skill_profile、request_id 等 | 全图节点共享；用于模型绑定、模式分支、任务状态回写、学习/回放等。 |
| **recursion_limit** | `compiled_graph.with_config({"recursion_limit": _GRAPH_RECURSION_LIMIT})` | 避免复杂任务过早触顶；SubAgent 每次调用消耗步数。 |
| **异步执行** | `graph.ainvoke`（task_watcher）；同步 checkpointer 时降级 `asyncio.to_thread(graph.invoke, ...)` | 与 LangGraph 推荐一致；watch 超时用 `asyncio.wait_for` + cancel。 |

## 二、数据流与职责划分

```
Client/LangGraph API
    → POST /threads/{id}/runs (input, config)
        → graph.astream_events / ainvoke(input, config)
            → router → deepagent_plan | deepagent_execute | editor_tool | error
                → deepagent_node: get_stream_writer() + agent.astream(stream_mode="messages")
                    → task_progress / session_context / run_error 等自定义 event
Checkpointer: 每步自动写入；thread_id 为持久化游标。
Store: 看板任务、邀请等；board_api / task_bidding 优先 store.search，无则 list+get 限幅。
```

## 三、可进一步发挥的 SDK 能力

### 3.1 可观测与追踪

- **run_name**：在发起 run 的请求中（如 task_service 的 run_payload 或前端 post body）增加 `run_name`（如 `"agent"` / `"plan"` / `"autonomous"`），便于 LangSmith/平台侧按名称过滤与统计。
- **metadata / tags**：config 中可带 `metadata` 或 `tags`，与现有 `configurable` 互补，用于成本、场景分类。

### 3.2 多 stream_mode 组合

- 当前：节点内仅使用 `stream_mode="messages"` 并自行通过 `get_stream_writer()` 发自定义 event。
- 可选：若需「节点级进度」（如当前在执行哪个节点），可由调用方在 stream 时传入 `stream_mode=["updates", "messages"]`，在 UI 展示节点名或步骤条；当前已用 task_progress 表达 phase/step，可按产品需要二选一或并存。

### 3.3 Checkpoint 与恢复

- **get_state / get_state_history**：LangGraph 在 compile 后支持 `graph.get_state(config)`、`graph.get_state_history(...)`。可用于：
  - 恢复 UI：展示「从某一步重新开始」或回溯到历史 checkpoint；
  - 排障：按 thread_id 拉取当前/历史状态。
- 当前 app 中已有 `client.threads.get_state(thread_id)`（LangGraph API 客户端），与上述能力对应；若独立部署图，可直接对 compiled_graph 调用 get_state。

### 3.4 Interrupt 与 Command 规范

- **interrupt(value)**：传入 JSON 可序列化 payload，恢复时由调用方传入 `Command(resume=value)`。
- 当前 Plan 分支用 `interrupt({ type, summary, context, options })`，前端/LangGraph API 恢复时需携带 `resume` 为同结构或至少含 `decision`/`response`；与官方「resume 即 interrupt 返回值」一致。
- 多 interrupt 场景下，resume 可为「interrupt_id → value」的映射，按顺序匹配。

### 3.5 Store 的 search 与索引

- 已用：`store.search(namespace, limit=N)` 在 board_api、task_bidding 中优先使用，避免 list + 逐 key get 的 N+1。
- 若 SqliteStore 支持 filter/条件查询，可进一步将「按 status/created_at 过滤」下推到 store，减少内存过滤与排序；当前为「全 namespace 拉取 + 应用层过滤」并已加短期缓存与 fallback 限幅。

### 3.6 任务巡检与 Cron

- task_watcher 使用 asyncio 循环拉取 available 任务并 `graph.ainvoke`，与「LangGraph Cron」独立；若迁移到 LangGraph Platform 的 Cron，可将调度交给平台，本处仅保留「单次认领与执行」逻辑。

## 四、实施建议（按优先级）

1. **P3**：在创建 run 的 API/前端 payload 中增加 `run_name`（或从 mode/thread_id 派生），提升可观测性。
2. **P3**：在文档或 CONTRIBUTING 中说明「Plan 恢复时需传 Command(resume=...)」，与前端/API 契约对齐。
3. **可选**：需要「按步回溯」时，对 compiled_graph 或 LangGraph API 的 get_state/get_state_history 做封装，供恢复或调试使用。
4. **可选**：若产品需要节点级流式进度，再引入 `stream_mode=["updates","messages"]` 与现有 task_progress 分工。

## 五、参考

- [LangGraph Persistence](https://langchain-ai.github.io/langgraph/concepts/persistence/)
- [LangGraph Interrupts (Human-in-the-loop)](https://docs.langchain.com/oss/python/langgraph/human-in-the-loop)
- [LangGraph types: interrupt, Command](https://reference.langchain.com/python/langgraph/types/)
- 项目内：[GENERAL_AGENT_DESIGN.md](GENERAL_AGENT_DESIGN.md)、[LANGGRAPH_CONFIG_IMPLEMENTATION.md](LANGGRAPH_CONFIG_IMPLEMENTATION.md)
