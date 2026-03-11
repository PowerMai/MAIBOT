# 角色配置说明（v3）

当前架构采用「单一通用角色 + Plugin 扩展」：

- 主角色配置：`backend/config/roles.json`（推荐仅保留 `default`）
- 项目覆盖：`knowledge_base/roles/<role_id>/config.json`（可选）
- 领域能力扩展：`knowledge_base/plugins/<plugin>/plugin.json`

运行时角色规则（见 `backend/engine/roles/role_manager.py`）：

1. 先读取 `roles.json` 的 `roles` 与 `aliases`。
2. 再读取 `knowledge_base/roles/<role_id>/config.json` 做同名覆盖。
3. 角色继承（`extends`）已弃用，不再做父子链合并。
4. 旧角色 ID（assistant/analyst/engineer/strategist 等）通过 `aliases` 自动映射到 `default`。

建议：

- 把通用行为放在 `default` 角色。
- 把领域能力放在 Plugin（skills/agents/prompt_overlay）。
