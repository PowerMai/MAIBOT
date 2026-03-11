import json
from pathlib import Path


def main() -> int:
    root = Path(__file__).resolve().parents[4]
    entities_path = root / "knowledge_base" / "learned" / "ontology" / "entities.json"
    relations_path = root / "knowledge_base" / "learned" / "ontology" / "relations.json"
    if not entities_path.exists() or not relations_path.exists():
        print(json.dumps({"ok": False, "error": "ontology_files_missing"}, ensure_ascii=False))
        return 1
    entities_data = json.loads(entities_path.read_text(encoding="utf-8"))
    relations_data = json.loads(relations_path.read_text(encoding="utf-8"))
    entities = entities_data.get("entities", []) if isinstance(entities_data, dict) else []
    relations = relations_data.get("relations", []) if isinstance(relations_data, dict) else []
    ids = {str(e.get("id")) for e in entities if isinstance(e, dict) and e.get("id")}
    issues = []
    for i, r in enumerate(relations):
        if not isinstance(r, dict):
            issues.append(f"{i}:relation_not_object")
            continue
        s = str(r.get("subject_id") or "")
        o = str(r.get("object_id") or "")
        if not s or s not in ids:
            issues.append(f"{i}:invalid_subject")
        if not o or o not in ids:
            issues.append(f"{i}:invalid_object")
        if not r.get("predicate"):
            issues.append(f"{i}:missing_predicate")
    ok = len(issues) == 0
    print(json.dumps({"ok": ok, "relation_count": len(relations), "issue_count": len(issues), "issues": issues[:100]}, ensure_ascii=False))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
