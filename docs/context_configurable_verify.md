# Configurable 装配校验说明

用于验证「前端 config → API → _prepare_agent_config → inject_runtime_context」链上 `workspace_path`、`editor_path`、`open_files` 等是否被正确传递到提示词。

## 1. 已添加的观测点

| 位置 | 日志标记 | 说明 |
|------|----------|------|
| main_graph._prepare_agent_config | `[context_verify] _prepare_agent_config 出口` | DEBUG：thread_id、是否含 workspace_path/editor_path、open_files 数量 |
| deep_agent._collect_dynamic_prompt_snapshot | `[context_verify] _collect_dynamic_prompt_snapshot configurable` | DEBUG：workspace_path/editor_path 是否存在、open_files_count |
| deep_agent._collect_dynamic_prompt_snapshot | `[context_verify] inject_runtime_context: get_config() 返回的 configurable 为空` | **WARNING**：中间件未拿到 run 的 config，UserContext 全为默认值 |
| 前端 MyRuntimeProvider | `[context_verify] config 关键字段` | 仅 DEV：发送前 editor_path、workspace_path、open_files、editor_content 是否有值 |

## 2. 如何验证

### 方式 A：前端发一条消息 + 看后端日志

1. 后端以 DEBUG 启动，例如：`LOG_LEVEL=DEBUG` 或设置 `logging.getLogger("backend.engine").setLevel(logging.DEBUG)`。
2. 前端开发模式启动，打开有**焦点文件**的编辑区（保证 ChatArea 收到 editorPath/editorContent）。
3. 在对话里发一条消息。
4. 看后端日志：
   - 出现 `[context_verify] _prepare_agent_config 出口: ... has workspace_path=True, has editor_path=True` → 说明 API → 节点入口正确。
   - 出现 `[context_verify] _collect_dynamic_prompt_snapshot configurable: workspace_path=True, editor_path=True` → 说明中间件拿到了 config，装配链完整。
   - 出现 `[context_verify] inject_runtime_context: get_config() 返回的 configurable 为空` → 说明断点在「中间件未拿到 config」，需做兜底（如从 request.state 取 configurable）。

### 方式 B：运行校验脚本（后端已启动）

```bash
# 项目根目录，并激活 backend 虚拟环境
LOG_LEVEL=DEBUG python -m backend.scripts.verify_context_configurable --base-url http://127.0.0.1:2024
```

脚本会创建线程并发送一条带 `workspace_path`、`editor_path` 的 stream 请求。若接口返回 4xx，请根据实际 LangGraph/Server 的请求体格式调整脚本中的 payload。成功后查看后端日志中的 `[context_verify]` 行。

## 3. 兜底逻辑（已实现）

当 `get_config()` 返回的 configurable 为空时，`_collect_dynamic_prompt_snapshot` 按序尝试：

1. **request.state["_run_configurable"]**：若主图在调用 agent 前将当前 run 的 configurable 写入 state 并传入 request，可在此处生效。
2. **get_run_configurable()**（Phase 2.2）：deepagent_node 在调用 agent.astream 前执行 `set_run_configurable(configurable)`，将 configurable 写入 ContextVar；中间件执行时若 get_config() 为空，则从该 ContextVar 读取，避免 UserContext 全为默认值。

任一兜底生效时 DEBUG 日志会输出 `[context_verify] configurable 从 ... 兜底`。若仍出现 WARNING「configurable 为空」，需检查 LangGraph 是否将 config 传入当前执行上下文，以及 deepagent_node 是否在 astream 前调用了 set_run_configurable。
