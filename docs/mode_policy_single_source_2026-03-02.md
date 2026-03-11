# Mode Policy Single Source (Cursor/Cowork 对齐)

## 收敛目标

将“模式工具权限判定”收敛为单一事实源，避免多点重复定义引发漂移。

## 已落地

- 权威策略定义：`backend/engine/modes/mode_config.py`
  - `allowed_tools`
  - `denied_tools`
  - `explain_tool_policy(mode, tool_name)`
- 运行时消费端：`backend/engine/middleware/mode_permission_middleware.py`
  - 统一调用 `explain_tool_policy` 做拦截与报错

## 仍需关注的重复点

- 模式层提示词（`MODE_PROMPTS`）中的“允许/禁止”语义与 `allowed_tools/denied_tools` 需保持同步。
- 前端文案中的模式描述（何时可执行）需与后端策略一致。

## 收敛路径

1. 后端判定唯一来源：`mode_config` 的结构化字段与判定函数。
2. 提示词仅做行为说明，不重复实现权限逻辑。
3. 前端文案从后端接口读取或复用同一映射，避免手写分叉。
