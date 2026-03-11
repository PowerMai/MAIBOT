# Claude/Cowork/Cursor 兼容改造执行清单（2026-03-02）

## 目标

- 将当前“高一致 + 部分兼容”推进到“可对外宣称的高兼容稳定态”。
- 以最小风险路径补齐关键差距：先一致性真源，再插件生态闭环，再观测与 CI 规模化。

## 里程碑

| 里程碑 | 时间窗 | 目标结果 |
| --- | --- | --- |
| M1 | 1-2 周 | 任务状态单一真源与 Plan 语义收敛，消除伪兼容风险。 |
| M2 | 2-4 周 | 插件/skills 生态关键闭环（安装升级、manifest 强校验、执行面打通）。 |
| M3 | 4-6 周 | 统一观测与兼容矩阵 CI，形成可持续兼容保障。 |

## P0（必须先做）

| 编号 | 任务 | 主要改动位置 | 预估工期 | 验收标准 | 风险/依赖 |
| --- | --- | --- | --- | --- | --- |
| P0-1 | 任务状态单一真源（Task=Thread 或 Board 单源） | `backend/engine/tasks/task_service.py`、`backend/api/app.py`、`backend/engine/tasks/task_watcher.py`、`backend/engine/tasks/task_bidding.py` | 4-6 天 | 同一任务在 `/tasks`、`/board/tasks`、执行日志三处状态一致；无状态倒退。 | 需迁移双轨同步逻辑，建议先灰度开关。 |
| P0-2 | Plan 确认语义收敛（去文本启发式） | `backend/engine/core/main_graph.py`、`backend/engine/middleware/mode_permission_middleware.py`、前端 Plan 触发路径 | 2-3 天 | 仅 `plan_confirmed=true` 执行；回归用例覆盖“未确认不执行”。 | 依赖前端确认字段稳定传递。 |
| P0-3 | 后端会话事件协议补齐 | `backend/api/app.py`（事件发布点）、前端事件消费统一层 | 3-4 天 | 切线程/切模式/切角色跨窗口一致；事件可追踪。 | 需与现有 CustomEvent 兼容迁移。 |

## P1（兼容能力补齐）

| 编号 | 任务 | 主要改动位置 | 预估工期 | 验收标准 | 风险/依赖 |
| --- | --- | --- | --- | --- | --- |
| P1-1 | 插件 manifest 强校验（Schema + 版本门禁） | `backend/engine/plugins/spec.py`、`backend/engine/plugins/plugin_loader.py` | 3-4 天 | 非法 manifest 安装失败且给出明确错误；`min_version` 可硬拦截。 | 会暴露历史插件不规范项。 |
| P1-2 | 安装/升级/回滚闭环（下载-校验-原子切换） | `backend/engine/plugins/plugin_registry.py`、`backend/api/app.py`、前端插件管理入口 | 5-7 天 | `/plugins/install`、`/plugins/sync`、`/plugins/update` 可回放；失败可回滚；版本可追踪。 | 需定义签名/哈希策略与可信源。 |
| P1-3 | plugin agents/hooks/.mcp.json 执行面打通 | `backend/engine/plugins/plugin_loader.py`、`backend/tools/mcp/mcp_tools.py`、运行时注入链 | 5-8 天 | 插件声明的 agent/hook/mcp 可实际执行并可观测。 | 权限沙箱与副作用边界需先定。 |
| P1-4 | skills 统一索引（注入可用=管理可见） | `backend/engine/skills/skill_registry.py`、`backend/tools/skills_tool.py` | 2-3 天 | `list_skills/match_skills` 与运行时可用 skills 一致。 | 可能影响匹配排序与推荐结果。 |

## P2（稳定性与规模化）

