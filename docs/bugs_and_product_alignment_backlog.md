# Bugs 与产品对齐 Backlog

对齐锚点：[产品设计文档](../knowledge_base/docs/产品设计文档.md)、[Claude/Cowork 评分卡](claude_cowork_parity_scorecard_2026-03-02.md)、[系统审视与优化](SYSTEM_REVIEW_AND_OPTIMIZATION.md)。**全项目分析报告**（契约符合性、差距与风险、改进清单、落地顺序）：[product_alignment_analysis_2026-03-04.md](product_alignment_analysis_2026-03-04.md)。**高可靠副驾驶对标检查**（五维结论与门禁结果）：[高可靠副驾驶对标检查结果_2026-03-09.md](高可靠副驾驶对标检查结果_2026-03-09.md)；其优先修复建议与本节「二、待追踪」及 product_alignment_analysis §3 P1–P2 一致。

---

## 一、已落地项（验证结论）

### 正确性（Phase 1）

| 项 | 状态 | 位置 |
|----|------|------|
| B1 msg.content 为 list 时摘要 | 已落地 | main_graph.py：getattr(msg,"content",None) + _extract_subagent_summary(content) 支持 list |
| B2 task_progress 带 tool_call_id | 已落地 | main_graph.py：data 含 "tool_call_id": tc_id |
| B3 board 同步 task_status_history | 已落地 | task_bidding.py：sync_board_task_by_thread_id 写入 task_status_history |
| B4 board PATCH description | 已落地 | board_api.py：projection_extra_updates 含 description |

### 体验与一致性（Phase 2）

| 项 | 状态 | 位置 |
|----|------|------|
| B5 evidence_rules agent+medium | 已落地 | agent_prompts.py：_layer1_extended 含 agent，evidence_rules 注入 |
| B6 思维链外化 | 已落地 | agent_prompts.py output_format：结论前 1–2 句推理路径 |
| F1 Apply hasActiveFile 随编辑器 | 已落地 | FullEditorV2Enhanced 派发 ACTIVE_FILE_PATH_CHANGED；markdown-text 订阅更新 |
| F2 任务详情「查看执行日志」 | 已落地 | TaskDetailView：SETTINGS_PREFILL_EXEC_THREAD_EVENT + task.detail.viewExecLog |
| F3 MemoryPanel 画像 loading | 已落地 | MemoryPanel：profileOpen && !profile && profileLoading 时 t("common.loading") |
| F4 无活动线程取消反馈 | 已落地 | MyRuntimeProvider：t("composer.noActiveRun") + toast.info |
| F5 CustomEvent 泛型 | 已落地 | events.d.ts：task_progress、settings_auto_save_changed、switch_left_panel 具类型 |

### 产品对齐（Phase 3）

| 项 | 状态 | 位置 |
|----|------|------|
| ArtifactPanel 保存到工作区 | 已落地 | ArtifactPanel.tsx：handleSaveToWorkspace、保存按钮、可选在编辑区打开 |
| 状态栏模型/角色 | 已落地 | FullEditorV2Enhanced：STATUS_MODEL_LABELS、getStatusBarModelLabel、底部状态栏「模型：」 |
| 欢迎页数据驱动与助理称呼 | 已落地 | ThreadWelcome：getAgentProfile().name → assistantName，roleGreeting / greetingAsName |
| 助理名字可配置 | 已落地 | 设置 Agent 档案「助理名称」；Thread 与欢迎页使用 boardApi.getAgentProfile().name |

### 分析补充（i18n 与文案）

| 项 | 状态 | 位置 |
|----|------|------|
| 门禁/发布摘要文案 i18n | 已落地 | WorkspaceDashboard：dashboard.releaseGate.*（摘要标题、详情、复制成功等） |
| 知识图谱零散文案 i18n | 已落地 | KnowledgeGraphView：knowledge.loadFailed、subgraphLoadFailed、fitCanvas、backView |

### 对齐顶层设计与国际大厂持续分析（已落地）

