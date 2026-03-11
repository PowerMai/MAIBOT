#!/usr/bin/env python3
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
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _resolve(path_like: str) -> Path:
    p = Path(path_like)
    return p if p.is_absolute() else (PROJECT_ROOT / p)


def _score_by_status(status: str) -> float:
    s = str(status or "").strip().lower()
    if s == "pass":
        return 5.0
    if s == "warn":
        return 3.0
    if s == "fail":
        return 1.0
    return 2.0


def _clip(v: float, lo: float = 0.0, hi: float = 5.0) -> float:
    return max(lo, min(hi, float(v)))


def _dim(name: str, score: float, evidence: List[str], note: str) -> Dict[str, Any]:
    level = "aligned" if score >= 4.5 else ("partial" if score >= 3.0 else "gap")
    return {
        "name": name,
        "score_0_to_5": round(_clip(score), 2),
        "level": level,
        "note": note,
        "evidence": evidence,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Build Claude/Cowork/Cursor parity scorecard")
    parser.add_argument("--release-summary", default="backend/data/release_gate_summary.json")
    parser.add_argument("--business-acceptance", default="backend/data/business_acceptance_report.json")
    parser.add_argument("--plugins-report", default="backend/data/plugins_compat_smoke_report.json")
    parser.add_argument("--plugin-runtime-report", default="backend/data/plugin_runtime_compat_smoke_report.json")
    parser.add_argument("--skills-report", default="backend/data/skills_compat_smoke_report.json")
    parser.add_argument("--watcher-snapshot", default="backend/data/watcher_observability_snapshot.json")
    parser.add_argument("--release-postcheck", default="backend/data/release_postcheck_report.json")
    parser.add_argument("--output-json", default="backend/data/parity_scorecard.json")
    args = parser.parse_args()

    release_summary = _read_json(_resolve(args.release_summary))
    business = _read_json(_resolve(args.business_acceptance))
    plugins = _read_json(_resolve(args.plugins_report))
    plugin_runtime = _read_json(_resolve(args.plugin_runtime_report))
    skills = _read_json(_resolve(args.skills_report))
    watcher = _read_json(_resolve(args.watcher_snapshot))
    postcheck = _read_json(_resolve(args.release_postcheck))

    dimensions: List[Dict[str, Any]] = []

    # 1) 业务可跑通
    biz_ok = bool(business.get("ok", False))
    dod = business.get("definition_of_done") if isinstance(business.get("definition_of_done"), dict) else {}
    dod_all = all(bool(dod.get(k, False)) for k in ["functional", "exceptions", "performance", "consistency"])
    score_business = 5.0 if (biz_ok and dod_all) else (3.5 if biz_ok else 1.5)
    dimensions.append(
        _dim(
            "business_runthrough",
            score_business,
            [str(_resolve(args.business_acceptance).as_posix())],
            "业务验收脚本与 DoD 收口状态",
        )
    )

    # 2) 发布与稳定性门禁
    overall = str(release_summary.get("overall_status") or "").lower()
    profile = str(release_summary.get("profile_gate_status") or "").lower()
    score_release = 5.0 if overall == "pass" and profile == "pass" else (3.0 if profile == "pass" else 1.5)
    dimensions.append(
        _dim(
            "release_readiness",
            score_release,
            [str(_resolve(args.release_summary).as_posix()), str(_resolve(args.release_postcheck).as_posix())],
            "发布门禁与后置核查",
        )
    )

    # 3) 插件生态兼容
    score_plugins = (
        _score_by_status(plugins.get("status"))
        + _score_by_status(plugin_runtime.get("status"))
        + _score_by_status((release_summary.get("compatibility_matrix") or {}).get("checks", {}).get("plugins_compat"))
    ) / 3.0
    dimensions.append(
        _dim(
            "plugin_ecosystem_compat",
            score_plugins,
            [
                str(_resolve(args.plugins_report).as_posix()),
                str(_resolve(args.plugin_runtime_report).as_posix()),
            ],
            "插件 manifest/运行时可见性/链路一致性",
        )
    )

    # 4) Skills 行为一致性（v2）
    checks = skills.get("checks") if isinstance(skills.get("checks"), dict) else {}
    behavior_ok = (
        int(((checks.get("skills_demo_run_api") or {}).get("status_code", 0) or 0) == 200)
        and int(((checks.get("skills_trial_list_api") or {}).get("status_code", 0) or 0) == 200)
        and int(((checks.get("skills_validate_api") or {}).get("status_code", 0) or 0) == 200)
    )
    score_skills = 5.0 if skills.get("status") == "pass" and behavior_ok else (3.0 if skills.get("status") == "warn" else 1.5)
    dimensions.append(
        _dim(
            "skills_behavior_compat",
            score_skills,
            [str(_resolve(args.skills_report).as_posix())],
            "skills 列表 + validate + demo/trial 行为一致性",
        )
    )

    # 5) Watcher 可观测与恢复性
    wm = watcher.get("metrics") if isinstance(watcher.get("metrics"), dict) else {}
    search_calls = int(wm.get("search_calls", 0) or 0)
    fallback_ratio = float(wm.get("fallback_ratio", 0.0) or 0.0)
    loop_errors = int(wm.get("loop_errors", 0) or 0)
    if loop_errors == 0 and search_calls > 0 and fallback_ratio <= 0.30:
        score_watcher = 5.0
    elif loop_errors == 0 and search_calls == 0:
        score_watcher = 3.5  # 观测窗口样本不足
    else:
        score_watcher = 2.0
    dimensions.append(
        _dim(
            "watcher_resilience",
            score_watcher,
            [str(_resolve(args.watcher_snapshot).as_posix())],
            "watcher 主路径命中/fallback 比例/loop error",
        )
    )

    # 6) SLO 质量
    rel = (release_summary.get("evidence") or {}).get("reliability_slo") or {}
    snap = rel.get("snapshot") if isinstance(rel.get("snapshot"), dict) else {}
    metrics = snap.get("metrics") if isinstance(snap.get("metrics"), dict) else {}
    success = float(metrics.get("success_rate", 0.0) or 0.0)
    deliverable = float(metrics.get("deliverable_effective_rate", 0.0) or 0.0)
    human_rate = float(metrics.get("human_intervention_rate", 1.0) or 1.0)
    score_slo = _clip((success * 2.5) + (deliverable * 1.8) + (max(0.0, 1.0 - human_rate) * 0.7))
    dimensions.append(
        _dim(
            "reliability_slo_health",
            score_slo,
            [str(_resolve(args.release_summary).as_posix())],
            "成功率/有效交付率/人工干预率综合",
        )
    )

    overall_score_0_to_5 = sum(float(d["score_0_to_5"]) for d in dimensions) / max(1, len(dimensions))
    overall_score_100 = round(overall_score_0_to_5 * 20.0, 1)
    level = "aligned" if overall_score_100 >= 85 else ("partial" if overall_score_100 >= 70 else "gap")
    key_gaps = [d["name"] for d in dimensions if float(d["score_0_to_5"]) < 4.0]

    out = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "overall_score_100": overall_score_100,
        "overall_level": level,
        "dimensions": dimensions,
        "key_gaps": key_gaps,
        "summary": {
            "target": "claude_cowork_cursor_parity",
            "notes": "scorecard 用于趋势比较与发布评估，不替代人工架构评审",
        },
    }

    out_path = _resolve(args.output_json)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("parity scorecard built")
    print(f"- score: {overall_score_100}")
    print(f"- level: {level}")
    print(f"- output: {out_path.as_posix()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
