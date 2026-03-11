"""Knowledge gap detector for autonomous planning."""

from __future__ import annotations

import json
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List


def _load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def _load_jsonl(path: Path) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    if not path.exists():
        return rows
    for line in path.read_text(encoding="utf-8").splitlines():
        text = line.strip()
        if not text:
            continue
        try:
            obj = json.loads(text)
        except Exception:
            continue
        if isinstance(obj, dict):
            rows.append(obj)
    return rows


def _load_entities(base: Path) -> List[Dict[str, Any]]:
    jsonl_rows = _load_jsonl(base / "entities.jsonl")
    if jsonl_rows:
        return jsonl_rows
    payload = _load_json(base / "ontology" / "entities.json", {})
    if isinstance(payload, dict) and isinstance(payload.get("entities"), list):
        return [x for x in payload["entities"] if isinstance(x, dict)]
    return []


def _load_relations(base: Path) -> List[Dict[str, Any]]:
    jsonl_rows = _load_jsonl(base / "relations.jsonl")
    if jsonl_rows:
        return jsonl_rows
    payload = _load_json(base / "ontology" / "relations.json", {})
    if isinstance(payload, dict) and isinstance(payload.get("relations"), list):
        return [x for x in payload["relations"] if isinstance(x, dict)]
    return []


def _priority(score: float) -> str:
    if score >= 0.8:
        return "high"
    if score >= 0.5:
        return "medium"
    return "low"


def detect_knowledge_gaps(project_root: Path | None = None) -> Dict[str, Any]:
    root = (project_root or Path(__file__).resolve().parents[3]).resolve()
    learned = root / "knowledge_base" / "learned"
    audits = learned / "audits"
    audits.mkdir(parents=True, exist_ok=True)

    schema = _load_json(learned / "ontology" / "schema.json", {})
    entities = _load_entities(learned)
    relations = _load_relations(learned)
    entity_type_counter = Counter(
        str(e.get("type") or e.get("entity_type") or "").upper()
        for e in entities
        if (e.get("type") or e.get("entity_type"))
    )

    gaps: List[Dict[str, Any]] = []
    entity_types = schema.get("entity_types", {}) if isinstance(schema, dict) else {}
    if isinstance(entity_types, dict):
        for et in entity_types.keys():
            etype = str(et or "").strip()
            if not etype:
                continue
            count = int(entity_type_counter.get(etype.upper(), 0))
            if count < 5:
                score = 1.0 if count == 0 else 0.7
                gaps.append(
                    {
                        "type": "entity_coverage",
                        "entity_type": etype,
                        "count": count,
                        "required_min": 5,
                        "impact_score": score,
                        "priority": _priority(score),
                        "suggested_task": "kb_web_harvest",
                    }
                )

    if len(relations) < max(10, len(entities) // 3):
        density_score = 0.6 if entities else 0.3
        gaps.append(
            {
                "type": "relation_density",
                "relation_count": len(relations),
                "entity_count": len(entities),
                "impact_score": density_score,
                "priority": _priority(density_score),
                "suggested_task": "kb_entity_extract",
            }
        )

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "gap_count": len(gaps),
        "gaps": sorted(gaps, key=lambda x: float(x.get("impact_score", 0.0)), reverse=True),
    }
    out = audits / "gap_report.json"
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    report["output_path"] = str(out)
    return report

