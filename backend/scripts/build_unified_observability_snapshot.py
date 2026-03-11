#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[2]


def _read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _resolve(path_like: str) -> Path:
    p = Path(path_like)
    return p if p.is_absolute() else (PROJECT_ROOT / p)


def main() -> int:
    parser = argparse.ArgumentParser(description="Build unified observability snapshot")
    parser.add_argument("--release-summary", default="backend/data/release_gate_summary.json")
    parser.add_argument("--watcher-snapshot", default="backend/data/watcher_observability_snapshot.json")
    parser.add_argument("--projection-evidence", default="backend/data/task_status_projection_evidence.json")
    parser.add_argument("--ui-stream-metrics", default="backend/data/ui_stream_metrics_snapshot.json")
    parser.add_argument("--memory-scope-contract-json", default="backend/data/memory_scope_contract_report.json")
    parser.add_argument("--memory-quality-json", default="backend/data/memory_quality_report.json")
    parser.add_argument("--memory-quality-trend-json", default="backend/data/memory_quality_trend_report.json")
    parser.add_argument("--policy-decision-json", default="backend/data/policy_decision_report.json")
    parser.add_argument("--output-json", default="backend/data/unified_observability_snapshot.json")
    args = parser.parse_args()

    release_summary = _read_json(_resolve(args.release_summary))
    watcher = _read_json(_resolve(args.watcher_snapshot))
    projection = _read_json(_resolve(args.projection_evidence))
    ui_stream_metrics = _read_json(_resolve(args.ui_stream_metrics))
    memory_scope_contract = _read_json(_resolve(args.memory_scope_contract_json))
    memory_quality = _read_json(_resolve(args.memory_quality_json))
    memory_quality_trend = _read_json(_resolve(args.memory_quality_trend_json))
    policy_decision = _read_json(_resolve(args.policy_decision_json))

    rel_evidence = release_summary.get("evidence") if isinstance(release_summary.get("evidence"), dict) else {}
    rel_slo = rel_evidence.get("reliability_slo") if isinstance(rel_evidence.get("reliability_slo"), dict) else {}
    rel_slo_snapshot = rel_slo.get("snapshot") if isinstance(rel_slo.get("snapshot"), dict) else {}
    rel_metrics = rel_slo_snapshot.get("metrics") if isinstance(rel_slo_snapshot.get("metrics"), dict) else {}
    compatibility_matrix = (
        release_summary.get("compatibility_matrix") if isinstance(release_summary.get("compatibility_matrix"), dict) else {}
    )
    eco_checks = compatibility_matrix.get("checks") if isinstance(compatibility_matrix.get("checks"), dict) else {}
    plugin_manifest_hygiene = (
        rel_evidence.get("plugin_manifest_hygiene")
        if isinstance(rel_evidence.get("plugin_manifest_hygiene"), dict)
        else {}
    )
    watcher_metrics = watcher.get("metrics") if isinstance(watcher.get("metrics"), dict) else {}
    ui_metrics = ui_stream_metrics.get("metrics") if isinstance(ui_stream_metrics.get("metrics"), dict) else {}
    blocking_reasons = (
        release_summary.get("blocking_reasons")
        if isinstance(release_summary.get("blocking_reasons"), list)
        else []
    )

    out = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "release": {
            "overall_status": release_summary.get("overall_status"),
            "profile_gate_status": release_summary.get("profile_gate_status"),
            "blocking_reasons": blocking_reasons,
            "task_execution_reliability_e2e_status": (
                (rel_evidence.get("task_execution_reliability_e2e") or {}).get("status")
                if isinstance(rel_evidence.get("task_execution_reliability_e2e"), dict)
                else None
            ),
        },
        "reliability_slo": {
            "task_count": rel_metrics.get("task_count"),
            "success_rate": rel_metrics.get("success_rate"),
            "blocked_recovery_rate": rel_metrics.get("blocked_recovery_rate"),
            "deliverable_effective_rate": rel_metrics.get("deliverable_effective_rate"),
            "human_intervention_rate": rel_metrics.get("human_intervention_rate"),
        },
        "task_status_projection": {
            "status": projection.get("status"),
            "strict_on": projection.get("strict_on"),
            "strict_off": projection.get("strict_off"),
        },
        "watcher": {
            "search_calls": watcher_metrics.get("search_calls"),
            "fallback_calls": watcher_metrics.get("fallback_calls"),
            "fallback_ratio": watcher_metrics.get("fallback_ratio"),
            "loop_errors": watcher_metrics.get("loop_errors"),
        },
        "ui_stream": {
            "generated_at": ui_stream_metrics.get("generated_at"),
            "sample_count": ui_metrics.get("sample_count"),
            "ttft_ms_p50": ui_metrics.get("ttft_ms_p50"),
            "ttft_ms_p95": ui_metrics.get("ttft_ms_p95"),
            "frontend_first_payload_ms_p50": ui_metrics.get("frontend_first_payload_ms_p50"),
            "frontend_first_payload_ms_p95": ui_metrics.get("frontend_first_payload_ms_p95"),
            "max_inter_token_gap_ms_p50": ui_metrics.get("max_inter_token_gap_ms_p50"),
            "max_inter_token_gap_ms_p95": ui_metrics.get("max_inter_token_gap_ms_p95"),
            "message_channel_fallback_count_p50": ui_metrics.get("message_channel_fallback_count_p50"),
            "message_channel_fallback_count_p95": ui_metrics.get("message_channel_fallback_count_p95"),
            "partial_suppressed_count_p50": ui_metrics.get("partial_suppressed_count_p50"),
            "partial_suppressed_count_p95": ui_metrics.get("partial_suppressed_count_p95"),
        },
        "memory_scope_contract": {
            "status": memory_scope_contract.get("status"),
            "workspace_isolated_default": memory_scope_contract.get("workspace_isolated_default"),
            "failed_checks": memory_scope_contract.get("failed_checks", []),
        },
        "memory_quality": {
            "status": memory_quality.get("status"),
            "warnings": memory_quality.get("warnings", []),
            "metrics": memory_quality.get("metrics", {}),
        },
        "memory_quality_trend": {
            "status": memory_quality_trend.get("status"),
            "regression_detected": (
                (memory_quality_trend.get("regression") or {}).get("detected")
                if isinstance(memory_quality_trend.get("regression"), dict)
                else None
            ),
            "delta": memory_quality_trend.get("delta", {}),
        },
        "policy_decisions": {
            "status": policy_decision.get("status"),
            "window_minutes": policy_decision.get("window_minutes"),
            "denied_total": (
                (policy_decision.get("metrics") or {}).get("denied_total")
                if isinstance(policy_decision.get("metrics"), dict)
                else None
            ),
            "unknown_layer_rows": (
                (policy_decision.get("metrics") or {}).get("unknown_layer_rows")
                if isinstance(policy_decision.get("metrics"), dict)
                else None
            ),
            "unknown_reason_rows": (
                (policy_decision.get("metrics") or {}).get("unknown_reason_rows")
                if isinstance(policy_decision.get("metrics"), dict)
                else None
            ),
            "by_layer": policy_decision.get("by_layer", {}),
            "by_reason_code": policy_decision.get("by_reason_code", {}),
            "schema": policy_decision.get("schema") or {"reason_codes": [], "policy_layers": []},
        },
        "ecosystem": {
            "availability": compatibility_matrix.get("ecosystem_availability"),
            "checks": {
                "plugins_compat": eco_checks.get("plugins_compat"),
                "plugin_runtime_compat": eco_checks.get("plugin_runtime_compat"),
                "plugin_command_conflicts": eco_checks.get("plugin_command_conflicts"),
                "skills_compat": eco_checks.get("skills_compat"),
                "skills_semantic_consistency": eco_checks.get("skills_semantic_consistency"),
                "knowledge_source_compliance": eco_checks.get("knowledge_source_compliance"),
                "task_execution_reliability_v2": eco_checks.get("task_execution_reliability_v2"),
                "task_execution_reliability_e2e": eco_checks.get("task_execution_reliability_e2e"),
            },
            "plugin_manifest_hygiene": {
                "status": plugin_manifest_hygiene.get("status"),
                "warnings_count": plugin_manifest_hygiene.get("warnings_count"),
                "errors_count": plugin_manifest_hygiene.get("errors_count"),
                "blocking": False,
            },
        },
    }

    out_path = _resolve(args.output_json)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("unified observability snapshot built")
    print(f"- output: {out_path.as_posix()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
