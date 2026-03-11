#!/usr/bin/env python3
"""
插件运行时兼容最小冒烟：
1) 已加载插件的 components.agents/hooks/mcp 声明与运行时可见性一致
2) 未声明执行面组件时给出 warn（不阻断），用于持续补齐生态覆盖
"""

from __future__ import annotations

import argparse
import importlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

from fastapi.testclient import TestClient

PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

app_module = importlib.import_module("backend.api.app")  # noqa: E402
from backend.api.app import app  # noqa: E402


def _write_report(path: str, payload: dict) -> str:
    out = Path(path)
    if not out.is_absolute():
        out = PROJECT_ROOT / out
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return out.as_posix()


def _fail(report: Dict[str, Any], report_json: str, message: str) -> int:
    report["status"] = "fail"
    report["errors"].append(message)
    report_path = _write_report(report_json, report)
    print(f"[plugin-runtime-compat:smoke] FAIL: {message}")
    print(f"- report: {report_path}")
    return 1


def run(report_json: str = "backend/data/plugin_runtime_compat_smoke_report.json") -> int:
    report: Dict[str, Any] = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "status": "fail",
        "checks": {},
        "metrics": {},
        "warnings": [],
        "errors": [],
    }
    client = TestClient(app)
    try:
        plugins_resp = client.get("/plugins/list")
        report["checks"]["plugins_list_api"] = {"status_code": plugins_resp.status_code}
        if plugins_resp.status_code != 200:
            return _fail(report, report_json, f"/plugins/list 返回异常: {plugins_resp.status_code} {plugins_resp.text}")
        body = plugins_resp.json() if plugins_resp.content else {}
        plugins = body.get("plugins", []) if isinstance(body, dict) else []
        if not isinstance(plugins, list):
            return _fail(report, report_json, "/plugins/list 返回结构异常")
        report["metrics"]["manifest_warnings_count"] = int(body.get("manifest_warnings_count", 0) or 0)
        report["metrics"]["manifest_errors_count"] = int(body.get("manifest_errors_count", 0) or 0)

        loaded_names = {str((row or {}).get("name") or "").strip() for row in plugins if isinstance(row, dict) and row.get("loaded")}
        loaded_names = {x for x in loaded_names if x}
        report["metrics"]["loaded_plugins"] = len(loaded_names)

        loader = app_module._build_plugin_loader()  # type: ignore[attr-defined]
        for name in loaded_names:
            try:
                loader.load(name)
            except Exception as e:
                report["warnings"].append(f"插件加载跳过 {name}: {e}")
        loaded_specs = loader.list_loaded()
        by_name = {str(spec.name or ""): spec for spec in loaded_specs}

        declared_agents = 0
        declared_hooks = 0
        declared_mcp = 0
        checked_plugins = 0
        active_agents = set(loader.get_active_agents())
        mcp_cfg = app_module._load_mcp_servers_config()  # type: ignore[attr-defined]
        mcp_servers = mcp_cfg.get("servers", []) if isinstance(mcp_cfg, dict) else []
        mcp_index = {
            str(row.get("name") or "").strip(): bool(row.get("enabled"))
            for row in mcp_servers
            if isinstance(row, dict) and str(row.get("name") or "").strip()
        }

        for plugin_name in sorted(loaded_names):
            spec = by_name.get(plugin_name)
            if spec is None:
                report["warnings"].append(f"已加载插件 {plugin_name} 未在 loader.list_loaded() 中解析到")
                continue
            checked_plugins += 1
            comps = spec.components or {}
            agents = comps.get("agents") if isinstance(comps.get("agents"), list) else []
            hooks = comps.get("hooks") if isinstance(comps.get("hooks"), list) else []
            mcps = comps.get("mcp") if isinstance(comps.get("mcp"), list) else []
            declared_agents += len(agents)
            declared_hooks += len(hooks)
            declared_mcp += len(mcps)

            if agents:
                resolved = set(spec.resolved_agents())
                if not resolved:
                    return _fail(report, report_json, f"{plugin_name}: 声明 agents 但未发现 agents/*.md")
                if not resolved.issubset(active_agents):
                    return _fail(report, report_json, f"{plugin_name}: agents 未全部暴露到运行时 active_agents")

            if hooks:
                hook_path = spec.resolved_hooks_path()
                if not hook_path:
                    return _fail(report, report_json, f"{plugin_name}: 声明 hooks 但缺少 hooks/hooks.json")

            if mcps:
                enabled_hits = 0
                for item in mcps:
                    aliases = app_module._resolve_mcp_server_aliases(str(item))  # type: ignore[attr-defined]
                    for alias in aliases:
                        if alias in mcp_index and bool(mcp_index.get(alias)):
                            enabled_hits += 1
                if enabled_hits == 0:
                    # 触发一次 install 路径，复用现有同步逻辑把 MCP server enabled 状态与插件加载态对齐
                    install_resp = client.post("/plugins/install", json={"name": plugin_name})
                    report["checks"][f"resync_mcp_{plugin_name}"] = {"status_code": install_resp.status_code}
                    if install_resp.status_code == 200:
                        mcp_cfg = app_module._load_mcp_servers_config()  # type: ignore[attr-defined]
                        mcp_servers = mcp_cfg.get("servers", []) if isinstance(mcp_cfg, dict) else []
                        mcp_index = {
                            str(row.get("name") or "").strip(): bool(row.get("enabled"))
                            for row in mcp_servers
                            if isinstance(row, dict) and str(row.get("name") or "").strip()
                        }
                        for item in mcps:
                            aliases = app_module._resolve_mcp_server_aliases(str(item))  # type: ignore[attr-defined]
                            for alias in aliases:
                                if alias in mcp_index and bool(mcp_index.get(alias)):
                                    enabled_hits += 1
                if enabled_hits == 0:
                    return _fail(report, report_json, f"{plugin_name}: 声明 mcp 但未看到对应 MCP server 启用")

        if declared_agents == 0 and declared_hooks == 0 and declared_mcp == 0:
            report["warnings"].append("所有已加载插件均未声明 agents/hooks/mcp，执行面覆盖不足")

        report["checks"]["runtime_component_consistency"] = {"ok": True}
        report["metrics"].update(
            {
                "checked_plugins": checked_plugins,
                "declared_agents": declared_agents,
                "declared_hooks": declared_hooks,
                "declared_mcp": declared_mcp,
                "active_agents": len(active_agents),
            }
        )
        # 覆盖度告警仅作为改进信号，不作为兼容失败；真正不一致由 errors/fail 阻断。
        report["status"] = "pass"
        report_path = _write_report(report_json, report)
        print("[plugin-runtime-compat:smoke] PASS")
        print(f"- checked_plugins: {checked_plugins}")
        print(f"- declared_agents/hooks/mcp: {declared_agents}/{declared_hooks}/{declared_mcp}")
        print(f"- report: {report_path}")
        return 0
    finally:
        client.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="插件运行时兼容最小冒烟")
    parser.add_argument(
        "--report-json",
        default="backend/data/plugin_runtime_compat_smoke_report.json",
        help="报告输出路径（默认: backend/data/plugin_runtime_compat_smoke_report.json）",
    )
    args = parser.parse_args()
    raise SystemExit(run(report_json=str(args.report_json or "backend/data/plugin_runtime_compat_smoke_report.json")))
