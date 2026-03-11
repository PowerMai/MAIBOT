#!/usr/bin/env python3
"""
Build GitHub job summary markdown for CI jobs.
"""

from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

try:
    from backend.scripts.release_drill_steps_utils import collect_required_step_failures
except Exception:  # pragma: no cover - fallback for direct script execution
    from release_drill_steps_utils import collect_required_step_failures


def _read_json(path: Path) -> Dict[str, Any]:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _required_step_failures(drill_steps: Dict[str, Any]) -> List[str]:
    rows = collect_required_step_failures(drill_steps)
    return [
        f"{row.get('name', 'unknown')} (status={row.get('status', 'unknown')}, rc={row.get('rc', 'n/a')})"
        for row in rows
    ]


def _parse_iso_datetime(value: str | None) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except Exception:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _collect_artifact_freshness(project_root: Path, max_age_minutes: int) -> List[Dict[str, Any]]:
    checks = [
        ("release_gate_summary", project_root / "backend" / "data" / "release_gate_summary.json", "generated_at"),
        (
            "unified_observability_snapshot",
            project_root / "backend" / "data" / "unified_observability_snapshot.json",
            "generated_at",
        ),
        ("release_postcheck_report", project_root / "backend" / "data" / "release_postcheck_report.json", "timestamp"),
        ("parity_scorecard", project_root / "backend" / "data" / "parity_scorecard.json", "generated_at"),
        ("parity_trend_report", project_root / "backend" / "data" / "parity_trend_report.json", "generated_at"),
        ("plugin_command_conflicts_report", project_root / "backend" / "data" / "plugin_command_conflicts_report.json", "generated_at"),
        ("knowledge_source_compliance_report", project_root / "backend" / "data" / "knowledge_source_compliance_report.json", "generated_at"),
    ]
    now = datetime.now(timezone.utc)
    rows: List[Dict[str, Any]] = []
    for name, path, ts_key in checks:
        row: Dict[str, Any] = {"name": name, "path": path.as_posix(), "ts_key": ts_key}
        if not path.exists():
            row["status"] = "missing"
            rows.append(row)
            continue
        payload = _read_json(path)
        ts_raw = str((payload or {}).get(ts_key) or "")
        ts = _parse_iso_datetime(ts_raw)
        if ts is None:
            row["status"] = "invalid_ts"
            row["timestamp"] = ts_raw or None
            rows.append(row)
            continue
        age_minutes = (now - ts).total_seconds() / 60.0
        row["age_minutes"] = round(age_minutes, 1)
        row["timestamp"] = ts.isoformat()
        row["status"] = "pass" if age_minutes <= float(max_age_minutes) else "stale"
        rows.append(row)
    return rows


def _render_artifact_freshness_block(project_root: Path, max_age_minutes: int) -> List[str]:
    lines: List[str] = ["", "### Artifact Freshness"]
    rows = _collect_artifact_freshness(project_root, max_age_minutes)
    stale_or_missing = [r for r in rows if str(r.get("status")) != "pass"]
    lines.append(f"- freshness_status: `{'pass' if not stale_or_missing else 'fail'}`")
    lines.append(f"- freshness_max_age_minutes: `{max_age_minutes}`")
    if stale_or_missing:
        lines.append("- freshness_issues:")
    for row in rows:
        status = str(row.get("status") or "unknown")
        if status == "pass":
            lines.append(
                f"- `{row.get('name')}`: `pass` (age={row.get('age_minutes')}m, ts={row.get('timestamp')})"
            )
        elif status == "stale":
            lines.append(
                f"- `{row.get('name')}`: `stale` (age={row.get('age_minutes')}m > {max_age_minutes}m, ts={row.get('timestamp')})"
            )
        elif status == "missing":
            lines.append(f"- `{row.get('name')}`: `missing` ({row.get('path')})")
        else:
            lines.append(
                f"- `{row.get('name')}`: `invalid_ts` (key={row.get('ts_key')}, value={row.get('timestamp')})"
            )
    return lines


