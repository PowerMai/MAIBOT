#!/usr/bin/env python3
"""Regression check for /status command family."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

DEFAULT_SECTIONS = ["all", "health", "rollout", "gate", "prompt_modules", "status_commands"]


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[5]


def _run_status(section: str) -> tuple[bool, dict[str, Any]]:
    repo_root = _repo_root()
    cmd = [
        sys.executable,
        str(repo_root / "backend/tools/upgrade/system_status_report.py"),
        "--section",
        section,
    ]
    proc = subprocess.run(
        cmd,
        cwd=repo_root,
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        return False, {"error": proc.stderr.strip() or proc.stdout.strip()}
    try:
        payload = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        return False, {"error": f"invalid_json: {exc}"}
    return True, payload


def _run_path_normalization_check() -> dict[str, Any]:
    repo_root = _repo_root()
    cmd = [
        sys.executable,
        str(repo_root / "backend/tools/upgrade/normalize_path_references.py"),
        "--dry-run",
    ]
    proc = subprocess.run(
        cmd,
        cwd=repo_root,
        capture_output=True,
        text=True,
        check=False,
    )
    output_text = (proc.stdout or "").strip()
    summary_match = re.search(
        r"\[summary\]\s+mode=(\S+)\s+files=(\d+)\s+references=(\d+)",
        output_text,
    )
    files = int(summary_match.group(2)) if summary_match else -1
    refs = int(summary_match.group(3)) if summary_match else -1
    passed = proc.returncode == 0 and refs == 0
    return {
        "passed": passed,
        "exit_code": proc.returncode,
        "changed_files": files,
        "changed_references": refs,
        "stdout": output_text[:2000],
        "stderr": (proc.stderr or "").strip()[:1000],
    }


def _validate_payload(section: str, payload: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if section in {"all", "health", "rollout", "gate", "prompt_modules", "status_commands"}:
        if "health_score" not in payload:
            errors.append("missing health_score")
        if "components" not in payload:
            errors.append("missing components")
        if "summary" not in payload:
            errors.append("missing summary")
    if section == "health" and "health" not in payload:
        errors.append("missing health")
    if section == "rollout" and "rollout" not in payload:
        errors.append("missing rollout")
    if section == "gate" and "gate" not in payload:
        errors.append("missing gate")
    if section in {"all", "prompt_modules"}:
        if "prompt_module_health_meta" not in payload:
            errors.append("missing prompt_module_health_meta")
    if section in {"all", "status_commands"}:
        if "status_command_regression_meta" not in payload:
            errors.append("missing status_command_regression_meta")
    return errors


def _discover_sections() -> list[str]:
    repo_root = _repo_root()
    cmd = [
        sys.executable,
        str(repo_root / "backend/tools/upgrade/system_status_report.py"),
        "--list-sections",
    ]
    proc = subprocess.run(
        cmd,
        cwd=repo_root,
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        return DEFAULT_SECTIONS
    try:
        payload = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return DEFAULT_SECTIONS
    sections = payload.get("sections")
    if not isinstance(sections, list):
        return DEFAULT_SECTIONS
    cleaned = [str(x).strip() for x in sections if str(x).strip()]
    return cleaned or DEFAULT_SECTIONS


def main() -> int:
    parser = argparse.ArgumentParser(description="Run /status regression checks.")
    parser.add_argument(
        "--output",
        default="knowledge_base/learned/auto_upgrade/status_command_regression.json",
        help="Output JSON report path (relative to repo root).",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Exit non-zero when any check fails.",
    )
    args = parser.parse_args()

    sections = _discover_sections()
    checks: list[dict[str, Any]] = []
    failed = 0

    for section in sections:
        ok, payload = _run_status(section)
        errors: list[str] = []
        if ok:
            errors = _validate_payload(section, payload)
        else:
            errors = [payload.get("error", "unknown error")]
        passed = ok and not errors
        if not passed:
            failed += 1
        checks.append(
            {
                "section": section,
                "passed": passed,
                "errors": errors,
                "keys": sorted(payload.keys()) if isinstance(payload, dict) else [],
            }
        )

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "total": len(sections),
        "failed": failed,
        "passed": failed == 0,
        "checks": checks,
    }
    path_normalization_meta = _run_path_normalization_check()
    report["path_normalization_meta"] = path_normalization_meta
    if not path_normalization_meta.get("passed", False):
        report["passed"] = False

    output_path = _repo_root() / args.output
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))

    if args.strict and failed > 0:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
