#!/usr/bin/env python3
"""
全链路业务验收入口：
1) 运行看板分发关键路径回归
2) 运行模型-角色-分发联动回归
3) 附加基础性能探测（/board/tasks 列表接口）
4) 输出统一 JSON 报告，供 release_gate 或人工审查
"""

from __future__ import annotations

import json
import statistics
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient


PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.api.app import app  # noqa: E402


def _run_script(script_name: str, timeout_sec: int = 90) -> dict[str, Any]:
    script_path = PROJECT_ROOT / "backend" / "scripts" / script_name
    started = time.perf_counter()
    try:
        proc = subprocess.run(
            [sys.executable, str(script_path)],
            capture_output=True,
            text=True,
            cwd=str(PROJECT_ROOT),
            timeout=timeout_sec,
        )
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        return {
            "name": script_name,
            "ok": proc.returncode == 0,
            "elapsed_ms": elapsed_ms,
            "stdout": proc.stdout[-2000:],
            "stderr": proc.stderr[-2000:],
            "exit_code": proc.returncode,
        }
    except subprocess.TimeoutExpired as exc:
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        return {
            "name": script_name,
            "ok": False,
            "elapsed_ms": elapsed_ms,
            "stdout": (exc.stdout or "")[-2000:],
            "stderr": (exc.stderr or "")[-2000:],
            "exit_code": -1,
            "error": f"timeout_after_{timeout_sec}s",
        }


def _probe_board_list_latency(samples: int = 10) -> dict[str, Any]:
    timings: list[float] = []
    errors = 0
    client = TestClient(app)
    try:
        for _ in range(max(1, samples)):
            t0 = time.perf_counter()
            resp = client.get("/board/tasks", params={"scope": "personal"})
            timings.append((time.perf_counter() - t0) * 1000)
            if resp.status_code != 200:
                errors += 1
    finally:
        client.close()
    timings_sorted = sorted(timings)
    p95_index = min(len(timings_sorted) - 1, int(round(len(timings_sorted) * 0.95)) - 1)
    p95 = timings_sorted[p95_index] if timings_sorted else 0.0
    avg = statistics.mean(timings_sorted) if timings_sorted else 0.0
    return {
        "samples": len(timings_sorted),
        "errors": errors,
        "avg_ms": round(avg, 2),
        "p95_ms": round(p95, 2),
        "max_ms": round(max(timings_sorted), 2) if timings_sorted else 0.0,
        "threshold": {"p95_ms": 500.0, "errors": 0},
        "pass": errors == 0 and p95 <= 500.0,
    }


def run() -> int:
    checks = [
        _run_script("test_board_dispatch_regression.py"),
        _run_script("test_model_role_dispatch_e2e.py"),
    ]
    perf = _probe_board_list_latency(samples=12)
    overall_ok = all(bool(c["ok"]) for c in checks) and bool(perf["pass"])

    report = {
        "ok": overall_ok,
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "checks": checks,
        "performance": perf,
        "definition_of_done": {
            "functional": all(bool(c["ok"]) for c in checks),
            "exceptions": all(bool(c["ok"]) for c in checks),
            "performance": bool(perf["pass"]),
            "consistency": all(bool(c["ok"]) for c in checks),
        },
    }

    out_path = PROJECT_ROOT / "backend" / "data" / "business_acceptance_report.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"业务验收报告已写入: {out_path}")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if overall_ok else 1


if __name__ == "__main__":
    raise SystemExit(run())
