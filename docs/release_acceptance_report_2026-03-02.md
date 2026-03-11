# 发布验收报告（2026-03-02）

## 结论

- 核心目标“Claude 对齐深度清理 + 能力闭合”已完成。
- 自动化回归通过，接口与 UI 关键路径可用。
- 当前发布门禁已通过；剩余 2 项为发布后持续治理：会话级插件跨线程隔离人工签字、生产网络下插件源连通性复验。

## 自动化结果

- 前端收敛检查：
  - `pnpm --dir frontend/desktop check:session-state` -> PASS
  - `pnpm --dir frontend/desktop check:single-agent` -> PASS
  - `pnpm --dir frontend/desktop check:slash-mode` -> PASS
  - `pnpm --dir frontend/desktop check:role-mode-contract` -> PASS
  - `pnpm --dir frontend/desktop check:session-flow` -> PASS
- 后端接口回归：
  - `/plugins/list`、`/plugins/commands`、`/slash/execute`（内置 + 插件命令）-> PASS
  - `backend/scripts/test_single_agent_api_acceptance.py` -> PASS
  - `backend/scripts/test_task_status_projection_e2e.py` -> PASS
  - `backend/scripts/test_task_status_projection_guard_off_e2e.py` -> PASS（灰度关闭时不写 `status_projection_*`）
  - `backend/scripts/collect_task_status_projection_evidence.py` -> PASS（统一聚合 `on/off + wiring`）
  - `TASK_STATUS_STRICT_WRITE=true backend/scripts/test_task_status_projection_e2e.py` -> PASS（strict 模式禁用 fallback）
  - `backend/scripts/plugin_runtime_compat_smoke.py` -> PASS（执行面检查通过：已加载插件声明并验证 agents/hooks/mcp）
  - `accept-bid` / `human-review` / `blocked` / `relay` / `task_board_tools` / `knowledge_api` 已接入统一状态写入口（`project_board_task_status`）并完成投影字段回归 -> PASS
  - `backend/scripts/check_task_status_wiring.py` -> PASS（关键写路径静态守卫）
  - `STRICT_RATE_LIMIT_CHECK=true make test-single-agent-api` -> PASS（CI/release 门禁启用严格校验）
  - `make plugins-compat-smoke` -> PASS（manifest warnings 已清零）
  - `make skills-compat-smoke` -> PASS（skills API 与 registry 一致）
- 质量门：
  - 前端契约检查 + 构建（`check:*` + `pnpm build`）-> PASS
  - 后端关键文件 `py_compile`（本地收口）-> PASS
  - `backend/scripts/build_release_gate_summary.py` -> PASS（统一发布证据摘要）
  - `make test-backend-core-regression` -> PASS（含 `test_task_bidding_status_projection.py`）
  - `backend/tests/test_task_watcher_schedule.py` -> PASS（11 passed，包含 invites 批量读取与观测重置校验）

## UI 验收摘要

- Slash 建议：内置命令可见 -> PASS
- 插件命令 `/bid-review` 可见且可执行 -> PASS
- Dashboard 快捷任务已清理“合同审查/招标*”残留 -> PASS
- Dashboard 填充输入框动作 -> PASS
- Dashboard 已新增“最近巡检结果”卡片与“查看门禁详情”弹层（只读）-> PASS
- Dashboard 门禁详情支持“一键复制文本摘要 / Markdown 摘要”双入口 -> PASS
- 会话插件隔离跨线程验证 -> PENDING（需人工补测）

## 风险与备注

