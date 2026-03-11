#!/usr/bin/env python3
"""
Skills 兼容性最小冒烟：
1) /skills/list 可用且返回非空
2) /skills/profiles 可用且包含 general
3) /skills/by-profile?profile_id=general 可用
4) API skills 数量与 SkillRegistry 一致（基础一致性）
5) /skills/validate 可用且 invalid_count=0（行为一致性基础门）
6) /skills/demo-run 与 /skills/trial（list）基础行为可用
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from fastapi.testclient import TestClient

PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.api.app import app  # noqa: E402
from backend.engine.skills.skill_registry import get_skill_registry  # noqa: E402


def _write_report(path: str, payload: dict) -> str:
    out = Path(path)
    if not out.is_absolute():
        out = PROJECT_ROOT / out
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return out.as_posix()


def _fail(message: str) -> int:
    print(f"[skills-compat:smoke] FAIL: {message}")
    return 1


def run(report_json: str = "backend/data/skills_compat_smoke_report.json") -> int:
    report: dict = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "status": "fail",
        "checks": {},
        "metrics": {},
        "warnings": [],
    }
    client = TestClient(app)
    try:
        list_resp = client.get("/skills/list")
        report["checks"]["skills_list_api"] = {"status_code": list_resp.status_code}
        if list_resp.status_code != 200:
            _write_report(report_json, report)
            return _fail(f"/skills/list 返回异常: {list_resp.status_code} {list_resp.text}")
        list_body = list_resp.json()
        api_skills = list_body.get("skills", []) if isinstance(list_body, dict) else []
        if not isinstance(api_skills, list) or len(api_skills) == 0:
            _write_report(report_json, report)
            return _fail("/skills/list 返回为空或结构异常")

        profiles_resp = client.get("/skills/profiles")
        report["checks"]["skills_profiles_api"] = {"status_code": profiles_resp.status_code}
        if profiles_resp.status_code != 200:
            _write_report(report_json, report)
            return _fail(f"/skills/profiles 返回异常: {profiles_resp.status_code} {profiles_resp.text}")
        profiles_body = profiles_resp.json()
        profiles = profiles_body.get("profiles", []) if isinstance(profiles_body, dict) else []
        profile_ids = {str((x or {}).get("id") or "").strip() for x in profiles if isinstance(x, dict)}
        if "general" not in profile_ids:
            _write_report(report_json, report)
            return _fail("skills profiles 缺少 general")

        by_profile_resp = client.get("/skills/by-profile", params={"profile_id": "general"})
        report["checks"]["skills_by_profile_api"] = {"status_code": by_profile_resp.status_code}
        if by_profile_resp.status_code != 200:
            _write_report(report_json, report)
            return _fail(f"/skills/by-profile 返回异常: {by_profile_resp.status_code} {by_profile_resp.text}")
        by_profile_body = by_profile_resp.json()
        profile_skills = by_profile_body.get("skills", []) if isinstance(by_profile_body, dict) else []
        if not isinstance(profile_skills, list):
            _write_report(report_json, report)
            return _fail("/skills/by-profile 返回结构异常")

        validate_resp = client.get("/skills/validate")
        report["checks"]["skills_validate_api"] = {"status_code": validate_resp.status_code}
        if validate_resp.status_code != 200:
            _write_report(report_json, report)
            return _fail(f"/skills/validate 返回异常: {validate_resp.status_code} {validate_resp.text}")
        validate_body = validate_resp.json() if isinstance(validate_resp.json(), dict) else {}
        if not bool(validate_body.get("ok", False)):
            _write_report(report_json, report)
            return _fail("/skills/validate 返回 ok=false")
        invalid_count = int(validate_body.get("invalid_count", 0) or 0)
        if invalid_count > 0:
            _write_report(report_json, report)
            return _fail(f"/skills/validate 检测到无效 skills: invalid_count={invalid_count}")

        market_resp = client.get("/skills/market")
        report["checks"]["skills_market_api"] = {"status_code": market_resp.status_code}
        if market_resp.status_code != 200:
            _write_report(report_json, report)
            return _fail(f"/skills/market 返回异常: {market_resp.status_code} {market_resp.text}")
        market_body = market_resp.json() if isinstance(market_resp.json(), dict) else {}
        market_items = market_body.get("skills", []) if isinstance(market_body, dict) else []
        if not isinstance(market_items, list):
            _write_report(report_json, report)
            return _fail("/skills/market 返回结构异常")
        market_demo_checked = False
        if market_items:
            first = market_items[0] if isinstance(market_items[0], dict) else {}
            market_id = str(first.get("id") or "").strip()
            if market_id:
                demo_resp = client.post(
                    "/skills/demo-run",
                    json={"market_id": market_id, "user_query": "请给出执行步骤与风险提示。"},
                )
                report["checks"]["skills_demo_run_api"] = {"status_code": demo_resp.status_code}
                if demo_resp.status_code != 200:
                    _write_report(report_json, report)
                    return _fail(f"/skills/demo-run 返回异常: {demo_resp.status_code} {demo_resp.text}")
                demo_body = demo_resp.json() if isinstance(demo_resp.json(), dict) else {}
                if not bool(demo_body.get("ok", False)):
                    _write_report(report_json, report)
                    return _fail("/skills/demo-run 返回 ok=false")
                comparison = demo_body.get("comparison") if isinstance(demo_body.get("comparison"), dict) else {}
                metrics = comparison.get("metrics") if isinstance(comparison.get("metrics"), list) else []
                if not metrics:
                    _write_report(report_json, report)
                    return _fail("/skills/demo-run comparison.metrics 为空")
                market_demo_checked = True
        if not market_demo_checked:
            report["warnings"].append("skills market 为空或缺少可用 id，已跳过 demo-run 行为检查")

        trial_list_resp = client.get("/skills/trial")
        report["checks"]["skills_trial_list_api"] = {"status_code": trial_list_resp.status_code}
        if trial_list_resp.status_code != 200:
            _write_report(report_json, report)
            return _fail(f"/skills/trial 返回异常: {trial_list_resp.status_code} {trial_list_resp.text}")
        trial_list_body = trial_list_resp.json() if isinstance(trial_list_resp.json(), dict) else {}
        limits = trial_list_body.get("limits") if isinstance(trial_list_body.get("limits"), dict) else {}
        if not bool(trial_list_body.get("ok", False)):
            _write_report(report_json, report)
            return _fail("/skills/trial 返回 ok=false")
        if not str(limits.get("window_days") or "").strip() or not str(limits.get("max_trials") or "").strip():
            _write_report(report_json, report)
            return _fail("/skills/trial limits 字段缺失")

        registry = get_skill_registry()
        registry.discover_skills(force_reload=True)
        reg_skills = registry.get_all_skills()
        reg_count = len(reg_skills)
        api_count = len(api_skills)
        if api_count != reg_count:
            _write_report(report_json, report)
            return _fail(f"API 与 registry skills 数量不一致: api={api_count}, registry={reg_count}")

        report["checks"]["registry_count_match"] = {"ok": True}
        report["status"] = "warn" if report["warnings"] else "pass"
        report["metrics"] = {
            "api_skills": api_count,
            "general_profile_skills": len(profile_skills),
            "profiles": len(profiles),
            "invalid_skills": invalid_count,
            "skills_market_items": len(market_items),
            "skills_trial_total": int(trial_list_body.get("total", 0) or 0),
            "skills_demo_run_checked": market_demo_checked,
        }
        report_path = _write_report(report_json, report)
        print("[skills-compat:smoke] PASS")
        print(f"- api_skills: {api_count}")
        print(f"- general_profile_skills: {len(profile_skills)}")
        print(f"- profiles: {len(profiles)}")
        print(f"- report: {report_path}")
        return 0
    finally:
        client.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Skills 兼容性最小冒烟")
    parser.add_argument(
        "--report-json",
        default="backend/data/skills_compat_smoke_report.json",
        help="报告输出路径（默认: backend/data/skills_compat_smoke_report.json）",
    )
    args = parser.parse_args()
    sys.exit(run(report_json=str(args.report_json or "backend/data/skills_compat_smoke_report.json")))
