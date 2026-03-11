# Prompt Modules Override

本目录用于项目级提示词模块覆盖与扩展。  
加载优先级：`.maibot/modules` > `backend/engine/prompts/modules`。

## 用法

- 新增模块：`tool_usage/my_tool.md`
- 覆盖系统模块：创建同名文件，例如 `modes/agent_hint.detailed.md`
- 在 `.maibot/prompt_assembly.json` 中引用模块名（不带 `.md`）

## 运行时开关

可在 `.maibot/settings.json` 中控制装配行为：

- `prompt_modules.enabled`: 是否启用模块装配
- `prompt_modules.enable_workspace_overrides`: 是否启用 `.maibot/modules` 覆盖优先
- `prompt_modules.force_detail_level`: 可选 `concise` / `detailed`，为空则按 `prompt_assembly.json` 决策
- `prompt_modules.warn_missing_modules`: 模块引用缺失时是否输出告警日志

## 示例

- `tool_conditional.my_tool = "tool_usage/my_tool"`
- `mode_conditional.agent = ["modes/agent_hint", "reminders/upstream_artifacts"]`

