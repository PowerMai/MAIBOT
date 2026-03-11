# 单体 Agent 可靠性 SLO 策略（2026-03-02）

## 目标

- 将“可用”提升到“可量化稳定”：每次发布前输出同口径可靠性快照。
- 对齐顶级产品的最小标准：指标可追踪、阈值可解释、异常可告警。

## 指标定义

- `success_rate`：执行终态任务中 `completed / (completed+failed)`（不把用户主动取消计入执行失败）。
- `blocked_recovery_rate`：被阻塞任务中，已恢复到 `running/completed` 的比例。
- `human_intervention_rate`：窗口内存在人类审核记录任务的占比。
- `deliverable_effective_rate`：已完成任务中，具备 `deliverables` 或 `changed_files` 或 `rollback_hint` 的占比。
- 口径排除：默认排除 `source_channel in {test, script, ci}` 的任务，避免发布演练/脚本样本污染生产可靠性判断。

## 阈值（单体阶段，按环境）

- `dev`
  - `task_count >= 10`
  - `blocked_total >= 5` 时才判定 `blocked_recovery_rate`
  - `success_rate >= 0.35`
  - `blocked_recovery_rate >= 0.10`
  - `deliverable_effective_rate >= 0.10`
  - `human_intervention_rate <= 0.80`
- `staging`
  - `task_count >= 20`
  - `blocked_total >= 15` 时才判定 `blocked_recovery_rate`
  - `success_rate >= 0.38`
  - `blocked_recovery_rate >= 0.14`
  - `deliverable_effective_rate >= 0.15`
  - `human_intervention_rate <= 0.60`
- `production`
  - `task_count >= 40`
  - `blocked_total >= 50` 时才判定 `blocked_recovery_rate`
  - `success_rate >= 0.39`
  - `blocked_recovery_rate >= 0.15`
  - `deliverable_effective_rate >= 0.16`
  - `human_intervention_rate <= 0.50`

说明：阈值以 `backend/config/reliability_slo_thresholds.json` 为运行时单一真源；脚本默认值仅作兜底。
`blocked_total` 低于门槛时，该项以 `notes` 记录“样本不足”并跳过，不计入 strict 失败。

## 执行方式

- 本地或 CI 执行：
  - `make check-reliability-slo`
- 轻量生命周期（默认开启）：
  - `backend/scripts/check_reliability_slo.py` 默认启用 `--minimal-lifespan`，等价于设置 `FASTAPI_LIFESPAN_MINIMAL=true`，用于减少 SLO 检查时与预热/MCP/A2A/watcher 相关的无关噪音。
  - 如需完整生命周期复核，可显式传 `--no-minimal-lifespan`。
- 单体 API 验收（含限流中间件一致性检查）：
  - 本地默认：`make test-single-agent-api`（slowapi 未生效时告警，不阻断）
  - 严格阻断：`STRICT_RATE_LIMIT_CHECK=true make test-single-agent-api`（slowapi 未生效即失败）
- 严格阻断模式：
  - `make check-reliability-slo-strict`
- 收紧前守卫（防止阈值振荡）：
  - `make check-slo-tightening-ready`（默认预演 `production min_blocked_recovery_rate -> 0.30`）
- 历史快照：
  - 输出到 `backend/data/reliability_slo_history.jsonl`
- 样本来源约束（建议）：
  - 所有自动化回归创建任务统一写 `source_channel=test`；
  - 脚本化批处理任务写 `source_channel=script`；
  - CI 注入任务写 `source_channel=ci`。
- 阈值单一配置源：
  - `backend/config/reliability_slo_thresholds.json`
  - 可通过 `--thresholds-json` 覆盖读取路径
- GitHub 手动发布门禁：
  - `release-readiness` 工作流支持 `release_profile=staging/production` 预设。
  - strict 相关门禁按工作流固定执行，不再开放手动覆盖输入。
- invites 读路径观测（watcher 热路径）：
  - 查询：`GET /autonomous/watcher/config`（查看 `runtime.invites_observability`）
  - 重置：`POST /autonomous/watcher/observability/reset`（建议灰度窗口开始前执行一次）
  - 建议观测项：`scan_fallback_calls / (scan_search_calls + scan_fallback_calls)`，用于监控 search 路径退化比例。

## 告警策略

- `warn`（默认）：阈值未达标，记录快照并输出告警，不阻断流水线。
- `fail`（strict）：阈值未达标，返回非零退出码，阻断发布门禁。
- 建议：PR 使用 `warn`，发布前人工触发 release 门禁时可切 `strict`。

## 模型蒸馏闭环入口（配套）

- 样本导出：`make export-distillation-samples`
- 闭环评测：`make evaluate-distillation-loop`
- 严格模式：`backend/.venv/bin/python backend/scripts/evaluate_distillation_loop.py --strict`
- 详细规范见：`docs/cloud_local_distillation_loop_2026-03-02.md`

## 运营动作（阈值未达标时）

1. 先看 `violations` 中命中项；
2. 对照 `single_agent_consistency_audit_2026-03-02.md` 的 P1 缺口排查；
3. 在发布报告中记录“偏差原因 + 补救动作 + 预计恢复时间”。

## 周度收紧计划（建议）

- W+1：`production.min_blocked_recovery_rate` 从 `0.15` 提升到 `0.18`
- W+2：`production.min_blocked_recovery_rate` 从 `0.18` 提升到 `0.24`
- W+3：`production.min_blocked_recovery_rate` 从 `0.24` 提升到 `0.30`
- 每次收紧前要求最近 3 次 strict 检查全部通过，避免“阈值振荡”。
