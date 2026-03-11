#!/usr/bin/env python3
"""
迁移脚本：.context -> .maibot

用法：
  python backend/scripts/migrate_context_to_maibot.py --workspace /abs/path/to/workspace
"""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path


def ensure_file(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        path.write_text(content, encoding="utf-8")


def remove_empty_context_dir(context_dir: Path) -> None:
    """迁移后清理空的 .context 目录（若仍有文件则保留）。"""
    if not context_dir.exists() or not context_dir.is_dir():
        return
    if any(p.is_file() for p in context_dir.rglob("*")):
        return
    for d in sorted([p for p in context_dir.rglob("*") if p.is_dir()], key=lambda x: len(x.parts), reverse=True):
        try:
            d.rmdir()
        except OSError:
            pass
    try:
        context_dir.rmdir()
    except OSError:
        pass


def migrate(workspace: Path) -> None:
    context_dir = workspace / ".context"
    maibot_dir = workspace / ".maibot"
    rules_dir = maibot_dir / "rules"

    maibot_dir.mkdir(parents=True, exist_ok=True)
    rules_dir.mkdir(parents=True, exist_ok=True)

    # 主记忆文件
    context_md = context_dir / "CONTEXT.md"
    maibot_md = maibot_dir / "MAIBOT.md"
    if context_md.exists() and not maibot_md.exists():
        shutil.copy2(context_md, maibot_md)

    # 规则目录
    context_rules = context_dir / "rules"
    if context_rules.exists() and context_rules.is_dir():
        for rule_file in context_rules.glob("*.md"):
            dst = rules_dir / rule_file.name
            if not dst.exists():
                shutil.copy2(rule_file, dst)

    # 旧文件映射
    mapping = {
        context_dir / "AGENTS.md": maibot_dir / "AGENTS.md",
        context_dir / "lessons.md": workspace / ".learnings" / "LEARNINGS.md",
    }
    for src, dst in mapping.items():
        if src.exists() and not dst.exists():
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)

    # 初始化模板
    ensure_file(maibot_dir / "SOUL.md", "# SOUL\n\n- 在此维护行为准则。\n")
    ensure_file(maibot_dir / "TOOLS.md", "# TOOLS\n\n- 在此维护工具经验与踩坑记录。\n")
    ensure_file(
        maibot_dir / "settings.json",
        '{\n'
        '  "sensitive_paths": [],\n'
        '  "execution_policy": {\n'
        '    "python": {\n'
        '      "max_timeout": 120,\n'
        '      "blocked_patterns": ["os.system(", "subprocess.Popen(", "subprocess.run(", "pty.spawn("]\n'
        '    },\n'
        '    "shell": {\n'
        '      "max_timeout": 60,\n'
        '      "allow_outside_workspace": false,\n'
        '      "blocked_patterns": ["rm -rf /", "mkfs", "shutdown", "reboot", "curl | sh", "wget | sh", ":(){:|:&};:"],\n'
        '      "allow_commands": []\n'
        '    }\n'
        '  },\n'
        '  "upgrade": {\n'
        '    "remote_manifest_url": ""\n'
        '  },\n'
        '  "autonomous": {\n'
        '    "task_watcher_enabled": false,\n'
        '    "task_watcher_role_id": ""\n'
        '  }\n'
        '}\n',
    )
    ensure_file(
        maibot_dir / "persona.json",
        '{\n  "name": "MAIBOT",\n  "tone": "professional",\n  "relationship": "assistant"\n}\n',
    )
    ensure_file(
        maibot_dir / "prompt_assembly.json",
        '{\n  "detail_level": {"default": "concise", "model_overrides": {}},\n  "always_load": [],\n  "tool_conditional": {},\n  "mode_conditional": {},\n  "role_conditional": {}\n}\n',
    )
    remove_empty_context_dir(context_dir)

    print(f"迁移完成: {workspace}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", required=True, help="工作区绝对路径")
    args = parser.parse_args()
    migrate(Path(args.workspace).resolve())


if __name__ == "__main__":
    main()