- `/plugins/sync` 在当前环境调用官方源出现 SSL EOF，导致本地同步计数为 0；本地链路可用，建议在生产网络环境复验官方源可达性。
- 仓库文档/知识资产中仍有历史 `bidding` 文案引用，不影响运行链路，但不满足“全仓无历史语义”的严格标准。
- 可靠性 SLO 检查已接入：是否放行以 `backend/data/release_gate_summary.json` 的 `profile_gate_status` 为准；当前按 strict 执行时如未达阈值会阻断发布。
- 已新增 `backend/scripts/check_slo_tightening_guard.py`（`make check-slo-tightening-ready`）用于阈值上调前自动守卫；当前样本尚未满足直接收紧到 `0.30` 的条件。
- API 限流一致性门已接入：CI/release 门禁启用 `STRICT_RATE_LIMIT_CHECK=true`，若 `slowapi` 未生效将直接失败；本地默认仅告警。
- P0-1 第四阶段已收口：`board_update_task`、`task_watcher`、`accept-bid`、`human-review`、`blocked`、`task_relay`、`task_board_tools`、`knowledge_api` 均已串到统一投影入口；状态来源可追溯到 `status_projection_source`。
- 已新增 `TASK_STATUS_STRICT_WRITE` 开关：开启时 watcher 的状态回写 fallback 会被禁用，便于在预发布环境做“纯统一入口”一致性压测。
- `release-readiness` 已固定 strict 任务状态写模式（不再开放手工覆盖）。
- 已在 `docs/release-readiness-checklist_2026-03-02.md` 增加 release-readiness 参数模板与 `gh workflow run` 示例，支持 staging/production 一键触发。
- 运营签字门已机器化：新增 `backend/scripts/check_release_signoff.py`，并在 `release-readiness` 固定 strict 执行。
- 发布摘要已可解释阻断：`backend/scripts/build_release_gate_summary.py` 增加 `release_profile` 与 `blocking_reasons` 字段。
- 发布摘要已对齐证据聚合：优先读取 `task_status_projection_evidence.json`，并按 `release_profile` 匹配同环境 SLO 快照。
- 已补充“预发布 -> 正式发布”演练模板：`docs/release_drill_report_2026-03-02.md`。
- 已新增 `scripts/release_run.sh`，封装 `release-readiness` 触发参数，降低人工触发配置错误风险。
- `task_watcher` 已接入 invites 读路径运行时观测：`scan_search_calls/scan_fallback_calls/scan_*_rows` 与处理结果计数（`ignored/skipped/invalid/bid_submitted/bid_failed`），可通过 `/autonomous/watcher/config` 的 `runtime.invites_observability` 直接查看优化命中效果。
- 已新增 `POST /autonomous/watcher/observability/reset`，支持灰度前清零 invites 观测计数；设置页“自治巡检（Task Watcher）”卡片已提供“重置观测”按钮用于批次化观测。
- 已新增 `scripts/watcher_observability_check.sh` 与 `make check-watcher-observability`，用于灰度窗口一键执行“reset -> 等待 -> 快照 -> fallback 比例”观测闭环。
- watcher 观测脚本已支持 `--strict` 阈值模式（`min_search_calls` / `max_fallback_ratio` / `max_loop_errors`），并提供 `make check-watcher-observability-strict` 作为阻断式巡检入口。
- 发布演练报告已支持自动读取 `backend/data/watcher_observability_snapshot.json` 并展示 watcher 指标（缺失时按“非阻断”提示）。
- 发布演练稳定化已落地：`release_drill.py` 对任务状态投影脚本默认注入 `TASK_WATCHER_ENABLED=false`、`FASTAPI_LIFESPAN_MINIMAL=true`、`BOARD_CREATE_TASK_AUTO_DISPATCH=false`，降低无关后台链路对验收结果的干扰。
- 可靠性口径已稳定化：`/board/metrics/reliability` 默认排除 `source_channel in {test,script,ci}`，避免演练样本导致 strict SLO 门禁抖动。
- 可靠性门禁已新增 blocked 样本门槛：当 `blocked_total` 低于环境阈值（`dev=5/staging=15/production=50`）时，`blocked_recovery_rate` 仅记录 `notes` 不参与 strict 失败判定，减少低样本抖动误阻断。

