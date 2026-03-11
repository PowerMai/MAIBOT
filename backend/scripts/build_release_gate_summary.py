#!/usr/bin/env python3
"""
聚合 release-readiness 关键证据，输出统一摘要 JSON。
"""

from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


PROJECT_ROOT = Path(__file__).resolve().parents[2]


def _read_json(path: Path) -> Optional[Dict[str, Any]]:
    if not path.exists():
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        return raw if isinstance(raw, dict) else None
    except Exception:
        return None


def _read_last_jsonl(path: Path) -> Optional[Dict[str, Any]]:
    if not path.exists():
        return None
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
        for line in reversed(lines):
            line = line.strip()
            if not line:
                continue
            data = json.loads(line)
            if isinstance(data, dict):
                return data
    except Exception:
        return None
    return None


def _read_last_jsonl_match(path: Path, key: str, expected: str) -> Optional[Dict[str, Any]]:
    if not path.exists():
        return None
    normalized_expected = str(expected or "").strip().lower()
    if not normalized_expected:
        return _read_last_jsonl(path)
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
        for line in reversed(lines):
            line = line.strip()
            if not line:
                continue
            data = json.loads(line)
            if not isinstance(data, dict):
                continue
            value = str(data.get(key) or "").strip().lower()
            if value == normalized_expected:
                return data
    except Exception:
        return None
    return None


def _status_of(obj: Optional[Dict[str, Any]], preferred: List[str]) -> str:
    if not obj:
        return "missing"
    for key in preferred:
        val = obj.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip().lower()
    if obj.get("ok") is True:
        return "pass"
    if obj.get("ok") is False:
        return "fail"
    return "unknown"


def _extract_manifest_counts(*reports: Optional[Dict[str, Any]]) -> Dict[str, int]:
    warnings_count = 0
    errors_count = 0
    for report in reports:
        if not isinstance(report, dict):
            continue
        metrics = report.get("metrics") if isinstance(report.get("metrics"), dict) else {}
        warnings_count = max(warnings_count, int(metrics.get("manifest_warnings_count", 0) or 0))
        errors_count = max(errors_count, int(metrics.get("manifest_errors_count", 0) or 0))
    return {"warnings_count": warnings_count, "errors_count": errors_count}


def _manifest_hygiene_status(warnings_count: int, errors_count: int) -> str:
    if int(errors_count or 0) > 0:
        return "fail"
    if int(warnings_count or 0) > 0:
        return "warn"
    return "pass"


