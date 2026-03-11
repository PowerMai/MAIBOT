# 发布前 Checklist（Claude/Cowork 对齐优化）

适用范围：`Claude 对齐深度清理与能力闭合优化` 这一轮改动。

## 值班 SOP 速查

- 日常巡检（非阻断）：`bash scripts/ops_daily_check.sh --snapshot --watcher`
- 发布巡检（阻断）：`bash scripts/ops_daily_check.sh --snapshot --strict-watcher`
- 发布窗口（含执行可靠性强校验）：`bash scripts/ops_daily_check.sh --snapshot --strict-watcher --strict-reliability-e2e`
- 失败告警：配置 `OPS_WEBHOOK_URL`（CI 使用 `OPS_DAILY_WEBHOOK_URL` secret 注入）
- 前端入口：`WorkspaceDashboard` -> 最近巡检结果 -> 查看门禁详情
- 快速同步：门禁详情支持“一键复制文本摘要 / Markdown 摘要”

## 1. 代码与配置完整性

- [ ] `plugins/bidding/`、`plugins/bid_agent/` 已删除且无残留引用。
- [x] `backend/config/agent_profile.json` 中 `active_role_id=default`、`skill_profile=general`。
- [x] `backend/config/autonomous_tasks.json` 不再包含 `knowledge_engineer` / `engineer` 旧 `role_id`。
- [x] `.module-boundary.json` 已将 `plugins/bidding/` 替换为 `plugins/sales/`。
- [x] `backend/config/skills_market.json` 中 `domain=bidding` 已替换为 `sales`。
- [x] `knowledge_base/learned/*` 中旧 `marketing/bidding` 路径已替换为 `plugins/sales/skills/*`。

## 2. 前端一致性

- [x] `roleIdentity.ts` 中旧别名均归一到 `default`。
- [x] `cursor-style-composer.tsx` 的 `SkillProfileId` 已移除废弃值（`bidding/contract/knowledge/knowledge_engineering`）。
- [x] `MyRuntimeProvider.tsx` 的 `VALID_SKILL_PROFILES` 与后端 profile 语义一致。
- [x] `cursor-style-composer.tsx` 已移除 `DEBUG_PRIMARY_ROLE_IDS` 旧角色分支。
- [x] `WorkspaceDashboard.tsx` 用例示例中无硬编码“招标分析/合同审查”。

## 3. 插件命令闭环

- [x] `GET /plugins/commands` 可返回已激活插件命令。
- [x] `POST /slash/execute` 对内置命令仍正常（`/plan /debug /review /research /plugins /install /memory`）。
- [x] `POST /slash/execute` 对插件命令可 fallback（示例：`/bid-review`）。
- [x] `systemApi.ts` 已包含 `listPluginCommands()` 与 `executeSlashCommand()`。
- [x] Composer slash 建议可动态展示插件命令。

## 4. Registry 与发现链路

- [x] `plugin_registry.py` 已修复缓存 spec `source_path` 指向（可解析本地 manifest）。
- [x] `plugin_loader.get_active_commands()` 能正确读取真实插件目录下的 `commands/*.md`。
- [x] `/plugins/sync` 后，`/plugins/list` 可见 `remote_version`/`update_available` 字段。

## 5. 接口回归（必测）

- [x] `GET /plugins/list` -> 200
- [x] `GET /plugins/commands` -> 200
- [x] `POST /slash/execute` + `/plan xxx` -> `switch_mode`
- [x] `POST /slash/execute` + `/plugins` -> `plugins_list`
- [x] `POST /slash/execute` + `/install sales` -> `plugins_install`
- [x] `POST /slash/execute` + `/bid-review xxx` -> `rewrite_prompt` 且 `source=plugin_command`
- [x] `POST /slash/execute` + `/unknown-cmd` -> 404（预期）
- [x] `backend/scripts/test_single_agent_api_acceptance.py` 通过（覆盖 blocked/artifacts/human-review/metrics）。
- [x] `backend/scripts/test_task_status_projection_e2e.py` 通过（状态投影字段写入一致）。
- [x] `backend/scripts/test_task_status_projection_guard_off_e2e.py` 通过（灰度关闭时不写 `status_projection_*`）。
- [x] `backend/scripts/test_task_execution_reliability_e2e.py` 通过（恢复/去重幂等/跨任务隔离）。
- [x] `backend/scripts/check_task_status_wiring.py` 通过（关键状态写路径接入统一入口守卫）。
- [x] `backend/scripts/collect_task_status_projection_evidence.py` 通过（聚合 `on/off + wiring` 证据）。
- [x] `TASK_STATUS_STRICT_WRITE=true backend/scripts/test_task_status_projection_e2e.py` 通过（strict 模式禁用 fallback 仍可跑通）。
- [x] `TASK_STATUS_AUTHORITY=board` 作为外部状态真源（`thread` 仅做投影与冲突告警）。
- [x] `backend/scripts/plugin_runtime_compat_smoke.py` 通过（覆盖度告警作为改进信号，不阻断；实际不一致由错误项阻断）。
- [x] 回归脚本创建任务使用 `source_channel=test`（避免污染生产 SLO 统计口径）。