def _render_release_readiness(
    summary: Dict[str, Any], postcheck: Dict[str, Any], drill_steps: Dict[str, Any]
) -> List[str]:
    lines: List[str] = ["## Release Readiness Summary", ""]
    if summary:
        lines.extend(
            [
                f"- overall_status: `{summary.get('overall_status', 'unknown')}`",
                f"- profile_gate_status: `{summary.get('profile_gate_status', 'unknown')}`",
                f"- release_profile: `{summary.get('release_profile', 'unknown')}`",
            ]
        )
        plugin_hygiene = (
            ((summary.get("evidence") or {}).get("plugin_manifest_hygiene"))
            if isinstance(summary.get("evidence"), dict)
            else {}
        )
        if isinstance(plugin_hygiene, dict) and plugin_hygiene:
            lines.append(
                "- plugin_manifest_hygiene: "
                f"`{plugin_hygiene.get('status', 'unknown')}` "
                f"(warnings={plugin_hygiene.get('warnings_count', 0)}, errors={plugin_hygiene.get('errors_count', 0)})"
            )
        reasons = summary.get("blocking_reasons") if isinstance(summary.get("blocking_reasons"), list) else []
        if reasons:
            lines.extend(["", "### Blocking Reasons"])
            for row in reasons[:8]:
                if not isinstance(row, dict):
                    continue
                lines.append(
                    f"- `{row.get('evidence', 'unknown')}`: `{row.get('status', 'unknown')}` ({row.get('reason', 'n/a')})"
                )
    else:
        lines.append("- release_gate_summary: `missing`")

    lines.extend(["", "### Release Postcheck"])
    if postcheck:
        lines.append(f"- status: `{postcheck.get('status', 'unknown')}`")
        failures = postcheck.get("failures") if isinstance(postcheck.get("failures"), list) else []
        warnings = postcheck.get("warnings") if isinstance(postcheck.get("warnings"), list) else []
        if failures:
            lines.append("- failures:")
            for item in failures[:10]:
                lines.append(f"  - {item}")
        if warnings:
            lines.append("- warnings:")
            for item in warnings[:10]:
                lines.append(f"  - {item}")
    else:
        lines.append("- release_postcheck_report: `missing`")

    lines.extend(["", "### Drill Required Steps"])
    if drill_steps:
        required_failures = _required_step_failures(drill_steps)
        lines.append(f"- required_step_fail_count: `{len(required_failures)}`")
        if required_failures:
            lines.append("- required_step_failures:")
            for item in required_failures[:12]:
                lines.append(f"  - {item}")
    else:
        lines.append("- required_step_fail_count: `unknown`")
        lines.append("- required_step_failures: `release_drill_steps.json missing`")
    return lines


