# 上线后运维观察清单（2026-03-02）

## 目标

- 用最小指标集持续验证“可用、可恢复、可发布”三件事。
- 避免只看单次 gate 结果，改为连续窗口观察。

## 6 项核心指标（建议每日检查）

1. `release_gate_summary.profile_gate_status`
   - 目标：`pass`
   - 位置：`backend/data/release_gate_summary.json`
   - 含义：最终发布门禁是否可放行。

2. `reliability_slo.metrics.blocked_recovery_rate`
   - 目标：`>= backend/config/reliability_slo_thresholds.json` 当前环境阈值
   - 位置：`backend/data/reliability_slo_history.jsonl` 最近一条
   - 含义：阻塞任务是否能被持续恢复。
   - 注意：若 `blocked_total` 小于环境门槛（`dev=5/staging=15/production=50`），该项会在 `notes` 标记为“样本不足”，不作为 strict 失败条件。

3. `reliability_slo.metrics.success_rate`
   - 目标：`>=` 当前环境阈值
   - 位置：`backend/data/reliability_slo_history.jsonl` 最近一条
   - 含义：执行终态成功率（不含用户取消）。

4. `task_status_projection_evidence.status`
   - 目标：`pass`
   - 位置：`backend/data/task_status_projection_evidence.json`
   - 含义：状态单一真源链路（on/off + wiring）是否健康。

5. `compatibility_matrix.ecosystem_availability`
   - 目标：`1.0`（至少保持 `>= 0.9`）
   - 位置：`backend/data/release_gate_summary.json`
   - 含义：插件/运行时/skills 生态可用率。

6. `unified_observability_snapshot`（聚合视图）
   - 目标：每日产出且字段齐全
   - 位置：`backend/data/unified_observability_snapshot.json`
   - 含义：统一汇总发布门禁、SLO、任务投影、watcher 与生态可用率，便于单页排障。

## 每日执行命令（最小集）

```bash
make collect-task-status-projection-evidence
make check-reliability-slo-strict
make build-release-gate-summary
make build-unified-observability-snapshot
make check-watcher-observability
# 需要阻断式判定时：
# make check-watcher-observability-strict
```

- 建议同步查看 `backend/data/release_drill_steps.json`：
  - 用于定位单步耗时、超时与重试（例如 `task_status_projection` 是否触发重试）。
  - 当 `profile_gate_status=blocked` 时，可先看该文件再看 `release_drill_report`，排障速度更快。

## 一键巡检（推荐）

```bash
./scripts/ops_daily_check.sh --snapshot --watcher
```

- 可选：`--skip-projection`（仅做 SLO + release summary 快速巡检）
- 可选：`--snapshot`（按 UTC 时间戳固化当次巡检快照到 `backend/data/ops-daily/`）
- 可选：`--watcher`（附加 watcher 观测检查，失败仅告警不阻断）
- 可选：`--strict-watcher`（附加 watcher 严格阈值检查，失败阻断）
- 可选：设置环境变量 `OPS_WEBHOOK_URL`，巡检失败时自动推送告警通知。
- Makefile 快捷入口：
  - `make ops-daily-check-watcher`
  - `make ops-daily-check-strict-watcher`
- `--snapshot` 模式下会额外归档并汇总 watcher 快照（若存在 `backend/data/watcher_observability_snapshot.json`）。
- 每日 markdown 快照会输出 watcher 严格阈值结论：`strict_threshold_status`（`pass/warn/fail`）与 `strict_threshold_violations`。
- 已接入 CI 定时巡检：`.github/workflows/ci.yml` 的 `ops-daily-check`（每日 UTC 01:17），并在 Job Summary 展示 watcher 严格阈值结论。
- 前端值班入口：`WorkspaceDashboard` 的“最近巡检结果”支持查看门禁详情，并可一键复制文本摘要 / Markdown 摘要，分别适配 IM 同步与复盘文档归档。

## 异常处理优先级

- P0（立即处理）：
  - `profile_gate_status != pass`
  - `task_status_projection_evidence.status != pass`
- P1（24h 内处理）：
  - `blocked_recovery_rate` 连续 2 次低于阈值
  - `ecosystem_availability < 1.0`
- P2（迭代优化）：
  - `success_rate` 波动明显但仍高于阈值

## 周度动作（建议）

- 每周固定一次阈值收紧评估：先跑 `make check-slo-tightening-ready`，满足再收紧。
- 每周固化一份快照结论到验收文档，避免口径漂移。
