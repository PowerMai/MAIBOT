from __future__ import annotations

import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import List

from backend.tools.base.paths import get_workspace_root


@dataclass
class Guardrail:
    trigger: str
    instruction: str
    reason: str
    provenance: str
    severity: str = "warning"
    created_at: str = ""
    hit_count: int = 0

    def to_line(self) -> str:
        created = self.created_at or datetime.now(timezone.utc).isoformat()
        return (
            f"- [{self.severity}] trigger={self.trigger} => instruction={self.instruction} "
            f"| reason={self.reason} | provenance={self.provenance} | hits={self.hit_count} | created={created}"
        )


class GuardrailsManager:
    """运行时 Guardrails 管理（轻量 markdown 持久化）。"""
    MAX_GUARDRAILS = 30

    def __init__(self) -> None:
        ws = get_workspace_root()
        self.file_path: Path = ws / ".maibot" / "GUARDRAILS.md"
        self._cache: List[Guardrail] | None = None
        self._cache_mtime: float = 0
        self._prompt_cache: dict[tuple[str, int], str] = {}
        self._prompt_cache_mtime: float = 0
        self._lock = threading.Lock()
        self._ensure_file()

    def _ensure_file(self) -> None:
        self.file_path.parent.mkdir(parents=True, exist_ok=True)
        if self.file_path.exists():
            return
        self.file_path.write_text(
            "# GUARDRAILS\n\n"
            "说明：记录高价值防错规则（Sign）。格式：\n"
            "- [severity] trigger=... => instruction=... | reason=... | provenance=... | hits=N | created=ISO8601\n\n",
            encoding="utf-8",
        )

    def _read_lines(self) -> List[str]:
        try:
            return self.file_path.read_text(encoding="utf-8").splitlines()
        except Exception:
            return []

    def _extract_value(self, text: str, start: str, end: str = "") -> str:
        idx = text.find(start)
        if idx < 0:
            return ""
        v = text[idx + len(start):]
        if end:
            cut = v.find(end)
            if cut >= 0:
                v = v[:cut]
        return v.strip()

    def _parse_line(self, line: str) -> Guardrail | None:
        text = (line or "").strip()
        if not text.startswith("- [") or "trigger=" not in text or "instruction=" not in text:
            return None
        severity = self._extract_value(text, "- [", "]")
        trigger = self._extract_value(text, "trigger=", "=>").strip()
        instruction = self._extract_value(text, "instruction=", "| reason=").strip()
        reason = self._extract_value(text, "| reason=", "| provenance=").strip()
        provenance = self._extract_value(text, "| provenance=", "| hits=").strip()
        hits_raw = self._extract_value(text, "| hits=", "| created=").strip()
        created = self._extract_value(text, "| created=").strip()
        try:
            hits = int(hits_raw or 0)
        except Exception:
            hits = 0
        if not trigger or not instruction:
            return None
        return Guardrail(
            trigger=trigger,
            instruction=instruction,
            reason=reason or "经验规则",
            provenance=provenance or "runtime",
            severity=(severity or "warning").lower(),
            created_at=created or datetime.now(timezone.utc).isoformat(),
            hit_count=max(hits, 0),
        )

    def _invalidate_cache(self) -> None:
        self._cache = None
        self._prompt_cache.clear()

    def list_guardrails(self) -> List[Guardrail]:
        try:
            mtime = self.file_path.stat().st_mtime if self.file_path.exists() else 0
        except OSError:
            mtime = 0
        if self._cache is not None and mtime == self._cache_mtime:
            return list(self._cache)
        rows: List[Guardrail] = []
        for line in self._read_lines():
            item = self._parse_line(line)
            if item:
                rows.append(item)
        self._cache = rows
        self._cache_mtime = mtime
        if self._prompt_cache_mtime != mtime:
            self._prompt_cache.clear()
            self._prompt_cache_mtime = mtime
        return list(rows)

    def _rewrite_file(self, rows: List[Guardrail]) -> None:
        header = (
            "# GUARDRAILS\n\n"
            "说明：记录高价值防错规则（Sign）。格式：\n"
            "- [severity] trigger=... => instruction=... | reason=... | provenance=... | hits=N | created=ISO8601\n\n"
        )
        body = "".join((row.to_line() + "\n") for row in rows)
        self.file_path.write_text(header + body, encoding="utf-8")
        self._invalidate_cache()

    def _parse_dt(self, value: str) -> datetime:
        try:
            return datetime.fromisoformat((value or "").replace("Z", "+00:00"))
        except Exception:
            return datetime(1970, 1, 1, tzinfo=timezone.utc)

    def _prune_if_needed(self, rows: List[Guardrail]) -> List[Guardrail]:
        if len(rows) <= self.MAX_GUARDRAILS:
            return rows
        ranked = sorted(
            rows,
            key=lambda x: (int(x.hit_count or 0), self._parse_dt(x.created_at)),
            reverse=True,
        )
        return ranked[: self.MAX_GUARDRAILS]

    def append_guardrail(self, guardrail: Guardrail) -> None:
        line = guardrail.to_line()
        with self.file_path.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
        self._invalidate_cache()

    def add_guardrail_from_failure(
        self,
        *,
        error_message: str,
        task_context: str,
        strategy_hint: str,
    ) -> Guardrail:
        low = (error_message or "").lower()
        if "not found" in low or "不存在" in low:
            instruction = "先校验路径并使用 glob/rg 重定位，再执行后续步骤。"
            trigger = "文件路径或资源不存在"
        elif "timeout" in low or "timed out" in low:
            instruction = "先拆分任务粒度，缩小输入范围，再进行重试。"
            trigger = "超时或长耗时操作失败"
        elif "permission" in low or "denied" in low:
            instruction = "先检查权限边界，必要时换到只读路径或请求授权。"
            trigger = "权限不足"
        else:
            instruction = "不要重复同一调用，先改参数或换工具再重试。"
            trigger = "重复失败模式"
        guardrail = Guardrail(
            trigger=trigger,
            instruction=instruction,
            reason=f"任务失败: {(error_message or '').strip()[:120]}",
            provenance=f"task={task_context[:80]} strategy={strategy_hint}",
            severity="warning",
            created_at=datetime.now(timezone.utc).isoformat(),
            hit_count=1,
        )
        with self._lock:
            rows = self.list_guardrails()
            merged = False
            for item in rows:
                if item.trigger == guardrail.trigger:
                    item.hit_count = max(0, int(item.hit_count or 0)) + 1
                    item.reason = guardrail.reason
                    item.provenance = guardrail.provenance
                    merged = True
                    guardrail = item
                    break
            if not merged:
                rows.append(guardrail)
            rows = self._prune_if_needed(rows)
            self._rewrite_file(rows)
        return guardrail

    def get_relevant_guardrails(self, query: str, limit: int = 4) -> List[Guardrail]:
        tokens = [t.strip().lower() for t in (query or "").split() if t.strip()]
        rows = self.list_guardrails()
        if not rows:
            return []
        if not tokens:
            return rows[-limit:]

        def _score(item: Guardrail) -> int:
            corpus = f"{item.trigger} {item.instruction} {item.reason}".lower()
            score = sum(1 for t in tokens if t in corpus)
            score += min(item.hit_count, 5)
            return score

        scored = [(_score(item), item) for item in rows]
        scored.sort(key=lambda x: x[0], reverse=True)
        selected = [item for score, item in scored if score > 0]
        ranked = selected if selected else [item for _, item in scored]
        return ranked[: max(1, int(limit))]

    def render_prompt_block(self, query: str, limit: int = 4) -> str:
        tokens = [t.strip().lower() for t in (query or "").split() if t.strip()]
        cache_key = (" ".join(tokens), max(1, int(limit)))
        if cache_key in self._prompt_cache:
            return self._prompt_cache[cache_key]

        rows = self.get_relevant_guardrails(query, limit=limit)
        if not rows:
            self._prompt_cache[cache_key] = ""
            return ""
        lines = []
        for idx, item in enumerate(rows, 1):
            lines.append(f"{idx}. 触发: {item.trigger}")
            lines.append(f"   指令: {item.instruction}")
            if item.reason:
                lines.append(f"   原因: {item.reason}")
        rendered = "\n".join(lines)
        self._prompt_cache[cache_key] = rendered
        return rendered

