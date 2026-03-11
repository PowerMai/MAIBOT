from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Iterable


REPO_ROOT = Path(__file__).resolve().parents[2]
BOUNDARY_FILE = REPO_ROOT / ".module-boundary.json"
DEFAULT_BASELINE_FILE = REPO_ROOT / ".module-boundary-baseline.json"
SKIP_DIRS = {".git", ".venv", "node_modules", "dist", "build", "__pycache__"}
TEXT_EXTS = {".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"}
KNOWN_ALLOWED_IMPORTS = {
    (
        "backend/engine/core/main_graph.py",
        "backend.engine.tasks.task_service",
    ),
    (
        "backend/engine/agent/deep_agent.py",
        "backend.engine.middleware.ontology_middleware",
    ),
}


def _normalize_entry(entry: str) -> str:
    return str(entry or "").strip().lstrip("./")


def _resolve_paths(entries: Iterable[str]) -> list[Path]:
    out: list[Path] = []
    for raw in entries:
        normalized = _normalize_entry(raw)
        if not normalized:
            continue
        out.append((REPO_ROOT / normalized).resolve())
    return out


def _iter_files(path: Path) -> Iterable[Path]:
    if path.is_file():
        if path.suffix.lower() in TEXT_EXTS:
            yield path
        return
    if not path.is_dir():
        return
    for child in path.rglob("*"):
        if any(part in SKIP_DIRS for part in child.parts):
            continue
        if child.is_file() and child.suffix.lower() in TEXT_EXTS:
            yield child


def _load_baseline(path: Path) -> set[str]:
    if not path.exists():
        return set()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, list):
            return {str(x).strip() for x in data if str(x).strip()}
    except Exception:
        return set()
    return set()


