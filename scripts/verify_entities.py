#!/usr/bin/env python3
"""Verify entities JSONL against ontology schema."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
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


def verify_entities(entities_path: Path, schema_path: Path) -> dict:
    entities = _load_jsonl(entities_path)
    if not entities:
        return {"ok": False, "error": "entities_not_found_or_empty", "entities_path": str(entities_path)}

    schema = {}
    if schema_path.exists():
        try:
            schema = json.loads(schema_path.read_text(encoding="utf-8"))
        except Exception:
            schema = {}
    allowed_types = set()
    if isinstance(schema.get("entity_types"), dict):
        allowed_types = set(str(k).upper() for k in schema["entity_types"].keys())

    errors: list[dict] = []
    seen_ids: set[str] = set()
    duplicate_ids = 0
    invalid_confidence = 0
    unknown_types = 0
    for idx, e in enumerate(entities):
        eid = str(e.get("id") or "").strip()
        etype = str(e.get("type") or e.get("entity_type") or "").strip()
        if not eid:
            errors.append({"line": idx + 1, "error": "id_missing"})
        elif eid in seen_ids:
            duplicate_ids += 1
        else:
            seen_ids.add(eid)

        if not etype:
            errors.append({"line": idx + 1, "error": "entity_type_missing"})
        elif allowed_types and etype.upper() not in allowed_types:
            unknown_types += 1

        if "confidence" in e:
            try:
                c = float(e.get("confidence"))
                if c < 0 or c > 1:
                    invalid_confidence += 1
            except Exception:
                invalid_confidence += 1

    ok = not errors and duplicate_ids == 0 and invalid_confidence == 0
    if allowed_types:
        ok = ok and unknown_types == 0

    return {
        "ok": ok,
        "entities_path": str(entities_path),
        "schema_path": str(schema_path),
        "total": len(entities),
        "unique_ids": len(seen_ids),
        "duplicate_ids": duplicate_ids,
        "unknown_types": unknown_types,
        "invalid_confidence": invalid_confidence,
        "errors": errors[:100],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--entities", default=str(DEFAULT_ENTITIES))
    parser.add_argument("--schema", default=str(DEFAULT_SCHEMA))
    args = parser.parse_args()

    result = verify_entities(Path(args.entities), Path(args.schema))
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
