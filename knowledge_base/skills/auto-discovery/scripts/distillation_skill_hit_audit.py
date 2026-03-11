#!/usr/bin/env python3
"""Audit skill-hit signals from distillation samples."""

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


def summarize_skill_hits(rows: list[dict], target_skill: str, recent_n: int) -> dict:
    target = target_skill.strip().lower()
    window = rows[-max(1, recent_n):] if rows else []
    total = len(window)
    hit = 0
    by_hint: dict[str, int] = defaultdict(int)
    by_tool: dict[str, int] = defaultdict(int)

    for row in window:
        md = row.get("metadata", {}) or {}
        hints = [str(x).lower() for x in (md.get("skill_hints") or []) if str(x).strip()]
        tools = [str(x) for x in (md.get("tool_names") or []) if str(x).strip()]
        for h in hints:
            by_hint[h] += 1
        for t in tools:
            by_tool[t] += 1
        if any(target in h for h in hints):
            hit += 1

    return {
        "status": "ok",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "target_skill": target_skill,
        "recent_window": total,
        "hit_count": hit,
        "hit_rate": round(hit / total, 4) if total > 0 else 0.0,
        "by_skill_hint": dict(sorted(by_hint.items(), key=lambda x: x[1], reverse=True)),
        "by_tool_name_top10": dict(sorted(by_tool.items(), key=lambda x: x[1], reverse=True)[:10]),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Audit distillation skill hit rate")
    parser.add_argument("--input", default="knowledge_base/learned/distillation_samples.jsonl")
    parser.add_argument("--target-skill", default="foundation/auto-discovery")
    parser.add_argument("--recent-n", type=int, default=200)
    parser.add_argument("--output-json", default="knowledge_base/learned/auto_upgrade/distillation_skill_hit_audit.json")
    parser.add_argument("--output-md", default="knowledge_base/learned/auto_upgrade/distillation_skill_hit_audit.md")
    args = parser.parse_args()

    root = _find_project_root(Path(__file__).resolve().parent)
    input_path = (root / args.input).resolve() if not Path(args.input).is_absolute() else Path(args.input).resolve()
    out_json = (root / args.output_json).resolve() if not Path(args.output_json).is_absolute() else Path(args.output_json).resolve()
    out_md = (root / args.output_md).resolve() if not Path(args.output_md).is_absolute() else Path(args.output_md).resolve()

    rows = _read_jsonl(input_path)
    summary = summarize_skill_hits(rows, args.target_skill, args.recent_n)
    summary["input"] = str(input_path)
    _write_json(out_json, summary)

    md_lines = [
        "# Distillation Skill Hit Audit",
        "",
        f"- target_skill: `{summary.get('target_skill', '')}`",
        f"- recent_window: `{summary.get('recent_window', 0)}`",
        f"- hit_count: `{summary.get('hit_count', 0)}`",
        f"- hit_rate: `{summary.get('hit_rate', 0)}`",
        "",
        "## Skill Hints",
    ]
    for k, v in (summary.get("by_skill_hint", {}) or {}).items():
        md_lines.append(f"- {k}: {v}")
    md_lines.append("")
    md_lines.append("## Tool Names Top10")
    for k, v in (summary.get("by_tool_name_top10", {}) or {}).items():
        md_lines.append(f"- {k}: {v}")
    md_lines.append("")
    out_md.parent.mkdir(parents=True, exist_ok=True)
    out_md.write_text("\n".join(md_lines), encoding="utf-8")

    print(json.dumps({"status": "ok", "output_json": str(out_json), "output_md": str(out_md)}, ensure_ascii=False))


if __name__ == "__main__":
    main()

