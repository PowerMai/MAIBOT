#!/usr/bin/env python3
"""
基于 release gate 摘要生成一份可审计的发布演练报告（Markdown）。
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

PROJECT_ROOT = Path(__file__).resolve().parents[2]


def _read_json(path: Path) -> Dict[str, Any]:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _read_last_jsonl_rows(path: Path, max_rows: int) -> List[Dict[str, Any]]:
    if max_rows <= 0 or not path.exists():
        return []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except Exception:
        return []
    rows: List[Dict[str, Any]] = []
    for line in reversed(lines):
        raw = line.strip()
        if not raw:
            continue
        try:
            item = json.loads(raw)
            if isinstance(item, dict):
                rows.append(item)
        except Exception:
            continue
        if len(rows) >= max_rows:
            break
    rows.reverse()
    return rows


def _pick_recent_rows_by_env(rows: List[Dict[str, Any]], env: str, max_rows: int) -> List[Dict[str, Any]]:
    if max_rows <= 0:
        return []
    target_env = str(env or "").strip().lower()
    if not target_env:
        return rows[-max_rows:]
    filtered = [
        row
        for row in rows
        if str(row.get("env") or "").strip().lower() == target_env
    ]
    if filtered:
        return filtered[-max_rows:]
    return rows[-max_rows:]


def _status_line(name: str, status: str) -> str:
    icon = "✅" if status == "pass" else ("⚠️" if status == "warn" else "❌")
    return f"- {icon} `{name}`: `{status or 'unknown'}`"


def _to_float(value: Any) -> float | None:
    try:
        return float(value)
    except Exception:
        return None


def _format_delta(actual: Any, threshold: Any) -> str:
    actual_f = _to_float(actual)
    threshold_f = _to_float(threshold)
    if actual_f is None or threshold_f is None:
        return "n/a"
    delta = actual_f - threshold_f
    return f"{delta:+.4f}"


def _delta_value(actual: Any, threshold: Any) -> float | None:
    actual_f = _to_float(actual)
    threshold_f = _to_float(threshold)
    if actual_f is None or threshold_f is None:
        return None
    return actual_f - threshold_f


def _margin_label(deltas: List[float | None], near_threshold: float = 0.01) -> str:
    valid = [d for d in deltas if d is not None]
    if not valid:
        return "unknown"
    min_delta = min(valid)
    if min_delta < 0:
        return "below-threshold"
    if min_delta < near_threshold:
        return "near-threshold"
    return "healthy"


def _build_blocking_lines(reasons: List[Dict[str, Any]]) -> List[str]:
    if not reasons:
        return ["- 无阻断项"]
    lines: List[str] = []
    for row in reasons:
        if not isinstance(row, dict):
            continue
        evidence = str(row.get("evidence") or "unknown")
        status = str(row.get("status") or "unknown")
        reason = str(row.get("reason") or "n/a")
        lines.append(f"- `{evidence}`: status=`{status}`, reason=`{reason}`")
    return lines or ["- 无阻断项"]


def _render(
    summary: Dict[str, Any],
    release_profile: str,
    recent_slo_rows: List[Dict[str, Any]],
    watcher_snapshot: Dict[str, Any],
    drill_steps: Dict[str, Any],
    ui_stream_metrics: Dict[str, Any],
) -> str:
    generated_at = datetime.now(timezone.utc).isoformat()
    overall = str(summary.get("overall_status") or "unknown")
    profile_gate = str(summary.get("profile_gate_status") or "unknown")
    evidence = summary.get("evidence") if isinstance(summary.get("evidence"), dict) else {}
    blocking = summary.get("blocking_reasons") if isinstance(summary.get("blocking_reasons"), list) else []

    checks = [
        ("reliability_slo", str((evidence.get("reliability_slo") or {}).get("status") or "missing")),
        ("legacy_semantic_scan", str((evidence.get("legacy_semantic_scan") or {}).get("status") or "missing")),
        ("task_status_projection", str((evidence.get("task_status_projection") or {}).get("status") or "missing")),
        ("task_execution_reliability_e2e", str((evidence.get("task_execution_reliability_e2e") or {}).get("status") or "missing")),
        ("plugins_compat", str((evidence.get("plugins_compat") or {}).get("status") or "missing")),
        ("plugin_runtime_compat", str((evidence.get("plugin_runtime_compat") or {}).get("status") or "missing")),
        ("plugin_manifest_hygiene(non-blocking)", str((evidence.get("plugin_manifest_hygiene") or {}).get("status") or "missing")),
        ("plugin_command_conflicts(non-blocking)", str((evidence.get("plugin_command_conflicts") or {}).get("status") or "missing")),
        ("skills_semantic_consistency(non-blocking)", str((evidence.get("skills_semantic_consistency") or {}).get("status") or "missing")),
        ("knowledge_source_compliance(non-blocking)", str((evidence.get("knowledge_source_compliance") or {}).get("status") or "missing")),
        ("skills_compat", str((evidence.get("skills_compat") or {}).get("status") or "missing")),
        ("release_signoff", str((evidence.get("release_signoff") or {}).get("status") or "missing")),
        ("slo_tightening_guard(non-blocking)", str((evidence.get("slo_tightening_guard") or {}).get("status") or "missing")),
    ]
    plugin_manifest_hygiene = (
        evidence.get("plugin_manifest_hygiene") if isinstance(evidence.get("plugin_manifest_hygiene"), dict) else {}
    )

    metrics = ((evidence.get("reliability_slo") or {}).get("snapshot") or {}).get("metrics")
    metrics = metrics if isinstance(metrics, dict) else {}
    success_rate = metrics.get("success_rate")
    deliverable_effective_rate = metrics.get("deliverable_effective_rate")
    blocked_recovery_rate = metrics.get("blocked_recovery_rate")
    task_count = metrics.get("task_count")
    watcher_metrics = watcher_snapshot.get("metrics") if isinstance(watcher_snapshot.get("metrics"), dict) else {}
    watcher_generated_at = str(watcher_snapshot.get("generated_at") or "")
    drill_step_rows = drill_steps.get("steps") if isinstance(drill_steps.get("steps"), list) else []
    ui_metrics = ui_stream_metrics.get("metrics") if isinstance(ui_stream_metrics.get("metrics"), dict) else {}
    ui_generated_at = str(ui_stream_metrics.get("generated_at") or "")

    lines: List[str] = [
        "# 发布演练报告（自动生成）",
        "",
        f"- 生成时间（UTC）：`{generated_at}`",
        f"- 发布档位：`{release_profile}`",
        f"- `overall_status`：`{overall}`",
        f"- `profile_gate_status`：`{profile_gate}`",
        "",
        "## 关键证据状态",
        "",
    ]
    lines.extend(_status_line(name, status) for name, status in checks)
    lines.extend(
        [
            "",
            "## 阻断归因",
            "",
        ]
    )
    lines.extend(_build_blocking_lines(blocking))
    lines.extend(
        [
            "",
            "## 插件清单卫生（已安装口径，非阻断）",
            "",
            f"- `status`: `{plugin_manifest_hygiene.get('status', 'missing')}`",
            f"- `manifest_warnings_count`: `{plugin_manifest_hygiene.get('warnings_count', 'n/a')}`",
            f"- `manifest_errors_count`: `{plugin_manifest_hygiene.get('errors_count', 'n/a')}`",
            "",
            "## SLO 快照",
            "",
            f"- `task_count`: `{task_count}`",
            f"- `success_rate`: `{success_rate}`",
            f"- `blocked_recovery_rate`: `{blocked_recovery_rate}`",
            f"- `deliverable_effective_rate`: `{deliverable_effective_rate}`",
            "",
            "## 结论",
            "",
        ]
    )
    if profile_gate == "pass":
        lines.append("- 本次演练满足 strict 放行条件。")
    else:
        lines.append("- 本次演练未满足 strict 放行条件，请按“阻断归因”逐项补证后重跑。")
    lines.extend(["", "## SLO 趋势（最近 3 次）", ""])
    if not recent_slo_rows:
        lines.append("- 无可用历史样本")
    else:
        for row in recent_slo_rows:
            env = str(row.get("env") or "unknown")
            status = str(row.get("status") or "unknown")
            metrics_row = row.get("metrics") if isinstance(row.get("metrics"), dict) else {}
            thresholds_row = row.get("thresholds") if isinstance(row.get("thresholds"), dict) else {}
            success_delta = _delta_value(
                metrics_row.get("success_rate"),
                thresholds_row.get("min_success_rate"),
            )
            blocked_delta = _delta_value(
                metrics_row.get("blocked_recovery_rate"),
                thresholds_row.get("min_blocked_recovery_rate"),
            )
            deliverable_delta = _delta_value(
                metrics_row.get("deliverable_effective_rate"),
                thresholds_row.get("min_deliverable_effective_rate"),
            )
            margin = _margin_label([success_delta, blocked_delta, deliverable_delta])
            lines.append(
                "- "
                f"`{str(row.get('timestamp') or 'n/a')}` "
                f"env=`{env}` status=`{status}` "
                f"margin=`{margin}` "
                f"success=`{metrics_row.get('success_rate')}` "
                f"(Δ=`{_format_delta(metrics_row.get('success_rate'), thresholds_row.get('min_success_rate'))}`) "
                f"blocked_recovery=`{metrics_row.get('blocked_recovery_rate')}` "
                f"(Δ=`{_format_delta(metrics_row.get('blocked_recovery_rate'), thresholds_row.get('min_blocked_recovery_rate'))}`) "
                f"deliverable_effective=`{metrics_row.get('deliverable_effective_rate')}`"
                f"(Δ=`{_format_delta(metrics_row.get('deliverable_effective_rate'), thresholds_row.get('min_deliverable_effective_rate'))}`)"
            )
    lines.extend(["", "## Watcher Invites 观测快照（非阻断）", ""])
    if not watcher_metrics:
        lines.append("- 无可用 watcher 观测快照（可先执行 `make check-watcher-observability`）。")
    else:
        lines.extend(
            [
                f"- `generated_at`: `{watcher_generated_at or 'unknown'}`",
                f"- `search_calls`: `{watcher_metrics.get('search_calls')}`",
                f"- `fallback_calls`: `{watcher_metrics.get('fallback_calls')}`",
                f"- `fallback_ratio`: `{watcher_metrics.get('fallback_ratio')}`",
                f"- `search_errors`: `{watcher_metrics.get('search_errors')}`",
                f"- `loop_errors`: `{watcher_metrics.get('loop_errors')}`",
                f"- `rows_seen`: `{watcher_metrics.get('rows_seen')}`",
                f"- `processable_rows`: `{watcher_metrics.get('processable_rows')}`",
                f"- `bid_submitted`: `{watcher_metrics.get('bid_submitted')}`",
                f"- `bid_failed`: `{watcher_metrics.get('bid_failed')}`",
            ]
        )
    lines.extend(["", "## 发布演练执行明细", ""])
    if not drill_step_rows:
        lines.append("- 无可用演练步骤明细（可先执行 `backend/scripts/release_drill.py` 生成 `backend/data/release_drill_steps.json`）。")
    else:
        for row in drill_step_rows:
            if not isinstance(row, dict):
                continue
            step_name = str(row.get("name") or "unknown")
            step_status = str(row.get("status") or "unknown")
            step_rc = row.get("rc")
            step_elapsed_ms = row.get("elapsed_ms")
            timed_out = bool(row.get("timed_out"))
            timeout_seconds = row.get("timeout_seconds")
            required = bool(row.get("required", True))
            step_level = "required" if required else "non-blocking"
            warning = str(row.get("warning") or "").strip()
            extra = " timeout" if timed_out else ""
            if warning:
                extra = f"{extra} warning={warning}"
            lines.append(
                f"- `{step_name}`: level=`{step_level}` status=`{step_status}` rc=`{step_rc}` "
                f"elapsed_ms=`{step_elapsed_ms}` timeout_s=`{timeout_seconds}`{extra}"
            )
    lines.extend(["", "## UI 流式指标快照（与 LM Studio 对照）", ""])
    if not ui_metrics:
        lines.append("- 无可用 UI 流式指标快照（可写入 `backend/data/ui_stream_metrics_snapshot.json` 后重试）。")
    else:
        lines.extend(
            [
                f"- `generated_at`: `{ui_generated_at or 'unknown'}`",
                f"- `ttft_ms_p50`: `{ui_metrics.get('ttft_ms_p50')}`",
                f"- `ttft_ms_p95`: `{ui_metrics.get('ttft_ms_p95')}`",
                f"- `first_payload_ms_p50`: `{ui_metrics.get('frontend_first_payload_ms_p50')}`",
                f"- `first_payload_ms_p95`: `{ui_metrics.get('frontend_first_payload_ms_p95')}`",
                f"- `max_inter_token_gap_ms_p50`: `{ui_metrics.get('max_inter_token_gap_ms_p50')}`",
                f"- `max_inter_token_gap_ms_p95`: `{ui_metrics.get('max_inter_token_gap_ms_p95')}`",
                f"- `channel_fallback_count_p50`: `{ui_metrics.get('message_channel_fallback_count_p50')}`",
                f"- `channel_fallback_count_p95`: `{ui_metrics.get('message_channel_fallback_count_p95')}`",
                f"- `partial_suppressed_count_p50`: `{ui_metrics.get('partial_suppressed_count_p50')}`",
                f"- `partial_suppressed_count_p95`: `{ui_metrics.get('partial_suppressed_count_p95')}`",
                f"- `samples`: `{ui_metrics.get('sample_count')}`",
            ]
        )
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="构建发布演练报告（Markdown）")
    parser.add_argument(
        "--summary",
        default="backend/data/release_gate_summary.json",
        help="release gate 摘要路径",
    )
    parser.add_argument(
        "--release-profile",
        default="production",
        help="发布档位（staging/production）",
    )
    parser.add_argument(
        "--output",
        default="",
        help="报告输出路径（默认 docs/release_drill_report_YYYY-MM-DD.md）",
    )
    parser.add_argument(
        "--slo-history",
        default="backend/data/reliability_slo_history.jsonl",
        help="SLO 历史快照路径（用于趋势摘要）",
    )
    parser.add_argument(
        "--slo-history-limit",
        type=int,
        default=3,
        help="趋势摘要使用最近 N 次 SLO 快照（默认 3）",
    )
    parser.add_argument(
        "--watcher-observability",
        default="backend/data/watcher_observability_snapshot.json",
        help="watcher invites 观测快照路径（可选）",
    )
    parser.add_argument(
        "--drill-steps",
        default="backend/data/release_drill_steps.json",
        help="发布演练步骤明细路径（可选）",
    )
    parser.add_argument(
        "--ui-stream-metrics",
        default="backend/data/ui_stream_metrics_snapshot.json",
        help="UI 流式指标快照路径（可选）",
    )
    args = parser.parse_args()

    summary_path = Path(args.summary)
    if not summary_path.is_absolute():
        summary_path = PROJECT_ROOT / summary_path
    summary = _read_json(summary_path)
    if not summary:
        print(f"❌ 无法读取 release gate 摘要: {summary_path.as_posix()}")
        return 1
    slo_history_path = Path(args.slo_history)
    if not slo_history_path.is_absolute():
        slo_history_path = PROJECT_ROOT / slo_history_path
    all_recent_rows = _read_last_jsonl_rows(slo_history_path, max(int(args.slo_history_limit) * 5, int(args.slo_history_limit)))
    recent_slo_rows = _pick_recent_rows_by_env(
        all_recent_rows,
        str(args.release_profile or "production"),
        int(args.slo_history_limit),
    )
    watcher_snapshot_path = Path(args.watcher_observability)
    if not watcher_snapshot_path.is_absolute():
        watcher_snapshot_path = PROJECT_ROOT / watcher_snapshot_path
    watcher_snapshot = _read_json(watcher_snapshot_path)
    drill_steps_path = Path(args.drill_steps)
    if not drill_steps_path.is_absolute():
        drill_steps_path = PROJECT_ROOT / drill_steps_path
    drill_steps = _read_json(drill_steps_path)
    ui_metrics_path = Path(args.ui_stream_metrics)
    if not ui_metrics_path.is_absolute():
        ui_metrics_path = PROJECT_ROOT / ui_metrics_path
    ui_stream_metrics = _read_json(ui_metrics_path)

    out = str(args.output or "").strip()
    if not out:
        date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        out = f"docs/release_drill_report_{date_str}.md"
    out_path = Path(out)
    if not out_path.is_absolute():
        out_path = PROJECT_ROOT / out_path
    out_path.parent.mkdir(parents=True, exist_ok=True)
    content = _render(
        summary,
        str(args.release_profile or "production"),
        recent_slo_rows,
        watcher_snapshot,
        drill_steps,
        ui_stream_metrics,
    )
    out_path.write_text(content, encoding="utf-8")

    print("release drill report generated")
    print(f"- summary: {summary_path.as_posix()}")
    print(f"- output: {out_path.as_posix()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
