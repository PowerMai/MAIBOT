# 全项目 Bugs 与产品对齐分析报告（2026-03-04）

基于 [全项目 Bugs 与产品对齐分析计划] 执行，锚点：产品设计文档、Claude/Cowork 评分卡、Bugs Backlog、系统审视文档。

---

## 一、阶段 1：契约符合性清单

| 契约文档 | 核对结论 | 位置/说明 |
|----------|----------|------------|
| **prompts_authoritative_sources_and_layers.md** | **符合** | `agent_prompts.py` 含 Layer 0（identity/persona）、Layer 1（system_communication、request_routing、tool_calling、output_format、evidence_rules 等）；`mode_config.py` 含五种模式（Agent/Ask/Plan/Debug/Review），每模式有 label、allowed_tools/denied_tools、output_format、skill_path 等，与文档 Layer 0–2 一致。 |
| **task_state_event_contract.md** | **符合** | 状态唯一写入口：`task_bidding.project_board_task_status` 被 board_api、task_watcher、knowledge_api 调用；`TASK_SINGLE_SOURCE_ENABLED` 在 task_bidding.py 读取，默认 true；无直写 Store 的状态分支。 |
| **frontend_event_bus_baseline.md** | **符合** | `constants.ts` 定义 EVENTS.*，含 COMPOSER_PREFS_CHANGED、ROLE_CHANGED、CHAT_MODE_CHANGED、TASK_PROGRESS、SESSION_CHANGED 等；无硬编码 `thread_changed`（已统一 SESSION_CHANGED）；toolStreamEvents.ts 支持 `tool_result` 类型与 result_preview。 |
| **execution_document_contract.md** | **符合** | `execution_docs.py` 提供 `write_execution_summary`，`task_watcher.py` 在任务完成后调用（ENABLE_EXECUTION_DOCS 控制）；路径 `.maibot/execution_summary.md` 与契约一致。 |
| **api_error_convention.md** | **部分符合** | 后端 `_safe_error_detail` 在 app.py、knowledge_api 等使用；部分接口返回 200 + `ok: false` + `error`（如 workspace/list 异常、suggestions/work 异常）。Board 列表等已改为异常时 5xx；需持续收敛新接口统一采用 4xx/5xx 或 200+ok:false 约定。 |

---

## 二、阶段 2：差距与风险识别

### 2.1 Bugs / 健壮性

| 类别 | 位置 | 说明 |
|------|------|------|
| 后端 except | `backend/api/app.py`、`backend/api/knowledge_api.py` | 多处 `except Exception:` 已存在（P0-1 已对 main_graph/app 关键路径补 logger），其余路由/辅助接口仍有仅 pass 或仅 return 的 except，建议新改时补 logger.debug/warning 及统一错误响应。 |
| 前端静默 catch | `MyRuntimeProvider.tsx` L615、L2454；`WorkspaceDashboard.tsx` 多处 `.catch(() => {})`；`cursor-style-composer.tsx` L1559/L1585/L1608/L1636/L1801；`WorkspaceFileTree.tsx` L864/L968/L1112；`FullEditorV2Enhanced.tsx` 多处；`SettingsView.tsx` L1993；`TaskDetailView.tsx` L203；`thread.tsx` L254 | 部分为刻意静默（如轮询/可选接口）；部分应为用户可感知失败（如 loadModels、工作区/档案加载），建议对关键路径区分：需反馈的用 toast 或 setError，仅保底的保留静默。 |
| 会话/工作区边界 | 见 parity 评分卡「主要偏差点」 | 角色激活后 profile 缓存时序、高线程量下列表截断、工作区切换「后端失败但本地已写入」分叉—Backlog 已记录工作区真源收敛与 threads 稳健化已落地；profile 一致性建议保留回归用例。 |

### 2.2 体验与一致性

| 类别 | 位置 | 说明 |
|------|------|------|
| 工具执行可见性 | `main_graph.py` L2185–2206；`toolStreamEvents.ts` 支持 `tool_result` | **已落地**：后端对 ToolMessage 发送 `tool_result`（result_preview 前 500 字符），前端 eventBus 支持订阅并展示，与 user_task_pipeline_analysis 结论一致。 |
| UI 门禁 | [UI_RELEASE_QUALITY_GATE.md](UI_RELEASE_QUALITY_GATE.md) | 联动一致性、交互可达性、视觉一致性、数据与可观测、稳定性五类门禁；发布前需人工/自动化逐项勾选。 |
| i18n/无障碍 | [a11y_checklist.md](a11y_checklist.md) | 关键路径 i18n 与 aria/键盘已多轮补齐；可继续扫尾未覆盖的加载/错误/空状态文案。 |

### 2.3 产品对齐

| 类别 | 位置 | 说明 |
|------|------|------|
| 产品设计 Phase 1 | [产品设计文档](knowledge_base/docs/产品设计文档.md) | 招投标专家端到端、知识库构建工作流、桌面打包—已实现并对应；BidWizard、知识库/本体、Electron 打包见各模块。 |
| Parity 剩余风险 1 | `/suggestions/work` | 评分卡：仍含较多静态启发式。已做动态化增强：后端支持 `refresh` 跳过缓存、前端工作台「推荐任务」区可手动刷新；后续可继续增强「已安装插件+授权层级+当前会话目标」权重。 |
| Parity 剩余风险 2 | 模式系统 | 评分卡：与 Claude「命令即模式」完全等价有差异。当前兼容并存（显式模式 + slash 切换），见 mode_vs_command_parity；若产品收敛为命令即模式为主可逐步弱化模式下拉。 |
| Parity 剩余风险 3 | 插件命令冲突 | 评分卡：不同插件同名 command 前端去重+后端首命中。已落地：Slash 展示冲突说明、设置页「插件扩展」区补充 pluginSlashConflictNote；命名规范见 knowledge_base/plugins/README.md。 |

