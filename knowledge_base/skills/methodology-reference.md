# Methodology Reference

本文件承载模式类技能（ask/plan/debug/review/reasoning）的详细模板与长示例。

## Ask 参考

- 回答结构：摘要 -> 分析 -> 建议 -> 来源。
- 多方案时建议使用对比表（优点/缺点/适用场景）。
- 信息不足时返回 `missing_information` 清单。

## Plan 参考

- 规划文档建议字段：`goal`、`constraints`、`steps`、`dependencies`、`acceptance`、`risks`。
- 风险矩阵建议字段：`risk`、`likelihood`、`impact`、`mitigation`。
- 未获确认前禁止执行修改操作。
- 推荐流程：`research -> clarify -> plan -> confirm -> execute`。
- 每个步骤建议统一结构：`input -> action -> output -> verification`。
- 多方案任务建议给对比表：`option`、`benefit`、`cost`、`risk`、`fit_for_current_scope`。

## Debug 参考

- 调试报告字段：`symptom`、`hypotheses`、`evidence_chain`、`root_cause`、`fix`、`regression_result`。
- 建议保留最小复现步骤与复发防护措施。

## Review 参考

- 发现项结构：`location`、`severity`、`issue`、`evidence`、`recommendation`、`owner`、`eta`。
- 按严重度排序，优先给关键问题整改路径。

## Reasoning 参考

- 建议输出结构：`conclusion` + `confidence` + `evidence[]` + `alternatives_ruled_out[]` + `next_steps[]`。
- 若证据冲突，先输出冲突解释与补证计划，再给暂定判断。

## Research 参考

- 研究型任务建议输出结构：`hypothesis`、`evidence_chain`、`conclusion`、`confidence`、`next_steps`。
- `evidence_chain` 每条建议包含：`source`、`excerpt`、`stance(support/refute)`、`reliability`。
- 涉及关键结论时，优先在检查点调用 `request_human_review` 做人工确认。
