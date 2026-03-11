from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from backend.tools.base.paths import get_project_root

_WEEKDAY_MAP = {
    "mon": 0,
    "monday": 0,
    "tue": 1,
    "tuesday": 1,
    "wed": 2,
    "wednesday": 2,
    "thu": 3,
    "thursday": 3,
    "fri": 4,
    "friday": 4,
    "sat": 5,
    "saturday": 5,
    "sun": 6,
    "sunday": 6,
}


@dataclass
class TriggerTask:
    raw: Dict[str, Any]
    parsed: Dict[str, Any]
    slot: str


class TriggerManager:
    """
    统一触发器管理（当前实现 cron，预留 file-watch/system-event/calendar/shortcut）。
    """

    def __init__(self, config_path: Optional[Path] = None):
        root = get_project_root()
        self.config_path = config_path or (root / "backend" / "config" / "autonomous_tasks.json")

    def load_config(self) -> List[Dict[str, Any]]:
        if not self.config_path.exists():
            return []
        try:
            data = json.loads(self.config_path.read_text(encoding="utf-8"))
        except Exception:
            return []
        return data if isinstance(data, list) else []

    @staticmethod
    def parse_schedule(rule: str) -> Dict[str, Any]:
        raw = (rule or "").strip().lower()
        parts = raw.split()
        if len(parts) == 2 and parts[0] == "daily":
            return {"kind": "cron.daily", "time": parts[1]}
        if len(parts) == 3 and parts[0] == "weekly" and parts[1] in _WEEKDAY_MAP:
            return {"kind": "cron.weekly", "weekday": _WEEKDAY_MAP[parts[1]], "time": parts[2]}
        return {}

    @staticmethod
    def is_due(parsed: Dict[str, Any], now: datetime) -> bool:
        hhmm = str(parsed.get("time", "00:00"))
        try:
            h, m = hhmm.split(":")
            hour = int(h)
            minute = int(m)
        except Exception:
            return False
        if parsed.get("kind") == "cron.daily":
            return (now.hour, now.minute) >= (hour, minute)
        if parsed.get("kind") == "cron.weekly":
            return now.weekday() == int(parsed.get("weekday", -1)) and (now.hour, now.minute) >= (hour, minute)
        return False

    @staticmethod
    def slot_key(parsed: Dict[str, Any], now: datetime) -> str:
        hhmm = str(parsed.get("time", "00:00"))
        if parsed.get("kind") == "cron.daily":
            return f"daily:{now.strftime('%Y-%m-%d')}:{hhmm}"
        if parsed.get("kind") == "cron.weekly":
            return f"weekly:{now.strftime('%Y-%m-%d')}:{hhmm}"
        return ""

    def due_tasks(self, now: datetime) -> List[TriggerTask]:
        out: List[TriggerTask] = []
        for item in self.load_config():
            if not isinstance(item, dict) or not item.get("enabled", False):
                continue
            parsed = self.parse_schedule(str(item.get("schedule", "") or ""))
            if not parsed:
                continue
            if not self.is_due(parsed, now):
                continue
            out.append(TriggerTask(raw=item, parsed=parsed, slot=self.slot_key(parsed, now)))
        return out

