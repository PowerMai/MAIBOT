# Parity KPI 分阶段上线节奏

## 指标目标

- `parity_scorecard.overall_score_100`
- `parity_trend.regression.detected`
- `required_step_fail_count`
- `ui_stream.sample_count / p95 指标`

## 阶段策略

### 阶段 1（观测）

- 在 `ops-daily` 展示 KPI，不阻断发布。
- 目标：建立 7-14 天基线。

### 阶段 2（预警）

- 对关键回退（`regression_detected=true`）发出 warning。
- 对样本不足（`sample_count < 10`）提示数据不充分。

### 阶段 3（门禁）

- production 下将关键退化升级为阻断或强签收：
  - `required_step_fail_count > 0`
  - `parity_trend.regression.detected = true`
  - 核心 p95 指标越界且连续出现

## 发布节奏

- staging 先运行 2 周，确认误报率可接受。
- production 先灰度 20%，再全量。
- 任一阶段可回退到“仅预警”模式。
