#!/usr/bin/env python3
"""
发布后置核查：
- 读取 release_gate_summary / release_drill_report / slo_tightening_guard
- 输出 PASS/WARN/FAIL 结论与机器可读报告
"""

from __future__ import annotations

import argparse
import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

try:
    from backend.scripts.release_drill_steps_utils import collect_required_step_failures
except Exception:  # pragma: no cover - fallback for direct script execution
    from release_drill_steps_utils import collect_required_step_failures


PROJECT_ROOT = Path(__file__).resolve().parents[2]


def _read_json(path: Path) -> Dict[str, Any]:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _read_text(path: Path) -> str:
    if not path.exists():
        return ""
    try:
        return path.read_text(encoding="utf-8")
    except Exception:
        return ""


def _required_step_failures(drill_steps: Dict[str, Any]) -> List[str]:
    rows = collect_required_step_failures(drill_steps)
    return [
        f"required step failed: {row.get('name', 'unknown_step')} "
        f"(status={row.get('status', 'unknown')}, rc={row.get('rc', 'n/a')})"
        for row in rows
    ]


def _resolve_path(raw: str) -> Path:
    p = Path(raw)
    return p if p.is_absolute() else (PROJECT_ROOT / p)


def _to_float(value: Any) -> float | None:
    try:
        num = float(value)
        return num if math.isfinite(num) else None
    except Exception:
        return None


def _to_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except Exception:
        return int(default)


def _classify_margin(delta: float | None, near_threshold: float = 0.01) -> str:
    if delta is None:
        return "unknown"
    if delta < 0:
        return "below-threshold"
    if delta < near_threshold:
        return "near-threshold"
    return "healthy"


def _build_margin_section(summary: Dict[str, Any]) -> Dict[str, Any]:
    evidence = summary.get("evidence") if isinstance(summary.get("evidence"), dict) else {}
    reliability = (
        evidence.get("reliability_slo") if isinstance(evidence.get("reliability_slo"), dict) else {}
    )
    snapshot = reliability.get("snapshot") if isinstance(reliability.get("snapshot"), dict) else {}
    metrics = snapshot.get("metrics") if isinstance(snapshot.get("metrics"), dict) else {}
    thresholds = snapshot.get("thresholds") if isinstance(snapshot.get("thresholds"), dict) else {}
    pairs = {
        "success_rate": ("success_rate", "min_success_rate"),
        "blocked_recovery_rate": ("blocked_recovery_rate", "min_blocked_recovery_rate"),
        "deliverable_effective_rate": ("deliverable_effective_rate", "min_deliverable_effective_rate"),
    }
    out: Dict[str, Any] = {}
    for key, (metric_key, threshold_key) in pairs.items():
        metric_val = _to_float(metrics.get(metric_key))
        threshold_val = _to_float(thresholds.get(threshold_key))
        delta = None if metric_val is None or threshold_val is None else (metric_val - threshold_val)
        out[key] = {
            "metric": metric_val,
            "threshold": threshold_val,
            "delta": delta,
            "margin": _classify_margin(delta),
        }
    return out


def _extract_plugin_manifest_hygiene(summary: Dict[str, Any]) -> Dict[str, Any]:
    evidence = summary.get("evidence") if isinstance(summary.get("evidence"), dict) else {}
    hygiene = (
        evidence.get("plugin_manifest_hygiene")
        if isinstance(evidence.get("plugin_manifest_hygiene"), dict)
        else {}
    )
    status = str(hygiene.get("status") or "").strip().lower() or "missing"
    warnings_count = _to_int(hygiene.get("warnings_count"), 0)
    errors_count = _to_int(hygiene.get("errors_count"), 0)
    return {
        "status": status,
        "warnings_count": max(0, warnings_count),
        "errors_count": max(0, errors_count),
        "exists": bool(hygiene),
    }


