#!/usr/bin/env python3
"""
插件 manifest 兼容性检查（Claude/Cowork 风格基础门禁）。

默认规则（fail on error, warn on gap）：
1) plugins/*/.claude-plugin/plugin.json 必须存在且为合法 JSON object
2) 必填字段：name/version/description/author.name
3) version 需为 semver（x.y.z，可带 -prerelease/+build）
4) name 建议与插件目录同名（不一致仅警告）
5) compatibility/components 在 staging 为警告，在 production 为阻断
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[2]
PLUGINS_ROOT = PROJECT_ROOT / "plugins"
SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$")


def _iter_manifest_files() -> list[Path]:
    if not PLUGINS_ROOT.exists():
        return []
    return sorted(PLUGINS_ROOT.glob("*/.claude-plugin/plugin.json"))


def _as_str(value: Any) -> str:
    return str(value or "").strip()


def _is_truthy(value: str) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def main() -> int:
    manifests = _iter_manifest_files()
    if not manifests:
        print("⚠️ 未发现插件 manifest：plugins/*/.claude-plugin/plugin.json")
        return 1

    release_profile = str(os.environ.get("RELEASE_PROFILE", "staging") or "staging").strip().lower()
    strict_components = _is_truthy(os.environ.get("PLUGIN_MANIFEST_STRICT_COMPONENTS", ""))
    if not strict_components and release_profile == "production":
        strict_components = True

    errors: list[str] = []
    warnings: list[str] = []

    for manifest_path in manifests:
        plugin_dir = manifest_path.parents[1].name
        rel = manifest_path.relative_to(PROJECT_ROOT).as_posix()
        try:
            raw = json.loads(manifest_path.read_text(encoding="utf-8"))
        except Exception as exc:
            errors.append(f"{rel}: JSON 解析失败: {exc}")
            continue

        if not isinstance(raw, dict):
            errors.append(f"{rel}: 根节点必须是 object")
            continue

        name = _as_str(raw.get("name"))
        version = _as_str(raw.get("version"))
        description = _as_str(raw.get("description"))
        author = raw.get("author")
        author_name = _as_str(author.get("name")) if isinstance(author, dict) else ""

        if not name:
            errors.append(f"{rel}: 缺少必填字段 name")
        if not version:
            errors.append(f"{rel}: 缺少必填字段 version")
        elif not SEMVER_RE.match(version):
            errors.append(f"{rel}: version 非 semver: {version}")
        if not description:
            errors.append(f"{rel}: 缺少必填字段 description")
        if not author_name:
            errors.append(f"{rel}: 缺少必填字段 author.name")

        if name and name != plugin_dir:
            warnings.append(f"{rel}: name({name}) 与目录名({plugin_dir})不一致")

        if "compatibility" not in raw:
            msg = f"{rel}: 缺少 compatibility（min_version/source 等）"
            if strict_components:
                errors.append(msg)
            else:
                warnings.append(msg)
        if "components" not in raw:
            msg = f"{rel}: 缺少 components（tools/middleware/mcp/hooks/agents）"
            if strict_components:
                errors.append(msg)
            else:
                warnings.append(msg)

    print("=== Plugin Manifest Compatibility Check ===")
    print(f"checked: {len(manifests)} manifests")
    print(f"release_profile: {release_profile}")
    print(f"strict_components: {strict_components}")
    print(f"errors: {len(errors)}")
    print(f"warnings: {len(warnings)}")

    if warnings:
        print("\n[WARN]")
        for item in warnings:
            print(f"- {item}")

    if errors:
        print("\n[FAIL]")
        for item in errors:
            print(f"- {item}")
        return 1

    print("\n✅ 兼容性基础门禁通过（无阻断错误）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