def _render_unified_observability_block(unified_snapshot: Dict[str, Any]) -> List[str]:
    lines: List[str] = ["", "### Unified Observability Snapshot"]
    if not unified_snapshot:
        lines.append("- unified_observability_snapshot: `missing`")
        return lines
    release = unified_snapshot.get("release") if isinstance(unified_snapshot.get("release"), dict) else {}
    slo = unified_snapshot.get("reliability_slo") if isinstance(unified_snapshot.get("reliability_slo"), dict) else {}
    watcher = unified_snapshot.get("watcher") if isinstance(unified_snapshot.get("watcher"), dict) else {}
    projection = (
        unified_snapshot.get("task_status_projection")
        if isinstance(unified_snapshot.get("task_status_projection"), dict)
        else {}
    )
    ecosystem = unified_snapshot.get("ecosystem") if isinstance(unified_snapshot.get("ecosystem"), dict) else {}
    ecosystem_checks = ecosystem.get("checks") if isinstance(ecosystem.get("checks"), dict) else {}
    plugin_hygiene = (
        ecosystem.get("plugin_manifest_hygiene")
        if isinstance(ecosystem.get("plugin_manifest_hygiene"), dict)
        else {}
    )
    checks_text = ", ".join(
        f"{k}={ecosystem_checks.get(k)}"
        for k in (
            "plugins_compat",
            "plugin_runtime_compat",
            "plugin_command_conflicts",
            "skills_compat",
            "skills_semantic_consistency",
            "knowledge_source_compliance",
        )
    )
    lines.extend(
        [
            f"- overall_status: `{release.get('overall_status', 'unknown')}`",
            f"- profile_gate_status: `{release.get('profile_gate_status', 'unknown')}`",
            f"- success_rate: `{slo.get('success_rate')}`",
            f"- blocked_recovery_rate: `{slo.get('blocked_recovery_rate')}`",
            f"- projection_status: `{projection.get('status')}`",
            f"- watcher_search_calls: `{watcher.get('search_calls')}`",
            f"- watcher_fallback_ratio: `{watcher.get('fallback_ratio')}`",
            f"- ecosystem_availability: `{ecosystem.get('availability')}`",
            f"- ecosystem_checks: `{checks_text or 'unknown'}`",
            "- plugin_manifest_hygiene: "
            f"`{plugin_hygiene.get('status', 'unknown')}` "
            f"(warnings={plugin_hygiene.get('warnings_count', 'n/a')}, errors={plugin_hygiene.get('errors_count', 'n/a')})",
        ]
    )
    return lines


def _render_skills_behavior_block(skills_report: Dict[str, Any]) -> List[str]:
    lines: List[str] = ["", "### Skills Behavior Consistency (v2)"]
    if not skills_report:
        lines.append("- skills_compat_smoke_report: `missing`")
        return lines
    checks = skills_report.get("checks") if isinstance(skills_report.get("checks"), dict) else {}
    metrics = skills_report.get("metrics") if isinstance(skills_report.get("metrics"), dict) else {}
    lines.extend(
        [
            f"- status: `{skills_report.get('status', 'unknown')}`",
            f"- demo_run_status_code: `{((checks.get('skills_demo_run_api') or {}).get('status_code'))}`",
            f"- trial_list_status_code: `{((checks.get('skills_trial_list_api') or {}).get('status_code'))}`",
            f"- validate_status_code: `{((checks.get('skills_validate_api') or {}).get('status_code'))}`",
            f"- market_items: `{metrics.get('skills_market_items')}`",
            f"- invalid_skills: `{metrics.get('invalid_skills')}`",
        ]
    )
    return lines


def _render_parity_scorecard_block(parity: Dict[str, Any]) -> List[str]:
    lines: List[str] = ["", "### Claude/Cowork/Cursor Parity Scorecard"]
    if not parity:
        lines.append("- parity_scorecard: `missing`")
        return lines
    lines.extend(
        [
            f"- overall_score_100: `{parity.get('overall_score_100')}`",
            f"- overall_level: `{parity.get('overall_level', 'unknown')}`",
        ]
    )
    gaps = parity.get("key_gaps") if isinstance(parity.get("key_gaps"), list) else []
    if gaps:
        lines.append(f"- key_gaps: `{', '.join(str(x) for x in gaps[:8])}`")
    dims = parity.get("dimensions") if isinstance(parity.get("dimensions"), list) else []
    if dims:
        lines.append("- top_dimensions:")
        for row in dims[:6]:
            if not isinstance(row, dict):
                continue
            lines.append(
                f"  - `{row.get('name', 'unknown')}` score=`{row.get('score_0_to_5')}` level=`{row.get('level', 'unknown')}`"
            )
    return lines


