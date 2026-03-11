#!/usr/bin/env python3
"""
发布演练一键编排：
- 顺序执行 strict 证据收集步骤
- 即使中途失败也继续收集后续证据
- 最终统一生成 release_gate_summary + release_drill_report
- 退出码由 gate 结果决定（pass=0，blocked=1）
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from time import monotonic
from typing import Any, Dict, List, Tuple

PROJECT_ROOT = Path(__file__).resolve().parents[2]
PYTHON = sys.executable


def _run_step(
    name: str,
    cmd: List[str],
    timeout_seconds: int = 240,
    env_overrides: Dict[str, str] | None = None,
) -> Dict[str, Any]:
    print(f"\n=== STEP: {name} ===")
    print(f"$ {' '.join(cmd)}")
    run_env = None
    if env_overrides:
        run_env = dict(os.environ)
        run_env.update(env_overrides)
    started_at = datetime.now(timezone.utc).isoformat()
    started_perf = monotonic()
    timed_out = False
    try:
        rc = subprocess.run(cmd, cwd=PROJECT_ROOT, timeout=timeout_seconds, env=run_env).returncode
    except subprocess.TimeoutExpired:
        rc = 124
        timed_out = True
        print(f"=> {name}: timeout (>{timeout_seconds}s)")
    elapsed_ms = int((monotonic() - started_perf) * 1000)
    status = "pass" if rc == 0 else "fail"
    print(f"=> {name}: {status} (rc={rc}, elapsed_ms={elapsed_ms})")
    return {
        "name": name,
        "cmd": cmd,
        "rc": int(rc),
        "status": status,
        "timed_out": timed_out,
        "started_at": started_at,
        "elapsed_ms": elapsed_ms,
        "timeout_seconds": int(timeout_seconds),
        "env_overrides": sorted(list((env_overrides or {}).keys())),
    }


def _read_json(path: Path) -> Dict:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _write_json(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="一键发布演练（自动归因）")
    parser.add_argument("--release-profile", default="production")
    parser.add_argument(
        "--strict-required",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="是否要求 required gate 全部 pass（默认 true）",
    )
    parser.add_argument(
        "--steps-output",
        default="backend/data/release_drill_steps.json",
        help="发布演练步骤明细输出路径（JSON）",
    )
    args = parser.parse_args()

    stable_projection_env = {
        "TASK_WATCHER_ENABLED": "false",
        "FASTAPI_LIFESPAN_MINIMAL": "true",
        "BOARD_CREATE_TASK_AUTO_DISPATCH": "false",
    }
    steps: List[Tuple[str, List[str], int, Dict[str, str] | None, bool]] = [
        (
            "task_status_projection",
            [PYTHON, "backend/scripts/test_task_status_projection_e2e.py"],
            420,
            stable_projection_env,
            True,
        ),
        (
            "task_status_projection_guard_off",
            [PYTHON, "backend/scripts/test_task_status_projection_guard_off_e2e.py"],
            240,
            stable_projection_env,
            True,
        ),
        (
            "task_execution_reliability_e2e",
            [PYTHON, "backend/scripts/test_task_execution_reliability_e2e.py"],
            300,
            stable_projection_env,
            True,
        ),
        (
            "task_status_wiring",
            [PYTHON, "backend/scripts/check_task_status_wiring.py"],
            120,
            None,
            True,
        ),
        ("board_contract", [PYTHON, "backend/scripts/check_board_contracts.py"], 120, None, True),
        ("plugins_compat", [PYTHON, "backend/scripts/plugins_compat_smoke.py"], 180, None, True),
        ("plugin_runtime_compat", [PYTHON, "backend/scripts/plugin_runtime_compat_smoke.py"], 120, None, True),
        ("skills_compat", [PYTHON, "backend/scripts/skills_compat_smoke.py"], 120, None, True),
        (
            "watcher_observability_snapshot",
            [
                "bash",
                "scripts/watcher_observability_check.sh",
                "--window-seconds",
                "30",
                "--output-json",
                "backend/data/watcher_observability_snapshot.json",
            ],
            90,
            None,
            False,
        ),
        (
            "ui_stream_metrics_snapshot",
            [PYTHON, "backend/scripts/build_ui_stream_metrics_snapshot.py"],
            60,
            None,
            False,
        ),
        (
            "reliability_slo_strict",
            [PYTHON, "backend/scripts/check_reliability_slo.py", "--env", args.release_profile, "--strict"],
            120,
            None,
            True,
        ),
        ("legacy_terms_strict", [PYTHON, "backend/scripts/scan_legacy_bidding_terms.py", "--strict"], 240, None, True),
        ("release_signoff_strict", [PYTHON, "backend/scripts/check_release_signoff.py", "--strict"], 120, None, True),
    ]

    retry_once_steps = {"task_status_projection"}
    results: List[Tuple[str, int, bool]] = []
    executed_steps: List[Dict[str, Any]] = []
    for name, cmd, timeout_seconds, env_overrides, required in steps:
        step_result = _run_step(name, cmd, timeout_seconds=timeout_seconds, env_overrides=env_overrides)
        step_result["required"] = bool(required)
        if step_result.get("status") == "fail" and not required:
            step_result["status"] = "warn"
            step_result["warning"] = "non-blocking observability step failed"
            print(f"=> {name}: non-blocking failure downgraded to warn")
        executed_steps.append(step_result)
        rc = int(step_result.get("rc", 1))
        if rc != 0 and name in retry_once_steps:
            print(f"=> {name}: first attempt failed, retrying once")
            retry_result = _run_step(f"{name}_retry", cmd, timeout_seconds=timeout_seconds, env_overrides=env_overrides)
            retry_result["required"] = bool(required)
            executed_steps.append(retry_result)
            rc = int(retry_result.get("rc", 1))
        results.append((name, rc, required))

    summary_path = PROJECT_ROOT / "backend/data/release_gate_summary.json"
    prev_summary_mtime = summary_path.stat().st_mtime if summary_path.exists() else -1.0

    summary_cmd = [
        PYTHON,
        "backend/scripts/build_release_gate_summary.py",
        "--release-profile",
        str(args.release_profile),
    ]
    if args.strict_required:
        summary_cmd.append("--strict-required")
    summary_step = _run_step("build_release_gate_summary", summary_cmd)
    executed_steps.append(summary_step)
    summary_rc = int(summary_step.get("rc", 1))

    report_cmd = [
        PYTHON,
        "backend/scripts/build_release_drill_report.py",
        "--release-profile",
        str(args.release_profile),
    ]
    report_step = _run_step("build_release_drill_report", report_cmd)
    executed_steps.append(report_step)
    report_rc = int(report_step.get("rc", 1))

    summary = _read_json(summary_path)
    profile_gate_status = str(summary.get("profile_gate_status") or "unknown").lower()
    blocking_reasons = summary.get("blocking_reasons") if isinstance(summary.get("blocking_reasons"), list) else []
    generated_at = str(summary.get("generated_at") or "")
    summary_fresh = summary_path.exists() and summary_path.stat().st_mtime > prev_summary_mtime

    print("\n=== RELEASE DRILL RESULT ===")
    for name, rc, required in results:
        if rc == 0:
            state = "pass"
        elif required:
            state = "fail"
        else:
            state = "warn"
        print(f"- {name}: {state}")
    print(f"- build_release_gate_summary: {'pass' if summary_rc == 0 else 'fail'}")
    print(f"- build_release_drill_report: {'pass' if report_rc == 0 else 'fail'}")
    print(f"- summary_fresh: {summary_fresh}")
    print(f"- summary_generated_at: {generated_at or 'missing'}")
    print(f"- profile_gate_status: {profile_gate_status}")
    if blocking_reasons:
        print(f"- blocking_reasons: {len(blocking_reasons)}")
        for row in blocking_reasons:
            if isinstance(row, dict):
                print(f"  - {row.get('evidence')}: {row.get('status')} ({row.get('reason')})")

    steps_output = Path(args.steps_output)
    if not steps_output.is_absolute():
        steps_output = PROJECT_ROOT / steps_output
    _write_json(
        steps_output,
        {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "release_profile": str(args.release_profile or "production"),
            "strict_required": bool(args.strict_required),
            "steps": executed_steps,
            "final_results": [
                {
                    "name": name,
                    "rc": rc,
                    "required": required,
                    "status": ("pass" if rc == 0 else ("fail" if required else "warn")),
                }
                for name, rc, required in results
            ],
            "summary": {
                "summary_fresh": bool(summary_fresh),
                "summary_generated_at": generated_at,
                "profile_gate_status": profile_gate_status,
                "blocking_reasons": blocking_reasons,
            },
        },
    )
    print(f"- steps_output: {steps_output.as_posix()}")

    if summary_rc != 0:
        print("- gate summary generation failed; treating drill as blocked")
        return 1
    if not summary_fresh:
        print("- gate summary not refreshed in this run; treating drill as blocked")
        return 1
    if not generated_at:
        print("- gate summary missing generated_at; treating drill as blocked")
        return 1
    try:
        datetime.fromisoformat(generated_at.replace("Z", "+00:00")).astimezone(timezone.utc)
    except Exception:
        print("- gate summary generated_at is invalid; treating drill as blocked")
        return 1

    if profile_gate_status == "pass":
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
