#!/usr/bin/env python3
"""
SLO 阈值收紧守卫：
在提高某项阈值前，校验最近 N 次 strict 快照是否在目标阈值下仍达标。
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Tuple

PROJECT_ROOT = Path(__file__).resolve().parents[2]

THRESHOLD_TO_METRIC = {
    "min_task_count": "task_count",
    "min_success_rate": "success_rate",
    "min_blocked_recovery_rate": "blocked_recovery_rate",
    "min_deliverable_effective_rate": "deliverable_effective_rate",
    "max_human_intervention_rate": "human_intervention_rate",
}


def _load_json(path: Path) -> Dict[str, Any]:
    if not path.exists():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        return raw if isinstance(raw, dict) else {}
    except Exception:
        return {}


def _load_jsonl(path: Path) -> List[Dict[str, Any]]:
    if not path.exists():
        return []
    out: List[Dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
            if isinstance(row, dict):
                out.append(row)
        except Exception:
            continue
    return out


def _as_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except Exception:
        return default


def _is_metric_pass(metric_name: str, value: float, target: float) -> bool:
    if metric_name == "max_human_intervention_rate":
        return value <= target
    return value >= target


def _write_report(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="SLO 阈值收紧守卫")
    parser.add_argument("--env", default="production", choices=["dev", "staging", "production"])
    parser.add_argument(
        "--metric",
        default="min_blocked_recovery_rate",
        choices=sorted(THRESHOLD_TO_METRIC.keys()),
        help="要收紧的阈值项",
    )
    parser.add_argument("--target", type=float, required=True, help="目标阈值")
    parser.add_argument("--required-pass-runs", type=int, default=3, help="最近 strict 达标次数要求")
    parser.add_argument(
        "--thresholds-json",
        default="backend/config/reliability_slo_thresholds.json",
        help="阈值配置路径",
    )
    parser.add_argument(
        "--history-jsonl",
        default="backend/data/reliability_slo_history.jsonl",
        help="SLO 历史快照路径",
    )
    parser.add_argument(
        "--report-json",
        default="backend/data/slo_tightening_guard_report.json",
        help="守卫结果报告路径",
    )
    args = parser.parse_args()

    thresholds_path = Path(args.thresholds_json)
    if not thresholds_path.is_absolute():
        thresholds_path = PROJECT_ROOT / thresholds_path
    history_path = Path(args.history_jsonl)
    if not history_path.is_absolute():
        history_path = PROJECT_ROOT / history_path
    report_path = Path(args.report_json)
    if not report_path.is_absolute():
        report_path = PROJECT_ROOT / report_path

    thresholds = _load_json(thresholds_path)
    env_cfg = thresholds.get(args.env) if isinstance(thresholds, dict) else None
    report: Dict[str, Any] = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "status": "fail",
        "env": args.env,
        "metric": args.metric,
        "target": float(args.target),
        "required_pass_runs": int(args.required_pass_runs),
        "thresholds_file": thresholds_path.as_posix(),
        "history_file": history_path.as_posix(),
        "current": None,
        "failures": [],
    }
    if not isinstance(env_cfg, dict):
        print(f"❌ 未找到阈值环境配置: env={args.env} file={thresholds_path.as_posix()}")
        report["error"] = "env_thresholds_missing"
        _write_report(report_path, report)
        return 2

    current = _as_float(env_cfg.get(args.metric))
    report["current"] = current
    target = float(args.target)
    if args.metric.startswith("min_"):
        if target <= current:
            print(f"❌ 目标阈值未收紧: current={current:.4f} target={target:.4f}")
            report["error"] = "target_not_tighter"
            _write_report(report_path, report)
            return 1
    else:
        if target >= current:
            print(f"❌ 目标阈值未收紧: current={current:.4f} target={target:.4f}")
            report["error"] = "target_not_tighter"
            _write_report(report_path, report)
            return 1

    metric_field = THRESHOLD_TO_METRIC[args.metric]
    rows = _load_jsonl(history_path)
    strict_rows = [r for r in rows if str(r.get("env") or "") == args.env and bool(r.get("strict"))]
    recent = strict_rows[-max(1, int(args.required_pass_runs)) :]
    if len(recent) < int(args.required_pass_runs):
        print(
            f"❌ strict 快照不足: need={args.required_pass_runs} have={len(recent)} env={args.env} file={history_path.as_posix()}"
        )
        report["error"] = "insufficient_strict_samples"
        report["observed_runs"] = len(recent)
        _write_report(report_path, report)
        return 1

    failures: List[Tuple[int, float, str]] = []
    for idx, row in enumerate(recent, start=1):
        status = str(row.get("status") or "").lower()
        metrics = row.get("metrics") if isinstance(row.get("metrics"), dict) else {}
        value = _as_float(metrics.get(metric_field))
        ok = status == "pass" and _is_metric_pass(args.metric, value, target)
        if not ok:
            failures.append((idx, value, status))

    print("=== SLO Tightening Guard ===")
    print(f"env={args.env} metric={args.metric} current={current:.4f} target={target:.4f}")
    print(f"required_pass_runs={args.required_pass_runs} history={history_path.as_posix()}")
    report["observed_runs"] = len(recent)

    if failures:
        print("❌ 未通过收紧守卫：")
        for idx, value, status in failures:
            print(f"- recent#{idx}: status={status or 'unknown'} {metric_field}={value:.4f}")
            report["failures"].append(
                {
                    "recent_index": idx,
                    "status": status or "unknown",
                    metric_field: value,
                }
            )
        _write_report(report_path, report)
        return 1

    print("✅ 收紧守卫通过：最近 strict 快照在目标阈值下持续达标")
    report["status"] = "pass"
    _write_report(report_path, report)
    return 0


if __name__ == "__main__":
    sys.exit(main())
