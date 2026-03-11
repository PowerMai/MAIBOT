#!/usr/bin/env python3
"""Verify relations JSONL integrity and ontology mapping."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_RELATIONS = PROJECT_ROOT / "knowledge_base" / "learned" / "relations.jsonl"
DEFAULT_ENTITIES = PROJECT_ROOT / "knowledge_base" / "learned" / "entities.jsonl"
DEFAULT_SCHEMA = PROJECT_ROOT / "knowledge_base" / "learned" / "ontology" / "schema.json"


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


def verify_relations(relations_path: Path, entities_path: Path, schema_path: Path) -> dict:
    relations = _load_jsonl(relations_path)
    if not relations:
        return {"ok": False, "error": "relations_not_found_or_empty", "relations_path": str(relations_path)}

    entity_ids = {str(e.get("id")).strip() for e in _load_jsonl(entities_path) if e.get("id")}
    schema = {}
    if schema_path.exists():
        try:
            schema = json.loads(schema_path.read_text(encoding="utf-8"))
        except Exception:
            schema = {}
    allowed_types = set()
    if isinstance(schema.get("relation_types"), dict):
        allowed_types = set(str(k).upper() for k in schema["relation_types"].keys())

    missing_source = 0
    missing_target = 0
    unknown_type = 0
    format_errors: list[dict] = []
    for idx, rel in enumerate(relations):
        src = str(rel.get("source") or "").strip()
        tgt = str(rel.get("target") or "").strip()
        rtype = str(rel.get("type") or rel.get("relation_type") or "").strip()
        if not src:
            format_errors.append({"line": idx + 1, "error": "source_missing"})
        if not tgt:
            format_errors.append({"line": idx + 1, "error": "target_missing"})
        if not rtype:
            format_errors.append({"line": idx + 1, "error": "relation_type_missing"})
        if src and entity_ids and src not in entity_ids:
            missing_source += 1
        if tgt and entity_ids and tgt not in entity_ids:
            missing_target += 1
        if rtype and allowed_types and rtype.upper() not in allowed_types:
            unknown_type += 1

    ok = not format_errors and missing_source == 0 and missing_target == 0
    if allowed_types:
        ok = ok and unknown_type == 0

    return {
        "ok": ok,
        "relations_path": str(relations_path),
        "entities_path": str(entities_path),
        "schema_path": str(schema_path),
        "total": len(relations),
        "missing_source_ref": missing_source,
        "missing_target_ref": missing_target,
        "unknown_relation_type": unknown_type,
        "errors": format_errors[:100],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--relations", default=str(DEFAULT_RELATIONS))
    parser.add_argument("--entities", default=str(DEFAULT_ENTITIES))
    parser.add_argument("--schema", default=str(DEFAULT_SCHEMA))
    args = parser.parse_args()

    result = verify_relations(Path(args.relations), Path(args.entities), Path(args.schema))
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