def _extract_task_execution_reliability_e2e(summary: Dict[str, Any]) -> Dict[str, Any]:
    evidence = summary.get("evidence") if isinstance(summary.get("evidence"), dict) else {}
    e2e = (
        evidence.get("task_execution_reliability_e2e")
        if isinstance(evidence.get("task_execution_reliability_e2e"), dict)
        else {}
    )
    status = str(e2e.get("status") or "").strip().lower() or "missing"
    return {
        "status": status,
        "exists": bool(e2e),
        "source": str(e2e.get("source") or ""),
    }


def _extract_knowledge_source_compliance(summary: Dict[str, Any]) -> Dict[str, Any]:
    evidence = summary.get("evidence") if isinstance(summary.get("evidence"), dict) else {}
    ksc = (
        evidence.get("knowledge_source_compliance")
        if isinstance(evidence.get("knowledge_source_compliance"), dict)
        else {}
    )
    status = str(ksc.get("status") or "").strip().lower() or "missing"
    return {
        "status": status,
        "exists": bool(ksc),
        "source": str(ksc.get("source") or ""),
    }


def _extract_plugin_command_conflicts(summary: Dict[str, Any]) -> Dict[str, Any]:
    evidence = summary.get("evidence") if isinstance(summary.get("evidence"), dict) else {}
    pcc = (
        evidence.get("plugin_command_conflicts")
        if isinstance(evidence.get("plugin_command_conflicts"), dict)
        else {}
    )
    status = str(pcc.get("status") or "").strip().lower() or "missing"
    return {
        "status": status,
        "exists": bool(pcc),
        "source": str(pcc.get("source") or ""),
    }


def _manifest_hygiene_status(warnings_count: int, errors_count: int) -> str:
    if int(errors_count or 0) > 0:
        return "fail"
    if int(warnings_count or 0) > 0:
        return "warn"
    return "pass"


def _summary_blocking_failures(summary: Dict[str, Any]) -> List[str]:
    if not summary:
        return ["release_gate_summary 缺失或不可读"]
    failures: List[str] = []
    overall = str(summary.get("overall_status") or "").strip().lower()
    profile_gate = str(summary.get("profile_gate_status") or "").strip().lower()
    if overall != "pass":
        failures.append(f"overall_status 非 pass: {overall or 'unknown'}")
    if profile_gate != "pass":
        failures.append(f"profile_gate_status 非 pass: {profile_gate or 'unknown'}")
    return failures


def _drill_report_hint_warnings(drill_text: str) -> List[str]:
    # Markdown 仅作为人读提示，不参与结构化阻断判定。
    if not drill_text:
        return ["release_drill_report 缺失（不阻断）"]
    warnings: List[str] = []
    if "`profile_gate_status`：`pass`" not in drill_text:
        warnings.append("release_drill_report 未显示 profile_gate_status=pass（可能未刷新）")
    if "slo_tightening_guard(non-blocking)" not in drill_text:
        warnings.append("release_drill_report 未包含 slo_tightening_guard(non-blocking) 项（建议刷新）")
    if "plugin_manifest_hygiene(non-blocking)" not in drill_text:
        warnings.append("release_drill_report 未包含 plugin_manifest_hygiene(non-blocking) 项（建议刷新）")
    if "plugin_command_conflicts(non-blocking)" not in drill_text:
        warnings.append("release_drill_report 未包含 plugin_command_conflicts(non-blocking) 项（建议刷新）")
    if "knowledge_source_compliance(non-blocking)" not in drill_text:
        warnings.append("release_drill_report 未包含 knowledge_source_compliance(non-blocking) 项（建议刷新）")
    return warnings


