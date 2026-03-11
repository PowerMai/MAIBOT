"""
Project Rules Loader - Cursor 风格 .cursor/rules 加载与按上下文注入

与现有代码分工（不重复实现）：
- 项目记忆（.maibot/MAIBOT.md + .maibot/rules/*.md）由 deep_agent._load_memory_content 全量加载，不做本模块。
- 本模块仅负责 .cursor/rules/*.mdc|*.md，按 frontmatter 智能选取，与 project_memory 互补。

支持三种应用方式（与 Cursor 对齐）：
- Always Apply: alwaysApply=true 的规则每次请求都注入
- Apply to Specific Files: globs 匹配 editor_path / open_files 时注入
- Apply Intelligently: 根据 description 与当前 query 的关键词重叠选取规则

与 Guardrails 分工：本模块做「事前约束」（风格、架构、文件边界）；Guardrails 做失败驱动的防错规则。
"""

from __future__ import annotations

import re
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional, Any

logger = logging.getLogger(__name__)

# 默认从工作区根下的 .cursor/rules 读取
RULES_DIR_NAME = ".cursor/rules"
MAX_RULES_DEFAULT = 6
MAX_TOTAL_CHARS_DEFAULT = 6000  # 收紧以降低提示词体积，保证可用前提下减少 token


@dataclass
class ProjectRule:
    """单条项目规则（.mdc/.md 解析结果）"""
    path: str
    content: str
    description: str = ""
    always_apply: bool = False
    globs: List[str] = field(default_factory=list)

    def matches_globs(self, workspace_root: Path, candidate_paths: List[str]) -> bool:
        if not self.globs or not candidate_paths:
            return False
        try:
            for raw in candidate_paths:
                if not raw or not isinstance(raw, str):
                    continue
                p = Path(raw)
                if not p.is_absolute():
                    p = (workspace_root / raw).resolve()
                try:
                    rel = p.relative_to(workspace_root)
                except ValueError:
                    continue
                rel_str = str(rel).replace("\\", "/")
                for pattern in self.globs:
                    if not pattern:
                        continue
                    # pathlib.Path.match 支持 **，但要求 pattern 为单段或多段路径
                    norm = pattern.replace("\\", "/")
                    if _fnmatch_path(rel_str, norm):
                        return True
        except Exception as e:
            logger.debug("project_rules glob match error: %s", e)
        return False

    def description_score(self, query: str) -> int:
        """简单关键词重叠打分，用于 Apply Intelligently。"""
        if not query or not self.description:
            return 0
        q_tokens = set(_tokenize(query.lower()))
        d_tokens = set(_tokenize(self.description.lower()))
        return len(q_tokens & d_tokens)


def _tokenize(text: str) -> List[str]:
    return [t for t in re.split(r"[\s,;，；]+", (text or "")) if len(t) > 1]


def _fnmatch_path(path: str, pattern: str) -> bool:
    """简单 glob：* 与 ** 支持。path 与 pattern 均为 / 分隔。"""
    import fnmatch
    path = path.replace("\\", "/")
    pattern = pattern.replace("\\", "/")
    parts = [p for p in path.split("/") if p]
    segs = [s for s in pattern.split("/") if s]

    def match_seg(pi: int, pj: int) -> bool:
        if pj >= len(segs):
            return pi >= len(parts)
        if pi >= len(parts):
            return all(segs[k] == "**" for k in range(pj, len(segs)))
        if segs[pj] == "**":
            # ** 可匹配 0 或更多段
            for skip in range(0, len(parts) - pi + 1):
                if match_seg(pi + skip, pj + 1):
                    return True
            return False
        if fnmatch.fnmatch(parts[pi], segs[pj]):
            return match_seg(pi + 1, pj + 1)
        return False

    return match_seg(0, 0)


def _parse_frontmatter(content: str) -> tuple[dict, str]:
    """返回 (frontmatter_dict, body)。无 frontmatter 时返回 ({}, content)。"""
    if not content or not content.strip().startswith("---"):
        return {}, content
    parts = content.split("---", 2)
    if len(parts) < 3:
        return {}, content
    try:
        import yaml
        meta = yaml.safe_load(parts[1].strip()) or {}
        return meta if isinstance(meta, dict) else {}, parts[2].strip()
    except Exception:
        return {}, content


