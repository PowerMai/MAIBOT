#!/usr/bin/env python3
"""
评估“云端样本 -> 本地蒸馏数据”最小闭环健康度。
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[2]


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        raw = line.strip()
        if not raw:
            continue
        try:
            row = json.loads(raw)
        except Exception:
            continue
        if isinstance(row, dict):
            rows.append(row)
    return rows


def evaluate(rows: list[dict[str, Any]]) -> dict[str, Any]:
    total = len(rows)
    if total == 0:
        return {
            "status": "warn",
            "metrics": {
                "sample_count": 0,
                "avg_quality_score": 0.0,
                "with_plan_ratio": 0.0,
                "with_tool_sequence_ratio": 0.0,
                "with_human_feedback_ratio": 0.0,
            },
            "violations": ["no_samples"],
        }

    with_plan = 0
    with_tools = 0
    with_feedback = 0
    quality_sum = 0.0
    quality_count = 0
    for row in rows:
        if str(row.get("plan_summary") or "").strip():
            with_plan += 1
        tools = row.get("tool_sequence", [])
        if isinstance(tools, list) and len(tools) > 0:
            with_tools += 1
        if row.get("human_feedback"):
            with_feedback += 1
        meta = row.get("meta", {})
        if isinstance(meta, dict):
            q = meta.get("quality_score")
            if isinstance(q, (int, float)):
                quality_sum += float(q)
                quality_count += 1

    avg_quality = round(quality_sum / quality_count, 4) if quality_count else 0.0
    with_plan_ratio = round(with_plan / total, 4)
    with_tool_ratio = round(with_tools / total, 4)
    with_feedback_ratio = round(with_feedback / total, 4)

    violations: list[str] = []
    if total < 20:
        violations.append("sample_count_lt_20")
    if with_plan_ratio < 0.8:
        violations.append("plan_ratio_lt_0.8")
    if with_tool_ratio < 0.8:
        violations.append("tool_sequence_ratio_lt_0.8")
    if avg_quality < 6.5:
        violations.append("avg_quality_lt_6.5")

    status = "pass" if not violations else ("warn" if "sample_count_lt_20" in violations and len(violations) == 1 else "fail")
    return {
        "status": status,
        "metrics": {
            "sample_count": total,
            "avg_quality_score": avg_quality,
            "with_plan_ratio": with_plan_ratio,
            "with_tool_sequence_ratio": with_tool_ratio,
            "with_human_feedback_ratio": with_feedback_ratio,
        },
        "violations": violations,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="评估本地蒸馏闭环健康度")
    parser.add_argument(
        "--input",
        default="backend/data/distillation_training_samples.jsonl",
        help="训练样本输入路径",
    )
    parser.add_argument(
        "--report-json",
        default="backend/data/distillation_eval_report.json",
        help="评测报告输出路径",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="严格模式：status!=pass 返回非 0",
    )
    args = parser.parse_args()

    input_path = PROJECT_ROOT / str(args.input)
    report_path = PROJECT_ROOT / str(args.report_json)
    rows = _read_jsonl(input_path)
    report = evaluate(rows)
    report["input"] = str(args.input)
    report["strict"] = bool(args.strict)

    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print("distillation loop evaluation done")
    print(f"- status: {report['status']}")
    print(f"- sample_count: {report['metrics']['sample_count']}")
    print(f"- report: {report_path.as_posix()}")
    if args.strict and report["status"] != "pass":
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
