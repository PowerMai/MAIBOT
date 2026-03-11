# 对话场景回归验收（2026-02-26）

本报告用于验证“前后端业务闭环”在真实对话请求下的可用性与稳定性。

## 验收范围

覆盖以下 4 类高频请求：

1. 招标文件分析与投标建议
2. 竞争力分析与胜率评估
3. 系统状态与健康巡检展示
4. JSON 结构化展示与可视化
5. 斜杠命令状态查询（`/status` 系列）

## 证据来源

- 系统状态：`backend/tools/upgrade/system_status_report.py --section all`
- 知识审计：`knowledge_base/skills/foundation/auto-discovery/scripts/knowledge_system_audit.py`
- 能力注册表：`backend/tools/upgrade/build_capability_registry.py`
- 场景技能匹配快照：`knowledge_base/learned/audits/chat_scenario_skill_match.json`
- Prompt 模块健康：`backend/tools/upgrade/prompt_module_healthcheck.py --strict`
- 斜杠命令回归：`knowledge_base/skills/foundation/auto-discovery/scripts/status_command_regression.py --strict`

## 场景回归结果

| 场景 | 输入示例 | 预期 | 实际结果 | 结论 |
| --- | --- | --- | --- | --- |
| 招标分析 | 请分析这份招标文件并给出风险点与投标建议 | 路由到招投标核心技能 | Top5: `bidding-document-analysis`、`proposal-writing`、`compliance-check` 等 | 通过 |
| 竞争力分析 | 请做竞争力分析并评估胜率 | `competitive-analysis` 优先命中 | Top1: `competitive-analysis` | 通过 |
| 系统状态巡检 | 请输出当前系统状态和健康巡检结论 | 返回健康状态、gate、rollout | `system_status_report` 返回 health/gate/rollout 全量结构 | 通过 |
| JSON 可视化 | 把以下结果用 JSON 结构化展示并可视化对比 | 前端可渲染 JSON/UI 组件 | 已具备 `json_viewer` 与 `system_status` 生成式 UI 分支 | 通过 |
| 斜杠命令全量态 | `/status all` | 返回全量状态与统一摘要字段 | 返回 `health_score/components/summary` + `prompt_module_health_meta` + `status_command_regression_meta` | 通过 |
| 斜杠命令状态 | `/status prompt` | 能返回 prompt modules 健康摘要 | 返回 `prompt_module_health_meta` + `health_score/components/summary` | 通过 |
| 斜杠命令别名 | `/status modules` | 等价 `/status prompt` 路径 | 返回 prompt modules 健康摘要（同上） | 通过 |
| 斜杠命令回归态 | `/status commands` | 能返回命令家族自动化回归摘要 | 返回 `status_command_regression_meta` + `health_score/components/summary` | 通过 |

## 关键指标快照

- `health.counts`: `success=7, blocked=1, soft_fail=0, hard_fail=0, skipped=0`
- `knowledge_audit.score`: `100`（`healthy`）
- `capability_registry`: `tool_count=14`, `skill_count=57`, `resource_count=26`
- `prompt_module_health`: `missing_modules=0`, `referenced_modules=15`
- `status_command_regression`: `total=6`, `failed=0`, `passed=true`

## 当前阻塞与风险

1. `ab_eval_gate` 当前为 `blocked_by_data`
   - 原因：`insufficient_distillation_samples`
   - 影响：自动升级 gate 未通过前，部分“gated”变更不会自动放量
2. `rollout_runtime` 目前请求计数为 0
   - 影响：灰度运行命中率尚无生产样本支撑

## 建议动作（下一步）

1. 先补齐蒸馏样本（至少满足 gate 最低样本门槛），再触发一次 A/B gate。
2. 采集一轮真实会话 runtime telemetry，再生成 `rollout_runtime_summary` 复核放量依据。
3. 对 `system_status` 与 `json` 相关意图加入更多测试语料，持续回归 Top1 命中稳定性。
4. 持续执行 `status_command_regression.py` 并接入自动升级流水线，覆盖 `/status` 命令扩展分支（含 `commands` 子命令）。

## 结论

当前版本在“可调用、可展示、可审计”三方面已形成闭环，核心业务链路可用。  
剩余问题集中在“数据量不足导致的自动门禁阻塞”，属于数据准备问题而非功能缺陷。
