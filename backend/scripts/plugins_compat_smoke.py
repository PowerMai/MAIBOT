#!/usr/bin/env python3
"""
插件兼容性最小冒烟：
1) plugin manifest 基础兼容校验
2) 插件命令发现接口可用
3) slash 插件命令 fallback 可用（以 /bid-review 为例）
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from fastapi.testclient import TestClient

PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.api.app import app  # noqa: E402
from backend.scripts.check_plugin_manifest_compat import main as manifest_check_main  # noqa: E402


def _write_report(path: str, payload: dict) -> str:
    out = Path(path)
    if not out.is_absolute():
        out = PROJECT_ROOT / out
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return out.as_posix()


def fail(msg: str, code: int = 1) -> int:
    print(f"[plugins-compat:smoke] FAIL: {msg}")
    return code


def run(report_json: str = "backend/data/plugins_compat_smoke_report.json") -> int:
    report: dict = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "status": "fail",
        "checks": {},
        "metrics": {},
        "warnings": [],
    }
    # A. manifest 兼容性基础门禁
    manifest_rc = manifest_check_main()
    report["checks"]["manifest_compat"] = {"ok": manifest_rc == 0, "rc": manifest_rc}
    if manifest_rc != 0:
        _write_report(report_json, report)
        return fail("manifest 兼容性检查未通过")

    client = TestClient(app)
    try:
        # B. 确保 sales 可用（用于验证插件命令 fallback）
        install = client.post("/plugins/install", json={"name": "sales"})
        report["checks"]["install_sales"] = {"status_code": install.status_code}
        if install.status_code not in (200, 402):  # 402=授权不允许；当前 smoke 主要看命令发现链路
            _write_report(report_json, report)
            return fail(f"/plugins/install 返回异常: {install.status_code} {install.text}")

        # B2. /plugins/sync 网络语义分级（不阻断核心 smoke）
        sync = client.post("/plugins/sync")
        sync_note = {"status_code": sync.status_code, "network_semantic": "ok"}
        if sync.status_code >= 400:
            sync_note["network_semantic"] = "http_error"
            report["warnings"].append(f"/plugins/sync 返回 {sync.status_code}")
        else:
            try:
                body = sync.json() if isinstance(sync.json(), dict) else {}
            except Exception:
                body = {}
            msg = str(body.get("error") or body.get("message") or "").lower()
            if "ssl" in msg or "eof" in msg or "timeout" in msg:
                sync_note["network_semantic"] = "remote_unreachable"
                report["warnings"].append("plugins source network degraded")
            elif msg:
                sync_note["network_semantic"] = "degraded"
                report["warnings"].append(msg[:200])
        report["checks"]["plugins_sync"] = sync_note

        # C. 插件命令发现
        plugins_list = client.get("/plugins/list")
        report["checks"]["plugins_list_api"] = {"status_code": plugins_list.status_code}
        if plugins_list.status_code == 200:
            try:
                pbody = plugins_list.json() if isinstance(plugins_list.json(), dict) else {}
            except Exception:
                pbody = {}
            report["metrics"]["manifest_warnings_count"] = int(pbody.get("manifest_warnings_count", 0) or 0)
            report["metrics"]["manifest_errors_count"] = int(pbody.get("manifest_errors_count", 0) or 0)

        cmds = client.get("/plugins/commands")
        report["checks"]["plugins_commands_api"] = {"status_code": cmds.status_code}
        if cmds.status_code != 200:
            _write_report(report_json, report)
            return fail(f"/plugins/commands 返回异常: {cmds.status_code} {cmds.text}")
        rows = cmds.json().get("commands", [])
        if not isinstance(rows, list):
            _write_report(report_json, report)
            return fail("/plugins/commands 返回结构异常")
        command_names = {str((x or {}).get("command") or "").strip().lower() for x in rows if isinstance(x, dict)}
        if "/bid-review" not in command_names:
            _write_report(report_json, report)
            return fail("未发现 /bid-review（插件命令发现链路异常）")

        # D. slash fallback
        slash = client.post("/slash/execute", json={"command": "/bid-review smoke"})
        report["checks"]["slash_plugin_fallback"] = {"status_code": slash.status_code}
        if slash.status_code != 200:
            _write_report(report_json, report)
            return fail(f"/slash/execute /bid-review 返回异常: {slash.status_code} {slash.text}")
        body = slash.json()
        if body.get("type") != "rewrite_prompt" or body.get("source") != "plugin_command":
            _write_report(report_json, report)
            return fail(f"插件命令 fallback 响应不符合预期: {body}")

        report["metrics"].update(
            {
                "commands_count": len(rows),
                "has_bid_review": "/bid-review" in command_names,
            }
        )
        report["status"] = "warn" if report["warnings"] else "pass"
        report_path = _write_report(report_json, report)
        print("[plugins-compat:smoke] PASS")
        print(f"- commands_count: {len(rows)}")
        print(f"- report: {report_path}")
        return 0
    finally:
        client.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="插件兼容性最小冒烟")
    parser.add_argument(
        "--report-json",
        default="backend/data/plugins_compat_smoke_report.json",
        help="报告输出路径（默认: backend/data/plugins_compat_smoke_report.json）",
    )
    args = parser.parse_args()
    sys.exit(run(report_json=str(args.report_json or "backend/data/plugins_compat_smoke_report.json")))
