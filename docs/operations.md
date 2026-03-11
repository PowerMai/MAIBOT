# 运行与调试

## Agent 与 mode/缓存

- **对外语义**：本系统中的「Agent」指 `get_agent(config)` 返回的编译图（Orchestrator + SubAgents），由 [backend/engine/agent/deep_agent.py](backend/engine/agent/deep_agent.py) 提供。
- **数据流**：`main_graph` → `deepagent_node` → `get_agent(config)` → `create_orchestrator_agent(config, mode)`；节点从 `config.configurable` 或最后一条消息的 `additional_kwargs` 解析 `mode` 并注入 config，再调用 `get_agent`。
- **mode 与工具集**：前端通过 config 传递 `mode`（agent/ask/plan/debug），后端按 [backend/engine/modes/mode_config.py](backend/engine/modes/mode_config.py) 过滤工具；ask 仅只读，plan 含写入，debug 含脚本，agent 全量。
- **缓存**：Agent 按 `model_id:mode:skill_profile:workspace_path` 缓存，不同工作区使用不同实例以加载对应 `.context/` 记忆。存在有效附件（context_items）时跳过缓存以注入附件路径到系统提示。模型切换时清除 Agent 与 LLM 缓存。
- **记忆路径**：创建 Agent 时按本请求的 `configurable.workspace_path` 计算 `memory_paths`（`.context/CONTEXT.md` 等），未传或无效时回退到默认工作区根。

## 任务运行情况

- **会话状态**：LangGraph 使用 `data/checkpoints.db`（SqliteSaver）持久化会话；每轮 run 有 `thread_id` 与 `run_id`。
- **执行日志**：主要工具调用与步骤可写入 `data/execution_logs.db`（[backend/engine/logging/execution_logger.py](backend/engine/logging/execution_logger.py)）。按 `thread_id` 可关联某次对话的执行记录。
- **查看某次 run 的步骤与结果**：通过 LangGraph 的 checkpoint 与 state 接口（如 `getThreadState(threadId)`）可查看该 thread 的当前状态与历史；若有 execution_logger 集成，可再按 thread_id 查询 execution_logs 表得到步骤级记录。
- **从 checkpoint 恢复**：同一 thread 再次发送消息时，LangGraph 会从该 thread 的 checkpoint 恢复 state，无需额外操作。

## Plan 模式与「用户确认」

当前 **Plan 模式**依赖提示词约束：Agent 输出计划后由提示词要求“等待用户确认后再执行”，无图中强制中断。若产品要求 Plan 必须在图中暂停、用户确认后再继续执行，可扩展实现：

- **方案**：为 Plan 模式单独分支（例如 router 将 mode=plan 路由到 plan 子图），在该子图中对 deepagent 使用 `interrupt_after=["deepagent"]`，输出计划后图暂停；用户发送「确认执行」后从 checkpoint 恢复，再次进入 deepagent 执行。
- **实现要点**：在 `main_graph.py` 的 `route_decision` 或编译时区分 plan 分支，编译 plan 子图时传入 `interrupt_after`；前端在 Plan 模式下展示「确认执行」按钮，点击后发送一条新消息以恢复图。

## 目录约定（应用根 vs 工作区根）

- **应用根（开发时=本仓库）**：`backend/`、`frontend/`、默认 `knowledge_base/`、`docs/`、`scripts/`。只读资产与代码归属应用根。
- **工作区根（用户项目）**：默认 `tmp/`（即项目根下的 `tmp/`）；用户可在设置中指定「项目文件夹」，对应 `config.configurable.workspace_path`。工作区下统一约定：`uploads/`（上传）、`outputs/`（产出）、`.context/`（CONTEXT.md 等记忆）、`.memory/`（学习数据与知识图谱，其中 `.memory/learning/` 为自我学习持久化）。Agent 文件读写与产出均相对于工作区根。
- **数据与状态**：checkpoints、store、execution_logs 等在 `data/`（应用根下）；学习数据在工作区 `.memory/learning/`（见 [paths.py](backend/tools/base/paths.py) 的 LEARNING_PATH）。

