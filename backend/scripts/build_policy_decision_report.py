#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from backend.engine.architecture.tool_policy_contract import (
    ALL_POLICY_REASON_CODES,
    POLICY_LAYER_CODES,
)

PROJECT_ROOT = Path(__file__).resolve().parents[2]


def _parse_ts(value: str | None) -> datetime | None:
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


def _resolve(path_like: str) -> Path:
    p = Path(path_like)
    return p if p.is_absolute() else PROJECT_ROOT / p


def main() -> int:
    parser = argparse.ArgumentParser(description="Build policy decision observability report")
    parser.add_argument("--events-jsonl", default="backend/data/policy_decision_events.jsonl")
    parser.add_argument("--window-minutes", type=int, default=1440)
    parser.add_argument("--output-json", default="backend/data/policy_decision_report.json")
    args = parser.parse_args()

    now = datetime.now(timezone.utc)
    window_minutes = max(1, int(args.window_minutes))
    lower_bound = now - timedelta(minutes=window_minutes)
    events_path = _resolve(args.events_jsonl)

    by_layer: Counter[str] = Counter()
    by_reason: Counter[str] = Counter()
    invalid_rows = 0
    unknown_layer_rows = 0
    unknown_reason_rows = 0
    total_rows = 0
    in_window_rows = 0

    if events_path.exists():
        for raw in events_path.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = raw.strip()
            if not line:
                continue
            total_rows += 1
            try:
                row = json.loads(line)
            except Exception:
                invalid_rows += 1
                continue
            if not isinstance(row, dict):
                invalid_rows += 1
                continue
            ts = _parse_ts(str(row.get("timestamp") or ""))
            if ts is None or ts < lower_bound:
                continue
            in_window_rows += 1
            layer = str(row.get("policy_layer") or "").strip()
            reason_code = str(row.get("reason_code") or "").strip()
            if layer not in POLICY_LAYER_CODES:
                unknown_layer_rows += 1
            if reason_code not in ALL_POLICY_REASON_CODES:
                unknown_reason_rows += 1
            if layer:
                by_layer[layer] += 1
            if reason_code:
                by_reason[reason_code] += 1

    status = "pass"
    if invalid_rows > 0:
        status = "fail"
    elif unknown_layer_rows > 0 or unknown_reason_rows > 0:
        status = "warn"

    report: dict[str, Any] = {
        "generated_at": now.isoformat(),
        "status": status,
        "window_minutes": window_minutes,
        "source": events_path.as_posix(),
        "metrics": {
            "total_rows": total_rows,
            "in_window_rows": in_window_rows,
            "invalid_rows": invalid_rows,
            "unknown_layer_rows": unknown_layer_rows,
            "unknown_reason_rows": unknown_reason_rows,
            "denied_total": sum(by_reason.values()),
        },
        "schema": {
            "policy_layers": sorted(POLICY_LAYER_CODES),
            "reason_codes": sorted(ALL_POLICY_REASON_CODES),
        },
        "by_layer": dict(sorted(by_layer.items(), key=lambda item: item[0])),
        "by_reason_code": dict(sorted(by_reason.items(), key=lambda item: item[0])),
    }

    out = _resolve(args.output_json)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("policy decision report built")
    print(f"- status: {status}")
    print(f"- output: {out.as_posix()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
