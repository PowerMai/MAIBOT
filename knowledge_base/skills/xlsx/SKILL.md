---
name: xlsx
description: 处理和生成电子表格，支持数据清洗、计算与结构化导出。
level: general
triggers: [表格, Excel, 数据, xlsx]
---

# XLSX Skill

## 适用场景
- 数据整理、统计分析、台账生成。
- 需要可复算、可审计的表格交付。

## 执行步骤
1. 读取数据并做字段标准化。
2. 执行校验与异常值处理。
3. 计算指标并生成透视/汇总结果。
4. 导出 XLSX 与结果说明。

## 质量门
- 字段定义、单位、口径一致。
- 关键公式可追溯且通过抽样复算。
- 输出包含异常清单与处理说明。

详细数据口径与模板规范见：`knowledge_base/skills/document-reference.md`