## 用户任务与对话模型

- **线程 (Thread)**：一个 thread_id = 一个会话/任务容器。对话列表中的每项对应一个 thread。标题来源优先级：用户双击编辑的标题（若持久化）> 后端 `metadata.title` > 前端首条消息后 `updateThreadTitle` > 默认「新对话」。后端在首条用户消息处理完成后会写 `metadata.title`（[main_graph.py](backend/engine/core/main_graph.py) 中 `_update_thread_title`），前端创建新 thread 时也会调用 `updateThreadTitle`。
- **当前任务**：当前选中的 thread + 最后一条用户消息作为「目标」；任务进度条（Composer 上方）展示该目标摘要，可折叠展开（[thread.tsx](frontend/desktop/src/components/ChatComponents/thread.tsx) 中 `TaskProgressBar`）。
- **任务进度**：运行中由 RunningIndicator 显示「生成中…」+ 停止；步骤级进度由消息流中的 write_todos 工具结果展示，主图 state 仅 messages，无单独聚合 todos 面板。

## 自我学习与知识（ENABLE_SELF_LEARNING / 知识学习 / KG）

- **ENABLE_SELF_LEARNING**：在 [backend/engine/core/main_graph.py](backend/engine/core/main_graph.py) 的 deepagent 节点 finally 中，任务完成后若配置开启则调用 `learn_from_success` / `learn_from_failure`，并传入 `configurable` 中的 `skill_profile`、`business_domain`、`workspace_domain` 作为 `workspace_domain`，用于成功/失败模式按场景分段存储（见 [backend/tools/base/learning_middleware.py](backend/tools/base/learning_middleware.py)）。
- **知识学习**：学习数据持久化于工作区 `.memory/learning/`（即 `LEARNING_PATH`，见 [paths.py](backend/tools/base/paths.py)）；默认工作区为项目根 `tmp/` 时即为 `tmp/.memory/learning/`。存储 success_patterns、failure_patterns、reasoning_paths；可选与知识图谱衔接，便于 `retrieve_context` 按 task_type/workspace_domain 过滤。
- **推荐用法**：先启用知识库检索（ENABLE_KNOWLEDGE_RETRIEVER）；需要结构化知识或按领域过滤经验时再开 ENABLE_KNOWLEDGE_GRAPH；ENABLE_SELF_LEARNING 建议在稳定使用后开启，避免早期噪声写入。任务完成后可调用 extract_entities 将关键实体写入知识图谱（反哺 KG）；或在知识学习流程中定期用 python_run 调用 KnowledgeLearner.scan_and_learn()。
- **SubAgent 并行**：SubAgent 调用顺序由 Orchestrator 提示词与任务流决定；explore 与 knowledge 可在同一轮并行委派（同轮多 task()），再根据两者结果决定是否调用 planning/executor。

## 入口与闭环

- **仪表盘/命令面板「提交任务」**：打开右侧 AI 面板并派发 `fill_prompt`（`detail.prompt`、可选 `detail.autoSend`）。Composer（[cursor-style-composer.tsx](frontend/desktop/src/components/ChatComponents/cursor-style-composer.tsx)）监听后使用 `composerRuntime.setText` 或 textarea 回退填入输入框；若 `autoSend: true` 则派发 `composer_submit` 触发发送。
- **仪表盘/命令面板「继续」某项目**：打开右侧面板并派发 `switch_to_thread`（`detail.threadId` = projectId）。MyRuntimeProvider 监听后调用 `runtime.switchToThread(threadId)`，切换对话并加载该 thread 历史。
- **对话标签点击**：由 assistant-ui 的 thread list adapter 调用 `load(threadId)`，与「继续」行为一致。