## 6. UI 验收（必测）

- [x] 输入 `/` 可见内置 slash 建议。
- [x] 输入 `/bid` 可见 `/bid-review`。
- [x] Dashboard “快捷任务”无“合同审查”与“招标*”残留卡片。
- [x] Dashboard 一键填充动作可把提示词写入输入框。
- [x] Dashboard “最近巡检结果”卡片可显示 `profile_gate_status/overall_status/更新时间`。
- [x] Dashboard “查看门禁详情”弹层可展示 `blocking_reasons` 与关键 `evidence` 状态。
- [x] Dashboard 门禁详情支持“一键复制文本摘要 / Markdown 摘要”双入口。
- [ ] 会话级插件开关只影响当前线程，不污染其他线程（必验：`pnpm --dir frontend/desktop check:session-state` + `docs/manual_session_plugin_isolation_5min.md` 人工签字）。

## 7. 质量门

- [x] 前端改动文件 lint 通过。
- [x] `pnpm --dir frontend/desktop check:session-state` 通过（会话/模式写入收敛守卫）。
- [x] `pnpm --dir frontend/desktop check:slash-mode` 通过（slash 模式切换当次生效 + 命令分支可达性守卫）。
- [x] `pnpm --dir frontend/desktop check:task-entry` 通过（任务主入口与编辑区联动一致性）。
- [x] `pnpm --dir frontend/desktop check:editor-keys` 通过（编辑区快捷键行为链路守卫）。
- [x] `pnpm --dir frontend/desktop check:command-palette` 通过（命令面板入口可达性守卫）。
- [x] `make check-task-status-wiring` 通过（状态写入口防回退守卫）。
- [x] 后端改动文件 `py_compile` 通过。
- [x] `make test-single-agent-api` 可执行并通过（单体阶段后端接口关键路径）。
- [x] `make test-backend-core-regression` 通过（含 `test_task_bidding_status_projection.py`）。
- [x] `make test-task-execution-reliability-e2e` 通过（`dedup_first=false`、`dedup_second=true`、`isolation_ok=true`）。
- [x] `make check-reliability-slo-strict` 口径稳定（已排除 `source_channel in {test,script,ci}`）。
- [x] `make build-unified-observability-snapshot` 通过（统一观测快照可生成）。
- [x] `make build-knowledge-pipeline-snapshot` 通过（知识链路四象限快照可生成）。
- [x] `make build-memory-scope-contract-report` 通过（记忆作用域契约报告可生成）。
- [x] `make build-memory-quality-report` 通过（记忆质量报告可生成）。
- [x] `make build-memory-quality-trend-report` 通过（记忆质量趋势与回退预警可生成）。
- [x] `make skills-semantic-gate` 通过（skills 语义一致性门可生成告警/通过信号）。
- [x] `make plugin-command-conflict-gate` 通过（插件命令同名冲突与定向解析确定性可观测）。
- [x] `make knowledge-source-compliance-gate` 通过（知识来源合规：公有来源/证据完整性/白名单可观测，不触碰私有本体）。
- [x] `make build-parity-scorecard` 通过（Claude/Cowork/Cursor 对标评分卡可生成）。
- [x] `make build-parity-trend-report` 通过（对标评分趋势与回退预警可生成）。
- [x] `backend/scripts/check_ci_release_gates.py` 已纳入知识链路快照校验（`ingest/index/search/ontology`）。
- [ ] 无新增高优先级告警（运行时异常、接口 5xx、关键日志报错）。

## 8. 发布与回滚

### 发布步骤

- [ ] 代码门：契约守卫与构建全通过（前端 4 类 check + 后端 contract check）。
- [ ] 链路门：`test_single_agent_api_acceptance.py` 与关键手工回归通过。
- [ ] 运营门：人工签字 + `/plugins/sync` 外网连通性验证完成。
- [ ] 先部署后端（保证 `/plugins/commands` 与 `/slash/execute` 新语义可用）。
- [ ] 再部署前端（启用动态插件命令建议与 slash fallback 调用）。
- [ ] 执行“接口回归 + UI 验收”全套检查并附验收证据。

### 回滚策略

- [ ] 若插件命令链路异常，优先回滚前端 `executeSlashCommand` 调用逻辑，保留旧本地 slash 扩展。
- [ ] 若后端 slash fallback 异常，回滚 `/slash/execute` 新增插件命令分支。
- [ ] 若 Dashboard 建议异常，回滚 `/suggestions/work` 新推荐模板。

## 9. 上线后观察（24h）

