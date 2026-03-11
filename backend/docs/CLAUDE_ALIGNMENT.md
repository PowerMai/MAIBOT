# Claude 实现对齐清单

本系统按仓库内约定的「Claude/Cursor 实现方式」进行设计与实现，不依赖 Claude 官方未公开 API。本文档用于回归检查时快速核对。

## 依据

- `.cursor/rules/agent-architecture.mdc`：极简工具 + 对话驱动
- `.cursor/rules/agent-system-design.mdc`：提示词 = agent_prompts + project_memory + BUNDLE + 中间件
- `backend/engine/prompts/agent_prompts.py`：参考 Claude Code v2.1.37 模块划分
- `backend/docs/UNIFIED_MEMORY_ARCHITECTURE.md`：记忆层次
- `backend/docs/PATH_ARCHITECTURE.md`：四空间与路径
- `backend/tools/base/paths.py`：APP_ROOT vs WORKSPACE_ROOT，set_workspace_root(workspace_path)
- `backend/docs/SUBAGENT_OUTPUT_SPEC.md`：SubAgent 结构化输出约定（与 agent_prompts / mode_config 一致）

## 检查清单

| 领域 | 项 | 状态 | 说明 |
|------|----|------|------|
| 提示词 | 组装顺序：orchestrator → tool_strategy → memory → scene_context（可选）→ BUNDLE → 中间件 → inject_user_context | 已对齐 | deep_agent.py：get_orchestrator_prompt + memory + scene_context + BUNDLE；inject_user_context 最内层 |
| 提示词 | 记忆分工：project_memory / Store+langmem / 会话状态 | 已对齐 | agent_prompts.py &lt;tool_usage&gt; 记忆分工块 |
| 提示词 | workspace_layout 与 prompt_cfg 一致 | 已对齐 | create_orchestrator_agent 注入 upload_dir/output_dir/context_dir/knowledge_base |
| 记忆 | 项目记忆 = .context/CONTEXT.md + .context/rules/*.md | 已对齐 | _load_memory_content，文档已统一 |
| 记忆 | 框架原生：Checkpointer / Store / SummarizationMiddleware | 已对齐 | 无重复实现，见 UNIFIED_MEMORY 表 |
| 记忆 | 用户上下文：inject_user_context 从 config 注入 | 已对齐 | 替代 UserContextMiddleware |
| 路径 | 工作区根由 configurable.workspace_path / set_workspace_root 驱动 | 已对齐 | paths.py，create_orchestrator_agent |
| 路径 | BUNDLE 路径与 knowledge_base/skills 一致 | 已对齐 | paths.py 与 marketing/bidding、legal、office、reports 目录 |
| 工具 | 文件工具由 DeepAgent；python_run/shell_run/search_knowledge 等由 registry | 已对齐 | 不重复注册 |
| SubAgent | task() 时把前一步输出嵌入 description | 已对齐 | agent_prompts doing_tasks 关键规则 |
| SubAgent | Ask 模式不委派（subagent_configs = []） | 已对齐 | deep_agent.py mode == "ask" |
| 模式 | agent/ask/plan/debug 与 mode_config 一致 | 已对齐 | get_mode_config，is_tool_allowed |
| 前端 | configurable 键与 UserContext / inject_user_context 一致 | 已对齐 | MyRuntimeProvider config：workspace_path, context_items, open_files, mode, skill_profile 等 |
| 知识库 | 元数据/本体 API、scope 筛选、与对话/展示联动 | 已对齐 | knowledge_api.py metadata/ontology CRUD；KnowledgeBasePanel scope、本体管理；open_knowledge_ref → 展示区虚拟 Tab |
| 知识库 | 输入区「从知识库引用」作为 context_items 传入 | 已对齐 | cursor-style-composer 添加上下文菜单项，路径写入 context_items，后端 inject_user_context 使用 |
| Skills | 领域 = skill_profile、按 profile 列表与 by-profile API | 已对齐 | skill_profiles.json + /skills/profiles、/skills/by-profile；前端领域下拉与技能 Tab 由 API 驱动 |
| Skills | 生成草稿、技能管理（打开/删除/确认） | 已对齐 | POST /skills/generate-draft；KnowledgeBasePanel 技能 Tab、删除确认对话框、生成后自动打开 |
| 四模式 | 执行日志写入与 Debug 读取 | 已对齐 | main_graph deepagent_node start_task/complete_task；GET /execution-logs；聊天区「执行日志」按钮与无 thread 提示 |
| 任务规划 | 交付物先行：多步任务首轮或执行前列出交付物清单，完成前按清单自检 | 已对齐 | agent_prompts doing_tasks + task_management + completion_and_stopping |
| 任务规划 | 步骤契约：planning 返回 goal/key_info/steps/deliverables；executor 按 steps 执行并返回 steps_done/deliverables_created/verification_result | 已对齐 | get_planning_prompt / get_executor_prompt，doing_tasks 步骤 C/D/E |
| 任务规划 | 完成门：若有验证步骤须通过或用户接受；交付物落盘至 output_dir 或 tmp/outputs | 已对齐 | completion_and_stopping + workspace_layout |
| 模式 | Plan 模式计划结构：目标、交付物（路径+类型+验收）、步骤（id/action/output_path）、风险与假设、需确认点 | 已对齐 | mode_config MODE_PROMPTS[ChatMode.PLAN]，用户确认后可作 executor 输入 |
| SubAgent | 输出字段与 SUBAGENT_OUTPUT_SPEC 一致，Orchestrator 委派时在 description 中写明所需/所传字段 | 已对齐 | agent_prompts doing_tasks + 各 get_*_prompt |
| 通用能力 | 身份与 doing_tasks 覆盖多类任务；task_type/business_domain 注入 task_context；四模式表述包含非代码场景（资料、数据、流程、诊断） | 已对齐 | [GENERAL_AGENT_DESIGN.md](GENERAL_AGENT_DESIGN.md)；agent_prompts identity/doing_tasks；mode_config MODE_PROMPTS 角色块；_format_user_context task_context |

## 相关文档

- 记忆层次与「框架原生 vs 本系统增强」： [UNIFIED_MEMORY_ARCHITECTURE.md](UNIFIED_MEMORY_ARCHITECTURE.md)
- 路径与 .context： [PATH_ARCHITECTURE.md](PATH_ARCHITECTURE.md)
- 记忆各层详解： [MEMORY_ARCHITECTURE.md](MEMORY_ARCHITECTURE.md)
- SubAgent 输出约定与委派用法： [SUBAGENT_OUTPUT_SPEC.md](SUBAGENT_OUTPUT_SPEC.md)
- 通用 Agent 设计目标与能力边界（按场景与模式定义角色）： [GENERAL_AGENT_DESIGN.md](GENERAL_AGENT_DESIGN.md)
