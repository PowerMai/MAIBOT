import json
from pathlib import Path


def main() -> int:
    root = Path(__file__).resolve().parents[4]
    schema_path = root / "knowledge_base" / "learned" / "ontology" / "schema.json"
    entities_path = root / "knowledge_base" / "learned" / "ontology" / "entities.json"
    out_path = root / "knowledge_base" / "learned" / "audits" / "gap_report.json"
    if not (schema_path.exists() and entities_path.exists()):
        print(json.dumps({"ok": False, "error": "required_files_missing"}, ensure_ascii=False))
        return 1
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    entities = json.loads(entities_path.read_text(encoding="utf-8")).get("entities", [])
    schema_types = schema.get("entity_types", {}) if isinstance(schema, dict) else {}
    counts = {}
    for e in entities:
        if isinstance(e, dict):
            t = str(e.get("type") or "").upper()
            if t:
                counts[t] = counts.get(t, 0) + 1
    gaps = []
    for et in schema_types.keys() if isinstance(schema_types, dict) else []:
        key = str(et).upper()
        c = int(counts.get(key, 0))
        if c < 5:
            gaps.append({"type": "entity_coverage", "entity_type": et, "count": c, "required_min": 5, "priority": "high" if c == 0 else "medium"})
    payload = {
        "generated_at": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
        "gap_count": len(gaps),
        "gaps": gaps,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"ok": True, "output": str(out_path), "gap_count": len(gaps)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
