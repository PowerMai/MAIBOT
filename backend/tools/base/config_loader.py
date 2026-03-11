"""
ConfigLoader - 统一配置路径管理（薄封装，不是注册表）
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


class ConfigLoader:
    """统一系统/项目/工作区配置路径管理。"""

    def __init__(self, app_root: Path, project_root: Path, workspace_root: Path) -> None:
        self.app_root = Path(app_root).resolve()
        self.project_root = Path(project_root).resolve()
        self.workspace_root = Path(workspace_root).resolve()

    def get_system_config_path(self, name: str) -> Path:
        return self.app_root / "backend" / "config" / f"{name}.json"

    def get_system_config(self, name: str, default: Any = None) -> Any:
        path = self.get_system_config_path(name)
        if not path.exists():
            return default
        return json.loads(path.read_text(encoding="utf-8"))

    def get_project_path(self, *parts: str) -> Path:
        return self.workspace_root.joinpath(".maibot", *parts)

    def get_project_config(self, name: str, default: Any = None) -> Any:
        path = self.get_project_path(name)
        if not path.exists():
            return default
        if path.suffix.lower() == ".json":
            return json.loads(path.read_text(encoding="utf-8"))
        return path.read_text(encoding="utf-8")

    def get_workspace_path(self, *parts: str) -> Path:
        return self.workspace_root.joinpath(*parts)

    def list_editable_configs(self) -> list[str]:
        return [
            str(self.get_project_path("MAIBOT.md")),
            str(self.get_project_path("SOUL.md")),
            str(self.get_project_path("TOOLS.md")),
            str(self.get_project_path("AGENTS.md")),
            str(self.get_project_path("SESSION-STATE.md")),
            str(self.get_project_path("WORKING-BUFFER.md")),
            str(self.get_project_path("EVOLUTION-SCORES.md")),
            str(self.get_project_path("persona.json")),
            str(self.get_project_path("prompt_assembly.json")),
            str(self.get_project_path("settings.json")),
            str(self.get_project_path("prompt_calibration.json")),
            str(self.workspace_root / ".learnings"),
            str(self.workspace_root / "knowledge_base" / "skills"),
        ]

