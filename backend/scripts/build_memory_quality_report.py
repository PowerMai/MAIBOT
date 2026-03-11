#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sqlite3
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Tuple

PROJECT_ROOT = Path(__file__).resolve().parents[2]


def _resolve(path_like: str) -> Path:
    p = Path(path_like)
    return p if p.is_absolute() else (PROJECT_ROOT / p)


def _safe_load_json(raw: Any) -> Dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, (bytes, bytearray)):
        try:
            raw = raw.decode("utf-8", errors="ignore")
        except Exception:
            return {}
    if not isinstance(raw, str):
        return {}
    try:
        data = json.loads(raw)
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _parse_memory_scope(prefix: str) -> Tuple[str, str]:
    parts = str(prefix or "").split(".")
    if len(parts) >= 3 and parts[0] == "memories":
        return parts[1], parts[2]
    if len(parts) >= 2 and parts[0] == "memories_shared":
        return "shared", parts[1]
    return "", ""


def _collect_rows(store_db: Path) -> List[Tuple[str, str, Dict[str, Any]]]:
    if not store_db.exists():
        return []
    conn = sqlite3.connect(store_db.as_posix())
    try:
        cur = conn.cursor()
        rows = cur.execute(
            """
            SELECT prefix, key, value
            FROM store
            WHERE prefix LIKE 'memories.%' OR prefix LIKE 'memories_shared.%'
            """
        ).fetchall()
    finally:
        conn.close()
    out: List[Tuple[str, str, Dict[str, Any]]] = []
    for prefix, key, value in rows:
        out.append((str(prefix or ""), str(key or ""), _safe_load_json(value)))
    return out


def _compute_metrics(rows: List[Tuple[str, str, Dict[str, Any]]]) -> Dict[str, Any]:
    scope_threads: Dict[Tuple[str, str], set[str]] = defaultdict(set)
    preference_values: Dict[Tuple[str, str, str], set[str]] = defaultdict(set)
    false_recall_count = 0
    with_thread_count = 0
    preference_items = 0
    preference_conflicts = 0

    for prefix, key, value in rows:
        workspace_id, user_id = _parse_memory_scope(prefix)
        if not workspace_id or not user_id:
            continue
        source_thread = str(
            value.get("source_thread_id")
            or value.get("thread_id")
            or value.get("source_thread")
            or ""
        ).strip()
        if source_thread:
            with_thread_count += 1
            scope_threads[(workspace_id, user_id)].add(source_thread)

        # 误召回代理：标记类字段命中即计数
        if bool(value.get("false_recall")) or bool(value.get("incorrect")) or bool(value.get("rejected")):
            false_recall_count += 1

        category = str(value.get("category") or "").strip().lower()
        if category == "preference":
            preference_items += 1
            stable_key = str(value.get("preference_key") or key).strip().lower()
            stable_val = json.dumps(value.get("preference_value", value), ensure_ascii=False, sort_keys=True)
            pref_scope_key = (workspace_id, user_id, stable_key)
            preference_values[pref_scope_key].add(stable_val)

    for vals in preference_values.values():
        if len(vals) > 1:
            preference_conflicts += 1

    scope_count = len(scope_threads)
    multi_thread_scope_count = sum(1 for ts in scope_threads.values() if len(ts) >= 2)
    total_rows = len(rows)

    multi_thread_scope_ratio = (
        round(multi_thread_scope_count / scope_count, 4) if scope_count > 0 else None
    )
    cross_session_hit_rate = (
        round(with_thread_count / total_rows, 4) if total_rows > 0 else None
    )
    false_recall_rate = (
        round(false_recall_count / total_rows, 4) if total_rows > 0 else None
    )
    preference_stability_rate = (
        round(1 - (preference_conflicts / max(1, len(preference_values))), 4)
        if preference_values
        else None
    )

    return {
        "memory_rows": total_rows,
        "scopes": scope_count,
        "rows_with_source_thread": with_thread_count,
        "multi_thread_scope_count": multi_thread_scope_count,
        "preference_items": preference_items,
        "preference_scopes": len(preference_values),
        "preference_conflicts": preference_conflicts,
        "cross_session_hit_rate": cross_session_hit_rate,
        "multi_thread_scope_ratio": multi_thread_scope_ratio,
        "false_recall_rate": false_recall_rate,
        "preference_stability_rate": preference_stability_rate,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Build memory quality report")
    parser.add_argument("--store-db", default="data/store.db")
    parser.add_argument("--output-json", default="backend/data/memory_quality_report.json")
    parser.add_argument("--min-memory-rows", type=int, default=20)
    parser.add_argument("--min-cross-session-hit-rate", type=float, default=0.5)
    parser.add_argument("--max-false-recall-rate", type=float, default=0.15)
    parser.add_argument("--min-preference-stability-rate", type=float, default=0.8)
    args = parser.parse_args()

    rows = _collect_rows(_resolve(args.store_db))
    metrics = _compute_metrics(rows)
    warnings: List[str] = []

    memory_rows = int(metrics.get("memory_rows") or 0)
    cross_session_hit_rate = metrics.get("cross_session_hit_rate")
    false_recall_rate = metrics.get("false_recall_rate")
    preference_stability_rate = metrics.get("preference_stability_rate")

    if memory_rows < int(args.min_memory_rows):
        warnings.append(f"insufficient_data: memory_rows<{int(args.min_memory_rows)}")
    if cross_session_hit_rate is not None and float(cross_session_hit_rate) < float(args.min_cross_session_hit_rate):
        warnings.append("cross_session_hit_rate_below_threshold")
    if false_recall_rate is not None and float(false_recall_rate) > float(args.max_false_recall_rate):
        warnings.append("false_recall_rate_above_threshold")
    if (
        preference_stability_rate is not None
        and float(preference_stability_rate) < float(args.min_preference_stability_rate)
    ):
        warnings.append("preference_stability_rate_below_threshold")

    status = "pass" if not warnings else "warn"
    out = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "status": status,
        "metrics": metrics,
        "thresholds": {
            "min_memory_rows": int(args.min_memory_rows),
            "min_cross_session_hit_rate": float(args.min_cross_session_hit_rate),
            "max_false_recall_rate": float(args.max_false_recall_rate),
            "min_preference_stability_rate": float(args.min_preference_stability_rate),
        },
        "warnings": warnings,
    }

    output = _resolve(args.output_json)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("memory quality report built")
    print(f"- status: {status}")
    print(f"- output: {output.as_posix()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

