---
name: pdf
description: 解析与生成 PDF，支持结构提取、审阅与交付导出。
level: general
triggers: [PDF, 解析, 导出, 表单]
---

# PDF Skill

## 适用场景
- 从 PDF 提取文本与结构化信息。
- 将最终文档导出为可分发 PDF。

## 执行步骤
1. 读取 PDF 并抽取文本/页面结构。
2. 清洗内容，识别章节与关键字段。
3. 执行校验（完整性、可读性、引用）。
4. 输出解析结果或导出文件。

## 质量门
- 关键字段与页码映射可追溯。
- 导出 PDF 无乱码、无缺页、无占位符。
- 提供错误页与修复建议（若失败）。

详细解析与导出规范见：`knowledge_base/skills/document-reference.md`
