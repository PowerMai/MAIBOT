# Layer Taxonomy Spec (L0/L1/L2/L3)

## 目标

统一 Prompt 分层与自治等级命名，避免同名多义导致治理漂移。

## 命名规范

- `PromptLayer0..5`：仅用于提示词架构语义
  - `PromptLayer0`: core identity
  - `PromptLayer1`: OS policy
  - `PromptLayer2`: mode policy
  - `PromptLayer3`: role persona
  - `PromptLayer4`: capability
  - `PromptLayer5`: runtime context
- `AutonomyLevel L0..L3`：仅用于运行时权限等级
  - `L0`: manual_approval_only
  - `L1`: semi_auto_with_write_approval
  - `L2`: auto_execute_with_guardrails
  - `L3`: full_auto_with_gated_changes

## 代码落点

- 统一常量定义：`backend/engine/architecture/layer_taxonomy.py`
- 工具权限决策契约：`backend/engine/architecture/tool_policy_contract.py`
- 自治等级消费：`backend/engine/autonomy/levels.py`
- Prompt 分层说明：`backend/engine/prompts/agent_prompts.py`
- 运行时判定链路：`backend/engine/middleware/mode_permission_middleware.py`

## 策略判定链路（运行时）

- 固定优先级：`role_mode -> mode -> autonomy -> mode_special`
- 任意拒绝均返回统一结构：
  - `allowed`
  - `policy_layer`
  - `reason_code`
  - `reason_text`
- `reason_code` 字典为契约字段，统一维护在 `tool_policy_contract.py`，用于观测聚合与 CI 校验。

## 验收

- 新增代码引用时，不再将 `L0..L3` 用于 Prompt 分层描述。
- 文档与代码注释中出现 `L0..L3` 时，必须带前缀上下文（`AutonomyLevel` 或 `PromptLayer`）。
- 工具拒绝事件在观测层可按 `policy_layer/reason_code` 聚合，不再使用自由文本作为唯一依据。
