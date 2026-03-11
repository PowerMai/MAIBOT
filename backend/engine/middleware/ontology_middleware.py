"""Ontology context middleware (Progressive Revelation, Palantir-inspired).

Detects the active domain from recent messages and injects a compact
ontology schema snippet into the system prompt. The schema provides
structural guidance (entity types, relationships, constraints) without
being treated as a factual source.
"""

from __future__ import annotations

import logging
import time
from pathlib import Path
from typing import Awaitable, Callable

from langchain.agents.middleware.types import AgentMiddleware, ModelRequest, ModelResponse
from langchain_core.messages import SystemMessage
from langchain_core.tools import BaseTool

logger = logging.getLogger(__name__)

# 同轮内短缓存，减少重复 IO/解析（TTL 秒）
_ONTOLOGY_SCHEMA_CACHE_TTL = 30.0

_DOMAIN_KEYWORDS: dict[str, list[str]] = {
    "bidding": ["招标", "投标", "bidding", "tender", "评标", "中标", "标书"],
    "contracts": ["合同", "contract", "协议", "agreement", "签约", "条款", "clause"],
    "reports": ["报告", "report", "分析报告", "summary", "executive summary"],
    "analyst": ["分析", "统计", "回归", "hypothesis", "dataset", "metric", "相关性", "可视化"],
    "legal": ["法律", "法规", "法条", "legal", "compliance", "regulation"],
    "finance": ["财务", "finance", "预算", "budget", "成本", "cost", "利润", "revenue"],
    "marketing": ["营销", "marketing", "推广", "campaign", "转化率", "conversion"],
    "education": ["教育", "education", "课程", "curriculum", "学习", "培训", "training"],
}


class OntologyContextMiddleware(AgentMiddleware):
    """Inject minimal ontology schema snippets based on runtime intent."""

    MAX_SCHEMA_CHARS = 2200

    def __init__(self, ontology_root: Path | None = None):
        from backend.tools.base.paths import ONTOLOGY_PATH

        self.ontology_root = ontology_root or ONTOLOGY_PATH
        self.tools: list[BaseTool] = self._load_tools()
        # domain -> (snippet, timestamp)，短 TTL 减少同轮内重复 get_schema_snippet 调用
        self._schema_cache: dict[str, tuple[str, float]] = {}

    def _load_tools(self) -> list[BaseTool]:
        """Register ontology tool (unified query+extract, 少工具原则)."""
        try:
            from backend.tools.ontology.ontology_tools import ontology

            return [ontology]
        except Exception as exc:
            logger.warning("[Ontology] tools unavailable: %s", exc)
            return []

    def _get_schema_snippet(self, domain: str) -> str:
        """Schema 单源：从 learned/ontology 的 canonical schema 加载并返回紧凑片段；同轮内短 TTL 缓存。"""
        now = time.monotonic()
        cached = self._schema_cache.get(domain)
        if cached is not None:
            snippet, ts = cached
            if now - ts <= _ONTOLOGY_SCHEMA_CACHE_TTL:
                return snippet
        from backend.tools.base.knowledge_graph import get_schema_snippet_for_injection

        use_domain = None if domain == "core" else domain
        snippet = get_schema_snippet_for_injection(use_domain, max_chars=self.MAX_SCHEMA_CHARS)
        self._schema_cache[domain] = (snippet, now)
        return snippet

    def _detect_domain(self, request: ModelRequest) -> str:
        text = "\n".join(str(m.content) for m in request.messages[-4:] if getattr(m, "content", None))
        lower = text.lower()
        scores: dict[str, int] = {}
        for domain, keywords in _DOMAIN_KEYWORDS.items():
            score = sum(1 for kw in keywords if kw in lower)
            if score > 0:
                scores[domain] = score
        if scores:
            return max(scores, key=scores.get)
        return "core"

    def wrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], ModelResponse],
    ):
        domain = self._detect_domain(request)
        compact = self._get_schema_snippet(domain)
        if not compact:
            return handler(request)
        current = request.system_prompt or ""
        block = (
            "\n\n<ontology_context>\n"
            f"domain={domain}\n"
            "Use this schema as structure-only guidance (not as factual source).\n"
            f"{compact}\n"
            "</ontology_context>"
        )
        if logger.isEnabledFor(logging.DEBUG):
            logger.debug("[Ontology] Injected domain=%s (%d chars)", domain, len(compact))
        return handler(request.override(system_message=SystemMessage(content=current + block)))

    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelResponse]],
    ) -> ModelResponse:
        domain = self._detect_domain(request)
        compact = self._get_schema_snippet(domain)
        if not compact:
            return await handler(request)
        current = request.system_prompt or ""
        block = (
            "\n\n<ontology_context>\n"
            f"domain={domain}\n"
            "Use this schema as structure-only guidance (not as factual source).\n"
            f"{compact}\n"
            "</ontology_context>"
        )
        if logger.isEnabledFor(logging.DEBUG):
            logger.debug("[Ontology] Injected domain=%s (%d chars)", domain, len(compact))
        return await handler(request.override(system_message=SystemMessage(content=current + block)))

