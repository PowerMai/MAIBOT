#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List


ROOT = Path(__file__).resolve().parents[2]


def _resolve_python_bin(explicit: str = "") -> str:
    if explicit:
        return explicit
    env_python = str((os.environ.get("PYTHON_BIN") or "")).strip()
    if env_python:
        return env_python
    venv_python = ROOT / "backend/.venv/bin/python"
    if venv_python.exists():
        return str(venv_python)
    return sys.executable


def _run(cmd: List[str]) -> Dict[str, Any]:
    proc = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
    return {
        "cmd": cmd,
        "ok": proc.returncode == 0,
        "returncode": proc.returncode,
        "stdout": proc.stdout,
        "stderr": proc.stderr,
    }


def _read_json(path: Path) -> Dict[str, Any]:
    if not path.exists():
        return {}
    try:
        raw = path.read_text(encoding="utf-8")
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _write_json(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="聚合任务状态投影门禁证据")
    parser.add_argument(
        "--out",
        default="backend/data/task_status_projection_evidence.json",
        help="聚合证据输出路径（默认: backend/data/task_status_projection_evidence.json）",
    )
    parser.add_argument(
        "--on-report",
        default="backend/data/task_status_projection_report.json",
        help="单一真源开启回归报告路径",
    )
    parser.add_argument(
        "--off-report",
        default="backend/data/task_status_projection_guard_off_report.json",
        help="单一真源关闭回归报告路径",
    )
    parser.add_argument(
        "--python-bin",
        default="",
        help="执行子脚本的 Python 解释器路径（默认: PYTHON_BIN env > backend/.venv/bin/python > 当前解释器）",
    )
    args = parser.parse_args()
    python_bin = _resolve_python_bin(args.python_bin)

    on_report = ROOT / str(args.on_report)
    off_report = ROOT / str(args.off_report)
    out_path = ROOT / str(args.out)

    steps: List[Dict[str, Any]] = []
    steps.append(
        _run(
            [
                python_bin,
                "backend/scripts/test_task_status_projection_e2e.py",
                "--report-json",
                str(on_report),
            ]
        )
    )
    steps.append(
        _run(
            [
                python_bin,
                "backend/scripts/test_task_status_projection_guard_off_e2e.py",
                "--report-json",
                str(off_report),
            ]
        )
    )
    steps.append(_run([python_bin, "backend/scripts/check_task_status_wiring.py"]))

    on_data = _read_json(on_report)
    off_data = _read_json(off_report)
    overall_ok = all(bool(s.get("ok")) for s in steps)

    payload: Dict[str, Any] = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "ok": overall_ok,
        "status": "pass" if overall_ok else "fail",
        "python_bin": python_bin,
        "steps": [
            {"name": "projection_on_e2e", **steps[0]},
            {"name": "projection_guard_off_e2e", **steps[1]},
            {"name": "task_status_wiring_check", **steps[2]},
        ],
        "reports": {
            "projection_on": on_data,
            "projection_guard_off": off_data,
        },
    }
    _write_json(out_path, payload)

    print("task status projection evidence collected")
    print(f"- ok: {overall_ok}")
    print(f"- out: {out_path.as_posix()}")
    if not overall_ok:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
