"""External ontology import helpers (OWL/RDF/Schema.org/LOV)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
from langchain_core.tools import tool

from backend.tools.base.paths import ONTOLOGY_IMPORT_STAGING_PATH

ONTOLOGY_ROOT = ONTOLOGY_IMPORT_STAGING_PATH
ONTOLOGY_ROOT.mkdir(parents=True, exist_ok=True)


def _safe_json(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False)


@tool("search_lov")
def search_lov(query: str, limit: int = 5) -> str:
    """Search Linked Open Vocabularies (LOV) API by keyword.

    Use when:
    - 需要发现可复用的公开本体资源。

    Avoid when:
    - 已有明确本地 schema 且无需外部扩展。

    Strategy:
    - 先 broad query，再缩小到具体领域词做二次检索。
    """
    try:
        url = "https://lov.linkeddata.es/dataset/lov/api/v2/vocabulary/search"
        resp = httpx.get(url, params={"q": query}, timeout=20.0)
        resp.raise_for_status()
        data = resp.json()
        items = []
        for row in (data.get("results") or [])[: max(1, min(limit, 20))]:
            items.append(
                {
                    "uri": row.get("uri"),
                    "prefix": row.get("prefix"),
                    "titles": row.get("titles"),
                    "descriptions": row.get("descriptions"),
                }
            )
        return _safe_json({"status": "ok", "query": query, "count": len(items), "items": items})
    except Exception as e:
        return _safe_json({"status": "error", "query": query, "reason": str(e), "items": []})


@tool("import_owl")
def import_owl(url_or_path: str, output_name: str = "imported_ontology.json") -> str:
    """Import OWL/RDF file and convert to lightweight JSON triples.

    Use when:
    - 需要把标准 OWL/RDF 资源导入本地系统做二次加工。

    Avoid when:
    - 仅需查询 schema 字段而非导入全量三元组。

    Strategy:
    - 先小规模导入验证质量，再扩大到完整本体。
    """
    try:
        from rdflib import Graph
    except Exception as e:
        return _safe_json(
            {
                "status": "error",
                "reason": f"rdflib not installed: {e}",
                "hint": "请先通过 shell_run 或 python_run 安装 rdflib",
            }
        )

    g = Graph()
    try:
        if url_or_path.startswith("http://") or url_or_path.startswith("https://"):
            g.parse(url_or_path)
        else:
            g.parse(str(Path(url_or_path).expanduser().resolve()))
    except Exception as e:
        return _safe_json({"status": "error", "reason": f"parse failed: {e}"})

    triples = []
    for s, p, o in g:
        triples.append({"subject": str(s), "predicate": str(p), "object": str(o)})
        if len(triples) >= 5000:
            break

    out_path = ONTOLOGY_ROOT / output_name
    out_path.write_text(_safe_json({"source": url_or_path, "triples": triples}), encoding="utf-8")
    return _safe_json({"status": "ok", "saved": str(out_path), "triples": len(triples)})


@tool("import_schema_org")
def import_schema_org(types: str = "Organization,Product,Dataset") -> str:
    """Import selected Schema.org types (JSON-LD context based scaffold).

    Use when:
    - 需要快速建立通用领域的基础实体类型。

    Avoid when:
    - 已有严格行业 schema，不希望引入通用字段干扰。

    Strategy:
    - 先导入 2-5 个核心类型，再按业务逐步扩展。
    """
    type_names = [t.strip() for t in types.split(",") if t.strip()]
    if not type_names:
        type_names = ["Organization", "Product", "Dataset"]

    schema = {
        "domain": "schema_org",
        "entities": {},
    }
    for t in type_names:
        schema["entities"][t] = {
            "fields": ["name", "description", "url", "identifier"],
            "source": "https://schema.org",
        }

    out_path = ONTOLOGY_ROOT / "schema_org.yaml"
    try:
        import yaml

        out_path.write_text(yaml.safe_dump(schema, allow_unicode=True, sort_keys=False), encoding="utf-8")
    except Exception:
        # fallback json
        out_path = ONTOLOGY_ROOT / "schema_org.json"
        out_path.write_text(_safe_json(schema), encoding="utf-8")

    return _safe_json({"status": "ok", "saved": str(out_path), "types": type_names})


@tool("import_from_wikidata")
def import_from_wikidata(search: str, limit: int = 10) -> str:
    """Import concept candidates from Wikidata and save as local ontology seed."""
    q = (search or "").strip()
    if not q:
        return _safe_json({"status": "error", "reason": "search 不能为空"})
    try:
        endpoint = "https://www.wikidata.org/w/api.php"
        resp = httpx.get(
            endpoint,
            params={
                "action": "wbsearchentities",
                "format": "json",
                "language": "zh",
                "uselang": "zh",
                "type": "item",
                "search": q,
                "limit": max(1, min(int(limit), 50)),
            },
            timeout=20.0,
        )
        resp.raise_for_status()
        data = resp.json()
        entities = []
        for item in (data.get("search") or [])[: max(1, min(int(limit), 50))]:
            entities.append(
                {
                    "id": item.get("id"),
                    "label": item.get("label"),
                    "description": item.get("description"),
                    "concepturi": item.get("concepturi"),
                }
            )
        out_path = ONTOLOGY_ROOT / f"wikidata_{q.replace(' ', '_')}.json"
        out_path.write_text(_safe_json({"query": q, "entities": entities}), encoding="utf-8")
        return _safe_json({"status": "ok", "saved": str(out_path), "count": len(entities)})
    except Exception as e:
        return _safe_json({"status": "error", "reason": str(e)})