def main() -> int:
    parser = argparse.ArgumentParser(description="构建 release gate 证据摘要")
    parser.add_argument(
        "--output",
        default="backend/data/release_gate_summary.json",
        help="输出路径（默认: backend/data/release_gate_summary.json）",
    )
    parser.add_argument(
        "--slo-history",
        default="backend/data/reliability_slo_history.jsonl",
        help="SLO 历史路径",
    )
    parser.add_argument(
        "--legacy-report",
        default="backend/data/legacy_bidding_scan_report.json",
        help="历史语义扫描报告路径",
    )
    parser.add_argument(
        "--projection-report",
        default="backend/data/task_status_projection_report.json",
        help="状态投影回归报告路径",
    )
    parser.add_argument(
        "--projection-evidence-report",
        default="backend/data/task_status_projection_evidence.json",
        help="状态投影证据聚合报告路径",
    )
    parser.add_argument(
        "--plugins-compat-report",
        default="backend/data/plugins_compat_smoke_report.json",
        help="插件兼容冒烟报告路径",
    )
    parser.add_argument(
        "--plugin-runtime-compat-report",
        default="backend/data/plugin_runtime_compat_smoke_report.json",
        help="插件运行时兼容冒烟报告路径",
    )
    parser.add_argument(
        "--plugin-command-conflicts-report",
        default="backend/data/plugin_command_conflicts_report.json",
        help="插件命令冲突报告路径（先 warn）",
    )
    parser.add_argument(
        "--skills-compat-report",
        default="backend/data/skills_compat_smoke_report.json",
        help="skills 兼容冒烟报告路径",
    )
    parser.add_argument(
        "--skills-semantic-report",
        default="backend/data/skills_semantic_consistency_report.json",
        help="skills 语义一致性报告路径（先 warn）",
    )
    parser.add_argument(
        "--knowledge-source-compliance-report",
        default="backend/data/knowledge_source_compliance_report.json",
        help="知识来源合规报告路径（先 warn）",
    )
    parser.add_argument(
        "--task-execution-reliability-e2e-report",
        default="backend/data/task_execution_reliability_e2e_report.json",
        help="任务执行可靠性 E2E 报告路径",
    )
    parser.add_argument(
        "--signoff-report",
        default="backend/data/release_signoff_report.json",
        help="运营签字报告路径",
    )
    parser.add_argument(
        "--slo-tightening-guard-report",
        default="backend/data/slo_tightening_guard_report.json",
        help="SLO 收紧守卫报告路径（观察证据，不参与阻断）",
    )
    parser.add_argument(
        "--release-profile",
        default="staging",
        help="发布档位（staging/production）",
    )
    parser.add_argument(
        "--strict-required",
        action="store_true",
        help="required gate 必须 pass（任何非 pass 视为阻断）",
    )
    args = parser.parse_args()

    release_profile = str(args.release_profile or "staging").strip().lower() or "staging"
    slo = _read_last_jsonl_match(PROJECT_ROOT / args.slo_history, "env", release_profile) or _read_last_jsonl(
        PROJECT_ROOT / args.slo_history
    )
    legacy = _read_json(PROJECT_ROOT / args.legacy_report)
    projection = _read_json(PROJECT_ROOT / args.projection_report)
    projection_evidence = _read_json(PROJECT_ROOT / args.projection_evidence_report)
    plugins_compat = _read_json(PROJECT_ROOT / args.plugins_compat_report)
    plugin_runtime_compat = _read_json(PROJECT_ROOT / args.plugin_runtime_compat_report)
    plugin_command_conflicts = _read_json(PROJECT_ROOT / args.plugin_command_conflicts_report)
    skills_compat = _read_json(PROJECT_ROOT / args.skills_compat_report)
    skills_semantic = _read_json(PROJECT_ROOT / args.skills_semantic_report)
    knowledge_source_compliance = _read_json(PROJECT_ROOT / args.knowledge_source_compliance_report)
    task_execution_reliability_e2e = _read_json(PROJECT_ROOT / args.task_execution_reliability_e2e_report)
    signoff = _read_json(PROJECT_ROOT / args.signoff_report)
    slo_tightening_guard = _read_json(PROJECT_ROOT / args.slo_tightening_guard_report)

    slo_status = _status_of(slo, ["status"])
    legacy_status = _status_of(legacy, ["status"])
    projection_status = _status_of(projection_evidence, ["status"])
    if projection_status in {"missing", "unknown"}:
        projection_status = _status_of(projection, ["status"])
    plugins_compat_status = _status_of(plugins_compat, ["status"])
    plugin_runtime_compat_status = _status_of(plugin_runtime_compat, ["status"])
    plugin_command_conflicts_status = _status_of(plugin_command_conflicts, ["status"])
    skills_compat_status = _status_of(skills_compat, ["status"])
    skills_semantic_status = _status_of(skills_semantic, ["status"])
    knowledge_source_compliance_status = _status_of(knowledge_source_compliance, ["status"])
    task_execution_reliability_e2e_status = _status_of(task_execution_reliability_e2e, ["status"])
    reliability_v2_enabled = str(os.getenv("TASK_EXECUTION_RELIABILITY_V2", "false")).strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    reliability_v2_status = "pass" if reliability_v2_enabled else "skip"
    signoff_status = _status_of(signoff, ["status"])
    slo_tightening_guard_status = _status_of(slo_tightening_guard, ["status"])

    statuses = [
        slo_status,
        legacy_status,
        projection_status,
        plugins_compat_status,
        plugin_runtime_compat_status,
        plugin_command_conflicts_status,
        skills_compat_status,
        skills_semantic_status,
        knowledge_source_compliance_status,
        task_execution_reliability_e2e_status,
        reliability_v2_status,
        signoff_status,
    ]
    if "fail" in statuses:
        overall = "fail"
    elif "warn" in statuses:
        overall = "warn"
    elif "missing" in statuses:
        overall = "incomplete"
    elif all(s == "pass" for s in statuses):
        overall = "pass"
    else:
        overall = "unknown"

    ecosystem_checks = {
        "plugins_compat": plugins_compat_status,
        "plugin_runtime_compat": plugin_runtime_compat_status,
        "plugin_command_conflicts": plugin_command_conflicts_status,
        "skills_compat": skills_compat_status,
        "skills_semantic_consistency": skills_semantic_status,
        "knowledge_source_compliance": knowledge_source_compliance_status,
        "task_execution_reliability_v2": reliability_v2_status,
        "task_execution_reliability_e2e": task_execution_reliability_e2e_status,
    }
    plugin_manifest_counts = _extract_manifest_counts(plugins_compat, plugin_runtime_compat)
    total = len(ecosystem_checks)
    pass_count = sum(1 for s in ecosystem_checks.values() if s == "pass")
    ecosystem_availability = round(pass_count / total, 4) if total else 0.0

    blocking_reasons: List[Dict[str, str]] = []
    for key, status in {
        "reliability_slo": slo_status,
        "legacy_semantic_scan": legacy_status,
        "task_status_projection": projection_status,
        "plugins_compat": plugins_compat_status,
        "plugin_runtime_compat": plugin_runtime_compat_status,
        "skills_compat": skills_compat_status,
        "task_execution_reliability_e2e": task_execution_reliability_e2e_status,
        "task_execution_reliability_v2": reliability_v2_status,
        "release_signoff": signoff_status,
    }.items():
        if args.strict_required:
            should_block = status not in ("pass", "skip")
        elif release_profile == "production":
            should_block = status in {"fail", "warn", "missing", "incomplete", "unknown"}
        else:
            should_block = status in {"fail"}
        if key == "task_execution_reliability_v2" and status == "skip":
            should_block = False
        if should_block:
            if args.strict_required:
                reason = "strict-required gate"
            elif release_profile == "production":
                reason = "production strict gate"
            else:
                reason = "staging fail gate"
            blocking_reasons.append(
                {
                    "evidence": key,
                    "status": status,
                    "reason": reason,
                }
            )

    profile_gate_status = "blocked" if blocking_reasons else "pass"

    summary = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "overall_status": overall,
        "release_profile": release_profile,
        "profile_gate_status": profile_gate_status,
        "evidence": {
            "reliability_slo": {
                "status": slo_status,
                "source": args.slo_history,
                "snapshot": slo,
            },
            "legacy_semantic_scan": {
                "status": legacy_status,
                "source": args.legacy_report,
                "snapshot": legacy,
            },
            "task_status_projection": {
                "status": projection_status,
                "source": args.projection_evidence_report
                if projection_evidence
                else args.projection_report,
                "snapshot": projection_evidence if projection_evidence else projection,
                "raw_projection_report": projection if projection_evidence else None,
            },
            "plugins_compat": {
                "status": plugins_compat_status,
                "source": args.plugins_compat_report,
                "snapshot": plugins_compat,
            },
            "plugin_runtime_compat": {
                "status": plugin_runtime_compat_status,
                "source": args.plugin_runtime_compat_report,
                "snapshot": plugin_runtime_compat,
            },
            "plugin_command_conflicts": {
                "status": plugin_command_conflicts_status,
                "source": args.plugin_command_conflicts_report,
                "snapshot": plugin_command_conflicts,
                "blocking": False,
            },
            "skills_compat": {
                "status": skills_compat_status,
                "source": args.skills_compat_report,
                "snapshot": skills_compat,
            },
            "skills_semantic_consistency": {
                "status": skills_semantic_status,
                "source": args.skills_semantic_report,
                "snapshot": skills_semantic,
                "blocking": False,
            },
            "knowledge_source_compliance": {
                "status": knowledge_source_compliance_status,
                "source": args.knowledge_source_compliance_report,
                "snapshot": knowledge_source_compliance,
                "blocking": False,
            },
            "task_execution_reliability_e2e": {
                "status": task_execution_reliability_e2e_status,
                "source": args.task_execution_reliability_e2e_report,
                "snapshot": task_execution_reliability_e2e,
            },
            "task_execution_reliability_v2": {
                "status": reliability_v2_status,
                "source": "env:TASK_EXECUTION_RELIABILITY_V2",
                "enabled": reliability_v2_enabled,
                "blocking": any(r["evidence"] == "task_execution_reliability_v2" for r in blocking_reasons),
            },
            "plugin_manifest_hygiene": {
                "status": _manifest_hygiene_status(
                    int(plugin_manifest_counts.get("warnings_count", 0) or 0),
                    int(plugin_manifest_counts.get("errors_count", 0) or 0),
                ),
                "warnings_count": int(plugin_manifest_counts.get("warnings_count", 0) or 0),
                "errors_count": int(plugin_manifest_counts.get("errors_count", 0) or 0),
                "blocking": False,
            },
            "release_signoff": {
                "status": signoff_status,
                "source": args.signoff_report,
                "snapshot": signoff,
            },
            "slo_tightening_guard": {
                "status": slo_tightening_guard_status,
                "source": args.slo_tightening_guard_report,
                "snapshot": slo_tightening_guard,
                "blocking": False,
            },
        },
        "compatibility_matrix": {
            "ecosystem_availability": ecosystem_availability,
            "checks": ecosystem_checks,
        },
        "blocking_reasons": blocking_reasons,
        "notes": [
            "overall_status 为 fail 时建议阻断发布。",
            "overall_status 为 warn/incomplete 时需在发布签字中明确风险接受。",
            "release_profile=production 时，warn/missing/unknown 也会进入阻断理由。",
            "slo_tightening_guard 为观察证据，不直接参与发布阻断。",
        ],
    }

    out = Path(args.output)
    if not out.is_absolute():
        out = PROJECT_ROOT / out
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print("release gate summary generated")
    print(f"- overall_status: {overall}")
    print(f"- profile_gate_status: {profile_gate_status}")
    print(f"- output: {out.as_posix()}")
    return 1 if blocking_reasons else 0


if __name__ == "__main__":
    raise SystemExit(main())

