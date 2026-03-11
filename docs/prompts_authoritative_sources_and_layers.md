# 提示词权威来源与分层说明

本文档固定本系统提示词的**权威来源列表**与**分层结构**，便于与 Claude/Cowork/Cursor 的提示词治理方式对齐，并支持逐层对照与变更管理。

---

## 一、分层结构（5 层 + 中间件）

最终提示词 = **Layer 0–4（agent_prompts.py）+ project_memory + BUNDLE + 中间件注入 + Layer 5（动态）**。

| 层 | 内容 | 权威来源 |
|----|------|----------|
| **Layer 0** | 核心身份（identity） | [agent_prompts.py](backend/engine/prompts/agent_prompts.py)；有角色时动态生成，无角色时通用身份 |
| **Layer 1** | OS 层（system_communication、request_routing、tool_calling、tone_and_style、resource_awareness、drive_and_responsibility、collaboration_protocol、tool_usage、task_management、security、workspace_layout、version_awareness、error_recovery、making_changes、document_quality_check、output_format、evidence_rules 等） | agent_prompts.py |
| **Layer 2** | 模式层（mode_behavior：supersedes、permissions、cognitive_framework、output_expectations、completion_criteria） | [mode_config.py](backend/engine/modes/mode_config.py) |
| **Layer 3** | 角色层（role_persona、role_cognitive_style、role_interaction、role_quality、role_drive） | [roles.json](backend/config/roles.json) 或项目角色配置 |
| **Layer 4** | 业务能力层（use_skills、knowledge_graph_context、BUNDLE、project_memory） | BUNDLE.md（按 skill_profile）、project_rules_loader、知识图谱上下文 |
| **Layer 5** | 运行时上下文（inject_user_context、user_preferences、human_checkpoints） | 请求时注入；前端/会话传入 |
| **中间件** | TodoList、Filesystem、SubAgent 等工具 schema 与用法示例 | DeepAgent 中间件；按项目策略可替换为中文或禁用 |

长期记忆：LangGraph Store（SQLite）+ langmem 工具（manage_memory、search_memory），由 DeepAgent/Store 提供。

---

## 二、权威文件列表

- **总览与规则**：[.cursor/rules/agent-system-design.mdc](.cursor/rules/agent-system-design.mdc)
- **Layer 0–1、Layer 4 部分**：[backend/engine/prompts/agent_prompts.py](backend/engine/prompts/agent_prompts.py)
- **Layer 2**：[backend/engine/modes/mode_config.py](backend/engine/modes/mode_config.py)
- **Layer 3**：角色配置（如 `backend/config/roles.json`）
- **模式与命令差异**：[docs/mode_vs_command_parity.md](mode_vs_command_parity.md)

---

## 三、变更与对照建议

- **变更**：修改提示词时优先改上述权威文件；避免在多个位置重复定义同一段内容。
- **与 Claude/Cowork/Cursor 对照**：Layer 0–2 的逐层对照见下文第四节；差异与取舍已记录。
- **工具 schema 语言**：当前中间件注入多为英文；若产品要求中文界面，可对「暴露给模型的工具描述」做语言与术语统一（项目规则中已有按策略替换/禁用的约定）。

---

## 四、Layer 0–2 与 Claude/Cowork 对照

对照依据：本系统 agent_prompts.py / mode_config.py 与 [claude_cowork_parity_scorecard_2026-03-02.md](claude_cowork_parity_scorecard_2026-03-02.md)、[mode_vs_command_parity.md](mode_vs_command_parity.md)、[layer_taxonomy_spec_2026-03-02.md](layer_taxonomy_spec_2026-03-02.md)。

| 层 | 本系统实践 | Claude/Cowork 公开实践 | 对照结论 | 差异与取舍 |
|----|------------|-------------------------|----------|------------|
| **Layer 0** | 核心身份：有角色时从 roles 配置生成 persona_identity，无角色时通用身份；可选 .maibot/persona.json | 系统级 identity/persona，与协作角色一致 | 对齐 | 本系统支持多角色切换与会话级绑定，与 Cowork 角色-线程一致 |
| **Layer 1** | OS 层：system_communication、request_routing、tool_calling、tone_and_style、resource_awareness、drive_and_responsibility、collaboration_protocol、tool_usage、task_management、security、workspace_layout、version_awareness、error_recovery、making_changes、document_quality_check、output_format、evidence_rules 等 | 系统级行为与安全规范、工具使用策略、输出格式 | 对齐 | 评分卡「后端 Prompt/Mode 协议对齐」5 分；段落顺序与禁止项与极简工具+对话驱动一致 |
| **Layer 2** | 模式层：mode_config 五种模式（Agent/Ask/Plan/Debug/Review），每模式含 supersedes 声明、permissions（allowed/denied_tools）、cognitive_framework、output_expectations、completion_criteria | Claude 侧重「命令即模式」；Cursor 有 Composer/Agent 等模式 | 取舍已记录 | 本系统采用**兼容并存**：显式模式选择 + slash 命令切换，详见 [mode_vs_command_parity.md](mode_vs_command_parity.md)；若产品收敛为「命令即模式」为主可逐步弱化模式下拉 |

- **验收**：Layer 0–2 变更时同步核对上表与 mode_vs_command_parity；新增模式或权限时更新 mode_config 与本节说明。