def _render_parity_trend_block(trend: Dict[str, Any]) -> List[str]:
    lines: List[str] = ["", "### Parity Trend"]
    if not trend:
        lines.append("- parity_trend_report: `missing`")
        return lines
    regression = trend.get("regression") if isinstance(trend.get("regression"), dict) else {}
    delta = trend.get("delta") if isinstance(trend.get("delta"), dict) else {}
    lines.extend(
        [
            f"- status: `{trend.get('status', 'unknown')}`",
            f"- score_delta: `{delta.get('overall_score_100')}`",
            f"- regression_detected: `{regression.get('detected')}`",
        ]
    )
    dim_reg = regression.get("dimension_regressions") if isinstance(regression.get("dimension_regressions"), list) else []
    if dim_reg:
        lines.append(f"- dimension_regressions: `{', '.join(str(x) for x in dim_reg[:8])}`")
    return lines


def _render_memory_scope_block(memory_scope: Dict[str, Any]) -> List[str]:
    lines: List[str] = ["", "### Memory Scope Contract"]
    if not memory_scope:
        lines.append("- memory_scope_contract_report: `missing`")
        return lines
    lines.extend(
        [
            f"- status: `{memory_scope.get('status', 'unknown')}`",
            f"- workspace_isolated_default: `{memory_scope.get('workspace_isolated_default')}`",
        ]
    )
    failed = memory_scope.get("failed_checks") if isinstance(memory_scope.get("failed_checks"), list) else []
    if failed:
        lines.append(f"- failed_checks: `{', '.join(str(x) for x in failed[:8])}`")
    return lines


def _render_memory_quality_block(memory_quality: Dict[str, Any]) -> List[str]:
    lines: List[str] = ["", "### Memory Quality"]
    if not memory_quality:
        lines.append("- memory_quality_report: `missing`")
        return lines
    metrics = memory_quality.get("metrics") if isinstance(memory_quality.get("metrics"), dict) else {}
    lines.extend(
        [
            f"- status: `{memory_quality.get('status', 'unknown')}`",
            f"- memory_rows: `{metrics.get('memory_rows')}`",
            f"- cross_session_hit_rate: `{metrics.get('cross_session_hit_rate')}`",
            f"- false_recall_rate: `{metrics.get('false_recall_rate')}`",
            f"- preference_stability_rate: `{metrics.get('preference_stability_rate')}`",
        ]
    )
    warns = memory_quality.get("warnings") if isinstance(memory_quality.get("warnings"), list) else []
    if warns:
        lines.append(f"- warnings: `{', '.join(str(x) for x in warns[:8])}`")
    return lines


def _render_memory_quality_trend_block(trend: Dict[str, Any]) -> List[str]:
    lines: List[str] = ["", "### Memory Quality Trend"]
    if not trend:
        lines.append("- memory_quality_trend_report: `missing`")
        return lines
    reg = trend.get("regression") if isinstance(trend.get("regression"), dict) else {}
    delta = trend.get("delta") if isinstance(trend.get("delta"), dict) else {}
    lines.extend(
        [
            f"- status: `{trend.get('status', 'unknown')}`",
            f"- regression_detected: `{reg.get('detected')}`",
            f"- delta_cross_session_hit_rate: `{delta.get('cross_session_hit_rate')}`",
            f"- delta_false_recall_rate: `{delta.get('false_recall_rate')}`",
            f"- delta_preference_stability_rate: `{delta.get('preference_stability_rate')}`",
        ]
    )
    return lines


def _extract_strict_lines(latest_ops_md: Path | None) -> tuple[str | None, str | None]:
    strict_line = None
    strict_violation_line = None
    if latest_ops_md and latest_ops_md.exists():
        try:
            for raw in latest_ops_md.read_text(encoding="utf-8").splitlines():
                s = raw.strip()
                if s.startswith("- strict_threshold_status:"):
                    strict_line = s
                elif s.startswith("- strict_threshold_violations:"):
                    strict_violation_line = s
        except Exception:
            return None, None
    return strict_line, strict_violation_line


def _latest_ops_summary(ops_dir: Path) -> Path | None:
    if not ops_dir.exists():
        return None
    files = sorted(ops_dir.glob("ops_daily_summary_*.md"))
    return files[-1] if files else None


