---
name: kb-gap-analysis
description: Detect knowledge gaps and generate actionable follow-up tasks.
---

# KB Gap Analysis

## 核心规则
1. 缺口必须量化（数量、覆盖率、影响范围）。
2. 缺口输出必须可转为任务（task_type、priority、owner）。
3. 无数据支持的缺口结论一律降级为 hypothesis。
4. 缺口必须关联业务影响，不做纯技术噪音清单。
5. 已关闭缺口要做复检，防止回归。

## 推理链示范
Input: “找出解决方案专家知识缺口”
Step 1: [观察] 对照 schema 与现有实体关系。
Step 2: [定位] 识别低覆盖实体与高频未命中查询。
Step 3: [执行] 生成 gap_report 和补齐任务建议。
Step 4: [验证] 检查报告字段和优先级规则。

## 执行步骤
- 对照 schema 与当前知识资产做覆盖分析。
- 统计高频未命中查询与高价值空白主题。
- 计算每类缺口的影响评分与优先级。
- 生成 `gap_report.json` 与待办任务清单。
- 回写上轮缺口关闭状态并标记回归项。

## 交付模板
- 分析范围与时间窗
- 缺口分组（领域/主题/实体类型）
- 影响评分与优先级
- 建议任务列表（task_type/owner/ETA）
- 已关闭与回归项

## 验证
- 必跑：`scripts/detect_gaps.py`
- 必检：报告字段完整、优先级可执行、任务可调度

## 端到端示例
Input:
- 目标：补齐“解决方案专家”近 30 天高频缺口
- 数据：`knowledge_base/learned/entities.jsonl`、`knowledge_base/learned/relations.jsonl`

工具调用序列:
1. `python_run` 执行 `scripts/detect_gaps.py` 生成 `gap_report.json`
2. `search_knowledge` 检索历史缺口关闭记录
3. `verify_output` 校验缺口报告结构与优先级字段
4. `write_file` 写入 `knowledge_base/learned/audits/gap_tasks.json`

Output（示例）:
- `gap_report.json`: 发现 18 个缺口，P0=5、P1=8、P2=5
- `gap_tasks.json`: 生成 6 条可调度任务（含 task_type/owner/ETA）
