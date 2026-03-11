#!/usr/bin/env python3
"""
插件命令冲突与解析确定性检查（先 warn）：
1) /plugins/commands 返回结构可用
2) 检测 command 重名冲突（跨插件）
3) 对重名命令验证 /cmd@plugin 的定向解析可用
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

from fastapi.testclient import TestClient

PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.api.app import app  # noqa: E402


def _write_report(path: str, payload: Dict[str, Any]) -> str:
    out = Path(path)
    if not out.is_absolute():
        out = PROJECT_ROOT / out
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return out.as_posix()


def _fail(message: str) -> int:
    print(f"[plugin-command-conflicts] FAIL: {message}")
    return 1


def run(report_json: str = "backend/data/plugin_command_conflicts_report.json") -> int:
    report: Dict[str, Any] = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "status": "fail",
        "checks": {},
        "metrics": {},
        "warnings": [],
    }

    client = TestClient(app)
    try:
        resp = client.get("/plugins/commands")
        report["checks"]["plugins_commands_api"] = {"status_code": resp.status_code}
        if resp.status_code != 200:
            _write_report(report_json, report)
            return _fail(f"/plugins/commands 返回异常: {resp.status_code}")
        body = resp.json() if isinstance(resp.json(), dict) else {}
        rows = body.get("commands", []) if isinstance(body, dict) else []
        if not isinstance(rows, list):
            _write_report(report_json, report)
            return _fail("/plugins/commands 返回结构异常")

        by_cmd: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
        for row in rows:
            if not isinstance(row, dict):
                continue
            cmd = str(row.get("command") or "").strip().lower()
            plugin = str(row.get("plugin") or "").strip().lower()
            if not cmd or not plugin:
                continue
            by_cmd[cmd].append(row)

        conflicts = {cmd: entries for cmd, entries in by_cmd.items() if len(entries) > 1}
        deterministic_checked = 0
        deterministic_failed = 0

        for cmd, entries in list(conflicts.items())[:20]:
            for row in entries[:5]:
                plugin = str(row.get("plugin") or "").strip().lower()
                if not plugin:
                    continue
                deterministic_checked += 1
                slash_resp = client.post("/slash/execute", json={"command": f"{cmd}@{plugin} smoke"})
                if slash_resp.status_code != 200:
                    deterministic_failed += 1
                    continue
                data = slash_resp.json() if isinstance(slash_resp.json(), dict) else {}
                if str(data.get("source") or "") != "plugin_command":
                    deterministic_failed += 1
                    continue
                if str(data.get("plugin") or "").strip().lower() != plugin:
                    deterministic_failed += 1

        if conflicts:
            report["warnings"].append(f"duplicate_commands={len(conflicts)}")
        if deterministic_failed > 0:
            report["warnings"].append(f"deterministic_resolution_failed={deterministic_failed}")

        report["metrics"] = {
            "commands_total": len(rows),
            "unique_commands": len(by_cmd),
            "duplicate_commands": len(conflicts),
            "deterministic_checked": deterministic_checked,
            "deterministic_failed": deterministic_failed,
            "sample_conflicts": {
                cmd: sorted({str(item.get("plugin") or "") for item in entries})
                for cmd, entries in list(conflicts.items())[:8]
            },
        }
        report["status"] = "warn" if report["warnings"] else "pass"
        out = _write_report(report_json, report)
        print("[plugin-command-conflicts] PASS")
        print(f"- commands_total: {len(rows)}")
        print(f"- duplicate_commands: {len(conflicts)}")
        print(f"- report: {out}")
        return 0
    finally:
        client.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="插件命令冲突与解析确定性检查（先 warn）")
    parser.add_argument(
        "--report-json",
        default="backend/data/plugin_command_conflicts_report.json",
        help="报告输出路径（默认: backend/data/plugin_command_conflicts_report.json）",
    )
    args = parser.parse_args()
    raise SystemExit(run(report_json=str(args.report_json or "backend/data/plugin_command_conflicts_report.json")))

