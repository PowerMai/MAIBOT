# 对标 Claude/Cursor/Cowork 总览与剩余差距

本文档在一处集中说明本系统与 Claude、Cursor、Cowork 的对应关系与剩余差距，便于产品、研发与对外表述一致。不替代现有专项文档，仅做总览与索引。

---

## 一、Claude 对标

| Claude 能力 | 本系统对应 | 文档/实现位置 |
|-------------|------------|----------------|
| Skills + MCP 分工（流程与标准 vs 连接与工具） | skill_profile、list_skills / match_skills / get_skill_info、MCP 中间件与插件 registry | [skills_claude_alignment.md](skills_claude_alignment.md)、[backend/engine/skills/skill_registry.py](backend/engine/skills/skill_registry.py) |
| 知识即上下文、可引用检索 | search_knowledge + knowledge_graph、source_id/excerpt 引用要求写入提示词 | [resources-and-capabilities.md](resources-and-capabilities.md) 第 7 节、[agent_prompts.py](backend/engine/prompts/agent_prompts.py) tool_strategy |
| 极简工具 + 对话驱动 | 少工具原则（ontology、ontology_import、knowledge_graph）、Layer1 提示词与 tool_usage | [ontology_path_convention.md](ontology_path_convention.md)、[.cursor/rules/agent-architecture.mdc](.cursor/rules/agent-architecture.mdc) |

---

## 二、Cursor 对标

| Cursor 能力 | 本系统对应 | 文档/实现位置 |
|-------------|------------|----------------|
| Composer/Agent、会话隔离 | thread-scoped 会话、模式（Agent/Ask/Plan + Debug 或 Review 其一，按角色代码能力二选一） | [domain-model.mdc](.cursor/rules/domain-model.mdc)、[mode_vs_command_parity.md](mode_vs_command_parity.md)、前端 Composer 与 thread 状态 |
| 工作区与文件上下文 | workspace 根、read_file/write_file 工作区路径、knowledge_base 约定 | [resources-and-capabilities.md](resources-and-capabilities.md)、[paths.py](backend/tools/base/paths.py) |
| 斜杠命令 | POST /slash/execute、内置命令与插件命令 fallback、前端 slash 建议 | [mode_vs_command_parity.md](mode_vs_command_parity.md)、[app.py](backend/api/app.py) slash 路由 |
| 工具执行可见性 | 工具调用流式事件；tool_result 事件与前端「工具 X 完成：摘要」已落地，与 Cursor 体验对齐 | [user_task_pipeline_analysis.md](user_task_pipeline_analysis.md)、[tool_display_cursor_alignment.md](tool_display_cursor_alignment.md)、main_graph.py / toolStreamEvents |
| 工作区写入顺序 | 工作区真源为「后端 POST /workspace/switch 成功后的前端 storage」；所有写 `maibot_workspace_path` 的入口（设置页、Electron 选文件夹、Web File System Access API）均先调后端再写入，失败则 toast 不写，避免前后端分叉。 | SettingsView、WorkspaceFileTree、[workspace.ts](frontend/desktop/src/lib/api/workspace.ts) switchWorkspaceByPath |

---

## 三、Cowork 对标

| Cowork 能力 | 本系统对应 | 文档/实现位置 |
|-------------|------------|----------------|
| 协作与任务 | Dashboard、Composer、任务协作与子线程、插件命令与快捷任务 | [claude_cowork_parity_scorecard_2026-03-02.md](claude_cowork_parity_scorecard_2026-03-02.md)、WorkspaceDashboard、slash 与插件命令闭环 |
| 角色-线程绑定 | 角色为会话级、maibot_active_role_thread_{threadId}、EVENTS.ROLE_CHANGED | [domain-model.mdc](.cursor/rules/domain-model.mdc)、前端角色与会话状态 |

---

## 四、剩余差距（下一阶段）

