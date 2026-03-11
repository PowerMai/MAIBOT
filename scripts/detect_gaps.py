#!/usr/bin/env python3
"""Detect knowledge gaps and output prioritized task candidates."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
LEARNED = PROJECT_ROOT / "knowledge_base" / "learned"
DEFAULT_COVERAGE_REPORT = LEARNED / "audits" / "coverage_report.json"
DEFAULT_OUTPUT = LEARNED / "audits" / "gap_report.json"


def _priority_from_score(score: float) -> str:
    if score >= 0.8:
        return "P0"
    if score >= 0.5:
        return "P1"
    return "P2"


def detect_gaps(coverage_report_path: Path) -> dict:
    if not coverage_report_path.exists():
        return {"ok": False, "error": "coverage_report_not_found", "path": str(coverage_report_path)}
    try:
        report = json.loads(coverage_report_path.read_text(encoding="utf-8"))
    except Exception as exc:
        return {"ok": False, "error": f"coverage_report_parse_failed: {exc}", "path": str(coverage_report_path)}

    missing_entity_types = list(((report.get("missing") or {}).get("entity_types") or []))
    missing_relation_types = list(((report.get("missing") or {}).get("relation_types") or []))
    quality = report.get("quality") or {}
    duplicate_rate = float(quality.get("duplicate_entity_rate_pct") or 0.0)
    dangling_rate = float(quality.get("dangling_relation_rate_pct") or 0.0)

    gaps: list[dict] = []
    for et in missing_entity_types:
        score = 0.7
        gaps.append(
            {
                "gap_type": "missing_entity_type",
                "target": et,
                "impact_score": score,
                "priority": _priority_from_score(score),
                "suggested_task": "kb_web_harvest",
                "owner": "knowledge_engineer",
            }
        )
    for rt in missing_relation_types:
        score = 0.6
        gaps.append(
            {
                "gap_type": "missing_relation_type",
                "target": rt,
                "impact_score": score,
                "priority": _priority_from_score(score),
                "suggested_task": "kb_entity_extract",
                "owner": "knowledge_engineer",
            }
        )
    if duplicate_rate > 5:
        score = min(1.0, duplicate_rate / 20.0)
        gaps.append(
            {
                "gap_type": "high_duplicate_rate",
                "target": f"{duplicate_rate:.2f}%",
                "impact_score": score,
                "priority": _priority_from_score(score),
                "suggested_task": "kb_quality_audit",
                "owner": "knowledge_engineer",
            }
        )
    if dangling_rate > 2:
        score = min(1.0, dangling_rate / 15.0)
        gaps.append(
            {
                "gap_type": "high_dangling_relation_rate",
                "target": f"{dangling_rate:.2f}%",
                "impact_score": score,
                "priority": _priority_from_score(score),
                "suggested_task": "kb_ontology_import",
                "owner": "knowledge_engineer",
            }
        )

    gaps_sorted = sorted(gaps, key=lambda x: x["impact_score"], reverse=True)
    return {
        "ok": True,
        "coverage_report": str(coverage_report_path),
        "gap_count": len(gaps_sorted),
        "gaps": gaps_sorted,
        "summary": {
            "P0": sum(1 for g in gaps_sorted if g["priority"] == "P0"),
            "P1": sum(1 for g in gaps_sorted if g["priority"] == "P1"),
            "P2": sum(1 for g in gaps_sorted if g["priority"] == "P2"),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--coverage-report", default=str(DEFAULT_COVERAGE_REPORT))
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    args = parser.parse_args()

    result = detect_gaps(Path(args.coverage_report))
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