def _render_ops_daily(
    summary: Dict[str, Any],
    postcheck: Dict[str, Any],
    drill_steps: Dict[str, Any],
    watcher_snapshot: Dict[str, Any],
    latest_ops_md: Path | None,
) -> List[str]:
    lines: List[str] = ["## Ops Daily Check Summary", ""]
    if summary:
        rel = (summary.get("evidence") or {}).get("reliability_slo") or {}
        metrics = (rel.get("snapshot") or {}).get("metrics") or {}
        lines.extend(
            [
                f"- overall_status: `{summary.get('overall_status', 'unknown')}`",
                f"- profile_gate_status: `{summary.get('profile_gate_status', 'unknown')}`",
                f"- success_rate: `{metrics.get('success_rate')}`",
                f"- blocked_recovery_rate: `{metrics.get('blocked_recovery_rate')}`",
                f"- task_count: `{metrics.get('task_count')}`",
                f"- task_execution_reliability_e2e: `{((summary.get('evidence') or {}).get('task_execution_reliability_e2e') or {}).get('status', 'missing')}`",
            ]
        )
    else:
        lines.append("- release_gate_summary: `missing`")

    strict_line, strict_violation_line = _extract_strict_lines(latest_ops_md)
    lines.extend(["", "### Watcher Strict Verdict"])
    if strict_line:
        lines.append(strict_line)
        lines.append(strict_violation_line or "- strict_threshold_violations: `unknown`")
    elif watcher_snapshot:
        wm = watcher_snapshot.get("metrics") if isinstance(watcher_snapshot.get("metrics"), dict) else {}
        lines.extend(
            [
                "- strict_threshold_status: `unknown`",
                f"- search_calls: `{wm.get('search_calls')}`",
                f"- fallback_ratio: `{wm.get('fallback_ratio')}`",
                f"- loop_errors: `{wm.get('loop_errors')}`",
            ]
        )
    else:
        lines.append("- strict_threshold_status: `missing`")

    if latest_ops_md:
        lines.extend(["", f"- ops_daily_summary: `{latest_ops_md.as_posix()}`"])

    lines.extend(["", "### Release Postcheck"])
    if postcheck:
        lines.append(f"- status: `{postcheck.get('status', 'unknown')}`")
        failures = postcheck.get("failures") if isinstance(postcheck.get("failures"), list) else []
        warnings = postcheck.get("warnings") if isinstance(postcheck.get("warnings"), list) else []
        if failures:
            lines.append("- failures:")
            for item in failures[:8]:
                lines.append(f"  - {item}")
        if warnings:
            lines.append("- warnings:")
            for item in warnings[:8]:
                lines.append(f"  - {item}")
    else:
        lines.append("- release_postcheck_report: `missing`")

    lines.extend(["", "### Drill Required Steps"])
    if drill_steps:
        required_failures = _required_step_failures(drill_steps)
        lines.append(f"- required_step_fail_count: `{len(required_failures)}`")
        if required_failures:
            lines.append("- required_step_failures:")
            for item in required_failures[:12]:
                lines.append(f"  - {item}")
    else:
        lines.append("- required_step_fail_count: `unknown`")
        lines.append("- required_step_failures: `release_drill_steps.json missing`")
    return lines


