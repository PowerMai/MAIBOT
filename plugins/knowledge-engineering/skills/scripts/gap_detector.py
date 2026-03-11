import json
from pathlib import Path


def _load_json(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def main() -> int:
    root = Path(__file__).resolve().parents[4]
    schema = _load_json(root / "knowledge_base" / "learned" / "ontology" / "schema.json", {})
    entities_payload = _load_json(root / "knowledge_base" / "learned" / "ontology" / "entities.json", {})
    relations_payload = _load_json(root / "knowledge_base" / "learned" / "ontology" / "relations.json", {})
    entities = entities_payload.get("entities", []) if isinstance(entities_payload, dict) else []
    relations = relations_payload.get("relations", []) if isinstance(relations_payload, dict) else []
    type_counts = {}
    for e in entities:
        if isinstance(e, dict):
            t = str(e.get("type") or "").upper()
            if t:
                type_counts[t] = type_counts.get(t, 0) + 1
    gaps = []
    entity_types = schema.get("entity_types", {}) if isinstance(schema, dict) else {}
    for et in entity_types.keys() if isinstance(entity_types, dict) else []:
        cnt = int(type_counts.get(str(et).upper(), 0))
        if cnt < 5:
            gaps.append(
                {
                    "type": "entity_coverage",
                    "entity_type": et,
                    "count": cnt,
                    "required_min": 5,
                    "priority": "high" if cnt == 0 else "medium",
                }
            )
    if len(relations) < max(10, len(entities) // 3):
        gaps.append(
            {
                "type": "relation_density",
                "relation_count": len(relations),
                "entity_count": len(entities),
                "priority": "medium",
            }
        )
    report = {
        "generated_at": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
        "gap_count": len(gaps),
        "gaps": gaps,
    }
    out = root / "knowledge_base" / "learned" / "audits" / "gap_report.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"ok": True, "output": str(out), "gap_count": len(gaps)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
