#!/usr/bin/env python3
"""
单体 Agent 可靠性 SLO 检查与快照落盘。

默认行为：输出告警但不阻断（exit 0）。
严格模式：--strict 时若不达标则 exit 1。
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Tuple

PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

DEFAULT_ENV_THRESHOLDS: Dict[str, Dict[str, float]] = {
    "dev": {
        "min_task_count": 10,
        "min_blocked_sample_count": 5,
        "min_success_rate": 0.35,
        "min_blocked_recovery_rate": 0.10,
        "min_deliverable_effective_rate": 0.10,
        "max_human_intervention_rate": 0.80,
    },
    "staging": {
        "min_task_count": 20,
        "min_blocked_sample_count": 15,
        "min_success_rate": 0.38,
        "min_blocked_recovery_rate": 0.14,
        "min_deliverable_effective_rate": 0.15,
        "max_human_intervention_rate": 0.60,
    },
    "production": {
        "min_task_count": 40,
        "min_blocked_sample_count": 50,
        "min_success_rate": 0.39,
        "min_blocked_recovery_rate": 0.15,
        "min_deliverable_effective_rate": 0.16,
        "max_human_intervention_rate": 0.50,
    },
}


def _f(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except Exception:
        return default


def _i(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except Exception:
        return default


def _append_jsonl(path: Path, row: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")


def _load_env_thresholds(path: Path) -> Dict[str, Dict[str, float]]:
    if not path.exists():
        return DEFAULT_ENV_THRESHOLDS
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return DEFAULT_ENV_THRESHOLDS
    if not isinstance(data, dict):
        return DEFAULT_ENV_THRESHOLDS
    merged: Dict[str, Dict[str, float]] = {}
    required = {
        "min_task_count",
        "min_blocked_sample_count",
        "min_success_rate",
        "min_blocked_recovery_rate",
        "min_deliverable_effective_rate",
        "max_human_intervention_rate",
    }
    for env, defaults in DEFAULT_ENV_THRESHOLDS.items():
        raw = data.get(env)
        if not isinstance(raw, dict):
            merged[env] = dict(defaults)
            continue
        next_row = dict(defaults)
        for key in required:
            if key in raw:
                next_row[key] = float(raw.get(key))
        merged[env] = next_row
    return merged


def _evaluate(metrics: Dict[str, Any], args: argparse.Namespace) -> Tuple[List[str], List[str]]:
    violations: List[str] = []
    notes: List[str] = []
    success_rate = _f(metrics.get("success_rate"))
    blocked_recovery_rate = _f(metrics.get("blocked_recovery_rate"))
    deliverable_effective_rate = _f(metrics.get("deliverable_effective_rate"))
    human_intervention_rate = _f(metrics.get("human_intervention_rate"))
    task_count = _i(metrics.get("task_count"))
    blocked_total = _i(metrics.get("blocked_total"))

    if task_count < args.min_task_count:
        violations.append(f"task_count={task_count} 低于最小样本 {args.min_task_count}")
    if success_rate < args.min_success_rate:
        violations.append(f"success_rate={success_rate:.4f} 低于阈值 {args.min_success_rate:.4f}")
    if blocked_total >= args.min_blocked_sample_count:
        if blocked_recovery_rate < args.min_blocked_recovery_rate:
            violations.append(
                f"blocked_recovery_rate={blocked_recovery_rate:.4f} 低于阈值 {args.min_blocked_recovery_rate:.4f}"
            )
    else:
        notes.append(
            f"blocked_total={blocked_total} 低于样本门槛 {args.min_blocked_sample_count}，跳过 blocked_recovery_rate 判定"
        )
    if deliverable_effective_rate < args.min_deliverable_effective_rate:
        violations.append(
            f"deliverable_effective_rate={deliverable_effective_rate:.4f} 低于阈值 {args.min_deliverable_effective_rate:.4f}"
        )
    if human_intervention_rate > args.max_human_intervention_rate:
        violations.append(
            f"human_intervention_rate={human_intervention_rate:.4f} 高于阈值 {args.max_human_intervention_rate:.4f}"
        )
    return violations, notes


def main() -> int:
    parser = argparse.ArgumentParser(description="单体 Agent 可靠性 SLO 检查")
    parser.add_argument("--env", choices=["dev", "staging", "production"], default="staging")
    parser.add_argument("--scope", default="personal")
    parser.add_argument("--window-hours", type=int, default=72)
    parser.add_argument("--min-task-count", type=int, default=None)
    parser.add_argument("--min-blocked-sample-count", type=int, default=None)
    parser.add_argument("--min-success-rate", type=float, default=None)
    parser.add_argument("--min-blocked-recovery-rate", type=float, default=None)
    parser.add_argument("--min-deliverable-effective-rate", type=float, default=None)
    parser.add_argument("--max-human-intervention-rate", type=float, default=None)
    parser.add_argument("--strict", action="store_true", help="不达标时返回 exit 1")
    parser.add_argument(
        "--history-jsonl",
        default="backend/data/reliability_slo_history.jsonl",
        help="SLO 历史快照输出路径（JSONL）",
    )
    parser.add_argument(
        "--thresholds-json",
        default="backend/config/reliability_slo_thresholds.json",
        help="环境阈值配置路径（默认: backend/config/reliability_slo_thresholds.json）",
    )
    parser.add_argument(
        "--minimal-lifespan",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="启用轻量生命周期模式（默认 true，减少脚本检查时的无关启动噪音）",
    )
    args = parser.parse_args()
    if args.minimal_lifespan:
        # 在导入 app 之前设置，确保生命周期按轻量模式启动。
        import os

        os.environ.setdefault("FASTAPI_LIFESPAN_MINIMAL", "true")

    from backend.api.app import board_reliability_metrics  # noqa: E402

    thresholds_path = Path(args.thresholds_json)
    if not thresholds_path.is_absolute():
        thresholds_path = PROJECT_ROOT / thresholds_path
    env_thresholds = _load_env_thresholds(thresholds_path)
    defaults = env_thresholds.get(args.env, env_thresholds.get("staging", DEFAULT_ENV_THRESHOLDS["staging"]))
    if args.min_task_count is None:
        args.min_task_count = int(defaults["min_task_count"])
    if args.min_blocked_sample_count is None:
        args.min_blocked_sample_count = int(defaults["min_blocked_sample_count"])
    if args.min_success_rate is None:
        args.min_success_rate = float(defaults["min_success_rate"])
    if args.min_blocked_recovery_rate is None:
        args.min_blocked_recovery_rate = float(defaults["min_blocked_recovery_rate"])
    if args.min_deliverable_effective_rate is None:
        args.min_deliverable_effective_rate = float(defaults["min_deliverable_effective_rate"])
    if args.max_human_intervention_rate is None:
        args.max_human_intervention_rate = float(defaults["max_human_intervention_rate"])

    body = asyncio.run(
        board_reliability_metrics(scope=args.scope, window_hours=int(args.window_hours))
    )
    if not isinstance(body, dict):
        print(f"❌ reliability 返回格式异常: {body}")
        return 2
    if not body.get("ok"):
        print(f"❌ reliability 接口返回失败: {body}")
        return 2

    metrics = body.get("metrics") if isinstance(body.get("metrics"), dict) else {}
    violations, notes = _evaluate(metrics, args)
    status = "pass" if not violations else ("fail" if args.strict else "warn")

    snapshot = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "env": args.env,
        "scope": args.scope,
        "window_hours": int(args.window_hours),
        "status": status,
        "strict": bool(args.strict),
        "thresholds": {
            "min_task_count": int(args.min_task_count),
            "min_blocked_sample_count": int(args.min_blocked_sample_count),
            "min_success_rate": float(args.min_success_rate),
            "min_blocked_recovery_rate": float(args.min_blocked_recovery_rate),
            "min_deliverable_effective_rate": float(args.min_deliverable_effective_rate),
            "max_human_intervention_rate": float(args.max_human_intervention_rate),
        },
        "metrics": metrics,
        "violations": violations,
        "notes": notes,
    }
    _append_jsonl(PROJECT_ROOT / args.history_jsonl, snapshot)

    print("=== Reliability SLO Check ===")
    print(f"env={args.env} scope={args.scope} window_hours={args.window_hours} strict={args.strict}")
    print(f"thresholds_file={thresholds_path.as_posix()}")
    print(f"metrics={json.dumps(metrics, ensure_ascii=False)}")
    if notes:
        print("notes:")
        for n in notes:
            print(f"- {n}")
    if violations:
        print("violations:")
        for v in violations:
            print(f"- {v}")
        if args.strict:
            print("\n❌ SLO 未达标（strict=true）")
            return 1
        print("\n⚠️ SLO 未达标（已记录告警，未阻断）")
        return 0

    print("\n✅ SLO 达标")
    return 0


if __name__ == "__main__":
    sys.exit(main())

