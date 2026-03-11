# Automation Skills Reference

用于 `auto-discovery` 与 `self-learning` 的补充说明。

## Auto Discovery
- 数据源建议：任务状态、失败记录、覆盖率、用户反馈。
- 任务生成字段建议：`task_type`、`priority`、`owner`、`acceptance`、`eta`。
- 合并策略：同类缺口聚合，避免重复任务泛滥。

## Self Learning
- 成功样本记录：问题类型、关键决策、验证方式、复用条件。
- 失败样本记录：根因、触发条件、修复动作、回归结果。
- 衰减策略：长时间未命中或低置信模式自动降权。
