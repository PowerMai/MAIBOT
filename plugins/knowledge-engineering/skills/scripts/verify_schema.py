import json
from pathlib import Path


def main() -> int:
    root = Path(__file__).resolve().parents[4]
    schema_path = root / "knowledge_base" / "learned" / "ontology" / "schema.json"
    if not schema_path.exists():
        print(json.dumps({"ok": False, "error": "schema_not_found", "path": str(schema_path)}, ensure_ascii=False))
        return 1
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    entity_types = schema.get("entity_types", {}) if isinstance(schema, dict) else {}
    relation_types = schema.get("relation_types", {}) if isinstance(schema, dict) else {}
    ok = isinstance(entity_types, dict) and isinstance(relation_types, dict) and len(entity_types) > 0
    print(
        json.dumps(
            {
                "ok": ok,
                "entity_type_count": len(entity_types) if isinstance(entity_types, dict) else 0,
                "relation_type_count": len(relation_types) if isinstance(relation_types, dict) else 0,
                "path": str(schema_path),
            },
            ensure_ascii=False,
        )
    )
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
