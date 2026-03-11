from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List


def _events_path(project_root: Path) -> Path:
    return project_root / "data" / "plugin_runtime_events.jsonl"


def append_plugin_runtime_event(project_root: Path, event: str, payload: Dict[str, Any] | None = None) -> None:
    p = _events_path(project_root)
    p.parent.mkdir(parents=True, exist_ok=True)
    row = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "event": str(event or "").strip() or "plugin_event",
        "payload": payload or {},
    }
    with p.open("a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")


def load_plugin_runtime_events(project_root: Path, limit: int = 200) -> List[Dict[str, Any]]:
    p = _events_path(project_root)
    if not p.exists():
        return []
    lines = p.read_text(encoding="utf-8").splitlines()
    rows: List[Dict[str, Any]] = []
    for line in lines[-max(1, int(limit or 1)) :]:
        try:
            row = json.loads(line)
            if isinstance(row, dict):
                rows.append(row)
        except Exception:
            continue
    return rows
