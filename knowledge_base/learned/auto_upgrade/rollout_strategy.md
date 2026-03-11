# Few-shot 策略与灰度说明

- **当前状态**：以 `rollout_state.json` 为准；当前为 **60%**（broad），档位序列 10 → 30 → 60 → 100。
- **下一档放量（60% → 100%）触发条件**：
  - A/B gate 通过：`ab_eval/ab_gate.json` 的 `passed === true`（含 delta ≥ min_delta、treatment_win_rate ≥ min_win_rate、treatment 无错误、**回归门禁通过**）。
  - 系统健康达标：`system_status_report.json` 的 health 无 hard_fail，可按需要求 success 占比或健康分阈值。
- **策略与 state 一致**：`rollout_policy.json` 的 `rollout_tiers` 与 `rollout_state.json` 的档位一致；放量由自动升级流水线在 gate 通过后推进，或由人工在确认后更新 `rollout_state.json`。
- **回退**：若需回退到 50% 或 30%，需人工修改 `rollout_state.json`（如 `rollout_percentage`、`rollout_index`、`stage`）并注明原因，必要时同步 `rollout_policy.json`。
