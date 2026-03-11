#!/usr/bin/env python3
"""Verify ontology schema structure."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SCHEMA = PROJECT_ROOT / "knowledge_base" / "learned" / "ontology" / "schema.json"


def verify_schema(schema_path: Path) -> dict:
    if not schema_path.exists():
        return {"ok": False, "error": "schema_not_found", "schema_path": str(schema_path)}

    try:
        schema = json.loads(schema_path.read_text(encoding="utf-8"))
    except Exception as exc:
        return {"ok": False, "error": f"schema_parse_failed: {exc}", "schema_path": str(schema_path)}

    required = ["entity_types", "relation_types", "domain_terms"]
    missing = [k for k in required if k not in schema]
    invalid_types = [
        k for k in required if k in schema and not isinstance(schema.get(k), dict)
    ]
    issues = []
    if missing:
        issues.append("missing_required_keys")
    if invalid_types:
        issues.append("invalid_key_types")

    return {
        "ok": not issues,
        "schema_path": str(schema_path),
        "missing": missing,
        "invalid_types": invalid_types,
        "entity_type_count": len(schema.get("entity_types", {})) if isinstance(schema.get("entity_types"), dict) else 0,
        "relation_type_count": len(schema.get("relation_types", {})) if isinstance(schema.get("relation_types"), dict) else 0,
        "issues": issues,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--schema", default=str(DEFAULT_SCHEMA), help="Schema JSON path")
    args = parser.parse_args()

    result = verify_schema(Path(args.schema))
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
