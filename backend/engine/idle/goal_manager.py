from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List

from backend.tools.base.paths import get_workspace_root


@dataclass
class GoalSnapshot:
    strategic: List[str]
    current: List[str]
    defaults: List[str]

    def as_dict(self) -> Dict[str, List[str]]:
        return {
            "strategic": self.strategic,
            "current": self.current,
            "defaults": self.defaults,
        }


class GoalManager:
    """管理 goals/active.md 目标栈。"""

    def __init__(self, path: Path | None = None):
        ws = get_workspace_root()
        self.path = path or (ws / "goals" / "active.md")

    def ensure_file(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if self.path.exists():
            return
        template = (
            "# Goals\n\n"
            "## Strategic\n"
            "- Build a high-quality autonomous agent product.\n\n"
            "## Current\n"
            "- Keep improving system reliability and capability.\n\n"
            "## Default\n"
            "- Run lightweight exploration and summarize findings.\n"
        )
        self.path.write_text(template, encoding="utf-8")

    def load(self) -> GoalSnapshot:
        self.ensure_file()
        text = self.path.read_text(encoding="utf-8")
        sections: Dict[str, List[str]] = {"strategic": [], "current": [], "default": []}
        current_key: str | None = None
        for raw in text.splitlines():
            line = raw.strip()
            if line.startswith("## "):
                title = line[3:].strip().lower()
                if title.startswith("strategic"):
                    current_key = "strategic"
                elif title.startswith("current"):
                    current_key = "current"
                elif title.startswith("default"):
                    current_key = "default"
                else:
                    current_key = None
                continue
            if current_key and line.startswith("- "):
                sections[current_key].append(line[2:].strip())
        return GoalSnapshot(
            strategic=sections["strategic"],
            current=sections["current"],
            defaults=sections["default"],
        )

    def next_goal(self) -> str:
        snap = self.load()
        if snap.current:
            return snap.current[0]
        if snap.defaults:
            return snap.defaults[0]
        return "Run a lightweight system self-check and learning cycle."

