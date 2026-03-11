---
name: kb-quality-audit
description: Audit knowledge base quality, consistency, and traceability.
---

# KB Quality Audit

## 核心规则
1. 先跑结构校验，再跑覆盖率和一致性检查。
2. 审计报告必须区分 blocker、warning、info。
3. 发现 blocker 时不得宣称“可用”。
4. 问题必须绑定修复动作和责任角色。
5. 审计输出必须支持下一步自动任务生成。

## 推理链示范
Input: “审计当前知识库质量”
Step 1: [观察] 读取 schema、entities、relations。
Step 2: [定位] 检测缺失字段、断链关系、重复实体。
Step 3: [执行] 统计覆盖率并产出问题清单。
Step 4: [验证] 给出可执行修复动作与优先级。

## 执行步骤
- 读取 schema、实体集、关系集与历史审计结果。
- 执行结构校验与引用一致性检查。
- 统计覆盖率、重复率、断链率等核心指标。
- 按严重级别分组问题并生成修复建议。
- 输出审计报告并产出可调度任务清单。

## 交付模板
- 审计范围与版本
- 指标统计（覆盖率/断链率/重复率）
- 问题分级（blocker/warning/info）
- 修复任务（owner/priority/ETA）
- 风险声明

## 验证
- 必跑：`scripts/audit_coverage.py` + `scripts/verify_entities.py`
- 必检：高危问题是否全部绑定修复动作

## 端到端示例
Input:
- 目标：审计办公知识库 v2026.03
- 数据：schema + entities + relations + 上轮审计报告

工具调用序列:
1. `python_run` 执行 `scripts/audit_coverage.py`
2. `python_run` 执行 `scripts/verify_entities.py`
3. `verify_ontology_entity` 抽样验证高风险实体
4. `verify_output` 校验审计报告字段完整性

Output（示例）:
- 覆盖率 82.4%，断链率 3.1%，重复率 5.6%
- blocker 4 条、warning 11 条、info 9 条
- 生成修复任务 7 条（含 owner/priority/ETA）
