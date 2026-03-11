#!/usr/bin/env python3
"""
发布门禁检查脚本（基于 regression_report.json）

用途：
1. 在 CI/CD 或本地发布前，快速判断是否达到发布门禁。
2. 支持最低通过率、最大失败项、允许状态集合等规则。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def _load_report(path: Path) -> dict:
    if not path.exists():
        raise FileNotFoundError(f"回归报告不存在: {path}")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        raise ValueError(f"回归报告不是合法 JSON: {e}") from e
    if not isinstance(data, dict):
        raise ValueError("回归报告格式错误：根节点应为 object")
    return data


def main() -> int:
    parser = argparse.ArgumentParser(description="发布门禁检查（基于回归 JSON 报告）")
    parser.add_argument(
        "--report",
        default="backend/data/regression_report.json",
        help="回归报告路径（默认: backend/data/regression_report.json）",
    )
    parser.add_argument(
        "--min-pass-rate",
        type=float,
        default=1.0,
        help="最低通过率阈值，默认 1.0",
    )
    parser.add_argument(
        "--max-failed-items",
        type=int,
        default=0,
        help="允许最大失败项数量，默认 0",
    )
    parser.add_argument(
        "--allow-status",
        nargs="+",
        default=["pass"],
        help="允许的 summary.status 列表，默认: pass",
    )
    args = parser.parse_args()

    report_path = Path(args.report)
    try:
        report = _load_report(report_path)
    except Exception as e:
        print(f"❌ 门禁失败：{e}")
        return 2

    summary = report.get("summary") if isinstance(report.get("summary"), dict) else {}
    status = str(summary.get("status", "")).strip().lower()
    pass_rate = float(summary.get("pass_rate", 0.0) or 0.0)
    failed_items = report.get("failed_items")
    if not isinstance(failed_items, list):
        failed_items = []

    violations = []
    if status not in {s.strip().lower() for s in args.allow_status}:
        violations.append(f"status={status!r} 不在允许集合 {args.allow_status}")
    if pass_rate < args.min_pass_rate:
        violations.append(f"pass_rate={pass_rate:.4f} 低于阈值 {args.min_pass_rate:.4f}")
    if len(failed_items) > args.max_failed_items:
        violations.append(f"failed_items={len(failed_items)} 超过阈值 {args.max_failed_items}")

    print("=== 发布门禁检查 ===")
    print(f"report: {report_path}")
    print(f"status: {status}")
    print(f"pass_rate: {pass_rate:.4f}")
    print(f"failed_items: {len(failed_items)}")
    if failed_items:
        print("failed_list:")
        for item in failed_items:
            print(f"- {item}")

    if violations:
        print("\n❌ 门禁未通过：")
        for v in violations:
            print(f"- {v}")
        return 1

    print("\n✅ 门禁通过：允许发布")
    return 0


if __name__ == "__main__":
    sys.exit(main())

