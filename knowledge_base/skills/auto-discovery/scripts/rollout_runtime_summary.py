#!/usr/bin/env python3
"""Summarize rollout runtime routing telemetry."""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path


def _find_project_root(start: Path) -> Path:
    cur = start.resolve()
    for candidate in [cur] + list(cur.parents):
        if (candidate / "backend").exists() and (candidate / "knowledge_base").exists():
            return candidate
    return start.resolve().parents[5]


def _read_jsonl(path: Path) -> list[dict]:
    rows: list[dict] = []
    if not path.exists():
        return rows
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
            if isinstance(row, dict):
                rows.append(row)
        except Exception:
            continue
    return rows


def _write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _safe_rate(n: int, d: int) -> float:
    if d <= 0:
        return 0.0
    return round(n / d, 4)


def summarize(rows: list[dict], top_n: int = 10) -> dict:
    total = len(rows)
    hit = 0
    stage_stats: dict[str, dict[str, int]] = defaultdict(lambda: {"total": 0, "hit": 0})
    ws_stats: dict[str, dict[str, int]] = defaultdict(lambda: {"total": 0, "hit": 0})

    for row in rows:
        dec = row.get("decision", {}) or {}
        enabled = bool(dec.get("candidate_enabled", False))
        stage = str(dec.get("stage", "unknown") or "unknown")
        ws = str(row.get("workspace_path", "") or "")
        ws_key = ws if ws else "unknown_workspace"

        if enabled:
            hit += 1
        stage_stats[stage]["total"] += 1
        ws_stats[ws_key]["total"] += 1
        if enabled:
            stage_stats[stage]["hit"] += 1
            ws_stats[ws_key]["hit"] += 1

    stage_view = {
        k: {
            "total": v["total"],
            "hit": v["hit"],
            "hit_rate": _safe_rate(v["hit"], v["total"]),
        }
        for k, v in stage_stats.items()
    }
    ws_items = sorted(ws_stats.items(), key=lambda x: x[1]["total"], reverse=True)[: max(1, top_n)]
    ws_view = {
        k: {
            "total": v["total"],
            "hit": v["hit"],
            "hit_rate": _safe_rate(v["hit"], v["total"]),
        }
        for k, v in ws_items
    }

    return {
        "status": "ok",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "total_requests": total,
        "candidate_hits": hit,
        "candidate_hit_rate": _safe_rate(hit, total),
        "by_stage": stage_view,
        "by_workspace_top": ws_view,
    }


def write_markdown(path: Path, summary: dict) -> None:
    lines = [
        "# Rollout Runtime Summary",
        "",
        f"- generated_at: `{summary.get('generated_at', '')}`",
        f"- total_requests: `{summary.get('total_requests', 0)}`",
        f"- candidate_hits: `{summary.get('candidate_hits', 0)}`",
        f"- candidate_hit_rate: `{summary.get('candidate_hit_rate', 0)}`",
        "",
        "## By Stage",
    ]
    for stage, v in (summary.get("by_stage", {}) or {}).items():
        lines.append(f"- {stage}: total={v.get('total', 0)}, hit={v.get('hit', 0)}, rate={v.get('hit_rate', 0)}")
    lines.append("")
    lines.append("## By Workspace (Top)")
    for ws, v in (summary.get("by_workspace_top", {}) or {}).items():
        lines.append(f"- {ws}: total={v.get('total', 0)}, hit={v.get('hit', 0)}, rate={v.get('hit_rate', 0)}")
    lines.append("")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description="Summarize rollout runtime telemetry")
    parser.add_argument("--input", default="knowledge_base/learned/auto_upgrade/rollout_runtime.jsonl")
    parser.add_argument("--output-json", default="knowledge_base/learned/auto_upgrade/rollout_runtime_summary.json")
    parser.add_argument("--output-md", default="knowledge_base/learned/auto_upgrade/rollout_runtime_summary.md")
    parser.add_argument("--top-n-workspaces", type=int, default=10)
    args = parser.parse_args()

    root = _find_project_root(Path(__file__).resolve().parent)
    input_path = (root / args.input).resolve() if not Path(args.input).is_absolute() else Path(args.input).resolve()
    out_json = (root / args.output_json).resolve() if not Path(args.output_json).is_absolute() else Path(args.output_json).resolve()
    out_md = (root / args.output_md).resolve() if not Path(args.output_md).is_absolute() else Path(args.output_md).resolve()

    rows = _read_jsonl(input_path)
    summary = summarize(rows, top_n=args.top_n_workspaces)
    summary["input"] = str(input_path)
    _write_json(out_json, summary)
    write_markdown(out_md, summary)
    print(json.dumps({"status": "ok", "input_rows": len(rows), "summary_json": str(out_json), "summary_md": str(out_md)}, ensure_ascii=False))


if __name__ == "__main__":
    main()

