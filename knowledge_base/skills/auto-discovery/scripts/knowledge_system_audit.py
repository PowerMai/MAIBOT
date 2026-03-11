#!/usr/bin/env python3
"""Audit knowledge system readiness and optionally run lightweight E2E checks."""

from __future__ import annotations

import argparse
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path


def _find_project_root(start: Path) -> Path:
    cur = start.resolve()
    for candidate in [cur] + list(cur.parents):
        if (candidate / "backend").exists() and (candidate / "knowledge_base").exists():
            return candidate
    return start.resolve().parents[5]


def _write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _run_cmd(cmd: list[str], cwd: Path, timeout_sec: int = 180) -> dict:
    try:
        out = subprocess.run(
            cmd,
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=timeout_sec,
            check=False,
        )
        return {
            "command": " ".join(cmd),
            "exit_code": out.returncode,
            "stdout": out.stdout[:3000],
            "stderr": out.stderr[:1200],
        }
    except Exception as e:
        return {"command": " ".join(cmd), "error": str(e)}


def _count_json_rows(path: Path) -> int:
    if not path.exists():
        return 0
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, list):
            return len(data)
        if isinstance(data, dict):
            return len(data)
    except Exception:
        return 0
    return 0


def _read_json(path: Path, default: dict | list | None = None):
    if default is None:
        default = {}
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def _audit_knowledge(root: Path, run_e2e: bool) -> dict:
    learned = root / "knowledge_base" / "learned"
    ontology_root = learned / "ontology"
    skills_root = root / "knowledge_base" / "skills"

    required_paths = {
        "ontology_schema_global": learned / "ontology" / "schema.json",
        "ontology_entities": learned / "ontology" / "entities.json",
        "ontology_relations": learned / "ontology" / "relations.json",
        "skill_ontology_management": skills_root / "knowledge" / "ontology-management" / "SKILL.md",
        "skill_knowledge_building": skills_root / "knowledge" / "knowledge-building" / "SKILL.md",
        "skill_solution_design": skills_root / "marketing" / "bidding" / "solution-design" / "SKILL.md",
    }

    checks = {
        key: {"path": str(path), "exists": path.exists()}
        for key, path in required_paths.items()
    }
    missing = [k for k, v in checks.items() if not v["exists"]]

    entities = _read_json(ontology_root / "entities.json", default=[])
    relations = _read_json(ontology_root / "relations.json", default=[])
    domain_schema_files = list((ontology_root / "domain").glob("**/schema.json"))

    stats = {
        "entity_count": _count_json_rows(ontology_root / "entities.json"),
        "relation_count": _count_json_rows(ontology_root / "relations.json"),
        "domain_schema_count": len(domain_schema_files),
        "distillation_sample_count": len(
            [
                ln
                for ln in (learned / "distillation_samples.jsonl").read_text(encoding="utf-8").splitlines()
                if ln.strip()
            ]
        )
        if (learned / "distillation_samples.jsonl").exists()
        else 0,
    }

    e2e_runs = []
    validate_e2e_script = skills_root / "marketing" / "bidding" / "solution-design" / "scripts" / "validate_e2e.py"
    if run_e2e and validate_e2e_script.exists():
        e2e_runs.append(
            _run_cmd(
                [
                    "python3",
                    str(validate_e2e_script),
                    "--stage",
                    "solution",
                    "--query",
                    "技术方案 评分项 交付物",
                ],
                cwd=root,
                timeout_sec=180,
            )
        )

    score = 100
    score -= min(len(missing) * 8, 40)
    if stats["entity_count"] == 0:
        score -= 20
    if stats["relation_count"] == 0:
        score -= 15
    score = max(0, score)
    health = "healthy" if score >= 80 else ("warning" if score >= 60 else "critical")

    return {
        "checks": checks,
        "missing": missing,
        "stats": stats,
        "samples_preview": {
            "entities_preview": entities[:3] if isinstance(entities, list) else [],
            "relations_preview": relations[:3] if isinstance(relations, list) else [],
        },
        "e2e_runs": e2e_runs,
        "score": score,
        "health_level": health,
    }


def _write_markdown(path: Path, report: dict) -> None:
    audit = report.get("knowledge_audit", {})
    stats = audit.get("stats", {})
    lines = [
        "# Knowledge System Audit",
        "",
        f"- Timestamp: `{report.get('timestamp', '')}`",
        f"- Score: `{audit.get('score', 0)}`",
        f"- Health: `{audit.get('health_level', 'unknown')}`",
        "",
        "## Key Stats",
        "",
        f"- entity_count: `{stats.get('entity_count', 0)}`",
        f"- relation_count: `{stats.get('relation_count', 0)}`",
        f"- domain_schema_count: `{stats.get('domain_schema_count', 0)}`",
        f"- distillation_sample_count: `{stats.get('distillation_sample_count', 0)}`",
        "",
        "## Missing Requirements",
        "",
    ]
    missing = audit.get("missing", [])
    if missing:
        for item in missing:
            lines.append(f"- `{item}`")
    else:
        lines.append("- none")
    lines.append("")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description="Audit knowledge system status")
    parser.add_argument("--run-e2e", action="store_true", help="Run lightweight e2e validation command")
    parser.add_argument("--output-json", default="knowledge_base/learned/auto_upgrade/knowledge_system_audit.json")
    parser.add_argument("--output-md", default="knowledge_base/learned/auto_upgrade/knowledge_system_audit.md")
    args = parser.parse_args()

    root = _find_project_root(Path(__file__).resolve().parent)
    output_json = (root / args.output_json).resolve() if not Path(args.output_json).is_absolute() else Path(args.output_json)
    output_md = (root / args.output_md).resolve() if not Path(args.output_md).is_absolute() else Path(args.output_md)

    report = {
        "status": "ok",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "project_root": str(root),
        "knowledge_audit": _audit_knowledge(root, run_e2e=args.run_e2e),
        "output_json": str(output_json),
        "output_md": str(output_md),
    }
    _write_json(output_json, report)
    _write_markdown(output_md, report)
    print(json.dumps({"status": "ok", "output_json": str(output_json), "output_md": str(output_md)}, ensure_ascii=False))


if __name__ == "__main__":
    main()

