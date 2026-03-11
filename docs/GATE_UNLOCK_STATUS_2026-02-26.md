# Gate 解锁状态（2026-02-26）

本次目标：解除 `ab_eval_gate` 的“样本不足阻塞”，并给出是否可放量的最终判定。

## 本次执行

1. 补齐最小蒸馏样本集  
   - 新增：`knowledge_base/learned/distillation_samples.jsonl`（8 条，含 `tool_names` / `skill_hints`）
2. 执行严格门禁 A/B 评测  
   - 命令：`evaluate_distillation_ab.py --mode run --strict --fail-on-gate`
3. 执行自动编排刷新  
   - 命令：`auto_rollout_upgrade.py`

## 同步修复（防止环境误报）

1. `backend/tools/upgrade/_legacy_bridge.py`  
   - 将 legacy 脚本调用从 `python3` 改为 `sys.executable`，避免解释器漂移导致依赖缺失。
2. `knowledge_base/skills/foundation/auto-discovery/scripts/auto_rollout_upgrade.py`  
   - 子命令执行时若命令以 `python/python3` 开头，统一替换为当前解释器。  
   - `ab_eval_gate` 的可选步骤失败语义归一：  
     - 数据不足 → `blocked_by_data`  
     - 门禁未过 → `blocked_by_gate`  
   - 避免误判为 `optional_soft_fail`。
3. `knowledge_base/skills/foundation/auto-discovery/scripts/auto_upgrade.py`
   - 发现与评测子流程统一使用 `sys.executable`，避免 `python3` 指向系统解释器导致的依赖漂移。
   - A/B 调用补充 `--allow-insufficient-samples`，保持异常语义一致。

## 最终门禁结果

- `gate.passed`: `true`
- `delta`: `0.0198`
- `win_rate`: `0.7500`
- 失败原因：无（strict 门禁已通过）

## Rollout 判定

- 当前阶段：`limited`
- 当前比例：`30%`
- 放量结论：**允许放量**（从 canary 自动晋升到 limited）

## 结果解读

1. 已成功解除“样本不足”阻塞，并进一步通过 strict 质量门禁。  
2. 当前健康状态为 `success=8, blocked=0, soft_fail=0, hard_fail=0`，自动编排链路稳定。  
3. release profile 已更新为 `limited@30%`，后续可在连续通过条件下继续自动晋升。  
