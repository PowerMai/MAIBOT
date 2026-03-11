#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

PROJECT_ROOT = Path(__file__).resolve().parents[2]


def _resolve(path_like: str) -> Path:
    p = Path(path_like)
    return p if p.is_absolute() else (PROJECT_ROOT / p)


def _read_json(path: Path) -> Dict[str, Any]:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _read_jsonl(path: Path) -> List[Dict[str, Any]]:
    if not path.exists():
        return []
    rows: List[Dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if not s:
            continue
        try:
            row = json.loads(s)
        except Exception:
            continue
        if isinstance(row, dict):
            rows.append(row)
    return rows


def _append_jsonl(path: Path, row: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")


def _to_float(value: Any) -> float | None:
    try:
        if value is None:
            return None
        return float(value)
    except Exception:
        return None


def main() -> int:
    parser = argparse.ArgumentParser(description="Build memory quality trend report")
    parser.add_argument("--memory-quality-json", default="backend/data/memory_quality_report.json")
    parser.add_argument("--history-jsonl", default="backend/data/memory_quality_history.jsonl")
    parser.add_argument("--output-json", default="backend/data/memory_quality_trend_report.json")
    parser.add_argument("--regression-threshold-cross-session-hit-rate", type=float, default=-0.05)
    parser.add_argument("--regression-threshold-false-recall-rate", type=float, default=0.03)
    parser.add_argument("--regression-threshold-preference-stability-rate", type=float, default=-0.05)
    args = parser.parse_args()

    report = _read_json(_resolve(args.memory_quality_json))
    if not report:
        raise SystemExit("memory_quality_report missing or invalid")

    metrics = report.get("metrics") if isinstance(report.get("metrics"), dict) else {}
    cur_cross = _to_float(metrics.get("cross_session_hit_rate"))
    cur_false = _to_float(metrics.get("false_recall_rate"))
    cur_pref = _to_float(metrics.get("preference_stability_rate"))
    cur_rows = int(metrics.get("memory_rows") or 0)
    cur_status = str(report.get("status") or "unknown")
    cur_generated_at = str(report.get("generated_at") or datetime.now(timezone.utc).isoformat())

    hist_path = _resolve(args.history_jsonl)
    history = _read_jsonl(hist_path)
    prev = history[-1] if history else {}

    prev_cross = _to_float(prev.get("cross_session_hit_rate")) if prev else None
    prev_false = _to_float(prev.get("false_recall_rate")) if prev else None
    prev_pref = _to_float(prev.get("preference_stability_rate")) if prev else None

    delta_cross = None if (cur_cross is None or prev_cross is None) else round(cur_cross - prev_cross, 4)
    delta_false = None if (cur_false is None or prev_false is None) else round(cur_false - prev_false, 4)
    delta_pref = None if (cur_pref is None or prev_pref is None) else round(cur_pref - prev_pref, 4)

    regressions: List[str] = []
    if delta_cross is not None and delta_cross <= float(args.regression_threshold_cross_session_hit_rate):
        regressions.append(f"cross_session_hit_rate:{delta_cross}")
    if delta_false is not None and delta_false >= float(args.regression_threshold_false_recall_rate):
        regressions.append(f"false_recall_rate:{delta_false}")
    if delta_pref is not None and delta_pref <= float(args.regression_threshold_preference_stability_rate):
        regressions.append(f"preference_stability_rate:{delta_pref}")

    trend_status = "first_run" if not prev else ("regression" if regressions else "improving_or_stable")
    out = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "status": trend_status,
        "current": {
            "generated_at": cur_generated_at,
            "status": cur_status,
            "memory_rows": cur_rows,
            "cross_session_hit_rate": cur_cross,
            "false_recall_rate": cur_false,
            "preference_stability_rate": cur_pref,
        },
        "previous": {
            "cross_session_hit_rate": prev_cross,
            "false_recall_rate": prev_false,
            "preference_stability_rate": prev_pref,
        },
        "delta": {
            "cross_session_hit_rate": delta_cross,
            "false_recall_rate": delta_false,
            "preference_stability_rate": delta_pref,
        },
        "regression": {
            "detected": bool(regressions),
            "items": regressions,
            "thresholds": {
                "cross_session_hit_rate": float(args.regression_threshold_cross_session_hit_rate),
                "false_recall_rate": float(args.regression_threshold_false_recall_rate),
                "preference_stability_rate": float(args.regression_threshold_preference_stability_rate),
            },
        },
    }

    _append_jsonl(
        hist_path,
        {
            "generated_at": cur_generated_at,
            "status": cur_status,
            "memory_rows": cur_rows,
            "cross_session_hit_rate": cur_cross,
            "false_recall_rate": cur_false,
            "preference_stability_rate": cur_pref,
        },
    )
    output = _resolve(args.output_json)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("memory quality trend report built")
    print(f"- status: {trend_status}")
    print(f"- output: {output.as_posix()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

