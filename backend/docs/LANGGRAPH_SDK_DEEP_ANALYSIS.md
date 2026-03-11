# LangGraph SDK 深度分析与改进

本文档在 [main_pipeline_and_middleware_rationality](../../docs/main_pipeline_and_middleware_rationality.md) 主链路对照基础上，专项梳理本系统对 LangGraph SDK 的使用、与官方能力对齐情况，以及可进一步发挥的改进点。不涉及 DeepAgent/中间件细节，仅聚焦 LangGraph 图、持久化、人机闭环与流式。

---

## 一、已用能力汇总

| 能力 | 使用位置 | 说明 |
|------|----------|------|
| **StateGraph + AgentState** | [main_graph.py](../engine/core/main_graph.py) `StateGraph(AgentState)` | 图状态仅 `messages`，使用 `add_messages` reducer，与 LangGraph 推荐一致。 |
| **Checkpointer** | main_graph.py `get_sqlite_checkpointer()`（约 665–769 行） | SqliteSaver（优先 `langgraph_checkpoint_sqlite`，回退 `langgraph.checkpoint.sqlite`）；不可用时降级 MemorySaver。按 `configurable.thread_id` 持久化，每 super-step 落盘。 |
| **Store** | main_graph.py `get_sqlite_store()`（约 787–894 行） | 看板/任务等长期数据；[board_api](../../api/routers/board_api.py)、[task_bidding.py](../tasks/task_bidding.py) 优先 `store.search(namespace, limit)`，无 search 时 list+get 并做限幅。 |
| **get_stream_writer** | main_graph.py 约 1249 行 | 节点内 `get_stream_writer()` 获取 LangGraph 注入的 writer，发送自定义 payload：`task_progress`、`reasoning`、`session_context`、`run_error` 等。子图内流式必须通过 writer 转发，否则外层 `stream_mode="messages"` 无法拿到子图 token。 |
| **interrupt()** | main_graph.py 约 2848–2869 行 | Plan 阶段在 `deepagent_plan_node` 内调用 `interrupt({...})`，挂起后由 LangGraph Server/客户端恢复时传入 `resume` 值；节点内按 `resume_payload`（str 或 dict 的 decision/response）判断是否继续执行。 |
| **ainvoke / invoke** | [task_watcher.py](../tasks/task_watcher.py) 约 1305/1324 行 | 自动任务使用 `graph.ainvoke(input, config=invoke_config)`，config 含 `thread_id` 等；若 checkpointer 仅支持同步，降级为 `asyncio.to_thread(graph.invoke, ...)`。 |
| **compile** | main_graph.py 约 3060–3065 行 | `workflow.compile(checkpointer=..., store=...)`，再 `with_config({"recursion_limit": _GRAPH_RECURSION_LIMIT})`。LangGraph API 模式下不注入 checkpointer/store，由平台管理。 |

---

## 二、SDK 能力与对齐

### 2.1 持久化（Persistence）

- **thread_id**：所有 run 的 `config.configurable.thread_id` 即持久化游标；同一 thread_id 下多次 invoke/astream 会基于同一 checkpoint 链继续。
- **Checkpointer**：每个 super-step 结束后写 checkpoint；支持故障恢复与「恢复至上次中断」。
- **Store**：与 Checkpointer 独立，用于业务数据（看板任务、邀请等）；namespace 由 [store_namespaces](../../config/store_namespaces.py) 定义。

### 2.2 人机闭环（Interrupt + 恢复）

- **中断**：Plan 节点在规划完成后调用 `interrupt({...})`，传入 JSON 可序列化结构（type、summary、context、options），供前端展示确认 UI。
- **恢复**：恢复时由 LangGraph Server/客户端发起新 run，通过 **Command(resume=...)** 或等价方式把用户选择传回；本节点接收到的 `resume_payload` 即该值。支持形态：
  - 字符串：如 `"approve"`，直接 `strip().lower()` 判断；
  - 字典：取 `decision` 或 `response` 字段。
- **约定**：`approved` 判定为 `decision in {"approve", "approved", "confirm", "confirmed", "yes", "execute"}`；否则不执行 execution 阶段并返回。

### 2.3 流式（Streaming）

