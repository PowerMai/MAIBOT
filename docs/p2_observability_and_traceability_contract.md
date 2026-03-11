# P2 可观测与知识可追溯约定

与「对齐顶层设计与国际大厂持续分析」方案中 P2 项对应的实现约定与入口，便于后续扩展统一观测面板与知识治理。

## 1. 观测入口与指标

| 用途 | 入口 | 说明 |
|------|------|------|
| 任务/看板可靠性 | `GET /board/metrics/reliability` | 含 success_rate、blocked_recovery_rate、deliverable_effective_rate、status_projection_* 等 |
| 统一观测快照 | `backend/data/unified_observability_snapshot.json` | release、reliability_slo、task_status_projection、ui_stream、ecosystem 等 |
| 执行前能力卡（最小集） | 流事件 `session_context` + configurable | 当前 threadId、mode、roleId；扩展时可含 model、tier、parallel_level、plan 状态 |

扩展为「统一 trace/task/session/mode/tool 面板」时，以前端观测页 + systemApi 聚合 + 上述接口为准。

### 1.1 可靠性 SLO 落地（P1）

- **指标来源**：`GET /board/metrics/reliability`（scope=personal，window_hours=72），返回 `metrics.success_rate`、`metrics.blocked_recovery_rate`、`metrics.deliverable_effective_rate` 等。
- **目标与节奏**：见 [P1 可靠性改进清单](p1_reliability_improvement_backlog_2026-03-02.md)（success_rate/blocked_recovery_rate/deliverable_effective_rate 分周目标与证据要求）。
- **检查入口**：`make check-reliability-slo`（告警不阻断）、`make check-reliability-slo-strict`（不达标则 exit 1）；阈值见 `backend/scripts/check_reliability_slo.py` 及可选 `backend/data/reliability_slo_thresholds.json`。
- **历史样本**：`backend/data/reliability_slo_history.jsonl`；统一快照中 `reliability_slo` 段与上述指标一致。

## 2. 兼容矩阵与 CI

- **插件**：`make plugins-compat-smoke`、`make plugin-runtime-compat-smoke`、`make plugin-command-conflict-gate`
- **Skills**：`make skills-compat-smoke`、`make skills-semantic-gate`
- **后端核心回归**：`make test-backend-core-regression` 含 Plan 确认路由（test_plan_confirmation_routing）、accept-bid 并发与 blocked 单源（test_accept_bid_concurrency）
- **兼容矩阵文档**：`docs/ecosystem_compatibility_matrix_*.md`，与 release_gate_summary / unified_observability_snapshot 一致

增加会话流或 Plan 回归用例时，纳入上述 Make 目标或 backend/tests，并更新本段。

## 3. 知识来源可追溯（P2-3）

知识库与 kb 工具链产出建议携带可追溯字段，供治理与审计：

- **source_url**：条目或检索结果的来源 URL 或路径
- **evidence**：引用片段或原文摘要，便于核对
- **confidence**：置信度或相关度（0–1），便于过滤与排序

实现时在 knowledge_base 流程、search_knowledge 返回结构及 ontology/ingest 元数据中预留或写入上述字段，前端/观测可据此展示来源与可信度。

## 4. API 业务错误响应形状（200 + 错误）

部分接口在异常时返回 **HTTP 200** 且 body 为业务错误，与 4xx/5xx 的 `{"detail": "..."}` 并存，便于前端统一解析：

- **约定**：200 业务错误体应包含 **`"ok": false`** 与 **`"error": "<message>"`**；成功时可选 `"ok": true` 或省略。
- **示例**：`GET /system/info` 在 psutil 未安装时返回 `{"ok": false, "error": "psutil not installed", ...}`；`/status` 子对象（如 index/search）失败时为 `{"ok": false, "error": "...", ...}` 并保留其它字段默认值以兼容调用方。
- **4xx/5xx**：仍由全局处理器统一返回 `{"detail": "..."}`。