def _load_rules_from_dir(rules_dir: Path) -> List[ProjectRule]:
    rules: List[ProjectRule] = []
    if not rules_dir.is_dir():
        return rules
    for ext in ("*.mdc", "*.md"):
        for f in rules_dir.glob(ext):
            try:
                raw = f.read_text(encoding="utf-8", errors="replace")
                meta, body = _parse_frontmatter(raw)
                desc = (meta.get("description") or "")
                if isinstance(desc, dict):
                    desc = str(desc.get("description", ""))
                desc = str(desc).strip()
                always = bool(meta.get("alwaysApply", False))
                globs_raw = meta.get("globs")
                if globs_raw is None:
                    globs = []
                elif isinstance(globs_raw, str):
                    globs = [s.strip() for s in globs_raw.split() if s.strip()]
                else:
                    globs = [str(s).strip() for s in (globs_raw or []) if str(s).strip()]
                rules.append(
                    ProjectRule(
                        path=str(f.relative_to(rules_dir.parent)),
                        content=body.strip(),
                        description=desc,
                        always_apply=always,
                        globs=globs,
                    )
                )
            except Exception as e:
                logger.debug("skip rule file %s: %s", f, e)
    return rules


def get_rules_for_context(
    workspace_path: Optional[str] = None,
    editor_path: Optional[str] = None,
    open_files: Optional[List[Any]] = None,
    query: Optional[str] = None,
    *,
    max_rules: int = MAX_RULES_DEFAULT,
    max_total_chars: int = MAX_TOTAL_CHARS_DEFAULT,
) -> str:
    """
    根据当前请求上下文选取并拼接项目规则块。

    - alwaysApply=true 的规则始终注入
    - globs 匹配 editor_path 或 open_files 中路径的规则注入
    - 剩余名额用「Apply Intelligently」：按 query 与 description 的关键词重叠排序选取

    workspace_path：未传或无效时使用 get_workspace_root() 作为规则根目录（全局工作区根）。
    调用方应尽量传入当前请求的 workspace_path，以保证规则与工作区一致。

    返回可注入系统提示的字符串，无规则时返回空字符串。
    """
    try:
        root = Path(workspace_path).resolve() if workspace_path and Path(workspace_path).is_dir() else None
    except Exception:
        root = None
    if root is None:
        try:
            from backend.tools.base.paths import get_workspace_root
            root = get_workspace_root()
        except Exception:
            return ""

    rules_dir = root / ".cursor" / "rules"
    all_rules = _load_rules_from_dir(rules_dir)
    if not all_rules:
        return ""

    # 收集候选路径（用于 glob 匹配）
    candidate_paths: List[str] = []
    if editor_path and str(editor_path).strip():
        candidate_paths.append(str(editor_path).strip())
    if open_files:
        for item in open_files:
            if isinstance(item, dict):
                p = item.get("path") or item.get("file") or ""
            else:
                p = str(item)
            if p and p not in candidate_paths:
                candidate_paths.append(p)

    # 1) 必选：alwaysApply
    selected: List[ProjectRule] = [r for r in all_rules if r.always_apply]
    # 2) glob 匹配
    for r in all_rules:
        if r in selected:
            continue
        if r.matches_globs(root, candidate_paths):
            selected.append(r)
    # 3) 智能补足：按 description 与 query 重叠排序
    remaining = [r for r in all_rules if r not in selected]
    if remaining and query:
        remaining.sort(key=lambda x: -x.description_score(query))
    for r in remaining:
        if len(selected) >= max_rules:
            break
        if r.description_score(query) > 0:
            selected.append(r)
    # 仍不足时按顺序补足（不超 max_rules）
    for r in all_rules:
        if len(selected) >= max_rules:
            break
        if r not in selected:
            selected.append(r)

    if not selected:
        return ""

    parts: List[str] = []
    total = 0
    for r in selected[:max_rules]:
        if total + len(r.content) + 2 > max_total_chars:
            parts.append(f"<!-- {r.path} 已截断 -->\n" + (r.content[: max_total_chars - total - 80] or ""))
            break
        parts.append(f"<!-- {r.path} -->\n{r.content}")
        total += len(r.content) + 2

    if not parts:
        return ""
    return "<project_rules>\n以下项目规则（.cursor/rules）与当前上下文相关，请优先遵循：\n\n" + "\n\n".join(parts) + "\n</project_rules>"
