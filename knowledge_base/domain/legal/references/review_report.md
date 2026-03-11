# 合同审查报告模板

## 使用说明
此模板用于生成合同审查报告。Executor Agent 应按此结构输出。

---

# {合同标题} 审查报告

**生成时间**: {generated_at}  
**源文件**: {source_file}

## 1. 合同概况

| 项目 | 内容 |
|------|------|
| 合同标题 | {contract_title} |
| 合同编号 | {contract_number} |
| 甲方 | {party_a} |
| 乙方 | {party_b} |
| 合同金额 | {amount} |
| 合同期限 | {start_date} 至 {end_date} |

## 2. 风险评估总览

### 2.1 整体风险等级: {overall_risk}

![风险热力图](contract_risk_heatmap.png)

### 2.2 风险评分: {risk_score}/100

| 维度 | 风险等级 | 说明 |
|------|----------|------|
| 付款条款 | {payment_risk} | {payment_note} |
| 交付条款 | {delivery_risk} | {delivery_note} |
| 违约责任 | {liability_risk} | {liability_note} |
| 知识产权 | {ip_risk} | {ip_note} |
| 保密条款 | {confidential_risk} | {confidential_note} |
| 争议解决 | {dispute_risk} | {dispute_note} |

## 3. 重点条款分析

### 3.1 付款条款
**原文位置**: {payment_location}
> {payment_quote}

**风险分析**: {payment_analysis}

**修改建议**: {payment_suggestion}

### 3.2 违约责任
**原文位置**: {liability_location}
> {liability_quote}

**风险分析**: {liability_analysis}

**修改建议**: {liability_suggestion}

### 3.3 争议解决
**原文位置**: {dispute_location}
> {dispute_quote}

**风险分析**: {dispute_analysis}

**修改建议**: {dispute_suggestion}

## 4. 风险清单

| 序号 | 条款 | 风险等级 | 问题描述 | 建议 |
|------|------|----------|----------|------|
| 1 | {clause_1} | {level_1} | {issue_1} | {suggestion_1} |
| 2 | {clause_2} | {level_2} | {issue_2} | {suggestion_2} |

**风险等级**: 🔴 高风险 | 🟡 中风险 | 🟢 低风险

## 5. 审查结论

### 5.1 主要风险点
1. {main_risk_1}
2. {main_risk_2}

### 5.2 修改建议优先级
| 优先级 | 条款 | 建议 |
|--------|------|------|
| 高 | {high_priority_clause} | {high_priority_suggestion} |
| 中 | {medium_priority_clause} | {medium_priority_suggestion} |
| 低 | {low_priority_clause} | {low_priority_suggestion} |

### 5.3 签约建议
{signing_recommendation}

---

## 附录

### A. 风险汇总表
见 `contract_risk_summary.xlsx`

### B. 条款原文引用
| 条款 | 位置 | 原文 |
|------|------|------|
| {clause_ref_1} | {clause_loc_1} | {clause_quote_1} |

---
*本报告由 AI 助手自动生成，仅供参考，不构成法律意见。*
