#!/usr/bin/env python3
"""Build machine-readable capability registry for tools/skills/resources."""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path


def _find_project_root(start: Path) -> Path:
    cur = start.resolve()
    for candidate in [cur] + list(cur.parents):
        if (candidate / "backend").exists() and (candidate / "knowledge_base").exists():
            return candidate
    return start.resolve().parents[5]


def _write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _parse_tool_names(registry_file: Path) -> list[str]:
    if not registry_file.exists():
        return []
    text = registry_file.read_text(encoding="utf-8")
    names = re.findall(r"self\.tools\[['\"]([A-Za-z0-9_\-]+)['\"]\]\s*=", text)
    seen: set[str] = set()
    result: list[str] = []
    for name in names:
        if name not in seen:
            seen.add(name)
            result.append(name)
    return sorted(result)


def _parse_skill_header(skill_file: Path) -> dict:
    text = skill_file.read_text(encoding="utf-8")
    lines = text.splitlines()
    meta: dict[str, str] = {}
    if lines and lines[0].strip() == "---":
        i = 1
        while i < len(lines):
            line = lines[i].strip()
            i += 1
            if line == "---":
                break
            if ":" not in line:
                continue
            key, value = line.split(":", 1)
            meta[key.strip()] = value.strip().strip('"').strip("'")
    rel = str(skill_file).split("/knowledge_base/skills/")[-1]
    skill_id = rel.replace("/SKILL.md", "")
    return {
        "skill_id": skill_id,
        "name": meta.get("name", skill_file.parent.name),
        "domain": meta.get("domain", ""),
        "level": meta.get("level", ""),
        "version": meta.get("version", ""),
        "path": str(skill_file),
    }


def _default_write_policy(root: Path) -> dict:
    return {
        "version": "v1",
        "description": "Runtime write policy for LLM-driven optimization.",
        "levels": {
            "runtime_safe": "可在运行时自动改写（低风险、可回滚）",
            "gated": "需门禁通过（gate_passed=true）后改写",
            "human_review": "仅生成人类审阅草案，不自动改写",
            "readonly": "运行时只读，不允许自动改写",
        },
        "rules": [
            {
                "path": "knowledge_base/learned/auto_upgrade/rollout_policy.json",
                "level": "runtime_safe",
                "reason": "策略图可由系统自优化调整",
            },
            {
                "path": "knowledge_base/learned/auto_upgrade/release_profile.json",
                "level": "runtime_safe",
                "reason": "灰度发布状态由编排自动维护",
            },
            {
                "path": "knowledge_base/learned/auto_upgrade/rollout_state.json",
                "level": "runtime_safe",
                "reason": "运行时状态持久化",
            },
            {
                "path": "knowledge_base/skills/**/*.md",
                "level": "gated",
                "reason": "技能描述改写需质量门禁",
            },
            {
                "path": "backend/engine/prompts/*.py",
                "level": "gated",
                "reason": "提示词核心逻辑影响全局行为",
            },
            {
                "path": "backend/config/models.json",
                "level": "human_review",
                "reason": "模型路由配置需人审防止成本/质量失衡",
            },
            {
                "path": "backend/**/*.py",
                "level": "readonly",
                "reason": "核心执行代码默认只读，避免无门禁自改",
            },
        ],
        "project_root": str(root),
    }


def _ensure_write_policy(path: Path, root: Path) -> dict:
    if not path.exists():
        policy = _default_write_policy(root)
        _write_json(path, policy)
        return policy
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return data
    except Exception:
        pass
    policy = _default_write_policy(root)
    _write_json(path, policy)
    return policy


def write_markdown(path: Path, registry: dict) -> None:
    tools = registry.get("tools", [])
    skills = registry.get("skills", [])
    resources = registry.get("resources", [])
    write_policy = registry.get("write_policy", {})
    lines = [
        "# Capability Registry",
        "",
        f"- Generated At: `{registry.get('timestamp', '')}`",
        f"- Tool Count: `{len(tools)}`",
        f"- Skill Count: `{len(skills)}`",
        f"- Resource Count: `{len(resources)}`",
        "",
        "## Top Tools",
        "",
    ]
    for name in tools[:30]:
        lines.append(f"- `{name}`")
    if len(tools) > 30:
        lines.append(f"- ... ({len(tools) - 30} more)")
    lines.extend(["", "## Key Skills", ""])
    for item in skills[:30]:
        lines.append(f"- `{item.get('skill_id', '')}` ({item.get('domain', 'unknown')})")
    if len(skills) > 30:
        lines.append(f"- ... ({len(skills) - 30} more)")
    lines.extend(["", "## Runtime Write Policy", ""])
    for rule in write_policy.get("rules", []):
        lines.append(
            f"- `{rule.get('path', '')}` -> `{rule.get('level', 'readonly')}` ({rule.get('reason', '')})"
        )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description="Build capability registry for LLM-driven orchestration")
    parser.add_argument("--output-json", default="knowledge_base/learned/auto_upgrade/capability_registry.json")
    parser.add_argument("--output-md", default="knowledge_base/learned/auto_upgrade/capability_registry.md")
    parser.add_argument(
        "--write-policy",
        default="knowledge_base/learned/auto_upgrade/runtime_write_policy.json",
        help="Runtime write policy path",
    )
    args = parser.parse_args()

    root = _find_project_root(Path(__file__).resolve().parent)
    output_json = (root / args.output_json).resolve() if not Path(args.output_json).is_absolute() else Path(args.output_json)
    output_md = (root / args.output_md).resolve() if not Path(args.output_md).is_absolute() else Path(args.output_md)
    write_policy_path = (root / args.write_policy).resolve() if not Path(args.write_policy).is_absolute() else Path(args.write_policy)

    registry_py = root / "backend" / "tools" / "base" / "registry.py"
    tools = _parse_tool_names(registry_py)

    skill_files = sorted((root / "knowledge_base" / "skills").glob("**/SKILL.md"))
    skills = [_parse_skill_header(p) for p in skill_files]

    resources = []
    for p in sorted((root / "knowledge_base" / "learned").glob("**/*.json")):
        resources.append({"type": "json", "path": str(p)})
    for p in sorted((root / "knowledge_base" / "learned").glob("**/*.jsonl")):
        resources.append({"type": "jsonl", "path": str(p)})

    write_policy = _ensure_write_policy(write_policy_path, root)
    registry = {
        "status": "ok",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "project_root": str(root),
        "tools": tools,
        "skills": skills,
        "resources": resources,
        "write_policy": write_policy,
    }
    _write_json(output_json, registry)
    write_markdown(output_md, registry)
    print(
        json.dumps(
            {
                "status": "ok",
                "output_json": str(output_json),
                "output_md": str(output_md),
                "tool_count": len(tools),
                "skill_count": len(skills),
                "resource_count": len(resources),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()

