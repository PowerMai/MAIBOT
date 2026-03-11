"""
互联网本体导入并合并到主 KG 的流程与映射规则。

将 ONTOLOGY_IMPORT_STAGING_PATH 下的导入产物（Wikidata/OWL/Schema.org）
通过映射规则转为 KnowledgeGraph 实体与关系，写入 learned/ontology，参与 expand_query 与 search_knowledge。
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

from langchain_core.tools import tool

from backend.tools.base.paths import ONTOLOGY_IMPORT_STAGING_PATH
from backend.tools.base.knowledge_graph import (
    EntityType,
    RelationType,
    get_knowledge_graph,
)

logger = logging.getLogger(__name__)

# 外部实体类型 -> 主 KG EntityType 映射（可扩展为配置文件）
DEFAULT_ENTITY_MAPPING: Dict[str, EntityType] = {
    "Organization": EntityType.ORGANIZATION,
    "organization": EntityType.ORGANIZATION,
    "Person": EntityType.PERSON,
    "person": EntityType.PERSON,
    "Product": EntityType.PRODUCT,
    "product": EntityType.PRODUCT,
    "Project": EntityType.PROJECT,
    "project": EntityType.PROJECT,
    "Dataset": EntityType.DOCUMENT,
    "document": EntityType.DOCUMENT,
    "Service": EntityType.SERVICE,
    "service": EntityType.SERVICE,
    "Requirement": EntityType.REQUIREMENT,
    "requirement": EntityType.REQUIREMENT,
}

# 外部关系谓词 -> 主 KG RelationType 映射（OWL/RDF 常见谓词）
DEFAULT_RELATION_MAPPING: Dict[str, RelationType] = {
    "type": RelationType.IS_A,
    "is_a": RelationType.IS_A,
    "partOf": RelationType.PART_OF,
    "part_of": RelationType.PART_OF,
    "contains": RelationType.CONTAINS,
    "requires": RelationType.REQUIRES,
    "references": RelationType.REFERENCES,
    "sameAs": RelationType.IS_A,
    "seeAlso": RelationType.REFERENCES,
}


def _short_name(uri_or_name: str) -> str:
    """从 URI 或长名中取短名（最后一段）。"""
    s = (uri_or_name or "").strip()
    if "/" in s:
        s = s.rstrip("/").split("/")[-1]
    if "#" in s:
        s = s.split("#")[-1]
    return s or "unknown"


def merge_wikidata_file(
    path: Path,
    kg: Any,
    entity_mapping: Optional[Dict[str, EntityType]] = None,
) -> Dict[str, int]:
    """将 wikidata_*.json 中的候选概念合并到 KG，作为实体（类型默认 OTHER，来源为 concepturi）。"""
    mapping = entity_mapping or DEFAULT_ENTITY_MAPPING
    stats = {"entities_added": 0, "skipped": 0}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        logger.warning("读取 wikidata 文件失败 %s: %s", path, e)
        return stats
    entities = data.get("entities") or []
    source_label = f"wikidata_import:{path.name}"
    for item in entities:
        label = (item.get("label") or item.get("id") or "").strip()
        if not label:
            stats["skipped"] += 1
            continue
        concepturi = item.get("concepturi") or ""
        desc = (item.get("description") or "").strip()
        entity_type = EntityType.OTHER
        for key, et in mapping.items():
            if key in desc or key in label:
                entity_type = et
                break
        try:
            kg.add_entity(
                name=label,
                entity_type=entity_type,
                properties={"description": desc, "concepturi": concepturi},
                confidence=0.7,
                source=source_label,
                source_location=concepturi,
            )
            stats["entities_added"] += 1
        except Exception as e:
            logger.debug("添加实体 %s 失败: %s", label, e)
            stats["skipped"] += 1
    return stats


def merge_owl_triples_file(
    path: Path,
    kg: Any,
    entity_mapping: Optional[Dict[str, EntityType]] = None,
    relation_mapping: Optional[Dict[str, RelationType]] = None,
) -> Dict[str, int]:
    """将 imported_ontology.json（triples）合并到 KG：先建实体，再建关系。"""
    emap = entity_mapping or DEFAULT_ENTITY_MAPPING
    rmap = relation_mapping or DEFAULT_RELATION_MAPPING
    stats = {"entities_added": 0, "relations_added": 0, "skipped": 0}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        logger.warning("读取 OWL 文件失败 %s: %s", path, e)
        return stats
    triples = data.get("triples") or []
    source_label = f"owl_import:{path.name}"
    name_to_id: Dict[str, str] = {}
    for t in triples:
        subj, pred, obj = t.get("subject"), t.get("predicate"), t.get("object")
        if not subj or not obj:
            continue
        s_name = _short_name(subj)
        o_name = _short_name(obj)
        if s_name not in name_to_id:
            try:
                e = kg.add_entity(
                    name=s_name,
                    entity_type=EntityType.OTHER,
                    properties={"uri": subj},
                    confidence=0.6,
                    source=source_label,
                )
                name_to_id[s_name] = e.id
                stats["entities_added"] += 1
            except Exception:
                stats["skipped"] += 1
                continue
        if o_name not in name_to_id:
            try:
                e = kg.add_entity(
                    name=o_name,
                    entity_type=EntityType.OTHER,
                    properties={"uri": obj},
                    confidence=0.6,
                    source=source_label,
                )
                name_to_id[o_name] = e.id
                stats["entities_added"] += 1
            except Exception:
                stats["skipped"] += 1
                continue
        pred_short = _short_name(pred).replace("-", "_")
        relation_type = rmap.get(pred_short) or rmap.get(pred_short.lower()) or RelationType.REFERENCES
        try:
            rel = kg.add_relation(
                subject_id=name_to_id[s_name],
                predicate=relation_type,
                object_id=name_to_id[o_name],
                source=source_label,
                evidence=pred,
            )
            if rel:
                stats["relations_added"] += 1
        except Exception:
            stats["skipped"] += 1
    return stats


def merge_imported_into_kg(
    source_path: str | Path,
    source_type: str = "wikidata",
    kg: Optional[Any] = None,
    save: bool = True,
) -> Dict[str, Any]:
    """
    将指定导入文件合并到主 KG。
    source_type: "wikidata" | "owl"
    返回: { "success", "stats", "error" }
    """
    path = Path(source_path)
    if not path.is_absolute():
        path = ONTOLOGY_IMPORT_STAGING_PATH / path
    if not path.exists():
        return {"success": False, "stats": {}, "error": f"文件不存在: {path}"}
    use_kg = kg or get_knowledge_graph()
    try:
        if source_type.lower() == "wikidata":
            stats = merge_wikidata_file(path, use_kg)
        elif source_type.lower() in ("owl", "rdf", "triples"):
            stats = merge_owl_triples_file(path, use_kg)
        else:
            return {"success": False, "stats": {}, "error": f"不支持的 source_type: {source_type}"}
        if save:
            use_kg.save()
        return {"success": True, "stats": stats, "error": ""}
    except Exception as e:
        logger.exception("合并导入到 KG 失败")
        return {"success": False, "stats": {}, "error": str(e)}


def list_imported_candidates() -> List[Dict[str, str]]:
    """列出暂存目录下可合并的导入文件（供 Agent 选择后调用 merge_imported_into_kg）。"""
    candidates = []
    staging = ONTOLOGY_IMPORT_STAGING_PATH
    if not staging.exists():
        return candidates
    for f in staging.iterdir():
        if not f.is_file():
            continue
        name = f.name
        if name.startswith("wikidata_") and name.endswith(".json"):
            candidates.append({"path": name, "source_type": "wikidata"})
        elif name == "imported_ontology.json" or (name.endswith(".json") and "imported" in name):
            candidates.append({"path": name, "source_type": "owl"})
    return candidates


@tool("merge_imported_ontology")
def merge_imported_ontology_tool(
    source_path: str,
    source_type: str = "wikidata",
) -> str:
    """将外部本体导入文件合并到主知识图谱，使 expand_query 与 search_knowledge 能利用这些概念。

    Use when: 已通过 search_lov/import_from_wikidata/import_owl 导入并落盘，需要把结果并入主 KG。
    source_path: 文件名（如 wikidata_招标.json）或相对 ONTOLOGY_IMPORT_STAGING_PATH 的路径。
    source_type: wikidata | owl
    """
    import json

    result = merge_imported_into_kg(source_path, source_type=source_type, save=True)
    return json.dumps(result, ensure_ascii=False)
