#!/usr/bin/env python3
"""Prompt module healthcheck for .maibot/prompt_assembly.json."""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


@dataclass
class ModuleCheck:
    name: str
    referenced_by: list[str]
    exists_in_project: bool
    exists_in_system: bool
    project_variants: list[str]
    system_variants: list[str]

    @property
    def is_missing(self) -> bool:
        return not self.exists_in_project and not self.exists_in_system


def _find_project_root(start: Path) -> Path:
    cur = start.resolve()
    for candidate in [cur] + list(cur.parents):
        if (candidate / "backend").exists() and (candidate / "knowledge_base").exists():
            return candidate
    return start.resolve()


def _read_json(path: Path, default: dict[str, Any]) -> dict[str, Any]:
    if not path.exists():
        return default
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else default
    except Exception:
        return default


def _module_variants(root: Path, module_name: str) -> list[str]:
    if not root.exists():
        return []
    variants = [
        f"{module_name}.detailed.md",
        f"{module_name}.concise.md",
        f"{module_name}.md",
    ]
    found: list[str] = []
    for rel in variants:
        p = root / rel
        if p.exists() and p.is_file():
            found.append(rel)
    return found


def _append_ref(
    refs: dict[str, set[str]],
    section: str,
    value: Any,
) -> None:
    if isinstance(value, str) and value.strip():
        refs.setdefault(value.strip(), set()).add(section)
        return
    if isinstance(value, list):
        for item in value:
            _append_ref(refs, section, item)


def _collect_references(assembly: dict[str, Any]) -> dict[str, set[str]]:
    refs: dict[str, set[str]] = {}
    for item in assembly.get("always_load", []) or []:
        _append_ref(refs, "always_load", item)

    tool_conditional = assembly.get("tool_conditional", {}) or {}
    if isinstance(tool_conditional, dict):
        for tool_name, item in tool_conditional.items():
            _append_ref(refs, f"tool_conditional:{tool_name}", item)

    mode_conditional = assembly.get("mode_conditional", {}) or {}
    if isinstance(mode_conditional, dict):
        for mode_name, item in mode_conditional.items():
            _append_ref(refs, f"mode_conditional:{mode_name}", item)

    role_conditional = assembly.get("role_conditional", {}) or {}
    if isinstance(role_conditional, dict):
        for role_name, item in role_conditional.items():
            _append_ref(refs, f"role_conditional:{role_name}", item)

    return refs


def _list_project_modules(project_root: Path) -> list[str]:
    root = project_root / ".maibot" / "modules"
    if not root.exists():
        return []
    names: set[str] = set()
    for p in root.rglob("*.md"):
        rel = str(p.relative_to(root))
        if rel.endswith(".detailed.md"):
            rel = rel[: -len(".detailed.md")]
        elif rel.endswith(".concise.md"):
            rel = rel[: -len(".concise.md")]
        else:
            rel = rel[: -len(".md")]
        names.add(rel)
    return sorted(names)


