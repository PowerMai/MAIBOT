#!/usr/bin/env python3
"""
Normalize path references to the latest sales knowledge path conventions.

Usage:
  python backend/tools/upgrade/normalize_path_references.py --dry-run
  python backend/tools/upgrade/normalize_path_references.py --apply
"""

from __future__ import annotations

import argparse
import re
from pathlib import Path
from typing import Iterable


PROJECT_ROOT = Path(__file__).resolve().parents[3]

# Only scan editable source/docs areas; skip build artifacts.
SCAN_DIRS = [
    PROJECT_ROOT / "backend",
    PROJECT_ROOT / "knowledge_base",
]

SCAN_EXTENSIONS = {".md", ".json", ".jsonl", ".py", ".yaml", ".yml", ".txt"}

# Ordered rules (specific -> generic)
RULES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"knowledge_base/domain/sales"), "knowledge_base/global/domain/sales"),
    (re.compile(r'("target_scope"\s*:\s*")domain/sales(")'), r"\1global/domain/sales\2"),
    (re.compile(r"(target_scope\s*:\s*)domain/sales\b"), r"\1global/domain/sales"),
    (re.compile(r'(\bsource\s*=\s*")domain/sales/'), r"\1global/domain/sales/"),
]


def _iter_files(roots: Iterable[Path]) -> Iterable[Path]:
    for root in roots:
        if not root.exists():
            continue
        for p in root.rglob("*"):
            if not p.is_file():
                continue
            if p.suffix.lower() not in SCAN_EXTENSIONS:
                continue
            # Ignore common generated/build/cache directories
            if any(part in {"dist", "build", ".next", "__pycache__", ".venv"} for part in p.parts):
                continue
            # Avoid self-rewriting / tooling churn
            if p.name == "normalize_path_references.py":
                continue
            yield p


def _replace_text(text: str) -> tuple[str, int]:
    updated = text
    total = 0
    for pattern, repl in RULES:
        updated, n = pattern.subn(repl, updated)
        total += n
    return updated, total


def main() -> int:
    parser = argparse.ArgumentParser(description="Normalize legacy sales path references.")
    parser.add_argument("--apply", action="store_true", help="Write modifications to files.")
    parser.add_argument("--dry-run", action="store_true", help="Preview modifications (default).")
    args = parser.parse_args()

    apply_mode = bool(args.apply)
    changed_files = 0
    changed_refs = 0

    for path in _iter_files(SCAN_DIRS):
        try:
            original = path.read_text(encoding="utf-8")
        except Exception:
            continue
        updated, count = _replace_text(original)
        if count <= 0 or updated == original:
            continue

        changed_files += 1
        changed_refs += count
        rel = path.relative_to(PROJECT_ROOT)
        print(f"[change] {rel} ({count})")

        if apply_mode:
            path.write_text(updated, encoding="utf-8")

    mode = "apply" if apply_mode else "dry-run"
    print(f"[summary] mode={mode} files={changed_files} references={changed_refs}")
    if not apply_mode:
        print("Tip: run with --apply to persist changes.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
