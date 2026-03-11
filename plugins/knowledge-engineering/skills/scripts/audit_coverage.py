import json
from pathlib import Path


def main() -> int:
    root = Path(__file__).resolve().parents[4]
    schema_path = root / "knowledge_base" / "learned" / "ontology" / "schema.json"
    entities_path = root / "knowledge_base" / "learned" / "ontology" / "entities.json"
    relations_path = root / "knowledge_base" / "learned" / "ontology" / "relations.json"
    if not (schema_path.exists() and entities_path.exists() and relations_path.exists()):
        print(json.dumps({"ok": False, "error": "required_files_missing"}, ensure_ascii=False))
        return 1
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    entities = json.loads(entities_path.read_text(encoding="utf-8")).get("entities", [])
    relations = json.loads(relations_path.read_text(encoding="utf-8")).get("relations", [])
    entity_types = schema.get("entity_types", {}) if isinstance(schema, dict) else {}
    covered_types = {str(e.get("type") or "").upper() for e in entities if isinstance(e, dict)}
    schema_types = {str(k).upper() for k in entity_types.keys()} if isinstance(entity_types, dict) else set()
    uncovered = sorted(t for t in schema_types if t and t not in covered_types)
    coverage = 0.0 if not schema_types else round((len(schema_types) - len(uncovered)) / len(schema_types), 4)
    print(
        json.dumps(
            {
                "ok": True,
                "entity_count": len(entities),
                "relation_count": len(relations),
                "schema_entity_type_count": len(schema_types),
                "covered_type_count": len(schema_types) - len(uncovered),
                "coverage_rate": coverage,
                "uncovered_types": uncovered,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