- **子图内**：DeepAgent 作为逻辑子图在节点内执行，`agent.astream(state, config, stream_mode="messages")` 仅在 LLM 消息完整时产出 chunk，无法逐 token。因此节点内通过 `get_stream_writer()` 将 token/reasoning 以自定义事件写出，由前端消费。
- **stream_mode**：外层图由 LangGraph Server 配置；若需同时拿到「节点进度」与「消息流」，调用方可传 `stream_mode=["updates","messages"]`（具体以 Server/客户端能力为准）。

### 2.4 Store 的 search 与回退

- 有 `store.search(namespace, limit)` 时，board_api 与 task_bidding 均优先调用，在内存中再按 status/thread_id 过滤，避免 N+1。
- 无 search 时：board_api 的 `_store_list_items` 与 task_bidding 的 `sync_board_task_by_thread_id` 使用 list+get，并对 list 长度做上限（如 task_bidding 的 `_SYNC_BOARD_FALLBACK_LIST_LIMIT`）。

---

## 三、可进一步发挥的点

### 3.1 get_state / get_state_history

- **用途**：恢复/回放 UI、排障、或「回到某一步」。
- **方式**：编译后的图支持 `compiled_graph.get_state(config)`（需传入含 `thread_id` 的 config）；或通过 LangGraph API 的 `GET /threads/{thread_id}/state` 获取当前 checkpoint 状态。
- **说明**：本系统当前未在业务逻辑中调用 get_state；若产品需要「恢复前预览」或时间旅行，可在 API 层封装 `threads.get_state` 并在文档中注明 thread_id 与 configurable 的对应关系。

### 3.2 Command(resume=) 与 Plan 恢复

- **当前**：Plan 恢复时，LangGraph Server 会将客户端传入的 resume 值交给 `interrupt()` 的返回值；本节点不直接使用 `Command` 类型，只接收最终 payload。
- **已实现**：后端恢复入口已统一使用 **Command(resume=...)** 格式。例如 [board_api.py](../../api/routers/board_api.py) 中任务恢复（约 1417 行）与人工审核后恢复（约 2149 行）均使用 `{"command": {"resume": {"decision": ..., "feedback": ...}}}` 调用 `POST .../threads/{thread_id}/runs`。节点内从 `interrupt()` 返回值解析 `decision`/`response`，与上述 payload 一致。
- **约定**：前端或其它恢复方在恢复 Plan/人工审核中断时，应使用相同结构（str 或 `{ decision?, response? }`），以便节点内 `approved` 判定正确。

### 3.3 run_name

- **用途**：LangSmith/日志中区分不同 run，便于可观测。
- **现状**：[task_service.py](../tasks/task_service.py) 创建任务并启动 run 时在 `run_payload.config` 中设置 `"run_name": f"task_{mode}"`（约 279 行）；[task_watcher.py](../tasks/task_watcher.py) 自动任务在 `invoke_config` 顶层设置 `"run_name": "autonomous"`（约 1290 行）。
- **建议**：前端或其它发起 run 的入口（如直接调 LangGraph API 的 chat），若 API 支持，可同样在 config 中传入 `run_name`，与上述一致。

### 3.4 stream_mode 列表

- 需要同时消费「节点级 updates」与「消息流」时，可由调用方传 `stream_mode=["updates","messages"]`（以 LangGraph Server 实际支持的参数为准），无需改图定义。

---

## 四、注意事项

1. **子图流式**：子图内必须用 `get_stream_writer()` 转发 token/reasoning，否则外层仅能收到子图结束后的 state updates，无法实现逐 token 流。
2. **同步 Checkpointer**：部分 SqliteSaver 实现仅支持同步，task_watcher 会捕获 `NotImplementedError` 并降级为 `graph.invoke`，保证自动任务仍可运行。
3. **Plan 中断 payload**：`interrupt(...)` 传入的对象会暴露给前端；恢复时前端需把用户选择以 str 或 `{ decision }` / `{ response }` 形式通过 Command(resume=...) 传回，与节点内解析保持一致。
4. **recursion_limit**：图编译后通过 `with_config({"recursion_limit": _GRAPH_RECURSION_LIMIT})` 设置，SubAgent 等会消耗该限制，需保证足够大（当前由常量控制）。

---

## 五、参考

- 主链路与中间件：[main_pipeline_and_middleware_rationality](../../docs/main_pipeline_and_middleware_rationality.md)
- 通用 Agent 设计：[GENERAL_AGENT_DESIGN.md](GENERAL_AGENT_DESIGN.md)
- LangGraph 官方：Persistence、Interrupts、Streaming 文档（见 LangChain Docs）。
