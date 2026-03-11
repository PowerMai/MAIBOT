from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List

from backend.engine.modes.mode_config import (
    ChatMode,
    MODE_COMPLETION_MARKERS,
    MODE_COMPLETION_FAIL_SUGGESTION,
)


@dataclass
class DoneSignal:
    passed: bool
    reason: str = ""
    suggestion: str = ""


_TERM_RE = re.compile(r"[A-Za-z0-9_]{3,}|[\u4e00-\u9fff]{2,}")
_ACCEPTANCE_SPLIT_RE = re.compile(r"[\n;；]")


class DoneVerifier:
    """轻量完成验证器：按 mode 做最小必要校验。"""

    _STOPWORDS = {
        "请",
        "帮我",
        "一下",
        "这个",
        "那个",
        "需要",
        "处理",
        "执行",
        "进行",
        "关于",
        "with",
        "that",
        "this",
        "please",
        "help",
        "task",
        "agent",
    }

    def _extract_terms(self, text: str, limit: int = 8) -> List[str]:
        raw = str(text or "")
        terms = _TERM_RE.findall(raw)
        cleaned: List[str] = []
        for t in terms:
            s = t.strip().lower()
            if not s or s in self._STOPWORDS:
                continue
            if s not in cleaned:
                cleaned.append(s)
            if len(cleaned) >= limit:
                break
        return cleaned

    def _contains_terms(self, content: str, terms: Iterable[str], min_hits: int = 1) -> bool:
        low = str(content or "").lower()
        hits = 0
        for t in terms:
            if t and t.lower() in low:
                hits += 1
            if hits >= min_hits:
                return True
        return False

    def _extract_acceptance(self, configurable: Dict[str, Any]) -> List[str]:
        out: List[str] = []
        value = configurable.get("acceptance_criteria")
        if isinstance(value, str) and value.strip():
            out.extend([x.strip() for x in _ACCEPTANCE_SPLIT_RE.split(value) if x.strip()])
        elif isinstance(value, list):
            for x in value:
                s = str(x or "").strip()
                if s:
                    out.append(s)
        return out[:8]

    def check(
        self,
        mode: str,
        query: str,
        result_content: str,
        configurable: Dict[str, Any] | None = None,
    ) -> DoneSignal:
        cfg = configurable or {}
        mode_norm = str(mode or "agent").strip().lower()
        result = str(result_content or "").strip()
        q = str(query or "").strip()

        if not result:
            return DoneSignal(False, "输出为空", "先给出当前阶段结果，再声明完成。")

        if mode_norm == "ask":
            return DoneSignal(True, "ask 模式跳过完成验证", "")

        try:
            cm = ChatMode(mode_norm)
        except ValueError:
            cm = None
        if cm is not None and cm in MODE_COMPLETION_MARKERS:
            markers = MODE_COMPLETION_MARKERS[cm]
            suggestion = MODE_COMPLETION_FAIL_SUGGESTION.get(cm, "补充必要内容。")
            if any(m in result.lower() for m in markers):
                return DoneSignal(True, f"{mode_norm} 结构通过", "")
            return DoneSignal(False, f"{mode_norm} 结构不完整", suggestion)

        # 默认按 agent 模式验证
        acc = self._extract_acceptance(cfg)
        for item in acc:
            terms = self._extract_terms(item, limit=4)
            if terms and not self._contains_terms(result, terms, min_hits=1):
                return DoneSignal(False, f"未满足验收标准: {item[:60]}", "逐条对齐 acceptance_criteria 并补充对应结果。")

        terms = self._extract_terms(q, limit=6)
        if terms and not self._contains_terms(result, terms, min_hits=max(1, len(terms) // 3)):
            return DoneSignal(False, "输出与任务意图对齐不足", "补充对 query 关键点的直接响应与产出。")

        return DoneSignal(True, "完成验证通过", "")