**本规划已覆盖**：模式收敛（Debug/Review 互斥、按代码能力二选一）；工作区切换单源（先 POST /workspace/switch 成功再写前端 storage，入口已排查）；用户记忆抽取（ENABLE_USER_MEMORY_EXTRACTION、USER_MEMORY_EXTRACTION_MAX_MESSAGES，run 结束后异步沉淀用户事实与偏好）。见 [CONTEXT_AND_MEMORY_SYSTEM_DESIGN.md](CONTEXT_AND_MEMORY_SYSTEM_DESIGN.md) §2、[learning_middleware.py](backend/tools/base/learning_middleware.py) enqueue_user_memory_reflection。

以下来自 [claude_cowork_parity_scorecard_2026-03-02.md](claude_cowork_parity_scorecard_2026-03-02.md)「当前剩余风险」及可选补充项：

- **/suggestions/work 动态化**：已落实。接口支持 `thread_id`、`mode`；已安装插件命令、用户画像（未完成意图/学习轨迹）、工作区文件类型、静态技能共同生成建议；`mode=ask` 时优先展示只读/分析类建议（授权层级）。前端传入当前会话 mode 与 threadId。
- **命令即模式完全等价**：模式系统与 Claude「命令即模式」仍有实现差异，目前为兼容并存；若产品收敛为命令即模式为主，可逐步弱化模式下拉。详见 [mode_vs_command_parity.md](mode_vs_command_parity.md)。
- **插件命令冲突**：已落实。不同插件同名 command 时，前端 Slash 下拉展示「多插件同名 · 插件A / 插件B」、加载时一次性 Toast 提示；执行以后端首命中为准。命名规范与冲突说明见 [knowledge_base/plugins/README.md](knowledge_base/plugins/README.md)「命令命名规范（避免冲突）」。
- **检索总超时**：KNOWLEDGE_RETRIEVAL_TIMEOUT_SEC 已在 [embedding_tools.py](backend/tools/base/embedding_tools.py) 实现限时执行与超时降级文案；默认 0 表示不启用，可按需配置。见 [ontology_path_convention.md](ontology_path_convention.md) 环境变量与行为。
- **GraphRAG 社区摘要（长期）**：社区检测 + 社区摘要 + 全局检索，与 [ontology_path_convention.md](ontology_path_convention.md) 业界对标一致，属长期规划。
- **待办（低优先级）**：编辑区接受/拒绝 diff 回写 run、先执行再确认 + 可回退；见 [cursor_claude_cowork_behavior_analysis.md](cursor_claude_cowork_behavior_analysis.md)。
- **与 Cursor 剩余差距清单**：待产品定稿/待人工核对/已知可接受差异的汇总表见 [高可靠副驾驶对标检查结果_2026-03-09.md](高可靠副驾驶对标检查结果_2026-03-09.md) 五、5.3 与 Cursor 差距清单，以及 [cursor_alignment_checklist.md](cursor_alignment_checklist.md)「与 Cursor 剩余差距汇总」小节。

---

## 五、权威来源与索引

- **行为级对标分析（Diff/工具确认/Ask 用户/结果汇总）**：[cursor_claude_cowork_behavior_analysis.md](cursor_claude_cowork_behavior_analysis.md)
- **综合评分与证据**：[claude_cowork_parity_scorecard_2026-03-02.md](claude_cowork_parity_scorecard_2026-03-02.md)
- **Skills 与 Claude/Cowork**：[skills_claude_alignment.md](skills_claude_alignment.md)
- **知识体系与可靠性智能体**：[resources-and-capabilities.md](resources-and-capabilities.md) 第 7 节、[ontology_path_convention.md](ontology_path_convention.md)
- **工具清单与 Claude/Cursor 对比**：[tools_inventory_and_description_spec.md](tools_inventory_and_description_spec.md)
- **模式与命令**：[mode_vs_command_parity.md](mode_vs_command_parity.md)
- **全项目对齐分析**：[product_alignment_analysis_2026-03-04.md](product_alignment_analysis_2026-03-04.md)
- **高可靠副驾驶对标检查**：[高可靠副驾驶对标检查结果_2026-03-09.md](高可靠副驾驶对标检查结果_2026-03-09.md)（可发现性/一致性/可靠性、推荐流程与完成语义单源、Plan 确认双入口与门禁结果）

发布或对外说明时，以本文档为「对标 Claude/Cursor/Cowork」总览入口；建议每季度与 parity scorecard、product_alignment_analysis 同步刷新。
