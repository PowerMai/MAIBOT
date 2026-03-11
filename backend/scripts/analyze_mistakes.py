"""Analyze mistake notebook jsonl files."""

from __future__ import annotations

import json
from collections import Counter, defaultdict
from pathlib import Path


def main() -> None:
    root = Path(__file__).resolve().parents[2] / "knowledge_base" / "learned" / "mistakes"
    counters = Counter()
    by_skill = defaultdict(Counter)

    for p in root.glob("*.jsonl"):
        for line in p.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except Exception:
                continue
            et = row.get("error_type", "unknown")
            skill = row.get("skill_name", p.stem)
            counters[et] += 1
            by_skill[skill][et] += 1

    print("== Error Type Counts ==")
    for k, v in counters.most_common():
        print(f"{k}: {v}")

    print("\n== Per Skill Top Errors ==")
    for skill, c in sorted(by_skill.items()):
        top = ", ".join(f"{k}:{v}" for k, v in c.most_common(3))
        print(f"{skill}: {top}")


if __name__ == "__main__":
    main()