| 项 | 状态 | 位置 |
|----|------|------|
| P0-1 任务状态单一真源 | 已落地 | task_bidding.project_board_task_status 唯一写入口；task_state_event_contract.md、TASK_SINGLE_SOURCE_ENABLED |
| P0-2 Plan 确认回归 | 已落地 | main_graph 图级 interrupt、plan_route_decision；tests/test_plan_confirmation_routing.py |
| P0-3 会话事件协议 | 已落地 | 流事件 session_context(threadId/mode/roleId)；domain-model.mdc 约定 |
| crystallization 404 修复 | 已落地 | app.py：GET /agent/crystallization-suggestion，与 CrystallizationToast 对接 |
| Phase3 冲突率可观测 | 已落地 | board_api _board_patch_status_*；GET /board/metrics/reliability 含 status_projection_* |
| Phase3 accept-bid 并发 | 已落地 | task_bidding _get_project_status_lock；tests/test_accept_bid_concurrency.py |
| Phase3 blocked 单源 | 已落地 | board_report_blocked 仅投影、失败 409；test_blocked_single_source_projection_failure_no_write |
| Phase4 门禁可选提智/成本 | 已落地 | check_ci_release_gates.py：--warn-cost-quality、_check_cost_quality_optional* |
| Phase4 会话级策略入口 | 已落地 | MyRuntimeProvider config.run_strategy/parallel_level；langserveChat 类型与存储键约定 |
| Phase5 CI Plan/skills | 已落地 | Makefile BACKEND_CORE_TESTS 含 test_plan_confirmation_routing、test_accept_bid_concurrency |
| Phase5 skills 统一索引 | 已落地 | skills_tool list_skills/match_skills 可选 profile/mode，与 build_runtime_index 一致 |
| P1-1 插件 manifest 强校验 | 已落地 | spec.py validate_manifest_schema、MANIFEST_REQUIRED_KEYS；plugin_loader 版本门禁 compatibility_min_version |
| P2 观测与可追溯约定 | 已落地 | docs/p2_observability_and_traceability_contract.md |
| 门禁可选硬阻断 | 已落地 | check_ci_release_gates.py：--hard-fail-cost-quality、RELEASE_GATES_STRICT=1，超标时 _ci_gate_failures 并返回非 0 |
| KB-3 本体构建格式 | 已落地 | ontology_builder.py DEFAULT_ONTOLOGY_FILE_TYPES 与 _read_file_text_for_ontology 已支持 .md/.txt/.pdf/.docx/.doc；build-task 传 file_types=None 使用默认全格式 |
| 工作区真源收敛 | 已落地 | WorkspaceFileTree 以 maibot_workspace_path 为优先读取；切换时写入该键并派发 WORKSPACE_CONTEXT_CHANGED；监听该事件同步 path 并刷新；localWorkspacePath 为派生/兼容 |

---

## 二、待追踪（后续迭代）

### Subagent/云端/可靠性（后续迭代）

- P0：并行策略可验证闭环（MAX_PARALLEL_* 执行层可验证）；云端提智路径默认可配置（models.json / model_manager）。
- P1：前端会话级资源策略入口已提供（run_strategy/parallel_level 存 thread 并传 config）；提智/成本指标已可选纳入门禁（--warn-cost-quality）。后续可将成本/成功率设为硬门禁。
- P1 可靠性：success_rate、blocked_recovery_rate、deliverable_effective_rate 达文档目标；[p1_reliability_improvement_backlog_2026-03-02.md](p1_reliability_improvement_backlog_2026-03-02.md)。

### 建议动态化与插件冲突（Phase D 排期）

- **/suggestions/work**：当前含较多静态启发式；建议改为「已安装插件 + 授权层级 + 当前会话目标」动态生成，与 Claude 评分卡剩余风险一致。
- **插件命令冲突**：不同插件同名 command 目前为前端去重 + 后端首命中；建议补充冲突提示（如 Toast/设置页说明）与命名规范文档（如 `knowledge_base/plugins/README.md` 或约定前缀）。

### 全项目分析后续迭代（2026-03-04 报告合并）