## 发布建议

- 可进入正式发布窗口（当前门禁与证据满足放行条件）。
- 发布后持续治理请完成：
  1. `docs/manual_session_plugin_isolation_5min.md` 的人工补测并签字；
  2. 生产网络环境执行一次 `/plugins/sync` 远端连通性验证。
  3. 按 `docs/single_agent_consistency_audit_2026-03-02.md` 完成 P1 缺口收口。
  4. 按 `docs/manual_watcher_invites_observability_5min.md` 完成一次灰度窗口观测记录。

## 全面体检收口补记（2026-03-02）

- 已完成零重复开发收口：后端状态迁移统一入口、前端 plan_confirmation 结构化决策、release summary 证据聚合语义对齐。
- 最新签字结论见 `docs/full_system_audit_signoff_2026-03-02.md`。
- 当前 strict 发布门禁已通过（`profile_gate_status=pass`），阻断项清零。
- 上线后持续观察请参考：`docs/ops_observability_checklist_2026-03-02.md`（6 项核心指标 + 每日命令）。
- 已接入 CI 每日自动巡检（`ops-daily-check`），自动产出并归档 SLO/投影/release summary 证据。
- 补充完成：前端模式契约不再裁剪 `debug/review`（仅动态推荐第4模式），并在后端新增角色-模式运行时硬校验，消除“仅前端约束”风险。
- 补充完成：`/plan|/debug|/review` 优先走 `/slash/execute` 单通道，`check:slash-mode` 已增加单通道守卫。
- 补充完成：`maibot_workspace_path` 读写统一窗口级优先（safeStorage），降低多窗口工作区串扰风险。
- 补充完成：本地执行 `backend/.venv/bin/python backend/scripts/release_drill.py --release-profile staging --strict-required`，所有步骤 PASS（含 task_status_projection、board_contract、plugins/skills compat、SLO strict、legacy strict、signoff strict、summary/report 生成）。
- 最新 gate 结论：`backend/data/release_gate_summary.json` 显示 `overall_status=pass`、`profile_gate_status=pass`，可进入发布。
- 补充修复：`scripts/watcher_observability_check.sh` 的 `strict_evaluate` 函数嵌套错误已修正，`bash -n` 语法检查通过；`make check-watcher-observability-strict` 在当前机器因后端未启动（127.0.0.1:8000 不可达）未执行到指标判定阶段。
- 补充收口：watcher 观测链路已闭环通过（`strict_status=pass`）。修复项包括：`watcher_observability_check.sh` 默认基址改为 `LANGGRAPH_API_URL(默认 127.0.0.1:2024)`、新增后端就绪等待与 reset 解析修正；`backend/api/app.py` 为内置自治任务注册增加启动超时保护（避免 `TASK_WATCHER_ENABLED=true` 阻塞端口监听）；`backend/engine/tasks/task_watcher.py` 增加无 `list/get` store 的 search-only 回退兼容（修复 `SqliteStore has no attribute list` 与 `loop_errors`）。
- 补充优化：`scripts/ops_daily_check.sh` 已支持 `--watcher` / `--strict-watcher`，并新增 `make ops-daily-check-watcher`、`make ops-daily-check-strict-watcher`，用于日常巡检一键切换“告警模式/阻断模式”。
- 补充优化：`ops_daily_check --snapshot` 已支持把 watcher 指标写入每日 markdown 快照（`fallback_ratio/loop_errors/search_calls`），便于值班快速复盘。
- 补充优化：`ops_daily_check --snapshot` 已新增 watcher 严格阈值结论（`strict_threshold_status` + `strict_threshold_violations`），值班可一眼判断是否升级处理。
- 补充优化：`WorkspaceDashboard` 已支持查看最近门禁摘要与 evidence 状态，并可复制文本摘要/Markdown 摘要直接贴入 IM 或验收文档，减少人工抄录误差。
