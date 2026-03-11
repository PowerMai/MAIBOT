---
name: self-evolution
description: Use this skill when the agent needs to propose safe code evolution with propose-review-test-commit flow, or when asked about rollout/gate status for auto-upgrade.
level: general
triggers: [进化, 升级, 提案, 评审, 测试, 放量, 门禁]
---

# 自我进化方法论

## Goal

在不破坏系统稳定性的前提下，持续进行小步可验证的代码升级。

## Workflow

Step 1. 明确升级目标和预期收益（性能、稳定性、可维护性）。  
Step 2. 生成提案文档到 `proposals/YYYY-MM-DD-<title>.md`。  
Step 3. 交叉评审（至少一个次级模型给出风险审查结论）。  
Step 4. 执行测试与回归检查。  
Step 5. 仅在验证通过后提交变更；失败则回滚提案状态。

## Safety Checklist

- 变更范围最小化，仅修改必要文件。  
- 禁止无测试的高风险变更直接进入主路径。  
- 对破坏性命令（如 `rm -rf`、`git reset --hard`）强制拦截。  
- L0/L1 仅允许提案，不允许自动代码落地；L3 才允许 gated 升级。

## 放量/门禁类查询（When to use）
- 用户询问「本次自动升级是否可以继续放量」「门禁是否通过」时，先获取系统状态（如 `/status` 或 `system_status_report.json`、`ab_gate.json`、`rollout_state.json`），再根据 gate 与 rollout 阶段给出判定与下一步建议。  
- **Avoid when**：非本工作区或无法读取上述状态时，说明无法获取实时放量/门禁信息，不臆测。

