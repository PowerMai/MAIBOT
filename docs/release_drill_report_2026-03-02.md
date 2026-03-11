# 发布演练报告（自动生成）

- 生成时间（UTC）：`2026-03-02T09:35:46.283386+00:00`
- 发布档位：`staging`
- `overall_status`：`warn`
- `profile_gate_status`：`pass`

## 关键证据状态

- ✅ `reliability_slo`: `pass`
- ✅ `legacy_semantic_scan`: `pass`
- ✅ `task_status_projection`: `pass`
- ✅ `task_execution_reliability_e2e`: `pass`
- ✅ `plugins_compat`: `pass`
- ✅ `plugin_runtime_compat`: `pass`
- ✅ `plugin_manifest_hygiene(non-blocking)`: `pass`
- ✅ `plugin_command_conflicts(non-blocking)`: `pass`
- ✅ `skills_semantic_consistency(non-blocking)`: `pass`
- ✅ `knowledge_source_compliance(non-blocking)`: `pass`
- ✅ `skills_compat`: `pass`
- ✅ `release_signoff`: `pass`
- ❌ `slo_tightening_guard(non-blocking)`: `fail`

## 阻断归因

- 无阻断项

## 插件清单卫生（已安装口径，非阻断）

- `status`: `pass`
- `manifest_warnings_count`: `0`
- `manifest_errors_count`: `0`

## SLO 快照

- `task_count`: `319`
- `success_rate`: `0.752`
- `blocked_recovery_rate`: `0.1778`
- `deliverable_effective_rate`: `0.5851`

## 结论

- 本次演练满足 strict 放行条件。

## SLO 趋势（最近 3 次）

- `2026-03-02T06:05:51.742028+00:00` env=`production` status=`pass` margin=`healthy` success=`1.0` (Δ=`+0.6100`) blocked_recovery=`0.3125` (Δ=`+0.1625`) deliverable_effective=`0.8333`(Δ=`+0.6733`)
- `2026-03-02T06:09:35.321041+00:00` env=`production` status=`pass` margin=`healthy` success=`1.0` (Δ=`+0.6100`) blocked_recovery=`0.3846` (Δ=`+0.2346`) deliverable_effective=`0.8205`(Δ=`+0.6605`)
- `2026-03-02T08:12:23.431170+00:00` env=`production` status=`pass` margin=`healthy` success=`1.0` (Δ=`+0.6100`) blocked_recovery=`0.9167` (Δ=`+0.7667`) deliverable_effective=`0.625`(Δ=`+0.4650`)

## Watcher Invites 观测快照（非阻断）

- `generated_at`: `2026-03-02T06:09:32.291918+00:00`
- `search_calls`: `0`
- `fallback_calls`: `0`
- `fallback_ratio`: `0.0`
- `search_errors`: `0`
- `loop_errors`: `0`
- `rows_seen`: `0`
- `processable_rows`: `0`
- `bid_submitted`: `0`
- `bid_failed`: `0`

## 发布演练执行明细

- `task_status_projection`: level=`required` status=`pass` rc=`0` elapsed_ms=`7081` timeout_s=`420`
- `task_status_projection_guard_off`: level=`required` status=`pass` rc=`0` elapsed_ms=`4267` timeout_s=`240`
- `task_status_wiring`: level=`required` status=`pass` rc=`0` elapsed_ms=`78` timeout_s=`120`
- `board_contract`: level=`required` status=`pass` rc=`0` elapsed_ms=`3891` timeout_s=`120`
- `plugins_compat`: level=`required` status=`pass` rc=`0` elapsed_ms=`5432` timeout_s=`180`
- `plugin_runtime_compat`: level=`required` status=`pass` rc=`0` elapsed_ms=`2549` timeout_s=`120`
- `skills_compat`: level=`required` status=`pass` rc=`0` elapsed_ms=`504` timeout_s=`120`
- `watcher_observability_snapshot`: level=`non-blocking` status=`pass` rc=`0` elapsed_ms=`30313` timeout_s=`90`
- `ui_stream_metrics_snapshot`: level=`non-blocking` status=`pass` rc=`0` elapsed_ms=`73` timeout_s=`60`
- `reliability_slo_strict`: level=`required` status=`pass` rc=`0` elapsed_ms=`3306` timeout_s=`120`
- `legacy_terms_strict`: level=`required` status=`pass` rc=`0` elapsed_ms=`34824` timeout_s=`240`
- `release_signoff_strict`: level=`required` status=`pass` rc=`0` elapsed_ms=`78` timeout_s=`120`
- `build_release_gate_summary`: level=`required` status=`pass` rc=`0` elapsed_ms=`40` timeout_s=`240`
- `build_release_drill_report`: level=`required` status=`pass` rc=`0` elapsed_ms=`40` timeout_s=`240`

## UI 流式指标快照（与 LM Studio 对照）

- `generated_at`: `2026-03-02T07:22:51.225252+00:00`
- `ttft_ms_p50`: `None`
- `ttft_ms_p95`: `None`
- `first_payload_ms_p50`: `None`
- `first_payload_ms_p95`: `None`
- `max_inter_token_gap_ms_p50`: `None`
- `max_inter_token_gap_ms_p95`: `None`
- `channel_fallback_count_p50`: `None`
- `channel_fallback_count_p95`: `None`
- `partial_suppressed_count_p50`: `None`
- `partial_suppressed_count_p95`: `None`
- `samples`: `0`
