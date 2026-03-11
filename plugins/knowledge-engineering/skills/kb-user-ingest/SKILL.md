---
name: kb-user-ingest
description: Ingest user files to learn style, templates, and private constraints.
---

# KB User Ingest

## 核心规则
1. 用户资料优先提取“格式风格与术语偏好”，不覆盖行业事实知识。
2. 风格知识与行业知识分库存储，避免语义污染。
3. 输出必须包含可复用模板和风格画像。
4. 涉及敏感信息时先脱敏，再做模板学习。
5. 风格画像更新采用追加策略，不直接覆盖历史。

## 推理链示范
Input: “学习我的投标方案写作风格”
Step 1: [观察] 识别文档结构、章节模式、术语偏好。
Step 2: [定位] 提取模板骨架与可变字段。
Step 3: [执行] 写入 style_profile 与 templates。
Step 4: [验证] 检查模板可渲染与字段完整。

## 执行步骤
- 扫描用户资料并识别文档类型。
- 提取章节结构、术语偏好、句式特征。
- 生成模板骨架与变量字段定义。
- 写入 `style_profile.json` 与模板目录。
- 运行结构校验并输出差异报告。

## 交付模板
- 输入资料范围
- 风格特征摘要
- 模板列表与变量字段
- 与历史画像差异
- 后续补充建议

## 验证
- 必跑：`scripts/verify_schema.py`
- 必检：模板可渲染、字段完整、敏感信息脱敏标记

## 端到端示例
Input:
- 目标：学习用户投标文档风格并生成模板
- 数据：`users/docs/bid_samples/*.docx`

工具调用序列:
1. `read_file`/`content_extract` 提取章节结构与术语偏好
2. `python_run` 统计句式、段落长度、常用表达
3. `write_file` 写入 `knowledge_base/users/style_profile.json`
4. `write_file` 生成 `knowledge_base/users/templates/bid_template.md`
5. `verify_output` 校验模板字段和画像结构

Output（示例）:
- `style_profile.json`: 术语偏好 126 条，句式规则 14 条
- `bid_template.md`: 12 个变量字段，支持直接渲染
- `ingest_diff.json`: 新增风格特征 9 项
