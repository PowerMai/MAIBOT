from __future__ import annotations

from datetime import datetime
from pathlib import Path

from backend.tools.base.paths import get_workspace_root


class Journal:
    """写入 journal/YYYY-MM-DD.md 每日活动日志。"""

    def __init__(self, root: Path | None = None):
        ws = get_workspace_root()
        self.root = root or (ws / "journal")

    def _today_path(self) -> Path:
        day = datetime.now().strftime("%Y-%m-%d")
        return self.root / f"{day}.md"

    def append(self, section: str, content: str) -> Path:
        self.root.mkdir(parents=True, exist_ok=True)
        p = self._today_path()
        ts = datetime.now().strftime("%H:%M:%S")
        block = f"\n## {section}\n- {ts} {content}\n"
        if not p.exists():
            p.write_text(f"# Journal {datetime.now().strftime('%Y-%m-%d')}\n", encoding="utf-8")
        with p.open("a", encoding="utf-8") as f:
            f.write(block)
        return p

