# 模型选择与蒸馏

本文档说明本系统中「Auto / 手动 / 升级」选模策略与蒸馏样本收集的关系，以及相关配置项含义。

## 一、模型选择策略

### Auto（自动选模）

由 `backend/config/models.json` 的 `auto_selection_rule` 控制，可选值：

- **default_only**：仅使用 `default_model`，不按能力或列表回退。
- **priority_then_available**（推荐）：优先使用 `default_model`；若不可用，再按任务类型与模型 `capability` 做能力选模（`_select_model_by_capability`），再按配置列表顺序回退到第一个可用聊天模型。
- **available_only** / **strict_available_only**：在配置的 `models` 中选第一个 enabled 且 available 的聊天模型。

当前默认为 `priority_then_available`，避免在用户未显式选择大模型时，仅因 capability 分数高而自动选用云 35B 等。

### 手动选模

前端或调用方在请求中传入 `configurable.model`（或等效的会话模型绑定）时，直接使用该模型，不执行 auto 解析。SubAgent 使用的模型由 `subagent_model_mapping` 与 `get_subagent_model()` 决定，映射模型不可用时会自动回退到主会话模型。

### 升级（Escalation）

当 `escalation_policy.enabled` 为 true 时，在 `get_model()` 中会按以下条件切换到更强模型：

- **手动指定 tier**：若传入 `configurable.escalation_tier`（如 `cloud-strong`），则在该 tier 下选可用模型。
- **策略触发**：否则根据 `escalation_policy.triggers` 与当前上下文判断 `should_escalate()`，例如：
  - `critic_review_reject`：审查结果为 reject 时升级。
  - `retry_count_ge_2`：重试次数 ≥ 2 时升级。
  - `user_explicit_request`：用户显式请求更强模型时升级。
  - `task_complexity_high`：任务复杂度分数高时升级。

目标模型从 `fallback_order`（如 `cloud-reasoning`、`cloud-strong`、`cloud-premium`）中按顺序选取第一个可用且具备 license 的模型。

## 二、蒸馏样本收集

`DistillationMiddleware` 在每次 Agent 运行结束后（`after_agent`）根据质量门与策略决定是否将本轮对话写入 `knowledge_base/learned/distillation_samples.jsonl`：

- **云模型**：当前运行模型 tier 以 `cloud` 开头且质量分数 ≥ 6.0 时，直接写入。
- **本地模型**：需通过质量门且满足 `_local_capture_reason`（如好评、任务成功等）才写入。
- **指定教师模型**：若在 `escalation_policy` 中配置了 `distillation_model` 为非空模型 id，则**仅当本次运行使用的模型等于该 id 时**才写入；留空则按上述云/本地逻辑写入，用于明确只收集「指定教师模型」的输出，便于后续教师-学生蒸馏或评测。

## 三、相关配置项

| 配置项 | 位置 | 说明 |
|--------|------|------|
| auto_selection_rule | models.json | 见上 Auto 可选值。 |
| default_model | models.json | Auto 优先使用的模型 id。 |
| escalation_policy.enabled | models.json | 是否启用升级策略。 |
| escalation_policy.distillation_model | models.json | 可选。指定教师模型 id 时，仅该模型产生的高质量回复写入蒸馏样本。 |
| escalation_policy.fallback_order | models.json | 升级时按顺序选择的 tier 列表。 |
| escalation_policy.triggers | models.json | 触发升级的条件列表。 |

## 四、参考

- 选模与回退逻辑：`backend/engine/agent/model_manager.py`（`_resolve_auto_model`、`get_model`、`get_fallback_model_for`、`should_escalate`）。
- 蒸馏写入逻辑：`backend/engine/middleware/distillation_middleware.py`（`after_agent`）。
