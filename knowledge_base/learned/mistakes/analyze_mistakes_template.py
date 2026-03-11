"""Template script for analyzing mistake notebook JSONL files.

Run with python_run or local Python:
python knowledge_base/learned/mistakes/analyze_mistakes_template.py
"""

from __future__ import annotations

import json
from collections import Counter, defaultdict
from pathlib import Path


def load_rows(mistakes_dir: Path) -> list[dict]:
    rows: list[dict] = []
    for file in mistakes_dir.glob("*.jsonl"):
        for line in file.read_text(encoding="utf-8").splitlines():
            raw = line.strip()
            if not raw:
                continue
            try:
                obj = json.loads(raw)
            except json.JSONDecodeError:
                continue
            obj["_file"] = file.name
            rows.append(obj)
    return rows


def main() -> None:
    base = Path(__file__).parent
    rows = load_rows(base)
    if not rows:
        print("No mistake rows found.")
        return

    error_counter = Counter(row.get("error_type", "unknown") for row in rows)
    skill_counter = Counter(row.get("skill_name", "unknown") for row in rows)
    cause_counter = Counter(row.get("root_cause", "unknown") for row in rows if row.get("root_cause"))

    print("=== Top error types ===")
    for name, count in error_counter.most_common(10):
        print(f"{name}: {count}")

    print("\n=== Top weak skills ===")
    for name, count in skill_counter.most_common(10):
        print(f"{name}: {count}")

    print("\n=== Top root causes ===")
    for name, count in cause_counter.most_common(10):
        print(f"{name}: {count}")

    fix_by_error: dict[str, Counter] = defaultdict(Counter)
    for row in rows:
        err = row.get("error_type", "unknown")
        fix = str(row.get("suggested_fix", "")).strip()
        if fix:
            fix_by_error[err][fix] += 1

    print("\n=== Suggested fixes by error type ===")
    for err, fixes in fix_by_error.items():
        print(f"[{err}]")
        for fix, count in fixes.most_common(3):
            print(f"  - {fix} ({count})")


if __name__ == "__main__":
    main()