def _to_markdown(report: dict[str, Any]) -> str:
    summary = report.get("summary", {})
    checks = report.get("checks", [])
    missing = [c for c in checks if c.get("missing")]
    orphan_project = report.get("orphan_project_modules", [])

    lines = [
        "# Prompt Module Healthcheck",
        "",
        f"- Timestamp: `{report.get('timestamp', '')}`",
        f"- Assembly: `{report.get('assembly_path', '')}`",
        f"- Project modules root: `{report.get('project_modules_root', '')}`",
        f"- System modules root: `{report.get('system_modules_root', '')}`",
        "",
        "## Summary",
        "",
        f"- Referenced modules: `{summary.get('referenced_modules', 0)}`",
        f"- Missing modules: `{summary.get('missing_modules', 0)}`",
        f"- Project overrides used: `{summary.get('project_override_hits', 0)}`",
        f"- System fallback hits: `{summary.get('system_hits', 0)}`",
        "",
    ]

    lines.append("## Missing References")
    lines.append("")
    if missing:
        for item in missing:
            lines.append(
                f"- `{item.get('name')}` (from: {', '.join(item.get('referenced_by', []))})"
            )
    else:
        lines.append("- none")
    lines.append("")

    lines.append("## Module Resolution")
    lines.append("")
    for item in checks:
        location = "project" if item.get("exists_in_project") else ("system" if item.get("exists_in_system") else "missing")
        lines.append(
            f"- `{item.get('name')}` -> `{location}` (project={item.get('project_variants', [])}, system={item.get('system_variants', [])})"
        )
    lines.append("")

    lines.append("## Orphan Project Modules")
    lines.append("")
    if orphan_project:
        for name in orphan_project:
            lines.append(f"- `{name}`")
    else:
        lines.append("- none")
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Prompt modules healthcheck")
    parser.add_argument("--project-root", default="", help="Project root path")
    parser.add_argument("--assembly", default=".maibot/prompt_assembly.json", help="Prompt assembly path")
    parser.add_argument(
        "--output-json",
        default="knowledge_base/learned/auto_upgrade/prompt_module_healthcheck.json",
        help="Healthcheck JSON report path",
    )
    parser.add_argument(
        "--output-md",
        default="docs/PROMPT_MODULE_HEALTHCHECK.md",
        help="Healthcheck markdown report path",
    )
    parser.add_argument("--strict", action="store_true", help="Exit non-zero when missing modules found")
    args = parser.parse_args()

    root = Path(args.project_root).resolve() if args.project_root else _find_project_root(Path.cwd())
    assembly_path = (root / args.assembly).resolve() if not Path(args.assembly).is_absolute() else Path(args.assembly).resolve()
    output_json = (root / args.output_json).resolve() if not Path(args.output_json).is_absolute() else Path(args.output_json).resolve()
    output_md = (root / args.output_md).resolve() if not Path(args.output_md).is_absolute() else Path(args.output_md).resolve()

    project_modules_root = root / ".maibot" / "modules"
    system_modules_root = root / "backend" / "engine" / "prompts" / "modules"
    assembly = _read_json(assembly_path, {})
    refs = _collect_references(assembly)

    checks: list[ModuleCheck] = []
    for name in sorted(refs.keys()):
        pv = _module_variants(project_modules_root, name)
        sv = _module_variants(system_modules_root, name)
        checks.append(
            ModuleCheck(
                name=name,
                referenced_by=sorted(refs[name]),
                exists_in_project=bool(pv),
                exists_in_system=bool(sv),
                project_variants=pv,
                system_variants=sv,
            )
        )

    check_rows = [
        {
            "name": c.name,
            "referenced_by": c.referenced_by,
            "exists_in_project": c.exists_in_project,
            "exists_in_system": c.exists_in_system,
            "project_variants": c.project_variants,
            "system_variants": c.system_variants,
            "missing": c.is_missing,
        }
        for c in checks
    ]
    missing_count = sum(1 for c in checks if c.is_missing)
    project_override_hits = sum(1 for c in checks if c.exists_in_project)
    system_hits = sum(1 for c in checks if (not c.exists_in_project and c.exists_in_system))

    referenced_names = {c.name for c in checks}
    orphan_project_modules = [n for n in _list_project_modules(root) if n not in referenced_names]

    report = {
        "status": "ok" if missing_count == 0 else "missing_modules",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "assembly_path": str(assembly_path),
        "project_modules_root": str(project_modules_root),
        "system_modules_root": str(system_modules_root),
        "summary": {
            "referenced_modules": len(checks),
            "missing_modules": missing_count,
            "project_override_hits": project_override_hits,
            "system_hits": system_hits,
        },
        "checks": check_rows,
        "orphan_project_modules": orphan_project_modules,
    }

    output_json.parent.mkdir(parents=True, exist_ok=True)
    output_json.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    output_md.parent.mkdir(parents=True, exist_ok=True)
    output_md.write_text(_to_markdown(report), encoding="utf-8")

    print(json.dumps({"status": report["status"], "missing_modules": missing_count, "report_json": str(output_json), "report_md": str(output_md)}, ensure_ascii=False))
    if args.strict and missing_count > 0:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

