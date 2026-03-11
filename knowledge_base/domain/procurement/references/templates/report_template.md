# 分析报告模板

用于招标分析、评标分析或投标总结等书面报告的通用结构，Agent 可按此结构输出。

---

## 1. 报告结构

```
1. 封面/标题
   - 报告名称、项目名称、编制日期、编制方

2. 摘要（可选）
   - 核心结论、主要发现、关键建议（1 页内）

3. 背景与目的
   - 项目/招标背景、报告目的、数据来源

4. 主体内容（按报告类型选择）
   - 招标分析：项目概况、评分标准、需求要点、风险与机会
   - 评标分析：得分构成、优劣势、改进建议
   - 投标总结：中标/未中标原因、经验教训、后续行动

5. 附录（可选）
   - 原始数据、清单、对照表
```

---

## 2. 招标文件分析报告要点

与 `references/templates/analysis_report.md` 配合使用时可包含：

- 项目概况表（名称、编号、预算、截止时间、采购人）
- 评分标准（技术/商务/价格权重及明细）
- 强制条款与资格要求摘要
- 关键风险与机会
- 建议的投标策略或下一步动作

---

## 3. 使用建议

- **招标分析**：结合 `01_ANALYZE_BIDDING_DOCUMENT_V2.md` 的 OUTPUT 结构填写，便于后续标书编制与评审。
- **评标/总结**：主体部分按「发现 → 依据 → 建议」组织，结论与建议放在摘要和文末。
- 报告路径与命名可与项目编号、日期一致，便于归档与检索。

---

## 4. 相关文件

- 招标分析输出格式：`knowledge_base/domain/procurement/references/templates/analysis_report.md`
- 分析操作指南：`knowledge_base/global/domain/bidding/02_operations/01_ANALYZE_BIDDING_DOCUMENT_V2.md`
- 报告撰写技能：`knowledge_base/skills/reports/SKILL.md`
