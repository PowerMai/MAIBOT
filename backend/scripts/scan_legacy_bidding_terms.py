#!/usr/bin/env python3
"""扫描代码面的遗留语义标识（仅报告，不自动修改）。"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Iterable, List, Set, Tuple


PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_PATTERNS = [
    r"\bbid_agent\b",
    r"\bknowledge_engineer\b",
    r"plugins/bidding",
    r"plugins/bid_agent",
    r"marketing/bidding",
    r"global/domain/bidding",
]
DEFAULT_EXTS = {".md", ".txt", ".py", ".ts", ".tsx", ".js", ".jsx", ".json", ".yaml", ".yml"}
DEFAULT_EXCLUDES = {
    ".git",
    ".venv",
    "node_modules",
    "dist",
    "release",
    "backend/data",
    "backend/tmp",
    "backend/docs",
    "backend/scripts/scan_legacy_bidding_terms.py",
    "frontend/desktop/dist",
    "frontend/desktop/node_modules",
    "knowledge_base",
    "workspace",
    "docs",
    "outputs",
    "uploads",
    "logs",
    "tmp",
}
DEFAULT_INCLUDE_ROOTS = [
    "backend",
    "frontend",
    "plugins",
    ".github",
    "Makefile",
    "package.json",
    "langgraph.json",
]


def _should_skip(path: Path) -> bool:
    raw = str(path.as_posix())
    for ex in DEFAULT_EXCLUDES:
        if raw == ex or raw.startswith(ex + "/"):
            return True
    return False


def _iter_files(root: Path, include_roots: List[str]) -> Iterable[Path]:
    include_set: Set[Path] = set()
    for item in include_roots:
        p = (root / item).resolve()
        if p.exists():
            include_set.add(p)
    for base in include_set:
        if base.is_file():
            p = base
            rel = p.relative_to(root)
            if not _should_skip(rel) and p.suffix.lower() in DEFAULT_EXTS:
                yield p
            continue
        for p in base.rglob("*"):
            if not p.is_file():
                continue
            rel = p.relative_to(root)
            if _should_skip(rel):
                continue
            if p.suffix.lower() in DEFAULT_EXTS:
                yield p


def _sorted_unique_files(paths: Iterable[Path]) -> List[Path]:
    uniq = {p.resolve(): p for p in paths}
    return [uniq[k] for k in sorted(uniq.keys(), key=lambda x: x.as_posix())]


def _scan_paths(root: Path, regexes: List[re.Pattern[str]], include_roots: List[str]) -> List[dict]:
    all_hits = []
    for file in _sorted_unique_files(_iter_files(root, include_roots)):
        rel = file.relative_to(root).as_posix()
        hits = _scan_file(file, regexes)
        if hits:
            all_hits.append({"file": rel, "hits": [{"line": ln, "pattern": pt, "text": tx} for ln, pt, tx in hits]})
    all_hits.sort(key=lambda x: len(x["hits"]), reverse=True)
    return all_hits


def _scan_file(path: Path, regexes: List[re.Pattern[str]]) -> List[Tuple[int, str, str]]:
    hits: List[Tuple[int, str, str]] = []
    try:
        lines = path.read_text(encoding="utf-8", errors="ignore").splitlines()
    except Exception:
        return hits
    for idx, line in enumerate(lines, 1):
        for reg in regexes:
            m = reg.search(line)
            if m:
                hits.append((idx, reg.pattern, line.strip()[:240]))
                break
    return hits


def main() -> int:
    parser = argparse.ArgumentParser(description="扫描代码面的遗留语义标识")
    parser.add_argument("--max-allowed", type=int, default=0, help="允许的最大命中数（默认 0）")
    parser.add_argument("--strict", action="store_true", help="超阈值时返回非零退出码")
    parser.add_argument(
        "--report-json",
        default="backend/data/legacy_bidding_scan_report.json",
        help="扫描报告输出路径",
    )
    parser.add_argument(
        "--include-roots",
        nargs="+",
        default=DEFAULT_INCLUDE_ROOTS,
        help="仅扫描这些根路径（相对项目根目录）",
    )
    args = parser.parse_args()

    regexes = [re.compile(p, re.IGNORECASE) for p in DEFAULT_PATTERNS]
    all_hits = _scan_paths(PROJECT_ROOT, regexes, args.include_roots)

    total_hits = sum(len(x["hits"]) for x in all_hits)
    status = "pass" if total_hits <= args.max_allowed else ("fail" if args.strict else "warn")
    report = {
        "status": status,
        "max_allowed": int(args.max_allowed),
        "total_hits": int(total_hits),
        "include_roots": args.include_roots,
        "patterns": DEFAULT_PATTERNS,
        "files": all_hits,
    }

    out = PROJECT_ROOT / args.report_json
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print("=== Legacy Bidding Semantic Scan ===")
    print(f"status={status} total_hits={total_hits} max_allowed={args.max_allowed} strict={args.strict}")
    print(f"report={out.as_posix()}")
    if all_hits:
        for row in all_hits[:20]:
            print(f"- {row['file']}: {len(row['hits'])} hit(s)")
    if status == "fail":
        print("❌ 语义残留超过阈值（strict=true）")
        return 1
    if status == "warn":
        print("⚠️ 语义残留超过阈值（已记录，未阻断）")
    else:
        print("✅ 语义残留符合阈值")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

