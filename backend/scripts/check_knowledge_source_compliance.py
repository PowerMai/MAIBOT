#!/usr/bin/env python3
"""
知识来源合规门禁（先 warn，不触碰私有/闭源本体内容）：
1) 公有来源：skills_market 的 source_type/remote_url 与可选白名单一致
2) 证据完整：ingestion manifest 每条具备 ts（capture 时间）
3) 合规信号：技能条目具备 source_type，不读取 ontology 实体/关系内容
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

PROJECT_ROOT = Path(__file__).resolve().parents[2]


def _read_json(path: Path) -> Dict[str, Any]:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _write_report(path: str, payload: Dict[str, Any]) -> str:
    out = Path(path)
    if not out.is_absolute():
        out = PROJECT_ROOT / out
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return out.as_posix()


def run(
    report_json: str = "backend/data/knowledge_source_compliance_report.json",
    project_root: Path | None = None,
) -> int:
    root = project_root or PROJECT_ROOT
    report: Dict[str, Any] = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "status": "pass",
        "checks": {},
        "metrics": {},
        "warnings": [],
    }

    # 1) 公有来源：skills_market.json
    market_path = root / "backend" / "config" / "skills_market.json"
    market = _read_json(market_path)
    source_type = str(market.get("source_type") or "local").strip().lower() or "local"
    remote_url = str(market.get("remote_url") or "").strip()
    skills = market.get("skills") if isinstance(market.get("skills"), list) else []
    skills_with_source = sum(1 for s in skills if isinstance(s, dict) and (s.get("source_type") or source_type))
    skills_missing_source = sum(1 for s in skills if isinstance(s, dict) and not s.get("source_type") and source_type == "remote")
    report["checks"]["skills_market_source"] = {
        "source_type": source_type,
        "has_remote_url": bool(remote_url),
        "skills_count": len(skills),
        "skills_with_source_type": skills_with_source,
    }
    if source_type == "remote" and not remote_url:
        report["warnings"].append("skills_market source_type=remote 但未配置 remote_url")
    if source_type == "remote" and skills_missing_source:
        report["warnings"].append(f"skills_market 有 {skills_missing_source} 条技能在 remote 模式下缺少 source_type")

    # 可选：公有来源白名单（若存在则校验 remote_url 在名单内）
    whitelist_path = root / "backend" / "config" / "public_sources_whitelist.json"
    if whitelist_path.exists():
        try:
            wl = json.loads(whitelist_path.read_text(encoding="utf-8"))
            allowed = wl.get("allowed_urls") or wl.get("allowed_remote_urls") or []
            # 白名单匹配：startswith 表示前缀放行，in remote_url 表示子串放行（如 path 片段），按需收紧可改为仅 startswith
            if isinstance(allowed, list) and remote_url and source_type == "remote":
                if not any(remote_url.startswith(str(a).strip()) or str(a).strip() in remote_url for a in allowed if a):
                    report["warnings"].append("remote_url 不在 public_sources_whitelist 中")
            report["checks"]["public_sources_whitelist"] = {"present": True, "allowed_count": len(allowed)}
        except Exception:
            report["checks"]["public_sources_whitelist"] = {"present": True, "parse_error": True}
            report["warnings"].append("public_sources_whitelist 解析失败")
    else:
        report["checks"]["public_sources_whitelist"] = {"present": False}
        if source_type == "remote":
            report["warnings"].append("未配置 public_sources_whitelist（建议对 remote 来源做 URL 白名单）")

    # 2) 证据完整：ingestion manifest 每条有 ts
    manifest_path = root / "knowledge_base" / "learned" / "ingestion" / "workspace_upload_manifest.jsonl"
    manifest_ok = 0
    manifest_missing_ts = 0
    if manifest_path.exists():
        for raw in manifest_path.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = raw.strip()
            if not line:
                continue
            try:
                item = json.loads(line)
                if isinstance(item, dict) and item.get("ts"):
                    manifest_ok += 1
                else:
                    manifest_missing_ts += 1
            except Exception:
                manifest_missing_ts += 1
    report["checks"]["ingestion_manifest_evidence"] = {
        "manifest_path": str(manifest_path),
        "entries_with_ts": manifest_ok,
        "entries_missing_ts": manifest_missing_ts,
    }
    report["metrics"]["ingest_entries_with_ts"] = manifest_ok
    report["metrics"]["ingest_entries_missing_ts"] = manifest_missing_ts
    if manifest_missing_ts > 0:
        report["warnings"].append(f"ingestion manifest 有 {manifest_missing_ts} 条缺少 ts（capture 证据不完整）")

    # 3) 不读取 ontology 内容，仅确认知识链路快照存在且结构正确（可选，避免重复依赖）
    snap_path = root / "backend" / "data" / "knowledge_pipeline_snapshot.json"
    if snap_path.exists():
        snap = _read_json(snap_path)
        has_quad = all(isinstance(snap.get(k), dict) for k in ("ingest", "index", "search", "ontology"))
        report["checks"]["knowledge_pipeline_snapshot"] = {"present": True, "has_quadrants": has_quad}
        if not has_quad:
            report["warnings"].append("knowledge_pipeline_snapshot 缺少 ingest/index/search/ontology 四象限")
    else:
        report["checks"]["knowledge_pipeline_snapshot"] = {"present": False}
        report["warnings"].append("knowledge_pipeline_snapshot 缺失（不阻断，建议生成）")

    report["status"] = "warn" if report["warnings"] else "pass"
    out = _write_report(report_json, report)
    print("[knowledge-source-compliance] PASS" if report["status"] == "pass" else "[knowledge-source-compliance] WARN")
    print(f"- skills_market source_type: {source_type}")
    print(f"- ingestion entries_with_ts: {manifest_ok}, missing_ts: {manifest_missing_ts}")
    print(f"- report: {out}")
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="知识来源合规门禁（先 warn）")
    parser.add_argument(
        "--report-json",
        default="backend/data/knowledge_source_compliance_report.json",
        help="报告输出路径",
    )
    parser.add_argument("--project-root", default=None, type=Path, help="项目根目录")
    args = parser.parse_args()
    raise SystemExit(run(report_json=str(args.report_json or "backend/data/knowledge_source_compliance_report.json"), project_root=args.project_root))
