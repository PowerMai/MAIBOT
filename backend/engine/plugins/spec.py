from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional
import re


# P1-1 manifest 强校验：必需字段（Schema 最小集）
MANIFEST_REQUIRED_KEYS = ("name", "version")
MANIFEST_ALLOWED_TIERS = {"free", "pro", "team", "enterprise", "ultimate", "*"}
MANIFEST_ALLOWED_COMPONENT_KEYS = {"skills", "agents", "commands", "hooks", "mcp"}


@dataclass
class PluginSpec:
    name: str
    version: str
    description: str = ""
    requires_tier: str = "free"
    license: str = "open"
    display_name: str = ""
    author_name: str = ""
    homepage: str = ""
    repository: str = ""
    category: str = ""
    icon: str = ""
    changelog: str = ""
    compatibility_min_version: str = ""
    components: Dict[str, List[str]] = field(default_factory=dict)
    dependencies: List[str] = field(default_factory=list)
    source_path: str = ""
    discovered_only: bool = False

    def validate(self, strict: bool = False) -> Dict[str, List[str]]:
        """
        校验插件 manifest 与本地结构。
        strict=True 时将结构缺失视为错误，否则仅告警。
        """
        errors: List[str] = []
        warnings: List[str] = []
        semver_like = re.compile(r"^\d+\.\d+\.\d+([.-][0-9A-Za-z.-]+)?$")

        if not self.name:
            errors.append("manifest 缺少 name")
        if not self.version:
            errors.append("manifest 缺少 version")
        elif not semver_like.match(self.version):
            warnings.append(f"version 不是标准 semver: {self.version}")
        if self.requires_tier and self.requires_tier not in MANIFEST_ALLOWED_TIERS:
            errors.append(f"requires_tier 非法: {self.requires_tier}")

        for key in self.components.keys():
            if str(key) not in MANIFEST_ALLOWED_COMPONENT_KEYS:
                warnings.append(f"未知 components 键: {key}")

        if self.components.get("skills") is not None and not self.resolved_skills_path():
            msg = "components.skills 已声明，但未找到 skills 目录"
            (errors if strict else warnings).append(msg)
        if self.components.get("agents") is not None and not self.resolved_agents():
            msg = "components.agents 已声明，但未找到 agents/*.md"
            (errors if strict else warnings).append(msg)
        if self.components.get("commands") is not None and not self.resolved_commands():
            msg = "components.commands 已声明，但未找到 commands/*.md"
            (errors if strict else warnings).append(msg)
        if self.components.get("hooks") is not None and not self.resolved_hooks_path():
            msg = "components.hooks 已声明，但未找到 hooks/hooks.json"
            (errors if strict else warnings).append(msg)
        if self.components.get("mcp") is not None and not self.resolved_mcp_path():
            msg = "components.mcp 已声明，但未找到 .mcp.json"
            (errors if strict else warnings).append(msg)

        return {"errors": errors, "warnings": warnings}

    @staticmethod
    def validate_manifest_schema(data: Dict[str, Any]) -> Dict[str, List[str]]:
        """P1-1：manifest 强校验（Schema 层）。校验必需字段与类型，返回 errors/warnings。"""
        errors: List[str] = []
        warnings: List[str] = []
        if not isinstance(data, dict):
            errors.append("manifest 根节点必须为对象")
            return {"errors": errors, "warnings": warnings}
        for key in MANIFEST_REQUIRED_KEYS:
            if key not in data or data.get(key) is None:
                errors.append(f"manifest 缺少必需字段: {key}")
            elif not str(data.get(key)).strip():
                errors.append(f"manifest 字段不能为空: {key}")
        comp = data.get("components")
        if comp is not None and not isinstance(comp, dict):
            errors.append("components 必须为对象")
        elif isinstance(comp, dict):
            for key in comp.keys():
                if str(key) not in MANIFEST_ALLOWED_COMPONENT_KEYS:
                    warnings.append(f"未知 components 键: {key}")
        tier = str(data.get("requires_tier") or "free").strip().lower()
        if tier and tier not in MANIFEST_ALLOWED_TIERS:
            errors.append(f"requires_tier 非法: {tier}")
        return {"errors": errors, "warnings": warnings}

    @classmethod
    def from_dict(cls, data: Dict[str, Any], source_path: str = "") -> "PluginSpec":
        schema_report = cls.validate_manifest_schema(data)
        if schema_report["errors"]:
            raise ValueError(f"插件 manifest Schema 校验失败: {'; '.join(schema_report['errors'])}")
        author = data.get("author")
        author_name = ""
        if isinstance(author, dict):
            author_name = str(author.get("name") or "").strip()
        components = data.get("components")
        if not isinstance(components, dict):
            components = {}
        normalized_components: Dict[str, List[str]] = {}
        for key, value in components.items():
            if isinstance(value, list):
                normalized_components[str(key)] = [str(item).strip() for item in value if str(item).strip()]
        deps = data.get("dependencies")
        dependencies = [str(item).strip() for item in deps] if isinstance(deps, list) else []

        return cls(
            name=str(data.get("name") or "").strip(),
            version=str(data.get("version") or "0.1.0").strip(),
            description=str(data.get("description") or "").strip(),
            requires_tier=str(data.get("requires_tier") or "free").strip().lower(),
            license=str(data.get("license") or "open").strip().lower(),
            display_name=str(data.get("display_name") or data.get("name") or "").strip(),
            author_name=author_name,
            homepage=str(data.get("homepage") or "").strip(),
            repository=str(data.get("repository") or "").strip(),
            category=str(data.get("category") or "").strip(),
            icon=str(data.get("icon") or "").strip(),
            changelog=str(data.get("changelog") or "").strip(),
            compatibility_min_version=str(
                (
                    (data.get("compatibility") or {}).get("min_version")
                    if isinstance(data.get("compatibility"), dict)
                    else ""
                )
                or ""
            ).strip(),
            components=normalized_components,
            dependencies=dependencies,
            source_path=source_path,
        )

    def _plugin_root(self) -> Path:
        base = Path(self.source_path)
        if base.is_file():
            base = base.parent
        if base.name == ".claude-plugin":
            base = base.parent
        return base.resolve()

    def resolved_skills_path(self) -> Optional[str]:
        path = self._plugin_root() / "skills"
        return str(path) if path.exists() and path.is_dir() else None

    def resolved_prompt_overlay_path(self) -> Optional[str]:
        path = self._plugin_root() / "prompt_overlay.json"
        return str(path) if path.exists() and path.is_file() else None

    def resolved_agents(self) -> List[str]:
        resolved: List[str] = []
        agents_dir = self._plugin_root() / "agents"
        if not agents_dir.exists() or not agents_dir.is_dir():
            return resolved
        for path in sorted(agents_dir.glob("*.md")):
            resolved.append(str(path.resolve()))
        return resolved

    def resolved_commands(self) -> List[str]:
        resolved: List[str] = []
        commands_dir = self._plugin_root() / "commands"
        if not commands_dir.exists() or not commands_dir.is_dir():
            return resolved
        for path in sorted(commands_dir.glob("*.md")):
            resolved.append(str(path.resolve()))
        return resolved

    def resolved_hooks_path(self) -> Optional[str]:
        path = self._plugin_root() / "hooks" / "hooks.json"
        return str(path) if path.exists() and path.is_file() else None

    def resolved_mcp_path(self) -> Optional[str]:
        path = self._plugin_root() / ".mcp.json"
        return str(path) if path.exists() and path.is_file() else None
