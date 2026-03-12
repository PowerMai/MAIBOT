# 模式系统与「命令即模式」对齐说明

## 当前策略：兼容并存

- **模式切换**：用户在前端选择 Agent / Plan / Ask / Debug / Review，状态写入 `maibot_chat_mode`（或会话键），发送时通过 `additional_kwargs.mode` 传给后端。后端 [mode_config.py](backend/engine/modes/mode_config.py) 据此做权限与行为约束。
- **命令触发**：用户输入 `/plan`、`/ask` 等 slash 命令时，前端或后端解析命令并切换模式（或直接执行对应流程），与「先选模式再输入」并存。
- 二者互补：选模式决定「本次对话怎么跑」；命令可快速切换模式或触发一次性动作。

## 模式数量：本系统 4 种可见

- 常见 AI 工作台为 4 种模式（如 Agent / Ask / Plan / Edit），按任务类型切换。
- **本系统**：Agent、Ask、Plan 为固定三种；**第四模式为 Debug 或 Review 其一**（未启用代码能力时不强调 Debug）。**Debug 与 Review 互斥**：每个角色的 `modes` 中至多包含其一，由「代码能力」决定——角色 id 属于编码类（如 coding_engineer、developer）或 capabilities 含 code_execution 时保留 Debug，否则保留 Review。实现位置： [backend/engine/roles/role_manager.py](backend/engine/roles/role_manager.py) 的 `_normalize_modes_debug_review_exclusive`、[backend/config/roles.json](backend/config/roles.json) 默认角色仅含 review。
- 配置与数据流：`mode_config.py` 的 `allowed_tools`/`denied_tools`、`MODE_PROMPTS`、`get_mode_tools`/`is_tool_allowed` 与 deep_agent 中「按 mode 过滤工具」的调用一致；`get_orchestrator_prompt` 注入的 Layer 2 来自 `get_mode_prompt(mode)`；前端 `additional_kwargs.mode` 与 `config.configurable.mode`、后端下发的 `session_context.mode` 与当前选中模式同步。

## 与「命令即模式」的差异

- 部分产品更强调「命令即模式」：通过自然语言或命令进入某种工作方式，模式与命令强绑定。
- 本项目采用**兼容并存**：保留显式模式选择（Composer 模式下拉），同时 slash 命令可切换模式或执行动作，便于既有用户习惯与键盘流。后续若产品收敛为「命令即模式」为主，可逐步弱化模式下拉、强化命令入口，并在此文档同步更新。

## 参考

- 模式权威定义：[backend/engine/modes/mode_config.py](backend/engine/modes/mode_config.py)
- 提示词模式层：Layer 2 [agent_prompts.py](backend/engine/prompts/agent_prompts.py)
- 前端模式与命令：[cursor-style-composer.tsx](frontend/desktop/src/components/ChatComponents/cursor-style-composer.tsx)