### 2.4 国际顶级能力（排期）

| 能力 | 说明 |
|------|------|
| 代码执行沙箱 | SYSTEM_REVIEW：当前直接执行，需沙箱隔离；仅限受信环境部署说明。 |
| 多模态 | 图片理解、表格识别、图表生成—部分支持，待增强。 |
| 可观测性 | LangSmith 已接；性能/使用统计低优先级。 |

---

## 三、阶段 3：分类改进清单

与 [bugs_and_product_alignment_backlog.md](bugs_and_product_alignment_backlog.md) 待追踪合并，按 P0–P3 分类。

### P0（正确性/数据一致性/安全）

| 标题 | 现状简述 | 建议改动方向 | 验收标准 |
|------|----------|--------------|----------|
| （无新增） | P0 任务状态单一真源、Plan 确认、blocked 单源、accept-bid 并发等已落地 | — | 现有 test_backend_core_regression、check_board_contract |

### P1（体验/可靠性/可观测）

| 标题 | 现状简述 | 建议改动方向 | 验收标准 |
|------|----------|--------------|----------|
| 前端关键路径静默 catch 收敛 | 部分 loadData/getProfile/loadModels 等失败时仅 .catch(() => {})，用户无感知 | 对「加载失败影响使用」的调用在 catch 中 toast 或 setError（可加 ref 仅首次 toast 避免刷屏） | 发布前抽查：工作区/档案/模型列表失败时有可感知反馈 |
| 后端辅助接口 except 与错误形状 | app.py/knowledge_api 中非主链路 except 仅 pass 或 return 空 | 新改或触达时补 logger.debug/warning；需 200+ok:false 的接口统一 body 形状 | 与 api_error_convention 一致；无裸 except |
| P1 可靠性 SLO 持续达标 | success_rate/blocked_recovery_rate/deliverable_effective_rate 见 p1_reliability_improvement_backlog | 按节奏跑 check-reliability-slo，复盘与发布证据 | 见 p2_observability_and_traceability_contract 第 1.1 节 |

### P2（体验增强/文档与契约）

| 标题 | 现状简述 | 建议改动方向 | 验收标准 |
|------|----------|--------------|----------|
| UI 门禁发布前勾选 | 联动一致性、可达性、视觉、数据、稳定性五类 | 每次发布按 UI_RELEASE_QUALITY_GATE 逐项执行并记录 | 门禁清单勾选完整 |
| API 错误形状全面收敛 | 部分新接口尚未统一 4xx/5xx 或 200+ok:false | 新增/修改接口时遵循 api_error_convention | 新接口无遗漏 |
| a11y/i18n 扫尾 | 个别加载/错误/空状态仍硬编码 | 按 a11y_checklist 与 i18n 覆盖扫尾 | 关键路径无硬编码 |

### P3（可选/排期）

| 标题 | 现状简述 | 建议改动方向 | 验收标准 |
|------|----------|--------------|----------|
| 代码执行沙箱 | 当前直接执行 | 仅限受信环境部署说明；沙箱方案单独设计 | 文档明确 |
| 多模态增强 | 部分支持 | 图片/表格/图表能力排期 | 产品排期 |
| 可观测性统计 | LangSmith 已接 | 性能/使用统计低优先级 | 按需 |

---

## 四、阶段 4：优先级与落地顺序

### 4.1 实施顺序建议

1. **本轮建议完成**：P1 中「前端关键路径静默 catch 收敛」中 1–2 处高可见（如工作区根加载、档案加载失败）补 toast；确认 P1 可靠性 SLO 与 check-reliability-slo 已按文档执行。
2. **下一迭代**：P1 其余静默 catch 分批收敛；P2 UI 门禁与 API 形状在每次发布前例行检查。
3. **持续**：P2 a11y/i18n 扫尾随需求做；P3 沙箱/多模态为排期项。

### 4.2 与 CI/门禁衔接

- **已有**：`make test-backend-core-regression`、`check-board-contract`、`check-reliability-slo`/`check-reliability-slo-strict`、`release-readiness-strict` 含上述部分；P1 可靠性见 [p1_reliability_improvement_backlog_2026-03-02.md](p1_reliability_improvement_backlog_2026-03-02.md)。
- **需人工/清单**：UI_RELEASE_QUALITY_GATE 五类门禁、发布前「自动化证据+人工签字+风险说明」三件套（见 release_checklist、P1-04）。
- **可选新增**：若需自动化前端「加载失败可感知」的回归，可加 E2E 或手工用例清单。

---

## 五、产出物索引

- **契约符合性**：见本文第一节。
- **差距与风险**：见本文第二节（含 Bugs/健壮性、体验/一致性、产品对齐、国际能力差距）。
- **改进清单**：见本文第三节（P0–P3）；与 [bugs_and_product_alignment_backlog.md](bugs_and_product_alignment_backlog.md) 合并维护。
- **落地顺序**：见本文第四节；与 [release_checklist.md](release_checklist.md)、[p1_reliability_improvement_backlog_2026-03-02.md](p1_reliability_improvement_backlog_2026-03-02.md) 衔接。
