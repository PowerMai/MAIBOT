#!/usr/bin/env python3
"""
校验运营签字材料（release signoff）并输出机器可读报告。
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[2]

REQUIRED_FIELDS = [
    "release_profile",
    "release_version",
    "approved_by",
    "approved_at",
    "checklist_ref",
    "rollback_runbook_ref",
]

REQUIRED_BUSINESS_FIELDS = [
    "business_metrics.activation_rate",
    "business_metrics.conversion_rate",
    "business_metrics.retention_d7",
    "business_metrics.trial_to_paid_days",
]


def _read_json(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def _pick_nested(doc: dict[str, Any], dotted_key: str) -> str:
    cur: Any = doc
    for part in dotted_key.split("."):
        if not isinstance(cur, dict):
            return ""
        cur = cur.get(part)
    return str(cur or "").strip()


def main() -> int:
    parser = argparse.ArgumentParser(description="检查发布签字材料")
    parser.add_argument(
        "--input",
        default="backend/data/release_signoff.json",
        help="签字文件路径",
    )
    parser.add_argument(
        "--report-json",
        default="backend/data/release_signoff_report.json",
        help="校验报告输出路径",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="严格模式：未通过即返回非 0",
    )
    args = parser.parse_args()

    input_path = PROJECT_ROOT / str(args.input)
    report_path = PROJECT_ROOT / str(args.report_json)
    doc = _read_json(input_path)

    missing_fields: list[str] = []
    missing_business_fields: list[str] = []
    errors: list[str] = []
    status = "pass"

    if doc is None:
        status = "fail" if args.strict else "warn"
        errors.append("signoff_file_missing_or_invalid_json")
    else:
        for field in REQUIRED_FIELDS:
            if not str(doc.get(field) or "").strip():
                missing_fields.append(field)
        for field in REQUIRED_BUSINESS_FIELDS:
            if not _pick_nested(doc, field):
                missing_business_fields.append(field)
        if missing_fields:
            status = "fail" if args.strict else "warn"
            errors.append("missing_required_fields")
        if missing_business_fields:
            status = "fail" if args.strict else "warn"
            errors.append("missing_business_fields")
        approved = doc.get("approved")
        if approved is False:
            status = "fail"
            errors.append("approved_is_false")

    report = {
        "status": status,
        "strict": bool(args.strict),
        "input": str(args.input),
        "missing_fields": missing_fields,
        "missing_business_fields": missing_business_fields,
        "errors": errors,
        "snapshot": doc if isinstance(doc, dict) else None,
    }

    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print("release signoff check done")
    print(f"- status: {status}")
    print(f"- report: {report_path.as_posix()}")
    if args.strict and status != "pass":
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