def main() -> int:
    parser = argparse.ArgumentParser(description="发布后置核查（PASS/WARN/FAIL）")
    parser.add_argument(
        "--summary-json",
        default="backend/data/release_gate_summary.json",
        help="release gate 摘要路径",
    )
    parser.add_argument(
        "--tightening-guard-json",
        default="backend/data/slo_tightening_guard_report.json",
        help="SLO 收紧守卫报告路径",
    )
    parser.add_argument(
        "--drill-report-md",
        default=f"docs/release_drill_report_{datetime.now(timezone.utc).strftime('%Y-%m-%d')}.md",
        help="发布演练 markdown 路径",
    )
    parser.add_argument(
        "--drill-steps-json",
        default="backend/data/release_drill_steps.json",
        help="发布演练步骤明细 JSON 路径（优先于 markdown 用于机器校验）",
    )
    parser.add_argument(
        "--output-json",
        default="backend/data/release_postcheck_report.json",
        help="后置核查报告输出路径",
    )
    parser.add_argument(
        "--parity-scorecard-json",
        default="backend/data/parity_scorecard.json",
        help="对标评分卡路径（可选）",
    )
    parser.add_argument(
        "--parity-trend-json",
        default="backend/data/parity_trend_report.json",
        help="对标趋势报告路径（可选）",
    )
    parser.add_argument(
        "--ui-stream-metrics-json",
        default="backend/data/ui_stream_metrics_snapshot.json",
        help="UI 流式指标快照路径（可选）",
    )
    parser.add_argument(
        "--memory-scope-contract-json",
        default="backend/data/memory_scope_contract_report.json",
        help="记忆作用域契约报告路径（可选）",
    )
    parser.add_argument(
        "--memory-quality-json",
        default="backend/data/memory_quality_report.json",
        help="记忆质量报告路径（可选）",
    )
    parser.add_argument(
        "--memory-quality-trend-json",
        default="backend/data/memory_quality_trend_report.json",
        help="记忆质量趋势报告路径（可选）",
    )
    args = parser.parse_args()

    summary_path = _resolve_path(args.summary_json)
    guard_path = _resolve_path(args.tightening_guard_json)
    drill_path = _resolve_path(args.drill_report_md)
    drill_steps_path = _resolve_path(args.drill_steps_json)
    output_path = _resolve_path(args.output_json)
    parity_path = _resolve_path(args.parity_scorecard_json)
    parity_trend_path = _resolve_path(args.parity_trend_json)
    ui_metrics_path = _resolve_path(args.ui_stream_metrics_json)
    memory_scope_path = _resolve_path(args.memory_scope_contract_json)
    memory_quality_path = _resolve_path(args.memory_quality_json)
    memory_quality_trend_path = _resolve_path(args.memory_quality_trend_json)

    summary = _read_json(summary_path)
    guard = _read_json(guard_path)
    drill_text = _read_text(drill_path)
    drill_steps = _read_json(drill_steps_path)
    ui_metrics_doc = _read_json(ui_metrics_path)
    parity_doc = _read_json(parity_path)
    parity_trend_doc = _read_json(parity_trend_path)
    memory_scope_doc = _read_json(memory_scope_path)
    memory_quality_doc = _read_json(memory_quality_path)
    memory_quality_trend_doc = _read_json(memory_quality_trend_path)
    ui_metrics = ui_metrics_doc.get("metrics") if isinstance(ui_metrics_doc.get("metrics"), dict) else {}
    ui_sample_count = _to_int(ui_metrics.get("sample_count"), 0)

    failures: List[str] = []
    warnings: List[str] = []

    failures.extend(_summary_blocking_failures(summary))
    overall = str(summary.get("overall_status") or "").strip().lower()
    profile_gate = str(summary.get("profile_gate_status") or "").strip().lower()
    plugin_manifest_hygiene = _extract_plugin_manifest_hygiene(summary)
    task_execution_reliability_e2e = _extract_task_execution_reliability_e2e(summary)
    knowledge_source_compliance = _extract_knowledge_source_compliance(summary)
    plugin_command_conflicts = _extract_plugin_command_conflicts(summary)

    guard_status = str(guard.get("status") or "").strip().lower()
    if not guard:
        warnings.append("slo_tightening_guard 报告缺失（不阻断）")
    elif guard_status != "pass":
        warnings.append(f"slo_tightening_guard={guard_status or 'unknown'}（不阻断，表示暂不建议继续收紧阈值）")

    warnings.extend(_drill_report_hint_warnings(drill_text))
    required_step_fail_count = len(_required_step_failures(drill_steps if isinstance(drill_steps, dict) else {}))
    if not drill_steps:
        warnings.append("release_drill_steps 缺失或不可读（不阻断，建议补齐结构化演练明细）")
    else:
        failures.extend(_required_step_failures(drill_steps))
    margins = _build_margin_section(summary)
    margin_levels = [str((row or {}).get("margin") or "unknown") for row in margins.values() if isinstance(row, dict)]
    if "below-threshold" in margin_levels:
        warnings.append("reliability margin 存在 below-threshold（建议优先处理边界风险）")
    elif "near-threshold" in margin_levels:
        warnings.append("reliability margin 存在 near-threshold（建议观察收敛后再收紧阈值）")
    ui_gap_p95 = _to_float(ui_metrics.get("max_inter_token_gap_ms_p95"))
    ui_fallback_p95 = _to_float(ui_metrics.get("message_channel_fallback_count_p95"))
    ui_partial_suppressed_p95 = _to_float(ui_metrics.get("partial_suppressed_count_p95"))
    if ui_metrics_doc and ui_sample_count >= 10 and ui_gap_p95 is not None and ui_gap_p95 > 1500:
        warnings.append(
            f"UI 流式间隔抖动偏高: max_inter_token_gap_ms_p95={ui_gap_p95:.0f}ms（建议排查前端消费节流/后端批量窗口）"
        )
    if ui_metrics_doc and ui_sample_count >= 10 and ui_fallback_p95 is not None and ui_fallback_p95 >= 1:
        warnings.append(
            f"UI 主通道回退偏高: message_channel_fallback_count_p95={ui_fallback_p95:.2f}（建议排查 custom 通道连续性）"
        )
    if ui_metrics_doc and ui_sample_count >= 10 and ui_partial_suppressed_p95 is not None and ui_partial_suppressed_p95 > 30:
        warnings.append(
            f"UI partial 抑制偏高: partial_suppressed_count_p95={ui_partial_suppressed_p95:.0f}（建议排查去重阈值是否过严）"
        )
    if ui_metrics_doc and ui_sample_count < 10:
        warnings.append(f"UI 流式样本量不足: sample_count={ui_sample_count}（建议至少采集 10 条再看 p95）")
    parity_score = _to_float(parity_doc.get("overall_score_100")) if parity_doc else None
    if parity_doc and parity_score is not None and parity_score < 80:
        warnings.append(f"parity_scorecard 偏低: overall_score_100={parity_score:.1f}（建议优先收敛 key_gaps）")
    elif not parity_doc:
        warnings.append("parity_scorecard 缺失（不阻断，建议生成用于趋势跟踪）")
    parity_regression = (
        (parity_trend_doc.get("regression") or {}).get("detected")
        if isinstance(parity_trend_doc.get("regression"), dict)
        else None
    )
    if parity_trend_doc and bool(parity_regression):
        warnings.append("parity_trend 检测到回退（建议检查 dimension_regressions 并回滚风险变更）")
    elif not parity_trend_doc:
        warnings.append("parity_trend_report 缺失（不阻断，建议用于回退预警）")
    memory_scope_status = str(memory_scope_doc.get("status") or "missing")
    if not memory_scope_doc:
        warnings.append("memory_scope_contract_report 缺失（不阻断，建议用于记忆隔离一致性巡检）")
    elif memory_scope_status != "pass":
        warnings.append(f"memory_scope_contract={memory_scope_status}（不阻断，建议先收敛 failed_checks）")
    memory_quality_status = str(memory_quality_doc.get("status") or "missing")
    if not memory_quality_doc:
        warnings.append("memory_quality_report 缺失（不阻断，建议用于跨会话命中/误召回质量监控）")
    elif memory_quality_status != "pass":
        warnings.append(f"memory_quality={memory_quality_status}（不阻断，建议关注 warnings 阈值越线）")
    memory_quality_trend_regression = (
        (memory_quality_trend_doc.get("regression") or {}).get("detected")
        if isinstance(memory_quality_trend_doc.get("regression"), dict)
        else None
    )
    if not memory_quality_trend_doc:
        warnings.append("memory_quality_trend_report 缺失（不阻断，建议用于记忆质量回退预警）")
    elif bool(memory_quality_trend_regression):
        warnings.append("memory_quality_trend 检测到回退（不阻断，建议排查 quality delta）")
    hygiene_exists = bool(plugin_manifest_hygiene.get("exists"))
    hygiene_status = str(plugin_manifest_hygiene.get("status") or "missing")
    hygiene_warnings = _to_int(plugin_manifest_hygiene.get("warnings_count"), 0)
    hygiene_errors = _to_int(plugin_manifest_hygiene.get("errors_count"), 0)
    if not hygiene_exists:
        warnings.append("plugin_manifest_hygiene 缺失（不阻断，可能 release_gate_summary 未刷新）")
    else:
        if hygiene_errors > 0:
            warnings.append(
                f"plugin_manifest_hygiene errors_count={hygiene_errors}（不阻断，建议优先修复已安装插件 manifest 错误）"
            )
        if hygiene_warnings > 0:
            warnings.append(
                f"plugin_manifest_hygiene warnings_count={hygiene_warnings}（不阻断，建议收敛已安装插件 manifest 告警）"
            )
        expected_status = _manifest_hygiene_status(hygiene_warnings, hygiene_errors)
        if hygiene_status not in {"missing", expected_status}:
            warnings.append(
                f"plugin_manifest_hygiene 状态与计数不一致: status={hygiene_status}, expected={expected_status}（不阻断，建议刷新汇总）"
            )
    e2e_exists = bool(task_execution_reliability_e2e.get("exists"))
    e2e_status = str(task_execution_reliability_e2e.get("status") or "missing")
    if not e2e_exists:
        warnings.append("task_execution_reliability_e2e 证据缺失（不阻断，建议补跑可靠性 E2E）")
    elif e2e_status != "pass":
        warnings.append(
            f"task_execution_reliability_e2e={e2e_status}（不阻断，建议优先修复“恢复/去重/隔离”回归）"
        )
    ksc_exists = bool(knowledge_source_compliance.get("exists"))
    ksc_status = str(knowledge_source_compliance.get("status") or "missing")
    if not ksc_exists:
        warnings.append("knowledge_source_compliance 证据缺失（不阻断，建议补跑知识来源合规门）")
    elif ksc_status != "pass":
        warnings.append(f"knowledge_source_compliance={ksc_status}（不阻断，建议收敛公有来源/证据完整性）")
    pcc_exists = bool(plugin_command_conflicts.get("exists"))
    pcc_status = str(plugin_command_conflicts.get("status") or "missing")
    if not pcc_exists:
        warnings.append("plugin_command_conflicts 证据缺失（不阻断，建议补跑插件命令冲突门）")
    elif pcc_status != "pass":
        warnings.append(f"plugin_command_conflicts={pcc_status}（不阻断，建议收敛同名命令冲突）")

    status = "fail" if failures else ("warn" if warnings else "pass")
    report = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "status": status,
        "summary": {
            "path": summary_path.as_posix(),
            "overall_status": overall or "missing",
            "profile_gate_status": profile_gate or "missing",
        },
        "slo_tightening_guard": {
            "path": guard_path.as_posix(),
            "status": guard_status or "missing",
        },
        "plugin_manifest_hygiene": {
            "source": summary_path.as_posix(),
            "status": str(plugin_manifest_hygiene.get("status") or "missing"),
            "warnings_count": hygiene_warnings,
            "errors_count": hygiene_errors,
            "blocking": False,
        },
        "task_execution_reliability_e2e": {
            "source": str(task_execution_reliability_e2e.get("source") or ""),
            "status": e2e_status,
            "exists": e2e_exists,
            "blocking": False,
        },
        "plugin_command_conflicts": {
            "source": str(plugin_command_conflicts.get("source") or ""),
            "status": pcc_status,
            "exists": pcc_exists,
            "blocking": False,
        },
        "knowledge_source_compliance": {
            "source": str(knowledge_source_compliance.get("source") or ""),
            "status": ksc_status,
            "exists": ksc_exists,
            "blocking": False,
        },
        "margins": margins,
        "drill_report": {
            "path": drill_path.as_posix(),
            "exists": bool(drill_text),
        },
        "drill_steps": {
            "path": drill_steps_path.as_posix(),
            "exists": bool(drill_steps),
            "required_step_fail_count": required_step_fail_count,
        },
        "ui_stream_metrics": {
            "path": ui_metrics_path.as_posix(),
            "exists": bool(ui_metrics_doc),
            "sample_count": ui_sample_count,
            "max_inter_token_gap_ms_p95": ui_gap_p95,
            "message_channel_fallback_count_p95": ui_fallback_p95,
            "partial_suppressed_count_p95": ui_partial_suppressed_p95,
        },
        "parity_scorecard": {
            "path": parity_path.as_posix(),
            "exists": bool(parity_doc),
            "overall_score_100": parity_score,
            "overall_level": parity_doc.get("overall_level") if parity_doc else None,
            "key_gaps": parity_doc.get("key_gaps", []) if isinstance(parity_doc.get("key_gaps"), list) else [],
        },
        "parity_trend": {
            "path": parity_trend_path.as_posix(),
            "exists": bool(parity_trend_doc),
            "status": parity_trend_doc.get("status") if parity_trend_doc else None,
            "score_delta": (
                (parity_trend_doc.get("delta") or {}).get("overall_score_100")
                if isinstance(parity_trend_doc.get("delta"), dict)
                else None
            ),
            "regression_detected": bool(parity_regression) if parity_trend_doc else None,
        },
        "memory_scope_contract": {
            "path": memory_scope_path.as_posix(),
            "exists": bool(memory_scope_doc),
            "status": memory_scope_status if memory_scope_doc else None,
            "failed_checks": memory_scope_doc.get("failed_checks", []) if memory_scope_doc else [],
        },
        "memory_quality": {
            "path": memory_quality_path.as_posix(),
            "exists": bool(memory_quality_doc),
            "status": memory_quality_status if memory_quality_doc else None,
            "warnings": memory_quality_doc.get("warnings", []) if memory_quality_doc else [],
            "metrics": memory_quality_doc.get("metrics", {}) if memory_quality_doc else {},
        },
        "memory_quality_trend": {
            "path": memory_quality_trend_path.as_posix(),
            "exists": bool(memory_quality_trend_doc),
            "status": memory_quality_trend_doc.get("status") if memory_quality_trend_doc else None,
            "regression_detected": bool(memory_quality_trend_regression) if memory_quality_trend_doc else None,
            "delta": memory_quality_trend_doc.get("delta", {}) if memory_quality_trend_doc else {},
        },
        "failures": failures,
        "warnings": warnings,
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print("=== Release Postcheck ===")
    print(f"status={status}")
    print(f"report={output_path.as_posix()}")
    if failures:
        print("failures:")
        for item in failures:
            print(f"- {item}")
    if warnings:
        print("warnings:")
        for item in warnings:
            print(f"- {item}")

    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
