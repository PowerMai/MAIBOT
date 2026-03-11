import json
from pathlib import Path


def main() -> int:
    root = Path(__file__).resolve().parents[4]
    entities_path = root / "knowledge_base" / "learned" / "ontology" / "entities.json"
    if not entities_path.exists():
        print(json.dumps({"ok": False, "error": "entities_not_found", "path": str(entities_path)}, ensure_ascii=False))
        return 1
    payload = json.loads(entities_path.read_text(encoding="utf-8"))
    entities = payload.get("entities", []) if isinstance(payload, dict) else []
    issues = []
    for idx, e in enumerate(entities):
        if not isinstance(e, dict):
            issues.append(f"{idx}:entity_not_object")
            continue
        if not e.get("id"):
            issues.append(f"{idx}:missing_id")
        if not e.get("type"):
            issues.append(f"{idx}:missing_type")
        conf = e.get("confidence")
        try:
            v = float(conf)
            if v < 0 or v > 1:
                issues.append(f"{idx}:confidence_out_of_range")
        except Exception:
            issues.append(f"{idx}:confidence_invalid")
        if not e.get("source"):
            issues.append(f"{idx}:missing_source")
    ok = len(issues) == 0
    print(json.dumps({"ok": ok, "entity_count": len(entities), "issue_count": len(issues), "issues": issues[:100]}, ensure_ascii=False))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
