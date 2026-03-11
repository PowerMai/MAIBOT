#!/usr/bin/env python3
"""
构建知识链路观测快照（ingest/index/search/ontology 四象限）。
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen


def _build_local_fallback(root: Path) -> dict:
    manifest_path = root / "knowledge_base" / "learned" / "ingestion" / "workspace_upload_manifest.jsonl"
    ingest_total = 0
    ingest_last = None
    if manifest_path.exists():
        for raw in manifest_path.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = raw.strip()
            if not line:
                continue
            ingest_total += 1
            try:
                item = json.loads(line)
                ts = str(item.get("ts") or "").strip()
                if ts:
                    ingest_last = ts
            except Exception:
                continue
    ontology_dir = root / "knowledge_base" / "learned" / "ontology"
    entities = 0
    relations = 0
    entities_file = ontology_dir / "entities.json"
    relations_file = ontology_dir / "relations.json"
    if entities_file.exists():
        try:
            data = json.loads(entities_file.read_text(encoding="utf-8"))
            entities = len(data.get("entities") or []) if isinstance(data, dict) else 0
        except Exception:
            pass
    if relations_file.exists():
        try:
            data = json.loads(relations_file.read_text(encoding="utf-8"))
            relations = len(data.get("relations") or []) if isinstance(data, dict) else 0
        except Exception:
            pass

    idx_db = root / "data" / "index_metadata.db"
    indexed_documents = 0
    cached_queries = 0
    if idx_db.exists():
        try:
            conn = sqlite3.connect(idx_db)
            indexed_documents = int(conn.execute("SELECT COUNT(*) FROM indexed_documents").fetchone()[0] or 0)
            cached_queries = int(conn.execute("SELECT COUNT(*) FROM query_cache").fetchone()[0] or 0)
            conn.close()
        except Exception:
            pass

    return {
        "ok": True,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": "local_fallback",
        "ingest": {
            "manifest_path": str(manifest_path),
            "total_uploaded": ingest_total,
            "last_uploaded_at": ingest_last,
        },
        "index": {
            "indexed_documents": indexed_documents,
        },
        "search": {
            "cached_queries": cached_queries,
        },
        "ontology": {
            "entities": entities,
            "relations": relations,
            "ontology_dir": str(ontology_dir),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Build knowledge pipeline observability snapshot")
    parser.add_argument(
        "--api-base",
        default=os.getenv("LANGGRAPH_API_URL", "http://127.0.0.1:2024"),
        help="Backend API base URL",
    )
    parser.add_argument(
        "--output",
        default="backend/data/knowledge_pipeline_snapshot.json",
        help="Output JSON path",
    )
    args = parser.parse_args()

    base = str(args.api_base or "").rstrip("/")
    if not base:
        raise SystemExit("api base is required")
    url = f"{base}/ops/knowledge-pipeline/status"
    payload = None
    try:
        req = Request(url=url, method="GET")
        with urlopen(req, timeout=10) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except Exception:
        payload = _build_local_fallback(Path.cwd())
    if isinstance(payload, dict) and "generated_at" not in payload:
        payload["generated_at"] = datetime.now(timezone.utc).isoformat()

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[knowledge-pipeline] snapshot written: {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

