from __future__ import annotations

import fnmatch
import json
import re
from pathlib import Path
from typing import Any

from langchain.agents.middleware.types import AgentMiddleware, AgentState
from langchain_core.messages import HumanMessage
from langgraph.runtime import Runtime

from backend.tools.base.paths import get_workspace_root


_SECRET_REDACTION_RULES = [
    (re.compile(
        r'((?:"|\'|`)?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|authorization|private[_-]?key)(?:"|\'|`)?\s*[:=]\s*)(?:"[^"\n]{0,512}"|\'[^\'\n]{0,512}\'|`[^`\n]{0,512}`|[^\s,;]{1,512})',
        re.IGNORECASE,
    ), r'\1"[REDACTED]"'),
    (re.compile(r"(\bbearer\s+)[A-Za-z0-9\-\._~\+/=]{8,256}", re.IGNORECASE), r"\1[REDACTED]"),
    (re.compile(r"\bsk-[A-Za-z0-9\-_]{12,256}\b", re.IGNORECASE), "[REDACTED_API_KEY]"),
    (re.compile(r"\bxox[baprs]-[A-Za-z0-9\-]{10,256}\b", re.IGNORECASE), "[REDACTED_API_KEY]"),
]
_PATH_LIKE_REGEXES = [
    re.compile(r"/Users/[^\s\"']+"),
    re.compile(r"/home/[^\s\"']+"),
    re.compile(r"[A-Za-z]:\\[^\s\"']+"),
]


class CloudCallGateMiddleware(AgentMiddleware):
    """云端调用前的敏感路径过滤（基于 .maibot/settings.json）。"""

    def __init__(self) -> None:
        ws = get_workspace_root()
        self.settings_path = ws / ".maibot" / "settings.json"
        self._patterns_cache: list[str] | None = None
        self._patterns_mtime: float = 0

    def _load_sensitive_patterns(self) -> list[str]:
        try:
            if not self.settings_path.exists():
                self._patterns_cache = []
                return []
            mtime = self.settings_path.stat().st_mtime
            if self._patterns_cache is not None and mtime == self._patterns_mtime:
                return self._patterns_cache
            data = json.loads(self.settings_path.read_text(encoding="utf-8"))
            pats = data.get("sensitive_paths", [])
            self._patterns_cache = [str(p) for p in pats if isinstance(p, str) and p.strip()]
            self._patterns_mtime = mtime
            return self._patterns_cache
        except Exception:
            return self._patterns_cache or []

    def _contains_sensitive_path(self, text: str, patterns: list[str]) -> bool:
        for p in patterns:
            if fnmatch.fnmatch(text, f"*{p}*"):
                return True
        return False

    def _sanitize_sensitive_content(self, text: str, patterns: list[str]) -> tuple[str, bool, int]:
        """
        将命中的敏感路径片段做摘要化替换，避免将原文发送到云端。
        返回: (new_text, changed, hit_count)
        """
        if not text:
            return text, False, 0
        redacted = text
        replaced = 0

        for rx, repl in _SECRET_REDACTION_RULES:
            redacted, n = rx.subn(repl, redacted)
            replaced += n

        # 优先按行替换，尽量保留非敏感上下文
        lines = redacted.splitlines()
        line_changed = False
        sanitized_lines: list[str] = []
        for line in lines:
            original_line = line
            hit_tokens: list[str] = []
            for p in patterns:
                pat = (p or "").strip()
                if not pat:
                    continue
                # 优先按 glob 规则匹配整行；失败再回退子串匹配
                try:
                    if fnmatch.fnmatch(original_line, f"*{pat}*"):
                        token = pat.replace("*", "").strip() or pat
                        hit_tokens.append(token)
                        continue
                except Exception:
                    pass
                token = pat.replace("*", "").strip()
                if token and token.lower() in original_line.lower():
                    hit_tokens.append(token)
            if hit_tokens:
                replaced += len(hit_tokens)
                token_preview = ", ".join(sorted(set(hit_tokens))[:3])
                sanitized_lines.append(
                    f"[SENSITIVE_CONTENT_SUMMARY] 命中敏感路径规则({token_preview})，原始内容已留在本地，仅保留摘要。"
                )
                line_changed = True
            else:
                sanitized_lines.append(original_line)

        if line_changed:
            redacted = "\n".join(sanitized_lines)

        # 兜底：对未按行匹配到但仍命中的 token 做替换
        for p in patterns:
            pat = (p or "").strip()
            if not pat:
                continue
            # 用简单片段替换避免整段误替换：glob 去 * 后按子串替换
            token = pat.replace("*", "").strip()
            if not token:
                continue
            hits = redacted.count(token)
            if hits > 0:
                replaced += hits
                redacted = redacted.replace(token, "[SENSITIVE_PATH]")

        for rx in _PATH_LIKE_REGEXES:
            redacted, n = rx.subn("[LOCAL_PATH]", redacted)
            replaced += n
        return redacted, replaced > 0, replaced

    def before_model(self, state: AgentState, runtime: Runtime[Any]) -> dict[str, Any] | None:  # noqa: ARG002
        messages = state.get("messages", [])
        if not messages:
            return None

        # 仅在云端模型策略下启用（由调用方透传）
        configurable = (runtime.context or {}).get("configurable", {}) if getattr(runtime, "context", None) else {}
        is_cloud = bool(configurable.get("use_cloud_model")) or str(configurable.get("model_tier", "")).startswith("cloud")
        if not is_cloud:
            return None

        patterns = self._load_sensitive_patterns()

        new_messages = list(messages)
        modified = False
        for i, msg in enumerate(new_messages):
            if not isinstance(msg, HumanMessage):
                continue
            content = str(msg.content or "")
            redacted, changed, count = self._sanitize_sensitive_content(content, patterns)
            contains_sensitive = self._contains_sensitive_path(content, patterns)
            if not changed and not contains_sensitive:
                continue

            # 全量处理所有 HumanMessage，避免历史上下文中残留敏感内容被发送到云端。
            if changed:
                safe_content = redacted
            else:
                safe_content = "[SENSITIVE_CONTENT_SUMMARY] 命中敏感路径规则，原始内容已留在本地，仅保留摘要。"
            hits = count if count > 0 else (1 if contains_sensitive else 0)
            new_messages[i] = HumanMessage(
                content=(
                    safe_content
                    + f"\n\n[CloudCallGate] 已对敏感路径做本地脱敏替换（hits={hits}），"
                    + "云端仅接收脱敏后的内容。"
                ),
                additional_kwargs=msg.additional_kwargs,
            )
            modified = True
        if modified:
            return {"messages": new_messages}
        return None

