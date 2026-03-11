# P1 可靠性改进清单（2026-03-02）

## 输入基线

- 来源：`backend/data/reliability_slo_history.jsonl` 最近窗口（72h）。
- 当前主要告警：
  - `success_rate` 低于目标 0.55（当前约 0.39~0.44）
  - `blocked_recovery_rate` 低于目标 0.35（当前 0.0）
  - `deliverable_effective_rate` 低于目标 0.30（当前约 0.24）

## P1 改进项（两周）

- P1-01：提升成功率（Owner: Backend/Agent）
  - 动作：对失败任务分类（工具失败/状态迁移失败/知识不足/权限失败），每类前 3 原因补守卫与 fallback。
  - 量化目标：`success_rate >= 0.48`（第1周），`>= 0.55`（第2周）。
  - 证据：每次发布附 `check_reliability_slo.py` 快照。

- P1-02：修复 blocked 恢复链路统计（Owner: Backend）
  - 动作：补充 blocked→available/running 的自动恢复路径覆盖与指标采集校验。
  - 量化目标：`blocked_recovery_rate >= 0.20`（第1周），`>= 0.35`（第2周）。
  - 证据：`test_single_agent_api_acceptance.py` + `check_board_contracts.py` 扩展用例通过。

- P1-03：提高交付有效率（Owner: Backend + Prompt）
  - 动作：对 completed 任务强制校验 `deliverables` 非空（缺失时降级为 failed 或补 report_artifacts）。
  - 量化目标：`deliverable_effective_rate >= 0.27`（第1周），`>= 0.30`（第2周）。
  - 证据：任务完成样本中 `deliverables` 覆盖率周报。

- P1-04：发布前运营门硬化（Owner: DevOps）
  - 动作：`release-readiness` 三段门执行后上传 artifacts 并签字归档。
  - 量化目标：每次发布均有“自动化证据 + 人工签字 + 风险说明”三件套。
  - 证据：`release-readiness-artifacts` + `release_signoff_template.md` 实际填报。

## 节奏建议

- 每 2 天跑一次 `make check-reliability-slo`，每周固定复盘一次。
- 任何一次 `success_rate` 下降超过 5% 触发临时复盘。
- 连续两次 `warn` 且同一指标不改善，升级为发布阻断评审。
