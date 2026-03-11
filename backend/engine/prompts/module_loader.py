from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class AssemblyContext:
    workspace_root: Path
    mode: str
    tool_names: list[str]
    role_id: str


class PromptModuleLoader:
    """文件系统驱动的提示词模块加载器。"""

    def __init__(self, app_root: Path):
        self.app_root = Path(app_root).resolve()
        self.modules_root = self.app_root / "backend" / "engine" / "prompts" / "modules"
    
    def _get_module_roots(
        self,
        workspace_root: Path | None = None,
        enable_workspace_overrides: bool = True,
    ) -> list[Path]:
        roots: list[Path] = []
        if workspace_root and enable_workspace_overrides:
            roots.append(Path(workspace_root).resolve() / ".maibot" / "modules")
        roots.append(self.modules_root)
        return roots

    def _read_json(self, path: Path, default: dict[str, Any]) -> dict[str, Any]:
        if not path.exists():
            return default
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return default

    def _resolve_detail_level(self, cfg: dict[str, Any], model_id: str = "") -> str:
        detail_cfg = cfg.get("detail_level", {}) if isinstance(cfg, dict) else {}
        default = str(detail_cfg.get("default", "concise") or "concise")
        overrides = detail_cfg.get("model_overrides", {}) if isinstance(detail_cfg, dict) else {}
        if model_id and isinstance(overrides, dict):
            return str(overrides.get(model_id, default) or default)
        return default

    def _load_runtime_settings(self, workspace_root: Path) -> dict[str, Any]:
        settings_path = Path(workspace_root).resolve() / ".maibot" / "settings.json"
        settings = self._read_json(settings_path, {})
        prompt_cfg = settings.get("prompt_modules", {}) if isinstance(settings, dict) else {}
        if not isinstance(prompt_cfg, dict):
            prompt_cfg = {}
        return {
            "enabled": bool(prompt_cfg.get("enabled", True)),
            "enable_workspace_overrides": bool(prompt_cfg.get("enable_workspace_overrides", True)),
            "force_detail_level": str(prompt_cfg.get("force_detail_level", "") or "").strip().lower(),
            "warn_missing_modules": bool(prompt_cfg.get("warn_missing_modules", True)),
        }

    def load_module(
        self,
        name: str,
        detail_level: str = "concise",
        workspace_root: Path | None = None,
        enable_workspace_overrides: bool = True,
    ) -> str:
        for root in self._get_module_roots(
            workspace_root=workspace_root,
            enable_workspace_overrides=enable_workspace_overrides,
        ):
            base = root / f"{name}.md"
            detailed = root / f"{name}.detailed.md"
            concise = root / f"{name}.concise.md"

            candidates: list[Path] = []
            if detail_level == "detailed":
                candidates = [detailed, base, concise]
            else:
                candidates = [concise, base, detailed]

            for p in candidates:
                if p.exists() and p.is_file():
                    try:
                        return p.read_text(encoding="utf-8").strip()
                    except Exception:
                        return ""
        return ""

    def list_available(
        self,
        workspace_root: Path | None = None,
        enable_workspace_overrides: bool = True,
    ) -> list[str]:
        names: set[str] = set()
        for root in self._get_module_roots(
            workspace_root=workspace_root,
            enable_workspace_overrides=enable_workspace_overrides,
        ):
            if not root.exists():
                continue
            for p in root.rglob("*.md"):
                rel = str(p.relative_to(root))
                if rel.endswith(".detailed.md"):
                    rel = rel[: -len(".detailed.md")]
                elif rel.endswith(".concise.md"):
                    rel = rel[: -len(".concise.md")]
                else:
                    rel = rel[: -len(".md")]
                names.add(rel)
        return sorted(names)

    def assemble(self, context: AssemblyContext, model_id: str = "") -> str:
        """按 tool/mode/role 条件加载模块并拼接。当工作区无 .maibot/prompt_assembly.json 时使用空默认配置（always_load/tool_conditional 等为空），不加载任何扩展模块；如需完整行为可从仓库 .maibot/prompt_assembly.json 复制到工作区。"""
        runtime_settings = self._load_runtime_settings(context.workspace_root)
        if not runtime_settings.get("enabled", True):
            return ""

        pa_path = context.workspace_root / ".maibot" / "prompt_assembly.json"
        cfg = self._read_json(
            pa_path,
            {
                "detail_level": {"default": "concise", "model_overrides": {}},
                "always_load": [],
                "tool_conditional": {},
                "mode_conditional": {},
                "role_conditional": {},
            },
        )
        detail_level = self._resolve_detail_level(cfg, model_id=model_id)
        force_detail_level = runtime_settings.get("force_detail_level", "")
        if force_detail_level in {"concise", "detailed"}:
            detail_level = force_detail_level
        enable_workspace_overrides = bool(runtime_settings.get("enable_workspace_overrides", True))
        warn_missing_modules = bool(runtime_settings.get("warn_missing_modules", True))
        modules: list[str] = []

        def _append_module_ref(value: Any) -> None:
            if isinstance(value, str):
                modules.append(value)
            elif isinstance(value, list):
                for item in value:
                    if isinstance(item, str):
                        modules.append(item)

        for m in cfg.get("always_load", []) or []:
            _append_module_ref(m)

        tool_conditional = cfg.get("tool_conditional", {}) or {}
        if isinstance(tool_conditional, dict):
            for tool_name in context.tool_names:
                _append_module_ref(tool_conditional.get(tool_name))

        mode_conditional = cfg.get("mode_conditional", {}) or {}
        if isinstance(mode_conditional, dict):
            _append_module_ref(mode_conditional.get(context.mode))

        role_conditional = cfg.get("role_conditional", {}) or {}
        if isinstance(role_conditional, dict) and context.role_id:
            _append_module_ref(role_conditional.get(context.role_id))

        # 去重（保序），避免多来源配置重复注入同一模块
        deduped_modules: list[str] = []
        seen: set[str] = set()
        for mod in modules:
            if mod not in seen:
                seen.add(mod)
                deduped_modules.append(mod)

        loaded: list[str] = []
        missing: list[str] = []
        for mod_name in deduped_modules:
            content = self.load_module(
                mod_name,
                detail_level=detail_level,
                workspace_root=context.workspace_root,
                enable_workspace_overrides=enable_workspace_overrides,
            )
            if content:
                loaded.append(content)
            else:
                missing.append(mod_name)
        if warn_missing_modules and missing:
            logger.warning(
                "Prompt modules missing: %s (workspace=%s)",
                ", ".join(missing),
                str(context.workspace_root),
            )
        return "\n\n".join(loaded)

