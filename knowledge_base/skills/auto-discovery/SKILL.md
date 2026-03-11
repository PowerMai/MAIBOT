---
name: auto-discovery
description: 自动发现系统能力缺口并生成可执行改进任务。
level: general
triggers: [发现, 缺口, 改进, 任务]
---

# Auto Discovery

## 目标
- 发现高频失败、低覆盖能力与配置薄弱点。
- 将发现转为可调度任务（含优先级与验收标准）。

## 执行步骤
1. 汇总近期任务日志、失败原因和覆盖率指标。
2. 聚类缺陷模式，识别可修复与可学习项。
3. 生成任务建议（task_type/owner/priority/ETA）。
4. 回写发现与处理状态，避免重复派发。

## 质量门
- 每个发现必须附证据来源与影响说明。
- 每条建议任务必须可执行且可验证。
- 重复发现需合并，不生成噪声任务。

## 系统状态与门禁查询（When to use）
- 用户询问**当前系统状态、门禁状态、灰度阶段**，或要求生成**系统健康分/工具数/技能数/状态卡片 UI 数据**时，优先使用本 skill。
- **Workflow 示例**：先调用 `/status` 或读取 `knowledge_base/learned/auto_upgrade/system_status_report.json`、`rollout_state.json`、`ab_eval/ab_gate.json` 等产出，再按约定格式组织回答（如 health 计数、gate 通过与否、rollout 阶段与比例、下一步建议）。
- **Avoid when**：非本工作区、无权限访问上述状态接口或文件时，明确说明「无法获取实时系统/门禁/灰度状态」，并建议用户在本工作区执行或联系管理员/查看监控。

详细规则见：`knowledge_base/skills/automation-reference.md`