def _write_baseline(path: Path, violations: list[str]) -> None:
    payload = sorted({str(v).strip() for v in violations if str(v).strip()})
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _collect_violations() -> tuple[list[str], list[str]]:
    if not BOUNDARY_FILE.exists():
        print(f"[module-boundary] 缺少文件: {BOUNDARY_FILE}")
        return ["配置错误：缺少 .module-boundary.json"], []
    try:
        data = json.loads(BOUNDARY_FILE.read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"[module-boundary] 读取失败: {exc}")
        return [f"配置错误：读取 .module-boundary.json 失败: {exc}"], []

    open_entries = data.get("open") if isinstance(data, dict) else None
    commercial_entries = data.get("commercial") if isinstance(data, dict) else None
    if not isinstance(open_entries, list) or not isinstance(commercial_entries, list):
        print("[module-boundary] open/commercial 字段必须是数组")
        return ["配置错误：open/commercial 字段必须是数组"], []

    open_paths = _resolve_paths(open_entries)
    commercial_paths = _resolve_paths(commercial_entries)

    missing_paths: list[str] = []
    for p in open_paths + commercial_paths:
        if not p.exists():
            rel = p.relative_to(REPO_ROOT) if str(p).startswith(str(REPO_ROOT)) else p
            missing_paths.append(str(rel))

    for op in open_paths:
        for cp in commercial_paths:
            if op == cp:
                rel = op.relative_to(REPO_ROOT)
                print(f"[module-boundary] open/commercial 重叠: {rel}")
                return [f"配置错误：open/commercial 重叠: {rel}"], missing_paths
            if op.is_dir() and cp.is_dir():
                if str(op).startswith(str(cp)) or str(cp).startswith(str(op)):
                    print(
                        "[module-boundary] 目录边界重叠: "
                        f"{op.relative_to(REPO_ROOT)} <-> {cp.relative_to(REPO_ROOT)}"
                    )
                    return [f"配置错误：目录边界重叠: {op.relative_to(REPO_ROOT)} <-> {cp.relative_to(REPO_ROOT)}"], missing_paths

    commercial_tokens = [_normalize_entry(x).rstrip("/") for x in commercial_entries if _normalize_entry(x)]
    commercial_py_modules: list[str] = []
    for token in commercial_tokens:
        if not token.startswith("backend/"):
            continue
        mod = token.rstrip("/")
        if mod.endswith(".py"):
            mod = mod[:-3]
        mod = mod.replace("/", ".")
        if mod:
            commercial_py_modules.append(mod)

    py_from_re = re.compile(r"^\s*from\s+([a-zA-Z0-9_\.]+)\s+import\s+")
    py_import_re = re.compile(r"^\s*import\s+([a-zA-Z0-9_\.]+)")
    ts_import_re = re.compile(r"""^\s*import\s+.+?\s+from\s+['"]([^'"]+)['"]""")
    ts_require_re = re.compile(r"""require\(\s*['"]([^'"]+)['"]\s*\)""")
    violations: list[str] = []
    for open_entry in open_entries:
        open_path = (REPO_ROOT / _normalize_entry(open_entry)).resolve()
        for file_path in _iter_files(open_path):
            try:
                text = file_path.read_text(encoding="utf-8", errors="ignore")
            except Exception:
                continue
            suffix = file_path.suffix.lower()
            if suffix == ".py":
                for line in text.splitlines():
                    m = py_from_re.search(line) or py_import_re.search(line)
                    if not m:
                        continue
                    mod = m.group(1).strip()
                    if any(mod == c or mod.startswith(f"{c}.") for c in commercial_py_modules):
                        rel = str(file_path.relative_to(REPO_ROOT))
                        if (rel, mod) in KNOWN_ALLOWED_IMPORTS:
                            continue
                        violations.append(
                            f"{rel} 引用了商业模块: {mod}"
                        )
                        break
                continue

            if suffix in {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"}:
                for line in text.splitlines():
                    m = ts_import_re.search(line) or ts_require_re.search(line)
                    if not m:
                        continue
                    mod = m.group(1).strip().lstrip("./")
                    if any(token and token in mod for token in commercial_tokens):
                        rel = str(file_path.relative_to(REPO_ROOT))
                        if (rel, mod) in KNOWN_ALLOWED_IMPORTS:
                            continue
                        violations.append(
                            f"{rel} 引用了商业模块: {mod}"
                        )
                        break

    return sorted(violations), missing_paths


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate module boundary isolation.")
    parser.add_argument(
        "--write-baseline",
        action="store_true",
        help="Write current violations to baseline file and exit 0.",
    )
    args = parser.parse_args()

    strict_mode = os.getenv("BOUNDARY_STRICT", "0") == "1"
    baseline_path = Path(
        os.getenv("BOUNDARY_BASELINE_PATH", str(DEFAULT_BASELINE_FILE))
    ).resolve()

    violations, missing_paths = _collect_violations()
    config_errors = [v for v in violations if v.startswith("配置错误：")]
    if config_errors:
        for e in config_errors:
            print(f"[module-boundary] {e}")
        return 1

    if missing_paths:
        print("[module-boundary] 警告：以下边界路径当前不存在（已跳过引用扫描）")
        for rel in missing_paths:
            print(f"  - {rel}")

    if args.write_baseline:
        _write_baseline(baseline_path, violations)
        print(f"[module-boundary] 已写入基线文件: {baseline_path}")
        print(f"[module-boundary] 基线违规数量: {len(violations)}")
        return 0

    baseline = _load_baseline(baseline_path)
    baseline_only = sorted([v for v in violations if v in baseline])
    new_violations = sorted([v for v in violations if v not in baseline])

    if violations:
        print("[module-boundary] 发现引用隔离违规：")
        for item in violations:
            print(f"  - {item}")
        print(
            f"[module-boundary] 违规汇总：总计={len(violations)}，"
            f"历史基线={len(baseline_only)}，新增={len(new_violations)}"
        )
        if strict_mode and new_violations:
            print("[module-boundary] 严格模式：检测到新增违规，检查失败")
            return 1
        if strict_mode and not new_violations:
            print("[module-boundary] 严格模式：仅存在历史基线违规，通过")
            return 0
        print("[module-boundary] 非严格模式下仅告警，不阻断 CI")
        return 0

    print("[module-boundary] 检查通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
