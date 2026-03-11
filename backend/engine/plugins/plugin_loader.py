from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Dict, List, Optional, Set

from backend.config.store_namespaces import NS_BILLING_USAGE
from backend.engine.license.tier_service import current_tier, is_plugin_install_allowed, tier_rank
from .plugin_registry import PluginRegistry
from .spec import PluginSpec

logger = logging.getLogger(__name__)


class PluginLoader:
    def __init__(
        self,
        project_root: Optional[Path] = None,
        profile: Optional[dict] = None,
        store=None,
    ) -> None:
        self.project_root = project_root or Path(__file__).resolve().parents[3]
        self.plugins_root = self.project_root / "plugins"
        self.kb_plugins_root = self.project_root / "knowledge_base" / "plugins"
        self.profile = profile or {}
        self.store = store
        self.registry = PluginRegistry(project_root=self.project_root)
        self._loaded: Dict[str, PluginSpec] = {}
        self._active_prompt_overlays: Dict[str, str] = {}
        self._discover_cache: Optional[List[PluginSpec]] = None
        self._manifest_warnings: List[Dict[str, str]] = []
        self._manifest_errors: List[Dict[str, str]] = []
        self._manifest_warning_keys: Set[str] = set()
        self._manifest_error_keys: Set[str] = set()

    @staticmethod
    def _version_tuple(raw: str) -> tuple:
        nums: List[int] = []
        for part in str(raw or "").replace("-", ".").split("."):
            nums.append(int(part) if part.isdigit() else 0)
        return tuple(nums)

    def _validate_spec_or_raise(self, spec: PluginSpec, strict: bool = True) -> None:
        report = spec.validate(strict=strict)
        for msg in report.get("warnings", []):
            logger.warning("插件 manifest 警告 [%s]: %s", spec.name or "unknown", msg)
        errors = report.get("errors", [])
        if errors:
            raise ValueError(f"插件 manifest 校验失败: {'; '.join(errors)}")

    def discover(self, force_refresh: bool = False) -> List[PluginSpec]:
        if not force_refresh and self._discover_cache is not None:
            return list(self._discover_cache)
        self._manifest_warnings = []
        self._manifest_errors = []
        self._manifest_warning_keys.clear()
        self._manifest_error_keys.clear()
        discovered: Dict[str, PluginSpec] = {}
        scan_roots: List[Path] = [self.plugins_root, self.kb_plugins_root]
        for root in scan_roots:
            if not root.exists():
                continue
            manifests = list(root.glob("*/.claude-plugin/plugin.json"))
            manifests.extend(root.glob("*/plugin.json"))
            for manifest in manifests:
                spec = self._load_spec_file(manifest)
                if spec and spec.name:
                    discovered[spec.name] = spec

        # 兼容老格式：mcp-* 目录没有 manifest 时自动发现
        if self.plugins_root.exists():
            for plugin_dir in self.plugins_root.glob("mcp-*"):
                if not plugin_dir.is_dir():
                    continue
                name = plugin_dir.name
                if any(s.name == name for s in discovered.values()):
                    continue
                discovered[name] = PluginSpec(
                    name=name,
                    version="0.1.0",
                    description=f"Legacy MCP plugin: {name}",
                    requires_tier="pro",
                    license="commercial",
                    source_path=str(plugin_dir),
                    discovered_only=True,
                )

        # 远端 registry 缓存（本地同名插件优先覆盖）
        for spec in self.registry.load_cached_specs():
            if spec and spec.name and spec.name not in discovered:
                discovered[spec.name] = spec

        self._discover_cache = sorted(discovered.values(), key=lambda s: s.name)
        return list(self._discover_cache)

    def load(self, plugin_name: str) -> None:
        plugin_name = str(plugin_name or "").strip()
        if not plugin_name:
            raise ValueError("plugin_name 不能为空")
        all_specs = {spec.name: spec for spec in self.discover()}
        spec = all_specs.get(plugin_name)
        if spec is None:
            raise ValueError(f"未找到插件: {plugin_name}")
        self._validate_spec_or_raise(spec, strict=True)
        # P1-1 版本门禁：插件声明的 compatibility.min_version 高于当前应用版本时拒绝加载
        min_ver = str(getattr(spec, "compatibility_min_version", "") or "").strip()
        if min_ver:
            import os
            app_ver = os.environ.get("APP_VERSION", "").strip() or "0.0.0"
            if self._version_tuple(app_ver) < self._version_tuple(min_ver):
                raise ValueError(
                    f"插件 {plugin_name} 要求应用版本 >= {min_ver}，当前为 {app_ver}；请升级应用或禁用该插件"
                )
        if not self.check_tier(spec, current_tier(self.profile)):
            raise PermissionError(f"当前 tier 不允许激活插件: {plugin_name}")

        if not is_plugin_install_allowed(self.profile, len(self._loaded)):
            raise PermissionError("当前授权版本已达到插件安装上限")

        existing = self._loaded.get(plugin_name)
        if existing is not None:
            if self._version_tuple(spec.version) <= self._version_tuple(existing.version):
                return
            logger.info("插件升级: %s %s -> %s", plugin_name, existing.version, spec.version)

        self._loaded[plugin_name] = spec
        self._cache_prompt_overlay(spec)
        self._record_plugin_install_usage(plugin_name)

    def unload(self, plugin_name: str) -> None:
        plugin_name = str(plugin_name or "").strip()
        if not plugin_name:
            return
        self._loaded.pop(plugin_name, None)
        self._active_prompt_overlays.pop(plugin_name, None)

    def list_loaded(self) -> List[PluginSpec]:
        return sorted(self._loaded.values(), key=lambda s: s.name)

    def check_tier(self, spec: PluginSpec, current_tier_value: str) -> bool:
        required = str(spec.requires_tier or "free").strip().lower()
        if required in {"", "*"}:
            return True
        return tier_rank(current_tier_value) >= tier_rank(required)

    def get_active_skill_paths(self) -> List[str]:
        result: List[str] = []
        seen: Set[str] = set()
        for spec in self._loaded.values():
            path = spec.resolved_skills_path()
            if not path or path in seen:
                continue
            seen.add(path)
            try:
                rel = Path(path).resolve().relative_to(self.project_root.resolve())
                result.append(str(rel))
            except Exception:
                result.append(path)
        return result

    def get_active_agents(self) -> List[str]:
        result: List[str] = []
        seen: Set[str] = set()
        for spec in self._loaded.values():
            for path in spec.resolved_agents():
                if path in seen:
                    continue
                seen.add(path)
                result.append(path)
        return result

    def get_active_commands(self) -> List[str]:
        result: List[str] = []
        seen: Set[str] = set()
        for spec in self._loaded.values():
            for path in spec.resolved_commands():
                if path in seen:
                    continue
                seen.add(path)
                result.append(path)
        return result

    def get_active_prompt_overlays(self) -> Dict[str, str]:
        return dict(self._active_prompt_overlays)

    def get_active_hooks(self) -> List[str]:
        result: List[str] = []
        seen: Set[str] = set()
        for spec in self._loaded.values():
            path = spec.resolved_hooks_path()
            if not path or path in seen:
                continue
            seen.add(path)
            result.append(path)
        return result

    def get_active_mcp_configs(self) -> List[str]:
        result: List[str] = []
        seen: Set[str] = set()
        for spec in self._loaded.values():
            path = spec.resolved_mcp_path()
            if not path or path in seen:
                continue
            seen.add(path)
            result.append(path)
        return result

    def get_manifest_warnings(self) -> List[Dict[str, str]]:
        return list(self._manifest_warnings)

    def get_manifest_errors(self) -> List[Dict[str, str]]:
        return list(self._manifest_errors)

    def _load_spec_file(self, manifest: Path) -> Optional[PluginSpec]:
        try:
            data = json.loads(manifest.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                spec = PluginSpec.from_dict(data, source_path=str(manifest))
                report = spec.validate(strict=False)
                for warn in report.get("warnings", []):
                    key = f"{manifest}::{warn}"
                    if key not in self._manifest_warning_keys:
                        self._manifest_warning_keys.add(key)
                        self._manifest_warnings.append(
                            {
                                "manifest": str(manifest),
                                "plugin": str(spec.name or ""),
                                "message": str(warn),
                            }
                        )
                if report.get("errors"):
                    for err in report["errors"]:
                        key = f"{manifest}::{err}"
                        if key in self._manifest_error_keys:
                            continue
                        self._manifest_error_keys.add(key)
                        self._manifest_errors.append(
                            {
                                "manifest": str(manifest),
                                "plugin": str(spec.name or ""),
                                "message": str(err),
                            }
                        )
                    logger.warning("插件 manifest 非法 %s: %s", manifest, "; ".join(report["errors"]))
                    return None
                return spec
        except Exception as e:
            logger.warning("读取插件描述失败 %s: %s", manifest, e)
        return None

    def _record_plugin_install_usage(self, plugin_name: str) -> None:
        if self.store is None:
            return
        try:
            key = f"plugins:{plugin_name}"
            out = self.store.get(NS_BILLING_USAGE, key)
            val = getattr(out, "value", out) if out else {}
            payload = dict(val) if isinstance(val, dict) else {}
            payload["plugin_name"] = plugin_name
            payload["install_count"] = int(payload.get("install_count", 0) or 0) + 1
            self.store.put(NS_BILLING_USAGE, key, payload)
        except Exception as e:
            logger.debug("记录插件计费使用失败: %s", e)

    def _cache_prompt_overlay(self, spec: PluginSpec) -> None:
        path = spec.resolved_prompt_overlay_path()
        if not path:
            return
        try:
            p = Path(path)
            if not p.exists():
                return
            text = p.read_text(encoding="utf-8").strip()
            if text:
                self._active_prompt_overlays[spec.name] = text
        except Exception as e:
            logger.debug("读取插件 prompt_overlay 失败 %s: %s", spec.name, e)