def main() -> int:
    parser = argparse.ArgumentParser(description="Build GitHub job summary markdown")
    parser.add_argument("--mode", choices=["release-readiness", "ops-daily"], required=True)
    parser.add_argument(
        "--summary-json",
        default="backend/data/release_gate_summary.json",
        help="Path to release_gate_summary.json",
    )
    parser.add_argument(
        "--postcheck-json",
        default="backend/data/release_postcheck_report.json",
        help="Path to release_postcheck_report.json",
    )
    parser.add_argument(
        "--drill-steps-json",
        default="backend/data/release_drill_steps.json",
        help="Path to release_drill_steps.json",
    )
    parser.add_argument(
        "--watcher-json",
        default="backend/data/watcher_observability_snapshot.json",
        help="Path to watcher observability snapshot (ops-daily only)",
    )
    parser.add_argument(
        "--ops-dir",
        default="backend/data/ops-daily",
        help="Path to ops-daily directory (ops-daily only)",
    )
    parser.add_argument(
        "--unified-snapshot-json",
        default="backend/data/unified_observability_snapshot.json",
        help="Path to unified observability snapshot json",
    )
    parser.add_argument(
        "--skills-report-json",
        default="backend/data/skills_compat_smoke_report.json",
        help="Path to skills compatibility smoke report",
    )
    parser.add_argument(
        "--parity-scorecard-json",
        default="backend/data/parity_scorecard.json",
        help="Path to parity scorecard report",
    )
    parser.add_argument(
        "--parity-trend-json",
        default="backend/data/parity_trend_report.json",
        help="Path to parity trend report",
    )
    parser.add_argument(
        "--memory-scope-contract-json",
        default="backend/data/memory_scope_contract_report.json",
        help="Path to memory scope contract report",
    )
    parser.add_argument(
        "--memory-quality-json",
        default="backend/data/memory_quality_report.json",
        help="Path to memory quality report",
    )
    parser.add_argument(
        "--memory-quality-trend-json",
        default="backend/data/memory_quality_trend_report.json",
        help="Path to memory quality trend report",
    )
    parser.add_argument(
        "--output",
        default="",
        help="Output markdown file path; defaults to GITHUB_STEP_SUMMARY",
    )
    parser.add_argument(
        "--freshness-max-age-minutes",
        type=int,
        default=180,
        help="Maximum allowed artifact age (minutes) for summary freshness rendering",
    )
    args = parser.parse_args()
    project_root = Path(__file__).resolve().parents[2]

    summary = _read_json(Path(args.summary_json))
    postcheck = _read_json(Path(args.postcheck_json))
    drill_steps = _read_json(Path(args.drill_steps_json))
    unified_snapshot = _read_json(Path(args.unified_snapshot_json))
    skills_report = _read_json(Path(args.skills_report_json))
    parity_scorecard = _read_json(Path(args.parity_scorecard_json))
    parity_trend = _read_json(Path(args.parity_trend_json))
    memory_scope_contract = _read_json(Path(args.memory_scope_contract_json))
    memory_quality = _read_json(Path(args.memory_quality_json))
    memory_quality_trend = _read_json(Path(args.memory_quality_trend_json))

    if args.mode == "release-readiness":
        lines = _render_release_readiness(summary, postcheck, drill_steps)
        lines.extend(_render_artifact_freshness_block(project_root, max(1, int(args.freshness_max_age_minutes))))
        lines.extend(_render_unified_observability_block(unified_snapshot))
        lines.extend(_render_skills_behavior_block(skills_report))
        lines.extend(_render_parity_scorecard_block(parity_scorecard))
        lines.extend(_render_parity_trend_block(parity_trend))
        lines.extend(_render_memory_scope_block(memory_scope_contract))
        lines.extend(_render_memory_quality_block(memory_quality))
        lines.extend(_render_memory_quality_trend_block(memory_quality_trend))
    else:
        watcher = _read_json(Path(args.watcher_json))
        latest_ops_md = _latest_ops_summary(Path(args.ops_dir))
        lines = _render_ops_daily(summary, postcheck, drill_steps, watcher, latest_ops_md)
        lines.extend(_render_unified_observability_block(unified_snapshot))
        lines.extend(_render_parity_scorecard_block(parity_scorecard))
        lines.extend(_render_parity_trend_block(parity_trend))
        lines.extend(_render_memory_scope_block(memory_scope_contract))
        lines.extend(_render_memory_quality_block(memory_quality))
        lines.extend(_render_memory_quality_trend_block(memory_quality_trend))

    output_path = Path(args.output or os.environ.get("GITHUB_STEP_SUMMARY", "")).expanduser()
    if not str(output_path):
        return 0
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
