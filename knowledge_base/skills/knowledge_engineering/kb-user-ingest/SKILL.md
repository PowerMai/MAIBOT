---
name: kb-user-ingest
description: Ingest user files to learn style, templates, and private constraints.
level: general
triggers: [用户资料摄入, 风格学习, 模板学习]
tools: [read_file, python_run, content_extract, write_file, verify_output]
---

# KB User Ingest

## 核心规则
1. 用户资料优先提取“格式风格与术语偏好”，不覆盖行业事实知识。
2. 风格知识与行业知识分库存储，避免语义污染。
3. 输出必须包含可复用模板和风格画像。
4. 涉及敏感信息时先脱敏，再做模板学习。
5. 风格画像更新采用追加策略，不直接覆盖历史。

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
- 建议：脚本就绪时使用 `run_skill_script` 执行 `scripts/verify_schema.py`，否则用 `python_run` 实现等价逻辑。
- 必检：模板可渲染、字段完整、敏感信息脱敏标记

详细推理链、端到端示例见：`knowledge_base/skills/knowledge_engineering/reference.md`