| 编号 | 任务 | 主要改动位置 | 预估工期 | 验收标准 | 风险/依赖 |
| --- | --- | --- | --- | --- | --- |
| P2-1 | 统一观测面板（trace/task/session/mode/tool） | 前端观测页、`systemApi` 指标聚合接口、后端指标上报点 | 4-6 天 | 单页可定位 90% 兼容链路问题。 | 埋点规范需要统一。 |
| P2-2 | 兼容矩阵 CI（插件+skills 回放） | `.github/workflows/ci.yml`、`backend/scripts/*_e2e.py`、前端 check 脚本 | 3-5 天 | PR 自动输出兼容通过率与失败项。 | CI 时长上升，需要分层运行。 |
| P2-3 | 知识来源治理与可追溯策略 | `knowledge_base` 流程文档、`kb` 工具链、配置模板 | 2-4 天 | 每条关键知识具备 `source_url/evidence/confidence`。 | 需要业务侧定义可信来源白名单。 |

## 发布门禁建议（新增/强化）

- 必须通过：
  - `npm run release:check`
  - `pnpm --dir frontend/desktop check:session-state`
  - `uv run python backend/scripts/test_full_business_acceptance.py`
- 新增建议：
  - `plugins-compat:smoke`（验证 manifest、命令发现、安装升级最小闭环）
  - `skills-compat:smoke`（验证 list/match 与运行时可用一致）

## 对外口径（阶段性）

- 当前阶段（M1 前）：
  - “核心工作流与 Claude/Cowork/Cursor 高度一致，生态高级兼容能力持续完善中。”
- M2 完成后：
  - “插件与 skills 兼容闭环已建立，具备稳定升级与回滚能力。”
- M3 完成后：
  - “形成可持续兼容治理体系（观测 + CI 矩阵 + 来源治理）。”

## 当日进度更新（2026-03-02）

- 已完成（可视为 M2 关键前置）：
  - `plugins-compat:smoke` 已落地并接入 CI（backend-tests + release-readiness）。
  - `skills-compat:smoke` 已落地并接入 CI（backend-tests + release-readiness）。
  - 全量插件 manifest 已补齐最小 `compatibility` 与 `components` 字段，`check_plugin_manifest_compat` warnings 清零。
  - 插件源同步增强：`plugin_registry` 增加重试、源健康统计输出与缓存文件。
  - `/suggestions/work` 增加最小缓存与扫描上限，降低大工作区响应抖动风险。
- 仍待推进（执行计划原项）：
  - P0-1 任务状态单一真源（Task/Board 双轨治理）。
  - P1-2 安装/升级/回滚全闭环（签名/哈希、原子切换、回滚策略）。
  - P1-3 plugin agents/hooks/.mcp.json 运行时执行面打通。

## 继续（2026-03-02 后续）

- **季度对齐规划**已全部完成：统一会话总线（跨窗口 session/role/chat_mode）、知识摄入语义统一（上传后增量建索引）、API 边界拆分（workspace-auto-index / knowledge-ops）、知识管道观测四象限与快照、检索结果来源与「打开来源会话」体验。
- **本次验证**：`test-backend-core-regression` 通过（29 passed）、`plugins-compat-smoke` / `skills-compat-smoke` 通过、`check_ci_release_gates` 通过、`build-knowledge-pipeline-snapshot` 成功、前端知识库契约测试（test-tender-contract.mjs）通过。
- **建议下一优先级**：P0-1（任务状态单一真源）或 P0-2（Plan 确认语义收敛，当前已由图级 `plan_confirmed` 控制，可做回归加固）。

## 下一阶段执行规划

详细范围、优先级与验收标准见 **[下一阶段执行规划（2026-03-02）](next_phase_execution_plan_2026-03-02.md)**。摘要：

- **阶段一（M1 收尾）**：P0-1 任务状态单一真源 → P0-2 Plan 确认语义收敛 → P0-3 后端会话事件协议（可选）。
- **阶段二（M2）**：P1-2 安装/升级/回滚闭环 → P1-3 执行面打通 → P1-4 skills 统一索引（P1-1 已部分完成）。
- **阶段三（M3）**：P2-1 统一观测面板、P2-2 兼容矩阵 CI、P2-3 知识来源治理，与现有 `release-readiness`、`ops_daily_check`、`build-knowledge-pipeline-snapshot` 整合。
