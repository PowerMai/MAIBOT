#!/usr/bin/env python3
"""Generate dialog-friendly system status report as JSON."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

AVAILABLE_SECTIONS = ("all", "health", "rollout", "gate", "prompt_modules", "status_commands")


def _project_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _read_json(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def _run_python(script_path: Path, args: list[str] | None = None, timeout_sec: int = 240) -> dict:
    argv = [sys.executable, str(script_path)] + (args or [])
    try:
        out = subprocess.run(
            argv,
            cwd=str(_project_root()),
            capture_output=True,
            text=True,
            timeout=timeout_sec,
            check=False,
        )
        return {
            "command": " ".join(argv),
            "exit_code": out.returncode,
            "stdout": out.stdout[:3000],
            "stderr": out.stderr[:1200],
        }
    except Exception as e:
        return {"command": " ".join(argv), "error": str(e)}


def _build_payload(section: str) -> dict:
    root = _project_root()
    learned = root / "knowledge_base" / "learned"
    auto_upgrade = learned / "auto_upgrade"

    execution = _read_json(auto_upgrade / "rollout_execution.json", {})
    release_profile = _read_json(auto_upgrade / "release_profile.json", {})
    gate = _read_json(learned / "ab_eval" / "ab_gate.json", {})
    runtime_summary = _read_json(auto_upgrade / "rollout_runtime_summary.json", {})
    capability_registry = _read_json(auto_upgrade / "capability_registry.json", {})
    knowledge_audit = _read_json(auto_upgrade / "knowledge_system_audit.json", {})
    prompt_module_health = _read_json(auto_upgrade / "prompt_module_healthcheck.json", {})
    status_command_regression = _read_json(auto_upgrade / "status_command_regression.json", {})

    health_counts = (execution.get("health_summary") or {}).get("counts", {}) if isinstance(execution, dict) else {}
    hard_fail = int(health_counts.get("hard_fail", 0) or 0)
    blocked = int(health_counts.get("blocked", 0) or 0)
    soft_fail = int(health_counts.get("soft_fail", 0) or 0)
    gate_passed = bool(gate.get("passed", False))
    prompt_missing = int((prompt_module_health.get("summary") or {}).get("missing_modules", 0) or 0)
    status_reg_total = int(status_command_regression.get("total", 0) or 0)
    status_reg_failed = int(status_command_regression.get("failed", 0) or 0)
    status_reg_passed = bool(status_command_regression.get("passed", False)) if status_reg_total > 0 else False
    path_normalization_meta = status_command_regression.get("path_normalization_meta", {}) or {}
    path_norm_refs = int(path_normalization_meta.get("changed_references", 0) or 0) if isinstance(path_normalization_meta, dict) else 0
    path_norm_passed = bool(path_normalization_meta.get("passed", False)) if isinstance(path_normalization_meta, dict) else False
    knowledge_score = int(((knowledge_audit.get("knowledge_audit") or {}).get("score", 0)) or 0)
    base_score = 100 - hard_fail * 20 - blocked * 10 - soft_fail * 5 - prompt_missing * 5 - status_reg_failed * 6
    if status_reg_total > 0 and not status_reg_passed:
        base_score -= 8
    if path_norm_refs > 0:
        base_score -= 6
    if not gate_passed:
        base_score -= 10
    # 将知识系统分纳入总分（占 20%）
    health_score = max(0, min(100, int(base_score * 0.8 + knowledge_score * 0.2)))
    components = [
        {
            "name": "rollout",
            "status": "healthy" if hard_fail == 0 else ("degraded" if hard_fail <= 1 else "down"),
            "detail": f"hard_fail={hard_fail}, blocked={blocked}, soft_fail={soft_fail}",
        },
        {
            "name": "gate",
            "status": "healthy" if gate_passed else "degraded",
            "detail": "passed" if gate_passed else str(gate.get("reason", "not_passed")),
        },
        {
            "name": "prompt_modules",
            "status": "healthy" if prompt_missing == 0 else ("degraded" if prompt_missing <= 2 else "down"),
            "detail": f"missing_modules={prompt_missing}",
        },
        {
            "name": "knowledge",
            "status": "healthy" if knowledge_score >= 85 else ("degraded" if knowledge_score >= 60 else "down"),
            "detail": f"score={knowledge_score}",
        },
        {
            "name": "status_commands",
            "status": (
                "healthy"
                if status_reg_total > 0 and status_reg_failed == 0
                else ("degraded" if status_reg_total > 0 else "down")
            ),
            "detail": (
                f"passed={status_reg_total - status_reg_failed}/{status_reg_total}"
                if status_reg_total > 0
                else "missing regression snapshot"
            ),
        },
        {
            "name": "path_normalization",
            "status": "healthy" if path_norm_refs == 0 else ("degraded" if path_norm_refs <= 3 else "down"),
            "detail": f"changed_references={path_norm_refs}, changed_files={int(path_normalization_meta.get('changed_files', 0) or 0) if isinstance(path_normalization_meta, dict) else 0}",
        },
    ]

    payload = {
        "status": "ok",
        "section": section,
        "health": execution.get("health_summary", {}),
        "health_trend": execution.get("health_trend", {}),
        "rollout": {
            "stage": execution.get("stage"),
            "rollout_percentage": execution.get("rollout_percentage"),
            "release_profile": release_profile,
            "runtime_summary": runtime_summary,
        },
        "gate": gate,
        "capability_registry_meta": {
            "tool_count": len(capability_registry.get("tools", []) or []),
            "skill_count": len(capability_registry.get("skills", []) or []),
            "resource_count": len(capability_registry.get("resources", []) or []),
        },
        "knowledge_audit_meta": {
            "score": ((knowledge_audit.get("knowledge_audit") or {}).get("score")),
            "health_level": ((knowledge_audit.get("knowledge_audit") or {}).get("health_level")),
        },
        "prompt_module_health_meta": {
            "status": prompt_module_health.get("status"),
            "missing_modules": ((prompt_module_health.get("summary") or {}).get("missing_modules", 0)),
            "referenced_modules": ((prompt_module_health.get("summary") or {}).get("referenced_modules", 0)),
        },
        "status_command_regression_meta": {
            "generated_at": status_command_regression.get("generated_at"),
            "total": status_reg_total,
            "failed": status_reg_failed,
            "passed": status_reg_passed,
        },
        "path_normalization_meta": {
            "passed": path_norm_passed,
            "changed_references": path_norm_refs,
            "changed_files": int(path_normalization_meta.get("changed_files", 0) or 0) if isinstance(path_normalization_meta, dict) else 0,
        },
        "health_score": health_score,
        "components": components,
        "summary": (
            f"health={health_score}, gate={'pass' if gate_passed else 'fail'}, "
            f"prompt_missing={prompt_missing}, status_cmd_fail={status_reg_failed}, "
            f"path_ref_drift={path_norm_refs}"
        ),
    }

    if section == "health":
        return {
            "status": "ok",
            "section": "health",
            "health": payload["health"],
            "health_trend": payload["health_trend"],
            "health_score": payload["health_score"],
            "components": payload["components"],
            "summary": payload["summary"],
        }
    if section == "rollout":
        return {
            "status": "ok",
            "section": "rollout",
            "rollout": payload["rollout"],
            "health_score": payload["health_score"],
            "components": payload["components"],
            "summary": payload["summary"],
        }
    if section == "gate":
        return {
            "status": "ok",
            "section": "gate",
            "gate": payload["gate"],
            "health_score": payload["health_score"],
            "components": payload["components"],
            "summary": payload["summary"],
        }
    if section == "prompt_modules":
        return {
            "status": "ok",
            "section": "prompt_modules",
            "prompt_module_health_meta": payload["prompt_module_health_meta"],
            "health_score": payload["health_score"],
            "components": payload["components"],
            "summary": payload["summary"],
        }
    if section == "status_commands":
        return {
            "status": "ok",
            "section": "status_commands",
            "status_command_regression_meta": payload["status_command_regression_meta"],
            "path_normalization_meta": payload["path_normalization_meta"],
            "health_score": payload["health_score"],
            "components": payload["components"],
            "summary": payload["summary"],
        }
    return payload


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate system status report json")
    parser.add_argument(
        "--section",
        default="all",
        choices=list(AVAILABLE_SECTIONS),
    )
    parser.add_argument("--refresh", action="store_true", help="Run rollout orchestrator before reading reports")
    parser.add_argument("--output-json", default="", help="Optional output path")
    parser.add_argument("--list-sections", action="store_true", help="Print available status sections as JSON")
    args = parser.parse_args()

    if args.list_sections:
        print(json.dumps({"status": "ok", "sections": list(AVAILABLE_SECTIONS)}, ensure_ascii=False))
        return

    root = _project_root()
    refresh_info = {}
    if args.refresh:
        refresh_info = _run_python(root / "backend" / "tools" / "upgrade" / "auto_rollout_upgrade.py")

    payload = _build_payload(args.section)
    if refresh_info:
        payload["refresh_info"] = refresh_info

    output_path = Path(args.output_json).resolve() if args.output_json else None
    if output_path is not None:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    main()
