# 生态兼容矩阵（插件 / Skills）

本矩阵只复用现有 smoke 与 release summary 输出，不新增并行系统。

## 数据来源

- `backend/scripts/plugins_compat_smoke.py`
- `backend/scripts/check_plugin_command_conflicts.py`
- `backend/scripts/check_knowledge_source_compliance.py`
- `backend/scripts/plugin_runtime_compat_smoke.py`
- `backend/scripts/skills_compat_smoke.py`
- `backend/scripts/build_release_gate_summary.py`

## 判定口径

- `pass`：可用，允许进入发布门后续阶段。
- `warn`：可降级，需在签字环节记录风险接受。
- `fail`：阻断发布，必须先修复。
- `missing`：证据缺失，按 `incomplete` 处理。

## 当前矩阵字段

- `compatibility_matrix.ecosystem_availability`：生态可用率，计算方式为 `pass_checks / total_checks`。
- `compatibility_matrix.checks.plugins_compat`：插件兼容状态。
- `compatibility_matrix.checks.plugin_runtime_compat`：插件运行时执行面兼容状态（agents/hooks/mcp 声明与运行时可见性）。
- `compatibility_matrix.checks.plugin_command_conflicts`：插件命令同名冲突与 `cmd@plugin` 定向解析确定性状态（先 warn）。
- `compatibility_matrix.checks.knowledge_source_compliance`：知识来源合规（公有来源/证据完整性/白名单，先 warn，不触碰私有本体）。
- `compatibility_matrix.checks.skills_compat`：Skills 兼容状态。

## 发布使用方式

1. 先执行 smoke 与门禁（建议顺序；门禁均为先 warn、不阻断）：
   - `make plugins-compat-smoke` 或 `python3 backend/scripts/plugins_compat_smoke.py`
   - `make plugin-command-conflict-gate` 或 `python3 backend/scripts/check_plugin_command_conflicts.py`
   - `make knowledge-source-compliance-gate` 或 `python3 backend/scripts/check_knowledge_source_compliance.py`
   - `make skills-semantic-gate` 或 `python3 backend/scripts/skills_semantic_consistency_gate.py`
   - `make skills-compat-smoke` 或 `python3 backend/scripts/skills_compat_smoke.py`
2. 再生成汇总：
   - `python3 backend/scripts/build_release_gate_summary.py`
3. 读取 `backend/data/release_gate_summary.json` 的 `compatibility_matrix` 字段，作为生态门准入依据。
