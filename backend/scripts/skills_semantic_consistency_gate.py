#!/usr/bin/env python3
"""
Skills 语义一致性门（Phase 1: 先 warn 后 block）：
1) /skills/market 可用且可选取样本
2) /skills/demo-run 输出结构完整
3) 关键语义约束：
   - metrics 中 skill 分不应低于 baseline
   - right 文本应包含“执行策略/风险控制”语义块
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

from fastapi.testclient import TestClient

PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.api.app import app  # noqa: E402


def _write_report(path: str, payload: Dict[str, Any]) -> str:
    out = Path(path)
    if not out.is_absolute():
        out = PROJECT_ROOT / out
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return out.as_posix()


def _fail(message: str) -> int:
    print(f"[skills-semantic:gate] FAIL: {message}")
    return 1


def run(report_json: str = "backend/data/skills_semantic_consistency_report.json") -> int:
    report: Dict[str, Any] = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "status": "fail",
        "checks": {},
        "metrics": {},
        "warnings": [],
    }
    client = TestClient(app)
    try:
        market_resp = client.get("/skills/market")
        report["checks"]["skills_market_api"] = {"status_code": market_resp.status_code}
        if market_resp.status_code != 200:
            _write_report(report_json, report)
            return _fail(f"/skills/market 返回异常: {market_resp.status_code}")

        market_body = market_resp.json() if isinstance(market_resp.json(), dict) else {}
        market_items = market_body.get("skills", []) if isinstance(market_body, dict) else []
        if not isinstance(market_items, list) or not market_items:
            report["status"] = "warn"
            report["warnings"].append("skills_market_empty_or_invalid")
            out = _write_report(report_json, report)
            print("[skills-semantic:gate] WARN: market 为空，跳过语义对比")
            print(f"- report: {out}")
            return 0

        checked = 0
        metric_rows = 0
        score_violation_count = 0
        text_violation_count = 0
        sampled: List[Dict[str, Any]] = []
        for item in market_items[:3]:
            if not isinstance(item, dict):
                continue
            market_id = str(item.get("id") or "").strip()
            if not market_id:
                continue
            checked += 1
            demo_resp = client.post(
                "/skills/demo-run",
                json={
                    "market_id": market_id,
                    "user_query": "请给出执行步骤、关键检查点和风险控制建议。",
                },
            )
            report["checks"][f"skills_demo_run_{checked}"] = {"status_code": demo_resp.status_code}
            if demo_resp.status_code != 200:
                _write_report(report_json, report)
                return _fail(f"/skills/demo-run[{market_id}] 返回异常: {demo_resp.status_code}")
            body = demo_resp.json() if isinstance(demo_resp.json(), dict) else {}
            if not bool(body.get("ok")):
                _write_report(report_json, report)
                return _fail(f"/skills/demo-run[{market_id}] 返回 ok=false")
            comparison = body.get("comparison") if isinstance(body.get("comparison"), dict) else {}
            metrics = comparison.get("metrics") if isinstance(comparison.get("metrics"), list) else []
            right_text = str(comparison.get("right") or "")
            if not metrics:
                _write_report(report_json, report)
                return _fail(f"/skills/demo-run[{market_id}] comparison.metrics 为空")

            for row in metrics:
                if not isinstance(row, dict):
                    continue
                baseline = int(row.get("baseline", 0) or 0)
                skill = int(row.get("skill", 0) or 0)
                metric_rows += 1
                if skill < baseline:
                    score_violation_count += 1
            if ("执行策略" not in right_text) or ("风险控制" not in right_text):
                text_violation_count += 1

            sampled.append(
                {
                    "market_id": market_id,
                    "title": str(comparison.get("title") or ""),
                    "metrics_count": len(metrics),
                }
            )

        if checked == 0:
            report["status"] = "warn"
            report["warnings"].append("no_valid_market_id_for_semantic_check")
            out = _write_report(report_json, report)
            print("[skills-semantic:gate] WARN: 无有效 market_id")
            print(f"- report: {out}")
            return 0

        if score_violation_count > 0:
            report["warnings"].append(f"metric_score_violations={score_violation_count}")
        if text_violation_count > 0:
            report["warnings"].append(f"text_semantic_violations={text_violation_count}")

        report["metrics"] = {
            "sampled_skills": checked,
            "metric_rows": metric_rows,
            "metric_score_violations": score_violation_count,
            "text_semantic_violations": text_violation_count,
            "sampled": sampled,
        }
        report["status"] = "warn" if report["warnings"] else "pass"
        out = _write_report(report_json, report)
        print("[skills-semantic:gate] PASS")
        print(f"- sampled_skills: {checked}")
        print(f"- report: {out}")
        return 0
    finally:
        client.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Skills 语义一致性门（先 warn）")
    parser.add_argument(
        "--report-json",
        default="backend/data/skills_semantic_consistency_report.json",
        help="报告输出路径（默认: backend/data/skills_semantic_consistency_report.json）",
    )
    args = parser.parse_args()
    raise SystemExit(run(report_json=str(args.report_json or "backend/data/skills_semantic_consistency_report.json")))

