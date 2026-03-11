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
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        s = line.strip()
        if not s:
            continue
        try:
            obj = json.loads(s)
            if isinstance(obj, dict):
                rows.append(obj)
        except Exception:
            continue
    return rows


def _append_jsonl(path: Path, row: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")


def _dim_map(card: Dict[str, Any]) -> Dict[str, float]:
    out: Dict[str, float] = {}
    dims = card.get("dimensions") if isinstance(card.get("dimensions"), list) else []
    for row in dims:
        if not isinstance(row, dict):
            continue
        name = str(row.get("name") or "").strip()
        if not name:
            continue
        try:
            out[name] = float(row.get("score_0_to_5", 0.0) or 0.0)
        except Exception:
            out[name] = 0.0
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description="Build parity trend report")
    parser.add_argument("--parity-scorecard-json", default="backend/data/parity_scorecard.json")
    parser.add_argument("--history-jsonl", default="backend/data/parity_scorecard_history.jsonl")
    parser.add_argument("--output-json", default="backend/data/parity_trend_report.json")
    parser.add_argument("--score-regression-threshold", type=float, default=-2.0)
    parser.add_argument("--dimension-regression-threshold", type=float, default=-0.5)
    args = parser.parse_args()

    card_path = _resolve(args.parity_scorecard_json)
    hist_path = _resolve(args.history_jsonl)
    out_path = _resolve(args.output_json)

    card = _read_json(card_path)
    if not card:
        raise SystemExit("parity_scorecard.json missing or invalid")

    current_score = float(card.get("overall_score_100", 0.0) or 0.0)
    current_level = str(card.get("overall_level") or "unknown")
    current_generated_at = str(card.get("generated_at") or datetime.now(timezone.utc).isoformat())
    current_dim = _dim_map(card)

    history = _read_jsonl(hist_path)
    previous = history[-1] if history else {}
    previous_score = float(previous.get("overall_score_100", 0.0) or 0.0) if previous else None
    previous_level = str(previous.get("overall_level") or "") if previous else None
    previous_dim = {str(k): float(v) for k, v in (previous.get("dimensions") or {}).items()} if previous else {}

    delta_score = None if previous_score is None else round(current_score - previous_score, 3)
    dim_deltas: Dict[str, float] = {}
    for name, val in current_dim.items():
        if name in previous_dim:
            dim_deltas[name] = round(val - previous_dim[name], 3)

    regressions = [
        f"{k}:{v}"
        for k, v in dim_deltas.items()
        if float(v) <= float(args.dimension_regression_threshold)
    ]
    score_regressed = previous_score is not None and float(delta_score or 0.0) <= float(args.score_regression_threshold)
    regression_detected = bool(score_regressed or regressions)

    trend_status = "regression" if regression_detected else ("first_run" if previous_score is None else "improving_or_stable")
    out = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "status": trend_status,
        "current": {
            "generated_at": current_generated_at,
            "overall_score_100": current_score,
            "overall_level": current_level,
        },
        "previous": {
            "overall_score_100": previous_score,
            "overall_level": previous_level,
        },
        "delta": {
            "overall_score_100": delta_score,
            "dimensions": dim_deltas,
        },
        "regression": {
            "detected": regression_detected,
            "score_regressed": score_regressed,
            "dimension_regressions": regressions,
            "thresholds": {
                "score": float(args.score_regression_threshold),
                "dimension": float(args.dimension_regression_threshold),
            },
        },
    }

    history_row = {
        "generated_at": current_generated_at,
        "overall_score_100": current_score,
        "overall_level": current_level,
        "dimensions": current_dim,
    }
    _append_jsonl(hist_path, history_row)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("parity trend report built")
    print(f"- status: {trend_status}")
    print(f"- output: {out_path.as_posix()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
