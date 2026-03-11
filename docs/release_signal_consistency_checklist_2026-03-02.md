# Release 信号一致性清单

## 目标

确保 `release_summary -> unified_snapshot -> postcheck -> ci_summary` 基于同一事实源，不发生口径分叉。

## 已落地检查点

- 脚本：`backend/scripts/check_ci_release_gates.py`
  - `overall_status` 一致
  - `profile_gate_status` 一致
  - `ecosystem_availability` 一致
  - `required_step_fail_count`（drill_steps 与 postcheck）一致
  - `plugin_manifest_hygiene` 的 `status/warnings/errors` 在 summary/unified/postcheck 三方一致
  - `policy_decisions.status` 在 `policy_decision_report` 与 `unified_snapshot` 一致
  - `policy_decision_report.schema(policy_layers/reason_codes)` 与引擎契约一致

## CI 顺序约束

- `release-readiness` 中必须先执行 `release_postcheck.py`，再执行 `check_ci_release_gates.py`。
- 目的：一致性检查只读取“本次流水线刚生成”的产物，避免读取历史文件造成误判。
- `release-readiness` 中启用 `check_ci_release_gates.py --require-fresh-artifacts`，对关键报告时间戳做新鲜度约束。
- `build-unified-observability-snapshot` 前先生成 `policy_decision_report`，确保 snapshot 与 gate 基于同一份策略观测数据。

## 关键数据路径

- summary：`backend/data/release_gate_summary.json`
- unified：`backend/data/unified_observability_snapshot.json`
- postcheck：`backend/data/release_postcheck_report.json`
- drill steps：`backend/data/release_drill_steps.json`
- policy report：`backend/data/policy_decision_report.json`

## 验收标准

- `python backend/scripts/check_ci_release_gates.py` 返回 0。
- 任一关键字段不一致时，CI 立即 fail 并输出明确差异项。
- 任意策略拒绝事件均能归档为结构化字段：`policy_layer + reason_code + reason_text`。
