#!/usr/bin/env python3
"""
可选：从 anthropics/skills 仓库同步指定技能的 SKILL.md 到本地 knowledge_base/skills/。

用法:
  python -m backend.scripts.sync_anthropic_skills --list
  python -m backend.scripts.sync_anthropic_skills --skill docx [--skill pdf] [--dry-run]
  python -m backend.scripts.sync_anthropic_skills --all [--dry-run]

默认分支 main；写入前若目标已存在可 --backup 备份。与 skills_market remote_url 解耦，供运维按需执行。
"""
from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

try:
    import httpx
except ImportError:
    httpx = None

# 仓库根与 skills 根
PROJECT_ROOT = Path(__file__).resolve().parents[2]
SKILLS_ROOT = PROJECT_ROOT / "knowledge_base" / "skills"
ANTHROPIC_RAW = "https://raw.githubusercontent.com/anthropics/skills/main/skills"


def list_available() -> list[str]:
    """列出 anthropics/skills 中已知可用的技能名（按仓库常见目录）。"""
    # 仅列举常见名，实际可改为 GitHub API 列目录
    return [
        "docx",
        "pdf",
        "pptx",
        "xlsx",
        "skill-creator",
        "mcp-builder",
    ]


def fetch_skill_md(skill_name: str, branch: str = "main") -> str | None:
    if not httpx:
        print("需要安装 httpx: pip install httpx", file=sys.stderr)
        return None
    url = f"https://raw.githubusercontent.com/anthropics/skills/{branch}/skills/{skill_name}/SKILL.md"
    try:
        r = httpx.get(url, timeout=15.0)
        r.raise_for_status()
        return r.text
    except Exception as e:
        print(f"获取 {skill_name} 失败: {e}", file=sys.stderr)
        return None


def sync_one(skill_name: str, dry_run: bool = False, backup: bool = False, branch: str = "main") -> bool:
    content = fetch_skill_md(skill_name, branch=branch)
    if not content:
        return False
    # 写入 knowledge_base/skills/{skill_name}/SKILL.md（与 registry 的 domain 推断一致）
    target_dir = SKILLS_ROOT / skill_name
    target_dir.mkdir(parents=True, exist_ok=True)
    target_file = target_dir / "SKILL.md"
    if target_file.exists() and backup and not dry_run:
        backup_path = target_file.with_suffix(".SKILL.md.bak")
        shutil.copy2(target_file, backup_path)
        print(f"已备份: {backup_path}")
    if dry_run:
        print(f"[dry-run] 将写入 {target_file} ({len(content)} 字节)")
        return True
    target_file.write_text(content, encoding="utf-8")
    print(f"已写入: {target_file}")
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description="从 anthropics/skills 同步 SKILL.md")
    parser.add_argument("--list", action="store_true", help="列出可同步的技能名")
    parser.add_argument("--skill", action="append", dest="skills", default=[], help="技能名，可多次指定")
    parser.add_argument("--all", action="store_true", help="同步 --list 中的全部")
    parser.add_argument("--dry-run", action="store_true", help="仅打印不写入")
    parser.add_argument("--backup", action="store_true", help="覆盖前备份现有 SKILL.md")
    parser.add_argument("--branch", default="main", help="anthropics/skills 分支")
    args = parser.parse_args()

    if args.list:
        for name in list_available():
            print(name)
        return 0

    to_sync = list(args.skills) if args.skills else (list_available() if args.all else [])
    if not to_sync:
        parser.print_help()
        return 1

    ok = 0
    for name in to_sync:
        if sync_one(name, dry_run=args.dry_run, backup=args.backup, branch=args.branch):
            ok += 1
    return 0 if ok == len(to_sync) else 1


if __name__ == "__main__":
    sys.exit(main())
