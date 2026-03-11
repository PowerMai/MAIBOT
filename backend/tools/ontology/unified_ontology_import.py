"""
外部本体导入统一工具（5 合 1）：少工具原则，单入口 + action 参数。

替代 search_lov / import_from_wikidata / import_owl / import_schema_org / merge_imported_ontology，
Registry 仅注册 ontology_import。
"""

from __future__ import annotations

import json
from typing import Any, Literal, Optional

from langchain_core.tools import tool

from backend.tools.ontology.external_import import (
    search_lov as _search_lov,
    import_from_wikidata as _import_from_wikidata,
    import_owl as _import_owl,
    import_schema_org as _import_schema_org,
)
from backend.tools.ontology.merge_imported import (
    merge_imported_into_kg,
    list_imported_candidates,
)


@tool("ontology_import")
def ontology_import(
    action: Literal[
        "search_lov",
        "import_wikidata",
        "import_owl",
        "import_schema_org",
        "merge_into_kg",
        "list_candidates",
    ],
    query: Optional[str] = None,
    limit: Optional[int] = None,
    search: Optional[str] = None,
    url_or_path: Optional[str] = None,
    output_name: Optional[str] = None,
    types: Optional[str] = None,
    source_path: Optional[str] = None,
    source_type: Optional[str] = None,
) -> str:
    """外部本体导入与合并（单工具多 action）。需要发现/导入/合并互联网本体时使用。

    Use when:
    - 需要发现可复用的公开本体（LOV）、从 Wikidata 拉取概念、导入 OWL/Schema.org、或将已导入结果合并到主 KG。
    Avoid when:
    - 已有明确本地 schema 且无需外部扩展；或仅做本地检索（用 search_knowledge/query_kg）。

    Actions:
    - search_lov: 发现 LOV 词汇，传 query、limit。
    - import_wikidata: 按词条搜索 Wikidata 并落盘，传 search、limit。
    - import_owl: 导入 OWL/RDF 文件或 URL，传 url_or_path、output_name。
    - import_schema_org: 生成 Schema.org 类型脚手架，传 types（逗号分隔）。
    - merge_into_kg: 将暂存文件合并到主知识图谱，传 source_path、source_type（wikidata|owl）。
    - list_candidates: 列出可合并的暂存文件，无需其他参数。
    """
    try:
        if action == "search_lov":
            return _search_lov.invoke({"query": query or "", "limit": limit if limit is not None else 5})
        if action == "import_wikidata":
            return _import_from_wikidata.invoke({
                "search": search or "",
                "limit": limit if limit is not None else 10,
            })
        if action == "import_owl":
            if not url_or_path:
                return json.dumps({"status": "error", "reason": "import_owl 需传 url_or_path"}, ensure_ascii=False)
            return _import_owl.invoke({
                "url_or_path": url_or_path,
                "output_name": output_name or "imported_ontology.json",
            })
        if action == "import_schema_org":
            return _import_schema_org.invoke({
                "types": types or "Organization,Product,Dataset",
            })
        if action == "merge_into_kg":
            if not source_path:
                return json.dumps({"status": "error", "reason": "merge_into_kg 需传 source_path"}, ensure_ascii=False)
            result = merge_imported_into_kg(source_path, source_type=source_type or "wikidata", save=True)
            return json.dumps(result, ensure_ascii=False)
        if action == "list_candidates":
            candidates = list_imported_candidates()
            return json.dumps({"status": "ok", "candidates": candidates}, ensure_ascii=False)
        return json.dumps({"status": "error", "reason": f"未知 action: {action}"}, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"status": "error", "reason": str(e)}, ensure_ascii=False)
