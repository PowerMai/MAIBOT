# 超时与环境变量参考

本文档集中说明与超时、连接、资源相关的环境变量与配置，便于不同用户环境（弱网、慢机、生产）调大或收紧，并以**资源可用为主要目标**。

---

## 一、超时策略原则

- **不简单中止**：超时后按场景区分——可降级则降级（如知识检索超时→提示用 read_file）、能提示则提示（模型超时→建议重试/换模型），必须中止时给出明确原因与可操作建议。
- **环境适配**：所有超时与连接相关 knob 均支持环境变量覆盖，慢环境/生产环境可适当加大，避免正常请求被误杀。
- **资源释放**：流式/任务侧超时后会取消等待并释放异步资源；工具内长时间运行依赖 `TOOL_DEFAULT_TIMEOUT` 与用户合理设定。

---

## 二、流式与模型超时

| 环境变量 / 配置 | 默认 | 说明 |
|----------------|------|------|
| `DEEPAGENT_STREAM_TIMEOUT_SECONDS` | 0（不覆盖） | 覆盖单次 run 流式总等待时间；>0 时优先于模型 api_timeout。慢环境可设 300～600。 |
| 模型级 `api_timeout` | 180 | [models.json](backend/config/models.json) 中各模型 `config.api_timeout`，流式请求总超时（秒）。9B 等慢模型可配 300+。 |
| 模型级 `api_timeout_doc` | 300 | 文档类任务流式超时。 |
| 模型级 `api_timeout_analysis` | 600 | 分析类任务流式超时。 |
| `LLM_TIMEOUT` | 600 | [DeepAgent Config](backend/engine/agent/deep_agent.py)，LLM 单次调用超时（秒）。 |
| `HTTP_READ_TIMEOUT` | 300.0 | HTTP 读超时（秒）。 |
| `HTTP_CONNECT_TIMEOUT` | 10.0 | HTTP 连接超时（秒）。 |
| `HTTP_WRITE_TIMEOUT` | 30.0 | HTTP 写超时（秒）。 |

流式超时计算：main_graph 中优先取 `task_type` 对应的 api_timeout（doc/analysis/default），再被 `DEEPAGENT_STREAM_TIMEOUT_SECONDS` 覆盖，最后限制在 [60, 1200] 秒。

---

## 三、工具执行超时

| 环境变量 / 配置 | 默认 | 说明 |
|----------------|------|------|
| `TOOL_DEFAULT_TIMEOUT` | 60 | [DeepAgent Config](backend/engine/agent/deep_agent.py) 与 [code_execution](backend/tools/base/code_execution.py)：python_run 等工具未传 timeout 时的默认值（秒）。 |
| `.maibot/settings.json` → `execution_policy.python.max_timeout` | 120 | 工作区级策略，python 执行最大允许超时。 |
| `.maibot/settings.json` → `execution_policy.shell.max_timeout` | 60 | 工作区级策略，shell 最大允许超时。 |

工具超时后返回友好文案并建议检查死循环或增加 timeout 参数；不返回部分 stdout（二期可做线程安全部分输出）。

---

## 四、启动超时

| 环境变量 | 默认 | 说明 |
|----------|------|------|
| `STARTUP_DEEPAGENT_INIT_TIMEOUT_SEC` | 20 | DeepAgent 初始化超时；超时后 log warning、降级跳过。 |
| `STARTUP_STORE_INIT_TIMEOUT_SEC` | 10 | Store 初始化超时。 |
| `STARTUP_AGENT_WARMUP_TIMEOUT_SEC` | 25 | Agent 预热超时。 |
| `STARTUP_SEED_NODES_TIMEOUT_SEC` | 12 | 种子节点超时。 |
| `STARTUP_WATCHER_TASKS_TIMEOUT_SEC` | 8 | Watcher 任务注册超时。 |
| `WATCHER_CONFIG_APPLY_TIMEOUT_SEC` | 6 | Watcher 配置应用超时。 |

启动步骤超时后均采用「降级跳过、记录告警」，不阻塞进程启动。

---

## 五、检索与 SQLite

| 环境变量 | 默认 | 说明 |
|----------|------|------|
| `KNOWLEDGE_RETRIEVAL_TIMEOUT_SEC` | 0 | 知识检索超时（秒）；0 表示不限制。>0 时超时返回降级文案「检索超时…或使用 read_file」。 |
| `RERANK_TIMEOUT` | 30 | Rerank 请求超时（秒）。 |
| `SQLITE_TIMEOUT` | 30.0 | [DeepAgent Config](backend/engine/agent/deep_agent.py)，SQLite 连接/操作超时（秒）。 |
| `EMBEDDING_TIMEOUT` | 60.0 | Embedding 请求超时（秒）。 |

---

## 六、任务执行超时

| 环境变量 | 默认 | 说明 |
|----------|------|------|
| `TASK_RUNNING_TIMEOUT_SECONDS` | 1800 | [task_watcher](backend/engine/tasks/task_watcher.py)：单次任务执行最大时长（秒）。超时后 cancel 并标记 execution_timeout。 |

---

## 七、生产与资源可用建议

- **以资源可用为主要目标**：在资源紧张或网络/模型较慢的环境下，优先**调大**超时与重试相关配置，避免过小导致正常请求被误杀。
- **推荐**：慢环境/生产可适当提高 `DEEPAGENT_STREAM_TIMEOUT_SECONDS`（如 300～600）、`TOOL_DEFAULT_TIMEOUT`（如 120）、models.json 中对应模型的 `api_timeout`；本机 9B 等慢模型建议 `api_timeout` 不低于 300。
- **遇偶发超时**：建议用户重试；流式超时当前不自动重试，避免状态复杂化。

---

## 八、相关文件

- 流式超时与错误分类：[main_graph.py](backend/engine/core/main_graph.py)（deepagent_node 内 stream_timeout_seconds、_is_timeout 等）。
- 工具超时：[code_execution.py](backend/tools/base/code_execution.py)（_get_default_tool_timeout、PythonExecutor.execute）。
- 任务超时：[task_watcher.py](backend/engine/tasks/task_watcher.py)（_running_timeout_seconds、asyncio.wait_for + cancel）。
- 知识检索超时：[embedding_tools.py](backend/tools/base/embedding_tools.py)（KNOWLEDGE_RETRIEVAL_TIMEOUT_SEC）。
- 配置与 Config：[deep_agent.py](backend/engine/agent/deep_agent.py)（Config 类）。
