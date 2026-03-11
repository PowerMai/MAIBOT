#!/usr/bin/env python3
"""Unified auto-discovery + auto-upgrade orchestrator."""

from __future__ import annotations

import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


def _safe_json_loads(text: str) -> dict:
    try:
        data = json.loads(text or "{}")
        return data if isinstance(data, dict) else {"raw": text}
    except Exception:
        return {"raw": text}


def _find_project_root(start: Path) -> Path:
    """向上查找项目根（需同时包含 backend 与 knowledge_base）。"""
    cur = start.resolve()
    for candidate in [cur] + list(cur.parents):
        if (candidate / "backend").exists() and (candidate / "knowledge_base").exists():
            return candidate
    return start.resolve().parents[5]


def _write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def run_cmd(args: list[str], timeout_sec: int = 60) -> dict:
    try:
        out = subprocess.run(
            args,
            capture_output=True,
            text=True,
            timeout=timeout_sec,
            check=False,
        )
        return {
            "command": " ".join(args),
            "exit_code": out.returncode,
            "stdout": out.stdout[:4000],
            "stderr": out.stderr[:2000],
            "parsed_stdout": _safe_json_loads(out.stdout.strip()),
        }
    except Exception as e:
        return {"command": " ".join(args), "error": str(e)}


def _count_jsonl_lines(path: Path) -> int:
    if not path.exists():
        return 0
    return len([line for line in path.read_text(encoding="utf-8").splitlines() if line.strip()])


def main() -> None:
    base = Path(__file__).resolve().parent
    root = _find_project_root(base)
    learned = root / "knowledge_base" / "learned"
    out_dir = learned / "auto_upgrade"
    out_dir.mkdir(parents=True, exist_ok=True)
    report_path = out_dir / "auto_upgrade_report.json"

    discover_scripts = [
        base / "discover_mcp_servers.py",
        base / "discover_skills.py",
        base / "discover_ontologies.py",
    ]
    discovery_runs = [run_cmd([sys.executable, str(p)], timeout_sec=50) for p in discover_scripts]

    ab_eval_script = root / "backend" / "tools" / "upgrade" / "evaluate_distillation_ab.py"
    distill_samples = learned / "distillation_samples.jsonl"
    sample_count = _count_jsonl_lines(distill_samples)
    if sample_count >= 4 and ab_eval_script.exists():
        ab_run = run_cmd(
            [
                sys.executable,
                str(ab_eval_script),
                "--mode",
                "run",
                "--out-dir",
                str(learned / "ab_eval"),
                "--strict",
                "--fail-on-gate",
                "--allow-insufficient-samples",
                "--regression-set",
                str(learned / "ab_eval" / "ab_regression_set.jsonl"),
            ],
            timeout_sec=180,
        )
    else:
        # 没有足够样本时也要落盘，让系统可观测、可继续自动化
        ab_run = {
            "status": "skipped",
            "reason": "distillation_samples_not_enough",
            "sample_count": sample_count,
            "required_min": 4,
            "next_action": "等待 DistillationMiddleware 累积样本后自动重试",
        }

    rollout = {
        "status": "pending_verification",
        "phase": "canary",
        "target_scope": "small_user_group",
        "rules": {
            "promote_when": "gate_passed_for_consecutive_runs >= 3",
            "rollback_when": "gate_failed_after_promotion",
        },
    }

    final = {
        "status": "ok",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "paths": {
            "report": str(report_path),
            "rollout_plan": str(out_dir / "rollout_plan.json"),
            "discovery_snapshot": str(out_dir / "discovery_snapshot.json"),
        },
        "discovery_runs": discovery_runs,
        "ab_evaluation": ab_run,
        "rollout_plan": rollout,
    }

    _write_json(out_dir / "discovery_snapshot.json", {"runs": discovery_runs})
    _write_json(out_dir / "rollout_plan.json", rollout)
    _write_json(report_path, final)
    print(json.dumps(final, ensure_ascii=False))


if __name__ == "__main__":
    main()

