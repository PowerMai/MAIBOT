from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List

from backend.tools.base.paths import get_workspace_root


class CostTracker:
    """记录 data/cost_ledger.jsonl 成本账本。"""

    def __init__(self, path: Path | None = None):
        ws = get_workspace_root()
        self.path = path or (ws / "data" / "cost_ledger.jsonl")

    def record(self, event: str, token_cost: float = 0.0, usd_cost: float = 0.0, metadata: Dict[str, Any] | None = None) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        row = {
            "ts": datetime.utcnow().isoformat() + "Z",
            "event": event,
            "token_cost": float(token_cost),
            "usd_cost": float(usd_cost),
            "metadata": metadata or {},
        }
        with self.path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    def tail(self, limit: int = 20) -> List[Dict[str, Any]]:
        if not self.path.exists():
            return []
        lines = self.path.read_text(encoding="utf-8").splitlines()
        out: List[Dict[str, Any]] = []
        for line in lines[-max(1, limit):]:
            try:
                val = json.loads(line)
                if isinstance(val, dict):
                    out.append(val)
            except Exception:
                continue
        return out

