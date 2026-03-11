#!/usr/bin/env python3
"""Model discovery and health snapshot for autonomous upgrades."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib import request as urlrequest
from urllib.error import URLError, HTTPError


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _read_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def _probe_http_base(url: str) -> dict[str, Any]:
    if not url:
        return {"reachable": False, "reason": "empty_url"}
    try:
        # Prefer simple /models probing for OpenAI-compatible endpoints.
        req = urlrequest.Request(url.rstrip("/") + "/models", method="GET")
        with urlrequest.urlopen(req, timeout=2) as resp:
            code = int(getattr(resp, "status", 0) or 0)
        return {"reachable": code in (200, 401, 403), "status_code": code}
    except HTTPError as e:
        code = int(getattr(e, "code", 0) or 0)
        return {"reachable": code in (401, 403), "status_code": code}
    except URLError as e:
        return {"reachable": False, "reason": str(e.reason)}
    except Exception as e:
        return {"reachable": False, "reason": str(e)}


def _scan_models(models_cfg: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for item in models_cfg.get("models", []) or []:
        if not isinstance(item, dict):
            continue
        url = str(item.get("url", "") or "")
        capability = item.get("capability") if isinstance(item.get("capability"), dict) else {}
        row = {
            "id": item.get("id"),
            "name": item.get("name"),
            "enabled": bool(item.get("enabled", False)),
            "tier": item.get("tier"),
            "priority": item.get("priority"),
            "provider": item.get("provider"),
            "context_length": item.get("context_length"),
            "is_reasoning_model": bool(item.get("is_reasoning_model", False)),
            "capability": capability,
            "endpoint_probe": _probe_http_base(url),
        }
        rows.append(row)
    return rows


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate model discovery snapshot")
    parser.add_argument(
        "--output",
        default="knowledge_base/learned/auto_upgrade/model_discovery_scan.json",
        help="Output JSON path relative to repo root",
    )
    args = parser.parse_args()

    root = _repo_root()
    models_cfg = _read_json(root / "backend" / "config" / "models.json", {})
    rows = _scan_models(models_cfg if isinstance(models_cfg, dict) else {})

    enabled = [x for x in rows if x.get("enabled")]
    reachable = [x for x in rows if (x.get("endpoint_probe") or {}).get("reachable")]

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "default_model": (models_cfg or {}).get("default_model"),
        "total_models": len(rows),
        "enabled_models": len(enabled),
        "reachable_endpoints": len(reachable),
        "models": rows,
    }

    out_path = root / args.output
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
