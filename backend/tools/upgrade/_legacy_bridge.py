"""Bridge backend upgrade entrypoints to legacy auto-discovery scripts."""

from __future__ import annotations

import json
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path


def _append_bridge_log(root: Path, row: dict) -> None:
    try:
        log_path = root / "data" / "upgrade_bridge_log.jsonl"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with log_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    except Exception:
        # 日志失败不影响主流程
        pass


def run_legacy(script_name: str, argv: list[str] | None = None) -> int:
    root = Path(__file__).resolve().parents[3]
    legacy = (
        root
        / "knowledge_base"
        / "skills"
        / "auto-discovery"
        / "scripts"
        / script_name
    )
    args = argv or []
    started = time.time()
    ts = datetime.now(timezone.utc).isoformat()
    if not legacy.exists():
        msg = f"legacy script not found: {legacy}"
        print(msg, file=sys.stderr)
        _append_bridge_log(
            root,
            {
                "ts": ts,
                "script": script_name,
                "argv": args,
                "legacy_path": str(legacy),
                "exit_code": 2,
                "error": msg,
                "error_summary": msg,
            },
        )
        return 2
    try:
        proc = subprocess.run(
            [sys.executable, str(legacy), *args],
            cwd=str(root),
            check=False,
            capture_output=True,
            text=True,
        )
    except Exception as e:
        err = f"bridge execution failed: {e}"
        print(err, file=sys.stderr)
        _append_bridge_log(
            root,
            {
                "ts": ts,
                "script": script_name,
                "argv": args,
                "legacy_path": str(legacy),
                "exit_code": 1,
                "error": err,
                "error_summary": err,
            },
        )
        return 1

    if proc.stdout:
        sys.stdout.write(proc.stdout)
    if proc.stderr:
        sys.stderr.write(proc.stderr)

    elapsed_ms = int((time.time() - started) * 1000)
    _append_bridge_log(
        root,
        {
            "ts": ts,
            "script": script_name,
            "argv": args,
            "legacy_path": str(legacy),
            "exit_code": int(proc.returncode),
            "elapsed_ms": elapsed_ms,
            "stdout_tail": (proc.stdout or "")[-1000:],
            "stderr_tail": (proc.stderr or "")[-1000:],
        },
    )
    if proc.returncode != 0:
        stderr_tail = (proc.stderr or "").strip()[-400:]
        stdout_tail = (proc.stdout or "").strip()[-300:]
        brief = stderr_tail or stdout_tail or "no stderr/stdout"
        print(
            f"[legacy_bridge] script={script_name} failed with exit_code={proc.returncode}. "
            f"reason={brief}. log=data/upgrade_bridge_log.jsonl",
            file=sys.stderr,
        )
    return int(proc.returncode)
