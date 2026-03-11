# Plugins 目录说明（迁移提示）

插件目录已对齐 Claude 结构并迁移到项目根目录 `plugins/`。

当前约定：

- `plugins/<plugin>/.claude-plugin/plugin.json`：插件清单（Claude 标准字段 + `requires_tier`）
- `plugins/<plugin>/skills/`：插件专属 Skills
- `plugins/<plugin>/agents/*.md`：插件专属子代理
- `plugins/<plugin>/hooks/hooks.json`：插件钩子（可选）
- `plugins/<plugin>/prompt_overlay.json`：本项目扩展的提示叠加（可选）

说明：

- 插件启用状态保存在 `data/plugins_state.json`
- 后端通过 `PluginLoader` 自动发现并加载 `plugins/` 下插件
- `knowledge_base/plugins/` 仅保留文档，不再作为主插件目录

## 命令命名规范（避免冲突）

- 不同插件若暴露同名 command（如 `/review`），前端会：
  - **Slash 建议**：下拉中展示「多插件同名 · 插件A / 插件B」标签（`plugin.commandConflictLabel` / `plugin.commandConflictHint`）。
  - **一次性 Toast**：加载到存在冲突的插件命令时，提示「存在同名命令，以首次命中为准」。
  - **执行**：以首次命中为准（后端按注册顺序）；设置页可展示 `settings.pluginSlashConflictNote` 说明。
- **命名前缀建议**（减少同名）：
  - 推荐格式：`<plugin>-<action>`（如 `bid-review`、`doc-summary`）或 `/<plugin>/<action>`（如 `/bidding/review`）。
  - 避免多个插件使用相同动词（如 `/review`、`/summary`）而不加前缀；若无法避免，用户将在 Slash 下拉与 Toast 中看到冲突提示。
- **后端**：`_collect_plugin_commands` 会对同名 command 打日志警告并为每条记录设置 `conflict`、`plugins`，供前端展示；GET `/plugins/commands` 返回的每条 command 含 `conflict`、`plugins` 字段。