- **P1**：前端关键路径静默 catch 收敛（加载失败时 toast 或 setError）；后端辅助接口 except 补 logger 与错误形状；P1 可靠性 SLO 按节奏执行（见 p1_reliability_improvement_backlog、p2_observability 第 1.1 节）。
- **P2**：UI 门禁发布前勾选（UI_RELEASE_QUALITY_GATE）；API 错误形状全面收敛；a11y/i18n 扫尾。
- 详细分类与验收标准见 [product_alignment_analysis_2026-03-04.md](product_alignment_analysis_2026-03-04.md) 第三节、第四节。
- **高可靠副驾驶对标检查（2026-03-09）**：门禁与 DoneVerifier 用例全部通过；五维结论见 [高可靠副驾驶对标检查结果_2026-03-09.md](高可靠副驾驶对标检查结果_2026-03-09.md)。优先修复建议与本节 P1/P2 一致，无新增 P0 项。

### 国际顶级产品能力（可选/排期）

- 代码执行沙箱化：仅限受信环境；沙箱方案需单独设计；部署文档明确「代码执行仅限受信环境」。
- 多模态：图片理解、表格识别、图表生成。
- 可观测性：LangSmith 已接；性能/使用统计低优先级。

### 能力对齐（文档/版本/Skills/工具/提示词/主链路计划）

| 优先级 | 项 | 状态 | 说明 |
|--------|----|------|------|
| P1 | 文件版本可回退 | 已落地 | FullEditorV2Enhanced 面包屑「历史版本」Popover + 恢复；文档约定仅会话内、不持久化 |
| P1 | 工具描述与用法审查 | 已落地 | registry 审查完成，tools_inventory 增审查记录；web_crawl_batch/content_extract/template_render 补全描述 |
| P2 | 每次执行写文档的契约 | 已落地 | docs/execution_document_contract.md；execution_docs.py + task_watcher 任务完成后调用 write_execution_summary（ENABLE_EXECUTION_DOCS） |
| P2 | Skills 市场版本与更新 | 已落地 | 后端 GET /skills/check-updates、POST /skills/update-all；安装时记录 version；前端「检查更新」「全部更新」+ 市场卡片与已安装列表展示版本（v*） |
| P2 | 提示词逐层对照 | 已落地 | prompts_authoritative_sources_and_layers.md 第四节「Layer 0–2 与 Claude/Cowork 对照」表 + 差异与取舍 |
| P3 | 用户级文件版本 | 已落地 | Store 快照：file_version_store.py、ns_file_versions；POST/GET /workspace/file-versions/snapshot|list|get|restore；每文件保留最近 50 条 |
| P3 | Skill 启用/禁用细粒度 | 已落地 | 全局：data/skills_disabled.json、GET/PATCH /skills/disabled；list_skills/match_skills 排除禁用项；会话级可后续由 configurable 注入 |

**产出文档**（已落地）：[doc_and_version_management_convention.md](doc_and_version_management_convention.md)、[skills_claude_alignment.md](skills_claude_alignment.md)、[tools_inventory_and_description_spec.md](tools_inventory_and_description_spec.md)、[prompts_authoritative_sources_and_layers.md](prompts_authoritative_sources_and_layers.md)。

---

## 三、验收口径（阶段）

- **正确性**：B1–B4 行为符合上述位置与文档。
- **体验**：B5–B6、F1–F5 符合计划与 product_analysis §9。
- **对齐**：用产品设计文档与 parity scorecard 做阶段验收。

*最后更新：2026-03-09 高可靠副驾驶对标检查已执行，检查结果与优先修复建议见 [高可靠副驾驶对标检查结果_2026-03-09.md](高可靠副驾驶对标检查结果_2026-03-09.md)；本 Backlog 已引用该报告。此前：2026-03-04 全项目分析报告产出；Phase 1–3 验证完成，WorkspaceDashboard 门禁文案与 KnowledgeGraphView i18n、P0–Phase5/P1-1/P2 约定、工作区真源收敛、threads 稳健化、建议动态化/插件冲突设置页说明已落地。*
