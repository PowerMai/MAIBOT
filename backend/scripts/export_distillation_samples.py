#!/usr/bin/env python3
"""
将 distillation_middleware 采集样本整理为本地蒸馏训练集（不改主推理链路）。
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
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
            obj = json.loads(raw)
        except Exception:
            continue
        if isinstance(obj, dict):
            rows.append(obj)
    return rows


def _extract_plan_excerpt(text: str) -> str:
    lines = [ln.strip() for ln in (text or "").splitlines() if ln.strip()]
    if not lines:
        return ""
    markers = ("计划", "步骤", "plan", "next step", "执行路径")
    for idx, ln in enumerate(lines):
        low = ln.lower()
        if any(m in low for m in markers):
            return "\n".join(lines[idx : idx + 6])[:1200]
    return "\n".join(lines[:4])[:800]


def build_dataset(
    source_rows: list[dict[str, Any]],
    min_quality: float = 6.0,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    output_rows: list[dict[str, Any]] = []
    tier_counter: Counter[str] = Counter()
    reason_counter: Counter[str] = Counter()

    for row in source_rows:
        quality = float(row.get("quality_score", 0.0) or 0.0)
        if quality < min_quality:
            continue
        prompt = str(row.get("compressed_input") or "").strip()
        answer = str(row.get("strong_output") or "").strip()
        if len(prompt) < 8 or len(answer) < 40:
            continue

        metadata = row.get("metadata", {})
        if not isinstance(metadata, dict):
            metadata = {}
        tool_names = metadata.get("tool_names", [])
        if not isinstance(tool_names, list):
            tool_names = []
        pref = row.get("preference_pair", {})
        if not isinstance(pref, dict):
            pref = {}

        tier = str(row.get("tier") or "unknown").strip().lower()
        reason = str(metadata.get("capture_reason") or "unknown").strip().lower()
        tier_counter[tier] += 1
        reason_counter[reason] += 1

        output_rows.append(
            {
                "task_input": prompt,
                "plan_summary": _extract_plan_excerpt(answer),
                "tool_sequence": [str(x).strip() for x in tool_names if str(x).strip()],
                "model_output": answer,
                "human_feedback": str(pref.get("chosen") or "").strip() or None,
                "meta": {
                    "timestamp": row.get("timestamp"),
                    "model_id": row.get("model_id"),
                    "tier": tier,
                    "quality_score": round(quality, 3),
                    "capture_reason": reason,
                },
            }
        )

    stats = {
        "source_count": len(source_rows),
        "selected_count": len(output_rows),
        "selection_rate": round((len(output_rows) / len(source_rows)), 4) if source_rows else 0.0,
        "tier_distribution": dict(tier_counter),
        "capture_reason_distribution": dict(reason_counter),
    }
    return output_rows, stats


def main() -> int:
    parser = argparse.ArgumentParser(description="导出本地蒸馏训练样本")
    parser.add_argument(
        "--input",
        default="knowledge_base/learned/distillation_samples.jsonl",
        help="原始样本路径",
    )
    parser.add_argument(
        "--output",
        default="backend/data/distillation_training_samples.jsonl",
        help="导出训练样本路径",
    )
    parser.add_argument(
        "--report-json",
        default="backend/data/distillation_collection_report.json",
        help="采集报告路径",
    )
    parser.add_argument(
        "--min-quality",
        type=float,
        default=6.0,
        help="最小质量分过滤阈值",
    )
    args = parser.parse_args()

    source_path = PROJECT_ROOT / str(args.input)
    output_path = PROJECT_ROOT / str(args.output)
    report_path = PROJECT_ROOT / str(args.report_json)

    source_rows = _read_jsonl(source_path)
    dataset, stats = build_dataset(source_rows, min_quality=float(args.min_quality))

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as f:
        for row in dataset:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    report = {
        "status": "pass" if stats["selected_count"] > 0 else "warn",
        "input": str(args.input),
        "output": str(args.output),
        "metrics": stats,
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print("distillation sample export done")
    print(f"- selected_count: {stats['selected_count']}")
    print(f"- output: {output_path.as_posix()}")
    print(f"- report: {report_path.as_posix()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
