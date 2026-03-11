"""Validation tools for knowledge and ontology outputs."""

from __future__ import annotations

import json
from typing import Any

from langchain_core.tools import tool


def _safe_json(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False)


def _ensure_dict(raw: Any) -> tuple[dict[str, Any] | None, str | None]:
    if isinstance(raw, dict):
        return raw, None
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                return parsed, None
            return None, "parsed_value_is_not_object"
        except Exception as exc:
            return None, f"invalid_json: {exc}"
    return None, "unsupported_input_type"


@tool("verify_output")
def verify_output(output: str, schema_path: str) -> str:
    """Validate JSON output with JSON Schema."""
    obj, err = _ensure_dict(output)
    if err:
        return _safe_json({"ok": False, "error": err})
    try:
        with open(schema_path, "r", encoding="utf-8") as f:
            schema = json.load(f)
    except Exception as exc:
        return _safe_json({"ok": False, "error": f"schema_load_failed: {exc}", "schema_path": schema_path})

    try:
        import jsonschema  # type: ignore

        jsonschema.validate(instance=obj, schema=schema)
        return _safe_json({"ok": True, "schema_path": schema_path})
    except Exception as exc:
        return _safe_json({"ok": False, "error": f"schema_validate_failed: {exc}", "schema_path": schema_path})


@tool("verify_knowledge_entry")
def verify_knowledge_entry(entry: str) -> str:
    """Validate required fields for a knowledge entry."""
    obj, err = _ensure_dict(entry)
    if err:
        return _safe_json({"ok": False, "error": err})

    required = ["source_url", "confidence", "evidence"]
    missing = [k for k in required if k not in obj or obj.get(k) in (None, "", [], {})]
    issues: list[str] = []
    conf = obj.get("confidence")
    if conf is None:
        issues.append("confidence_missing")
    else:
        try:
            conf_num = float(conf)
            if conf_num < 0 or conf_num > 1:
                issues.append("confidence_out_of_range")
        except Exception:
            issues.append("confidence_not_numeric")

    ok = not missing and not issues
    return _safe_json({"ok": ok, "missing": missing, "issues": issues})


@tool("verify_ontology_entity")
def verify_ontology_entity(entity: str, domain: str = "bidding") -> str:
    """Validate ontology entity against learned domain schema."""
    obj, err = _ensure_dict(entity)
    if err:
        return _safe_json({"ok": False, "error": err})

    from pathlib import Path

    root = Path(__file__).resolve().parents[3]
    schema_candidates = [
        root / "knowledge_base" / "learned" / "ontology" / "domain" / domain / "schema.json",
        root / "knowledge_base" / "learned" / "ontology" / "schema.json",
    ]
    schema_path = next((p for p in schema_candidates if p.exists()), None)
    if schema_path is None:
        return _safe_json({"ok": False, "error": "schema_not_found", "domain": domain})

    try:
        schema = json.loads(schema_path.read_text(encoding="utf-8"))
    except Exception as exc:
        return _safe_json({"ok": False, "error": f"schema_parse_failed: {exc}", "schema_path": str(schema_path)})

    entity_type = str(obj.get("type") or obj.get("entity_type") or "").strip()
    type_map = schema.get("entity_types", {}) if isinstance(schema, dict) else {}
    if not entity_type:
        return _safe_json({"ok": False, "error": "entity_type_missing", "schema_path": str(schema_path)})
    if entity_type.upper() not in type_map and entity_type not in type_map:
        return _safe_json(
            {
                "ok": False,
                "error": "entity_type_not_in_schema",
                "entity_type": entity_type,
                "schema_path": str(schema_path),
            }
        )

    return _safe_json({"ok": True, "entity_type": entity_type, "schema_path": str(schema_path)})
