#!/usr/bin/env python3
"""
从 UI 流式采样（jsonl）构建聚合快照，供 release drill/report 使用。
"""

from __future__ import annotations

import argparse
import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

PROJECT_ROOT = Path(__file__).resolve().parents[2]


def _resolve(path_like: str) -> Path:
    p = Path(path_like)
    return p if p.is_absolute() else (PROJECT_ROOT / p)


def _read_jsonl(path: Path) -> List[Dict[str, Any]]:
    if not path.exists():
        return []
    rows: List[Dict[str, Any]] = []
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            raw = line.strip()
            if not raw:
                continue
            try:
                item = json.loads(raw)
                if isinstance(item, dict):
                    rows.append(item)
            except Exception:
                continue
    except Exception:
        return []
    return rows


def _to_float(value: Any) -> float | None:
    try:
        num = float(value)
        return num if math.isfinite(num) else None
    except Exception:
        return None


def _percentile(values: List[float], p: float) -> float | None:
    if not values:
        return None
    arr = sorted(values)
    if len(arr) == 1:
        return arr[0]
    rank = max(0.0, min(1.0, p)) * (len(arr) - 1)
    lo = int(rank)
    hi = min(lo + 1, len(arr) - 1)
    w = rank - lo
    return arr[lo] * (1.0 - w) + arr[hi] * w


def _first_non_null(*values: Any) -> Any:
    for value in values:
        if value is not None:
            return value
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description="Build UI stream metrics snapshot")
    parser.add_argument(
        "--input-jsonl",
        default="backend/data/ui_stream_metrics_samples.jsonl",
        help="UI 流式采样 jsonl 路径",
    )
    parser.add_argument(
        "--output-json",
        default="backend/data/ui_stream_metrics_snapshot.json",
        help="UI 流式快照输出路径",
    )
    parser.add_argument(
        "--max-rows",
        type=int,
        default=500,
        help="最多读取最近 N 条样本（默认 500）",
    )
    args = parser.parse_args()

    in_path = _resolve(args.input_jsonl)
    out_path = _resolve(args.output_json)
    rows = _read_jsonl(in_path)
    if args.max_rows > 0 and len(rows) > args.max_rows:
        rows = rows[-args.max_rows :]

    ttft = [_to_float(r.get("ttft_ms")) for r in rows]
    ttft = [x for x in ttft if x is not None]
    first_payload = [_to_float(r.get("frontend_first_payload_ms")) for r in rows]
    first_payload = [x for x in first_payload if x is not None]
    inter_gap = [
        _to_float(_first_non_null(r.get("max_inter_token_gap_ms"), r.get("frontend_max_inter_payload_gap_ms")))
        for r in rows
    ]
    inter_gap = [x for x in inter_gap if x is not None]
    fallback_count = [_to_float(r.get("message_channel_fallback_count")) for r in rows]
    fallback_count = [x for x in fallback_count if x is not None]
    partial_suppressed_count = [_to_float(r.get("partial_suppressed_count")) for r in rows]
    partial_suppressed_count = [x for x in partial_suppressed_count if x is not None]

    metrics: Dict[str, Any] = {
        "sample_count": len(rows),
        "ttft_valid_count": len(ttft),
        "frontend_first_payload_valid_count": len(first_payload),
        "max_inter_token_gap_valid_count": len(inter_gap),
        "message_channel_fallback_valid_count": len(fallback_count),
        "partial_suppressed_valid_count": len(partial_suppressed_count),
        "ttft_ms_p50": _percentile(ttft, 0.50),
        "ttft_ms_p95": _percentile(ttft, 0.95),
        "frontend_first_payload_ms_p50": _percentile(first_payload, 0.50),
        "frontend_first_payload_ms_p95": _percentile(first_payload, 0.95),
        "max_inter_token_gap_ms_p50": _percentile(inter_gap, 0.50),
        "max_inter_token_gap_ms_p95": _percentile(inter_gap, 0.95),
        "message_channel_fallback_count_p50": _percentile(fallback_count, 0.50),
        "message_channel_fallback_count_p95": _percentile(fallback_count, 0.95),
        "partial_suppressed_count_p50": _percentile(partial_suppressed_count, 0.50),
        "partial_suppressed_count_p95": _percentile(partial_suppressed_count, 0.95),
    }

    payload: Dict[str, Any] = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "status": "pass" if rows else "no_data",
        "input_path": in_path.as_posix(),
        "metrics": metrics,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")

    print("ui stream metrics snapshot built")
    print(f"- input: {in_path.as_posix()}")
    print(f"- output: {out_path.as_posix()}")
    print(f"- sample_count: {len(rows)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