- [ ] 观察 `/slash/execute` 4xx/5xx 比例。
- [ ] 观察插件命令命中率与失败率（`source=plugin_command`）。
- [ ] 观察 Dashboard 建议点击率与任务转化率。
- [ ] 若启用巡检告警，确认 `OPS_WEBHOOK_URL` 已配置且失败场景能收到告警（可在预发布环境演练一次）。
- [ ] 收集命令冲突反馈（同名 command）并评估命名规范约束。
- [ ] 灰度窗口开始前执行 `POST /autonomous/watcher/observability/reset`，并在窗口结束后复核 `runtime.invites_observability` 的 fallback 比例是否异常升高。
- [ ] 按 `docs/manual_watcher_invites_observability_5min.md` 完成一次 5 分钟巡检并归档证据。

推荐值班命令（可直接复制）：

```bash
# 最小巡检（非阻断，适合日常值班）
bash scripts/ops_daily_check.sh --snapshot --watcher

# 阻断巡检（严格阈值，适合发布窗口/预发布演练）
bash scripts/ops_daily_check.sh --snapshot --strict-watcher

# 发布窗口（额外强制“继续不重跑”可靠性 E2E）
bash scripts/ops_daily_check.sh --snapshot --strict-watcher --strict-reliability-e2e
```

## 10. 标准模板与清理计划

- [ ] 使用 `docs/templates/release_signoff_template.md` 完成发布签字。
- [ ] 使用 `docs/templates/rollback_runbook_template.md` 维护回滚方案。
- [ ] 发生故障时使用 `docs/templates/incident_postmortem_template.md` 完成复盘。
- [ ] 执行 `backend/scripts/scan_legacy_bidding_terms.py` 并附扫描报告。
- [ ] 按 `docs/legacy_bidding_semantic_cleanup_plan_2026-03-02.md` 更新语义清理进展。
- [ ] 依据 `docs/p1_reliability_improvement_backlog_2026-03-02.md` 跟踪 P1 指标收敛。
- [ ] 使用 `release-readiness` 的 `release_profile` 预设控制阻断策略（`staging`/`production`）。
- [ ] strict 门禁固定执行（SLO/legacy/task_status_write/signoff），不再允许手工覆盖。
- [ ] 下载并归档 `release-readiness-artifacts`（含 `task_status_projection_report.json`、`task_status_projection_guard_off_report.json`、`task_execution_reliability_e2e_report.json`、`task_status_projection_evidence.json`、`slo_tightening_guard_report.json`）。
- [ ] 生成并归档 `backend/data/release_gate_summary.json`（作为签字单统一引用）。
- [ ] 生成并归档 `backend/data/release_signoff_report.json`（运营门签字机器校验结果）。
- [ ] 在正式发布前完成一次“预发布 -> 正式发布”演练并归档记录（见 `docs/release_drill_report_2026-03-02.md`）。

### release-readiness 触发参数模板（可直接复用）

- **staging**：`release_profile=staging`（strict 门禁固定执行）
- **production**：`release_profile=production`（strict 门禁固定执行）

CLI 示例（需安装并登录 GitHub CLI）：

```bash
gh workflow run ci.yml \
  -f release_profile=staging

gh workflow run ci.yml \
  -f release_profile=production
```

脚本化触发（推荐）：

```bash
./scripts/release_run.sh staging
./scripts/release_run.sh production
./scripts/release_run.sh production --dry-run
```

说明：非 `--dry-run` 模式下，脚本会先执行本地快照 `make release-postcheck`，再尝试等待最新 workflow_dispatch run 完成并下载 `release-readiness-artifacts`，输出远端后置核查 `backend/data/release_postcheck_remote_report.json`（远端下载失败仅告警）。

触发后快速核对（与脚本输出一致）：

```bash
make release-postcheck
jq '.overall_status,.profile_gate_status' backend/data/release_gate_summary.json
rg 'slo_tightening_guard|profile_gate_status' docs/release_drill_report_$(date +%Y-%m-%d).md
jq '.status,.failures' backend/data/slo_tightening_guard_report.json
```

## 验收备注（2026-03-02）

- `plugins/bidding`/`plugins/bid_agent` 目录已删除，但仓库文档与知识资产中仍存在“bidding”历史语义引用；该项按“无残留引用”标准暂不打勾。
- 会话级插件隔离在自动化 UI 中未能稳定完成“跨线程切换-回切”闭环（线程切换按钮可见性/点击拦截），建议人工补测该项后再打勾。
- `/plugins/sync` 链路已通过（200 + `/plugins/list` 含 `remote_version/update_available` 字段）；但外部 `https://plugins.anthropic.com/manifest.json` 在当前环境出现 SSL EOF，导致本次同步计数为 0，建议在可联网生产环境复测远端源可用性。
- 自动化补证：
  - `pnpm --dir frontend/desktop check:session-state` -> 通过（会话/模式写入收敛）。
  - `pnpm --dir frontend/desktop check:single-agent` -> 通过（单体 Agent 关键链路就绪）。
