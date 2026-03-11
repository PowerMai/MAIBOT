# A/B 评测与回归门禁

- **ab_gold.jsonl**：评测正例集（id、user_input、gold_output、meta）；当前 10 条。run 模式从 distillation_samples.jsonl 构建请求并写 gold，若需 10+ 条评测请保证输入样本数≥10 且 --eval-size 至少 10。
- **ab_regression_set.jsonl**：回归负例集，与 ab_gold 同格式。run 模式下会单独对回归集跑 control/treatment，任一样本 treatment 得分低于 control 则门禁不通过。
- **门禁**：`evaluate_distillation_ab.py --mode run` 通过 `ab_gate.json` 输出；通过条件为 delta/win_rate/error 达标且 **回归门禁通过**（回归集内所有样本 treatment ≥ control）。
- **后续 prompt 迭代**：需在迭代后重跑 A/B（含 `--regression-set`），确保通过回归门禁后再放量。
