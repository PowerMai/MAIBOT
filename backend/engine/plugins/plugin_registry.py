from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

import httpx

from .spec import PluginSpec

logger = logging.getLogger(__name__)


class PluginRegistry:
    """插件源注册器：同步远端 manifest 到本地缓存。"""

    def __init__(self, project_root: Optional[Path] = None) -> None:
        self.project_root = project_root or Path(__file__).resolve().parents[3]
        self.sources_path = self.project_root / "backend" / "config" / "plugin_sources.json"
        self.cache_dir = self.project_root / "data" / "plugin_cache"
        self.cache_manifest_path = self.cache_dir / "registry_plugins.json"
        self.cache_health_path = self.cache_dir / "registry_sources_health.json"
        self._last_source_health: Dict[str, Dict[str, Any]] = {}

    def load_sources(self) -> List[Dict[str, Any]]:
        default = [
            {"name": "claude-official", "url": "https://plugins.anthropic.com/manifest.json", "enabled": True},
            {"name": "local", "url": "file://plugins/", "enabled": True},
        ]
        if not self.sources_path.exists():
            return default
        try:
            data = json.loads(self.sources_path.read_text(encoding="utf-8"))
            if isinstance(data, dict) and isinstance(data.get("sources"), list):
                out: List[Dict[str, Any]] = []
                for row in data["sources"]:
                    if not isinstance(row, dict):
                        continue
                    name = str(row.get("name") or "").strip()
                    url = str(row.get("url") or "").strip()
                    if not name or not url:
                        continue
                    out.append({"name": name, "url": url, "enabled": bool(row.get("enabled", True))})
                if out:
                    return out
        except Exception as e:
            logger.warning("读取 plugin_sources 失败，回退默认源: %s", e)
        return default

    def fetch_manifest(self, source_url: str) -> List[Dict[str, Any]]:
        url = str(source_url or "").strip()
        if not url:
            return []
        parsed = urlparse(url)
        if parsed.scheme == "file":
            rows = self._fetch_file_manifest(parsed.path)
            self._last_source_health[url] = {
                "ok": True,
                "count": len(rows),
                "error": "",
                "retried": 0,
                "source_type": "file",
            }
            return rows
        rows = self._fetch_http_manifest(url)
        if url not in self._last_source_health:
            self._last_source_health[url] = {
                "ok": bool(rows),
                "count": len(rows),
                "error": "" if rows else "unknown",
                "retried": 0,
                "source_type": "http",
            }
        return rows

    def _fetch_file_manifest(self, raw_path: str) -> List[Dict[str, Any]]:
        rel = str(raw_path or "").lstrip("/")
        base = (self.project_root / rel).resolve() if rel else self.project_root
        manifests = list(base.glob("*/.claude-plugin/plugin.json"))
        manifests.extend(base.glob("*/plugin.json"))
        out: List[Dict[str, Any]] = []
        for manifest in manifests:
            try:
                data = json.loads(manifest.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    out.append(data)
            except Exception:
                continue
        return out

    def _fetch_http_manifest(self, url: str) -> List[Dict[str, Any]]:
        max_attempts = 3
        backoff_seconds = 0.6
        last_error = ""
        for attempt in range(1, max_attempts + 1):
            try:
                with httpx.Client(timeout=12.0, follow_redirects=True) as client:
                    resp = client.get(url)
                    resp.raise_for_status()
                    payload = resp.json()
                if isinstance(payload, list):
                    rows = [x for x in payload if isinstance(x, dict)]
                elif isinstance(payload, dict):
                    if isinstance(payload.get("plugins"), list):
                        rows = [x for x in payload["plugins"] if isinstance(x, dict)]
                    elif isinstance(payload.get("items"), list):
                        rows = [x for x in payload["items"] if isinstance(x, dict)]
                    else:
                        rows = []
                else:
                    rows = []
                self._last_source_health[url] = {
                    "ok": True,
                    "count": len(rows),
                    "error": "",
                    "retried": attempt - 1,
                    "source_type": "http",
                }
                return rows
            except Exception as e:
                last_error = str(e)
                if attempt >= max_attempts:
                    break
                time.sleep(backoff_seconds * attempt)
        logger.warning("拉取插件 manifest 失败 %s: %s", url, last_error)
        self._last_source_health[url] = {
            "ok": False,
            "count": 0,
            "error": last_error,
            "retried": max_attempts - 1,
            "source_type": "http",
        }
        return []

    def sync(self) -> Dict[str, Any]:
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self._last_source_health = {}
        merged: Dict[str, Dict[str, Any]] = {}
        source_stats: List[Dict[str, Any]] = []
        sources = self.load_sources()
        for src in sources:
            if not bool(src.get("enabled", True)):
                continue
            source_url = str(src.get("url") or "")
            rows = self.fetch_manifest(source_url)
            health = self._last_source_health.get(source_url, {})
            source_stats.append(
                {
                    "name": str(src.get("name") or ""),
                    "url": source_url,
                    "ok": bool(health.get("ok", True)),
                    "count": int(health.get("count", len(rows)) or 0),
                    "error": str(health.get("error") or ""),
                    "retried": int(health.get("retried", 0) or 0),
                    "source_type": str(health.get("source_type") or ("file" if source_url.startswith("file://") else "http")),
                }
            )
            for row in rows:
                name = str(row.get("name") or "").strip()
                if not name:
                    continue
                data = dict(row)
                try:
                    spec = PluginSpec.from_dict(data, source_path=self._resolve_cached_source_path(data))
                    report = spec.validate(strict=False)
                    if report.get("errors"):
                        logger.warning("registry 插件被跳过（manifest 非法）%s: %s", name, "; ".join(report["errors"]))
                        continue
                except Exception as e:
                    logger.warning("registry 插件解析失败 %s: %s", name, e)
                    continue
                data["source"] = str(src.get("name") or "")
                data["source_url"] = str(src.get("url") or "")
                merged[name] = data
        snapshot = {
            "synced_at": __import__("datetime").datetime.utcnow().isoformat() + "Z",
            "count": len(merged),
            "sources": source_stats,
            "plugins": sorted(merged.values(), key=lambda x: str(x.get("name") or "")),
        }
        self.cache_manifest_path.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2), encoding="utf-8")
        health_snapshot = {
            "synced_at": snapshot["synced_at"],
            "sources": source_stats,
        }
        self.cache_health_path.write_text(json.dumps(health_snapshot, ensure_ascii=False, indent=2), encoding="utf-8")
        return {
            "ok": True,
            "count": len(merged),
            "cache_path": str(self.cache_manifest_path),
            "sources": source_stats,
        }

    def load_cached_specs(self) -> List[PluginSpec]:
        if not self.cache_manifest_path.exists():
            return []
        try:
            payload = json.loads(self.cache_manifest_path.read_text(encoding="utf-8"))
        except Exception:
            return []
        rows = payload.get("plugins") if isinstance(payload, dict) else None
        if not isinstance(rows, list):
            return []
        specs: List[PluginSpec] = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            spec = PluginSpec.from_dict(row, source_path=self._resolve_cached_source_path(row))
            if not spec.name:
                continue
            spec.discovered_only = True
            specs.append(spec)
        return specs

    def _resolve_cached_source_path(self, row: Dict[str, Any]) -> str:
        name = str((row or {}).get("name") or "").strip()
        if not name:
            return str(self.cache_manifest_path)
        candidates = [
            self.project_root / "plugins" / name / ".claude-plugin" / "plugin.json",
            self.project_root / "plugins" / name / "plugin.json",
            self.project_root / "knowledge_base" / "plugins" / name / ".claude-plugin" / "plugin.json",
            self.project_root / "knowledge_base" / "plugins" / name / "plugin.json",
        ]
        for path in candidates:
            try:
                if path.exists() and path.is_file():
                    return str(path)
            except Exception:
                continue
        return str(self.cache_manifest_path)
