#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict

PROJECT_ROOT = Path(__file__).resolve().parents[2]


def _resolve(path_like: str) -> Path:
    p = Path(path_like)
    return p if p.is_absolute() else (PROJECT_ROOT / p)


def _read_text(path: Path) -> str:
    if not path.exists():
        return ""
    try:
        return path.read_text(encoding="utf-8")
    except Exception:
        return ""


def _check_token(path: Path, token: str) -> bool:
    return token in _read_text(path)


def main() -> int:
    parser = argparse.ArgumentParser(description="Build memory scope contract report")
    parser.add_argument(
        "--output-json",
        default="backend/data/memory_scope_contract_report.json",
        help="Output report path",
    )
    args = parser.parse_args()

    paths = {
        "main_graph": PROJECT_ROOT / "backend" / "engine" / "core" / "main_graph.py",
        "store_namespaces": PROJECT_ROOT / "backend" / "config" / "store_namespaces.py",
        "safe_storage": PROJECT_ROOT / "frontend" / "desktop" / "src" / "lib" / "safeStorage.ts",
        "role_identity": PROJECT_ROOT / "frontend" / "desktop" / "src" / "lib" / "roleIdentity.ts",
        "chat_mode_state": PROJECT_ROOT / "frontend" / "desktop" / "src" / "lib" / "chatModeState.ts",
        "contract_doc": PROJECT_ROOT / "docs" / "memory-scope-contract_2026-03-02.md",
    }

    checks: Dict[str, Dict[str, Any]] = {
        "scope_resolver_enabled": {
            "ok": _check_token(paths["main_graph"], "resolve_memory_scope("),
            "path": paths["main_graph"].as_posix(),
        },
        "thread_id_not_user_fallback": {
            "ok": not _check_token(paths["main_graph"], 'configurable.get("thread_id", "default_user")'),
            "path": paths["main_graph"].as_posix(),
        },
        "workspace_user_namespace": {
            "ok": _check_token(paths["store_namespaces"], '("memories", "{workspace_id}", "{user_id}")'),
            "path": paths["store_namespaces"].as_posix(),
        },
        "thread_keys_window_scoped": {
            "ok": _check_token(paths["safe_storage"], "isWindowScopedKey(")
            and _check_token(paths["safe_storage"], '"maibot_session_plugins_thread_"'),
            "path": paths["safe_storage"].as_posix(),
        },
        "global_role_default_split": {
            "ok": _check_token(paths["role_identity"], "maibot_active_role_default"),
            "path": paths["role_identity"].as_posix(),
        },
        "global_mode_default_split": {
            "ok": _check_token(paths["chat_mode_state"], "maibot_chat_mode_default"),
            "path": paths["chat_mode_state"].as_posix(),
        },
        "contract_documented": {
            "ok": paths["contract_doc"].exists(),
            "path": paths["contract_doc"].as_posix(),
        },
    }

    failed = [name for name, row in checks.items() if not bool(row.get("ok"))]
    status = "pass" if not failed else "warn"
    out = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "status": status,
        "workspace_isolated_default": True,
        "failed_checks": failed,
        "checks": checks,
    }

    output = _resolve(args.output_json)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("memory scope contract report built")
    print(f"- status: {status}")
    print(f"- output: {output.as_posix()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

