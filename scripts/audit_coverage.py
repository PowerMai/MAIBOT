#!/usr/bin/env python3
"""Audit coverage for ontology/entity/relation assets."""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
LEARNED = PROJECT_ROOT / "knowledge_base" / "learned"
DEFAULT_SCHEMA = LEARNED / "ontology" / "schema.json"
DEFAULT_ENTITIES = LEARNED / "entities.jsonl"
DEFAULT_RELATIONS = LEARNED / "relations.jsonl"
DEFAULT_OUTPUT = LEARNED / "audits" / "coverage_report.json"


def _load_jsonl(path: Path) -> list[dict]:
    rows: list[dict] = []
    if not path.exists():
        return rows
    for line in path.read_text(encoding="utf-8").splitlines():
        text = line.strip()
        if not text:
            continue
        try:
            item = json.loads(text)
        except Exception:
            continue
        if isinstance(item, dict):
            rows.append(item)
    return rows


def audit(schema_path: Path, entities_path: Path, relations_path: Path) -> dict:
    schema = {}
    if schema_path.exists():
        try:
            schema = json.loads(schema_path.read_text(encoding="utf-8"))
        except Exception:
            schema = {}
    entities = _load_jsonl(entities_path)
    relations = _load_jsonl(relations_path)

    entity_type_counter = Counter(str(e.get("type") or e.get("entity_type") or "").upper() for e in entities if (e.get("type") or e.get("entity_type")))
    relation_type_counter = Counter(str(r.get("type") or r.get("relation_type") or "").upper() for r in relations if (r.get("type") or r.get("relation_type")))

    schema_entity_types = set(str(x).upper() for x in (schema.get("entity_types", {}) or {}).keys())
    schema_relation_types = set(str(x).upper() for x in (schema.get("relation_types", {}) or {}).keys())

    covered_entities = set(entity_type_counter.keys()) & schema_entity_types if schema_entity_types else set(entity_type_counter.keys())
    covered_relations = set(relation_type_counter.keys()) & schema_relation_types if schema_relation_types else set(relation_type_counter.keys())

    entity_coverage = (len(covered_entities) / len(schema_entity_types) * 100.0) if schema_entity_types else 0.0
    relation_coverage = (len(covered_relations) / len(schema_relation_types) * 100.0) if schema_relation_types else 0.0

    entity_ids = {str(e.get("id")).strip() for e in entities if e.get("id")}
    dangling = 0
    for r in relations:
        src = str(r.get("source") or "").strip()
        tgt = str(r.get("target") or "").strip()
        if src and src not in entity_ids:
            dangling += 1
        if tgt and tgt not in entity_ids:
            dangling += 1
    dangling_rate = (dangling / max(1, len(relations) * 2)) * 100.0

    key_counter = Counter((str(e.get("type") or e.get("entity_type") or ""), str(e.get("name") or "")) for e in entities)
    duplicates = sum(count - 1 for count in key_counter.values() if count > 1)
    duplicate_rate = (duplicates / max(1, len(entities))) * 100.0

    return {
        "ok": True,
        "schema_path": str(schema_path),
        "entities_path": str(entities_path),
        "relations_path": str(relations_path),
        "totals": {"entities": len(entities), "relations": len(relations)},
        "coverage": {
            "entity_type_coverage_pct": round(entity_coverage, 2),
            "relation_type_coverage_pct": round(relation_coverage, 2),
        },
        "quality": {
            "dangling_relation_rate_pct": round(dangling_rate, 2),
            "duplicate_entity_rate_pct": round(duplicate_rate, 2),
        },
        "missing": {
            "entity_types": sorted(schema_entity_types - covered_entities),
            "relation_types": sorted(schema_relation_types - covered_relations),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--schema", default=str(DEFAULT_SCHEMA))
    parser.add_argument("--entities", default=str(DEFAULT_ENTITIES))
    parser.add_argument("--relations", default=str(DEFAULT_RELATIONS))
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    args = parser.parse_args()

    result = audit(Path(args.schema), Path(args.entities), Path(args.relations))
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
