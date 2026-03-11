# 聊天斜杠命令（Status）

本项目当前采用“输入框斜杠命令”方式，不新增额外按钮。  
命令由前端拦截后转为结构化请求，返回结果可在聊天区直接渲染。

## 可用命令（统一走 `/slash/execute` 单通道）

- `/plan [topic]`
- `/debug [issue]`
- `/review [target]`
- `/research [topic]`
- `/plugins`
- `/install <plugin>`

- `/status`
- `/status all`
- `/status health`
- `/status rollout`
- `/status gate`
- `/status prompt`
- `/status prompt_modules`
- `/status module`
- `/status modules`
- `/status commands`
- `/status command`
- `/status help`
- `/compact`
- `/memory [query]`
- `/skills [query]`
- `/learn [text]`
- `/persona [instruction]`

说明：前端保留自然语言兜底提示，但命令执行通道统一由后端 `/slash/execute` 解释与返回，避免多通道分叉导致口径漂移。

## 返回重点

- `health_score`：综合健康分（0-100）
- `components`：分项状态（rollout/gate/prompt_modules/knowledge）
- `summary`：摘要结论
- `prompt_module_health_meta`：提示词模块引用完整性（缺失数、引用数）
- `status_command_regression_meta`：`/status` 家族自动化回归结果（total/failed/passed）

说明：`/status health|rollout|gate|prompt|commands` 也返回 `health_score`、`components`、`summary`，便于前端统一渲染。

回归说明：`status_command_regression.py` 会通过 `system_status_report.py --list-sections` 自动发现 section，减少新增 section 时的漏测风险。

补充说明：

- `/compact`：触发上下文压缩导向提示，要求返回压缩前后与关键保留项。
- `/memory [query]`：有 query 时优先走 `search_memory`，无 query 时返回记忆概览。
- `/skills [query]`：有 query 时优先走 `match_skills`，无 query 时走 `list_skills`。
- `/learn [text]`：将学习点写入 `.learnings/LEARNINGS.md`。
- `/persona [instruction]`：根据指令更新或概览 `.maibot/persona.json`。

## 设计原则

- 命令优先：保持界面简洁，不增加按钮噪音。
- 结构化优先：优先返回 JSON 结构，便于前端生成式 UI 渲染。
- 可追溯：状态报告由后端巡检脚本生成，可落盘审计。

## 技能层触发建议

- 当用户问题包含“系统状态/健康检查/模块巡检/`/status`”时，优先匹配 `auto-discovery` + `quality-report`。
- 对状态类问答优先走结构化状态链路，避免先做无关通用检索。
