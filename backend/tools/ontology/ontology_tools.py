"""Ontology tools using LangChain official structured-output patterns."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from langchain_core.prompts import ChatPromptTemplate
from langchain_core.tools import tool
from pydantic import BaseModel, Field

from backend.engine.agent.model_manager import get_model_manager
from backend.tools.base.paths import ONTOLOGY_PATH
from backend.tools.base.knowledge_graph import get_canonical_schema_path, get_schema_for_tools

ONTOLOGY_ROOT = ONTOLOGY_PATH
ONTOLOGY_ROOT.mkdir(parents=True, exist_ok=True)
INSTANCE_FILE = ONTOLOGY_ROOT / "entities.jsonl"

_ONTOLOGY_LLM = None


def _load_schema(domain: str) -> dict[str, Any]:
    """Schema 单源：从 learned/ontology 的 canonical schema 加载，返回 tools 期望的 entities/relation_types 结构。"""
    use_domain = domain if domain and domain != "core" else None
    return get_schema_for_tools(use_domain)


def _get_ontology_llm():
    """Get shared LLM instance for ontology extraction/query."""
    global _ONTOLOGY_LLM
    if _ONTOLOGY_LLM is None:
        manager = get_model_manager()
        _ONTOLOGY_LLM = manager.create_llm(task_type="analysis")
    return _ONTOLOGY_LLM


class OntologyQueryResponse(BaseModel):
    domain: str
    schema_found: bool
    source_id: str
    excerpt: str
    entity_types: list[str] = Field(default_factory=list)
    match: dict[str, Any] = Field(default_factory=dict)


class ExtractedEntity(BaseModel):
    entity_type: str
    fields: dict[str, Any]
    confidence: float = 0.0
    excerpt: str = ""


class OntologyExtractResponse(BaseModel):
    entities: list[ExtractedEntity] = Field(default_factory=list)


@tool("ontology_query")
def ontology_query(
    domain: str,
    entity_type: str | None = None,
    field: str | None = None,
    keyword: str | None = None,
) -> str:
    """Query ontology schema/instances with LangChain structured output.

    Use when:
    - 需要确认领域 schema 是否定义了某实体类型/字段。
    - 需要基于关键词从本体实例中做溯源查询（source_id/excerpt）。

    Avoid when:
    - 问题与本体无关，仅是通用知识问答（优先 search_knowledge/web_search）。
    - domain 不明确且无上下文约束。

    Strategy:
    - 先传 domain + entity_type 粗定位，再用 field/keyword 精确过滤。
    - 返回结果中的 source_id/excerpt 直接用于证据链引用。

    Returns:
        JSON string with source_id/excerpt fields for citation grounding.
    """
    schema = _load_schema(domain)
    schema_file = str(get_canonical_schema_path(domain if domain != "core" else None).resolve())

    payload: dict[str, Any] = {
        "domain": domain,
        "schema_found": bool(schema),
        "source_id": schema_file,
        "excerpt": "",
        "entity_types": [],
        "match": {},
    }

    if not schema:
        return json.dumps(payload, ensure_ascii=False)

    entities = schema.get("entities", {}) if isinstance(schema, dict) else {}
    payload["entity_types"] = list(entities.keys())

    # LangChain official pattern: prompt + structured output
    try:
        llm = _get_ontology_llm().with_structured_output(OntologyQueryResponse)
        query_prompt = ChatPromptTemplate.from_messages(
            [
                (
                    "system",
                    "You are an ontology query assistant. Use only provided schema and keyword snippets. "
                    "Do not hallucinate fields. Return concise structured output.",
                ),
                (
                    "human",
                    "domain={domain}\nentity_type={entity_type}\nfield={field}\nkeyword={keyword}\n"
                    "schema_json={schema_json}\ninstance_hint={instance_hint}",
                ),
            ]
        )
        instance_hint = ""
        if keyword and INSTANCE_FILE.exists():
            hits = []
            for line in INSTANCE_FILE.read_text(encoding="utf-8").splitlines():
                if keyword.lower() in line.lower():
                    hits.append(line[:260])
                if len(hits) >= 3:
                    break
            instance_hint = "\n".join(hits)

        chain = query_prompt | llm
        result = chain.invoke(
            {
                "domain": domain,
                "entity_type": entity_type or "",
                "field": field or "",
                "keyword": keyword or "",
                "schema_json": json.dumps(schema, ensure_ascii=False),
                "instance_hint": instance_hint,
            }
        )
        payload = result.model_dump()
    except Exception:
        # Fallback deterministic matching for reliability
        if entity_type and entity_type in entities:
            payload["match"]["entity_type"] = entity_type
            payload["match"]["fields"] = entities[entity_type].get("fields", [])
            payload["excerpt"] = f"{entity_type}: fields={payload['match']['fields']}"
        if field and entity_type and entity_type in entities:
            fields = entities[entity_type].get("fields", [])
            if field in fields:
                payload["match"]["field"] = field
                payload["excerpt"] = f"{entity_type}.{field} is defined in ontology schema"

    # lightweight instance scan for keyword
    if keyword and INSTANCE_FILE.exists():
        matched = []
        for line in INSTANCE_FILE.read_text(encoding="utf-8").splitlines():
            if keyword.lower() in line.lower():
                try:
                    matched.append(json.loads(line))
                except Exception:
                    continue
            if len(matched) >= 5:
                break
        payload["match"]["instances"] = matched
        if matched and not payload["excerpt"]:
            payload["excerpt"] = json.dumps(matched[0], ensure_ascii=False)[:300]
            payload["source_id"] = str(INSTANCE_FILE.resolve())

    return json.dumps(payload, ensure_ascii=False)


@tool("ontology_extract")
def ontology_extract(
    domain: str,
    source_id: str,
    text: str,
    entity_type: str | None = None,
) -> str:
    """Extract ontology instances using LangChain structured extraction.

    Use when:
    - 需要把文档片段转成结构化本体实例（写入 entities.jsonl）。
    - 需要给知识图谱或后续方案生成提供可追溯实体数据。

    Avoid when:
    - 文本太短或噪声过高，无法抽取稳定实体。
    - 未准备 domain/schema，导致类型约束缺失。

    Strategy:
    - 优先分段抽取（每段 <= 4k 字符），减少混淆。
    - 对关键实体重复抽取并比对结果，提升稳定性。
    """
    schema = _load_schema(domain)
    entities = schema.get("entities", {}) if isinstance(schema, dict) else {}

    target_types = [entity_type] if entity_type else list(entities.keys())[:3]
    now = datetime.now(timezone.utc).isoformat()
    rows: list[dict[str, Any]] = []

    extraction_schema = {
        et: entities.get(et, {}).get("fields", [])
        for et in target_types
        if et in entities
    }

    try:
        llm = _get_ontology_llm().with_structured_output(OntologyExtractResponse)
        extract_prompt = ChatPromptTemplate.from_messages(
            [
                (
                    "system",
                    "You extract ontology entities from input text. "
                    "Use only entity types/fields provided by schema. "
                    "If field value missing, keep it null.",
                ),
                (
                    "human",
                    "domain={domain}\nsource_id={source_id}\n"
                    "schema={schema_json}\ntext={text}",
                ),
            ]
        )
        chain = extract_prompt | llm
        extracted = chain.invoke(
            {
                "domain": domain,
                "source_id": source_id,
                "schema_json": json.dumps(extraction_schema, ensure_ascii=False),
                "text": text[:4000],
            }
        )
        for ent in extracted.entities:
            if ent.entity_type not in extraction_schema:
                continue
            fields = extraction_schema[ent.entity_type]
            normalized = {f: ent.fields.get(f) for f in fields}
            rows.append(
                {
                    "domain": domain,
                    "entity_type": ent.entity_type,
                    "source_id": source_id,
                    "excerpt": ent.excerpt or text[:240],
                    "fields": normalized,
                    "confidence": ent.confidence,
                    "created_at": now,
                }
            )
    except Exception:
        # Fallback deterministic scaffold
        for et in target_types:
            if et not in entities:
                continue
            fields = entities[et].get("fields", [])
            rows.append(
                {
                    "domain": domain,
                    "entity_type": et,
                    "source_id": source_id,
                    "excerpt": text[:240],
                    "fields": {f: None for f in fields},
                    "confidence": 0.0,
                    "created_at": now,
                }
            )

    if rows:
        INSTANCE_FILE.parent.mkdir(parents=True, exist_ok=True)
        with INSTANCE_FILE.open("a", encoding="utf-8") as f:
            for row in rows:
                f.write(json.dumps(row, ensure_ascii=False) + "\n")

    return json.dumps(
        {
            "status": "ok",
            "saved": len(rows),
            "target_file": str(INSTANCE_FILE.resolve()),
            "source_id": source_id,
            "excerpt": text[:240],
        },
        ensure_ascii=False,
    )


@tool("ontology")
def ontology(
    action: str,
    domain: str = "bidding",
    entity_type: str | None = None,
    field: str | None = None,
    keyword: str | None = None,
    source_id: str = "",
    text: str = "",
) -> str:
    """本体查询与抽取（单工具双 action）。确认 schema/实例或从文本抽取结构化实体时使用。

    Use when:
    - query: 需要确认领域 schema 是否定义某实体类型/字段，或基于关键词从本体实例溯源。
    - extract: 需要把文档片段转成结构化本体实例（写入 entities.jsonl）。
    Avoid when:
    - 问题与本体无关（优先 search_knowledge/web_search）；文本过短或未准备 domain/schema。

    Actions:
    - query: 传 domain，可选 entity_type、field、keyword。
    - extract: 传 domain、source_id、text，可选 entity_type。
    """
    act = (action or "").strip().lower()
    if act == "query":
        return ontology_query.invoke({
            "domain": domain,
            "entity_type": entity_type,
            "field": field,
            "keyword": keyword,
        })
    if act == "extract":
        return ontology_extract.invoke({
            "domain": domain,
            "source_id": source_id or "ontology_extract",
            "text": text,
            "entity_type": entity_type,
        })
    return json.dumps({"status": "error", "reason": f"action 应为 query 或 extract，当前: {action}"}, ensure_ascii=False)

