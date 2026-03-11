#!/usr/bin/env python3
"""Export distillation samples into training/few-shot datasets."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def load_rows(path: Path) -> list[dict]:
    rows = []
    if not path.exists():
        return rows
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except Exception:
            continue
    return rows


def main() -> None:
    parser = argparse.ArgumentParser(description="Export distillation dataset")
    parser.add_argument("--input", default="knowledge_base/learned/distillation_samples.jsonl")
    parser.add_argument("--output", default="knowledge_base/learned/distillation_train.jsonl")
    parser.add_argument("--max", type=int, default=2000)
    args = parser.parse_args()

    in_path = Path(args.input).resolve()
    out_path = Path(args.output).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    rows = load_rows(in_path)[-max(1, args.max):]
    converted = []
    for r in rows:
        inp = str(r.get("compressed_input", "") or "").strip()
        out = str(r.get("strong_output", "") or "").strip()
        if not inp or not out:
            continue
        converted.append(
            {
                "messages": [
                    {"role": "user", "content": inp},
                    {"role": "assistant", "content": out},
                ],
                "meta": {
                    "model_id": r.get("model_id"),
                    "tier": r.get("tier"),
                    "timestamp": r.get("timestamp"),
                },
            }
        )

    with out_path.open("w", encoding="utf-8") as f:
        for row in converted:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    print({"status": "ok", "input_rows": len(rows), "output_rows": len(converted), "output": str(out_path)})


if __name__ == "__main__":
    main()

