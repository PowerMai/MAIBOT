#!/usr/bin/env python3
from __future__ import annotations

import argparse
import ast
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    from backend.scripts.release_drill_steps_utils import collect_required_step_failures
except Exception:  # pragma: no cover
    from release_drill_steps_utils import collect_required_step_failures


PROJECT_ROOT = Path(__file__).resolve().parents[2]
_RELEASE_PROFILE = "staging"

# 供 CI 摘要展示：收集失败/警告，最后写入 GITHUB_STEP_SUMMARY 或 stdout 段
_ci_gate_failures: list[str] = []
_ci_gate_warnings: list[str] = []


def _fail(msg: str) -> int:
    _ci_gate_failures.append(msg)
    print(f"[ci-release-gates] FAIL: {msg}")
    return 1


def _ok(msg: str) -> None:
    print(f"[ci-release-gates] OK: {msg}")


def _write_ci_summary(result: str, details: list[str]) -> None:
    """写入 CI 摘要：GITHUB_STEP_SUMMARY 存在时追加 Markdown，否则打印可解析段。"""
    lines = ["## Release Gates", f"**Result:** {result}"]
    if details:
        lines.append("**Details:**")
        for d in details:
            lines.append(f"- {d}")
    block = "\n".join(lines) + "\n"
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        try:
            with open(summary_path, "a", encoding="utf-8") as f:
                f.write(block)
        except Exception as e:
            print(f"[ci-release-gates] 写入 CI 摘要失败: {e}", file=sys.stderr)
    else:
        print("[ci-release-gates] --- CI_RELEASE_GATES_SUMMARY ---")
        print(block.strip())
        print("[ci-release-gates] --- END ---")


def _parse_iso_datetime(value: str | None) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except Exception:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _check_artifact_freshness(max_age_minutes: int) -> int:
    checks = [
        ("release_gate_summary", PROJECT_ROOT / "backend" / "data" / "release_gate_summary.json", "generated_at"),
        ("unified_observability_snapshot", PROJECT_ROOT / "backend" / "data" / "unified_observability_snapshot.json", "generated_at"),
        ("knowledge_pipeline_snapshot", PROJECT_ROOT / "backend" / "data" / "knowledge_pipeline_snapshot.json", "generated_at"),
        ("release_postcheck_report", PROJECT_ROOT / "backend" / "data" / "release_postcheck_report.json", "timestamp"),
        ("parity_scorecard", PROJECT_ROOT / "backend" / "data" / "parity_scorecard.json", "generated_at"),
        ("parity_trend_report", PROJECT_ROOT / "backend" / "data" / "parity_trend_report.json", "generated_at"),
        ("plugin_command_conflicts_report", PROJECT_ROOT / "backend" / "data" / "plugin_command_conflicts_report.json", "generated_at"),
        ("knowledge_source_compliance_report", PROJECT_ROOT / "backend" / "data" / "knowledge_source_compliance_report.json", "generated_at"),
        ("memory_scope_contract_report", PROJECT_ROOT / "backend" / "data" / "memory_scope_contract_report.json", "generated_at"),
        ("memory_quality_report", PROJECT_ROOT / "backend" / "data" / "memory_quality_report.json", "generated_at"),
        ("memory_quality_trend_report", PROJECT_ROOT / "backend" / "data" / "memory_quality_trend_report.json", "generated_at"),
        ("policy_decision_report", PROJECT_ROOT / "backend" / "data" / "policy_decision_report.json", "generated_at"),
    ]
    stale: list[str] = []
    now = datetime.now(timezone.utc)
    for name, path, ts_key in checks:
        if not path.exists():
            stale.append(f"{name}: missing file")
            continue
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception as e:
            stale.append(f"{name}: parse error ({e})")
            continue
        if not isinstance(payload, dict):
            stale.append(f"{name}: invalid payload type")
            continue
        ts = _parse_iso_datetime(str(payload.get(ts_key) or ""))
        if ts is None:
            stale.append(f"{name}: missing/invalid `{ts_key}`")
            continue
        age_minutes = (now - ts).total_seconds() / 60.0
        if age_minutes > float(max_age_minutes):
            stale.append(f"{name}: stale ({age_minutes:.1f}m > {max_age_minutes}m)")
    if stale:
        return _fail(f"产物新鲜度检查失败: {stale}")
    _ok(f"产物新鲜度检查通过（<= {max_age_minutes} 分钟）")
    return 0


def _check_compat_matrix() -> int:
    matrix_path = PROJECT_ROOT / "docs" / "ecosystem_compatibility_matrix_2026-03-02.md"
    if not matrix_path.exists():
        return _fail(f"缺少兼容矩阵文档: {matrix_path}")
    text = matrix_path.read_text(encoding="utf-8", errors="ignore")
    required_tokens = [
        "plugin_runtime_compat",
        "plugins_compat",
        "plugin_command_conflicts",
        "knowledge_source_compliance",
        "skills_compat",
        "release_gate_summary.json",
    ]
    missing = [token for token in required_tokens if token not in text]
    if missing:
        return _fail(f"兼容矩阵缺少关键字段: {missing}")
    _ok("兼容矩阵文档存在且包含关键字段")
    return 0


def _check_awrap_contract() -> int:
    middleware_dir = PROJECT_ROOT / "backend" / "engine" / "middleware"
    if not middleware_dir.exists():
        return _fail("middleware 目录不存在")
    violations: list[str] = []
    allow_missing_async = {
        "content_fix_middleware.py:ContentFixMiddleware",
        "mcp_middleware.py:MCPMiddleware",
        "ontology_middleware.py:OntologyContextMiddleware",
    }
    for py in middleware_dir.glob("*.py"):
        try:
            tree = ast.parse(py.read_text(encoding="utf-8", errors="ignore"))
        except Exception:
            continue
        for node in tree.body:
            if not isinstance(node, ast.ClassDef):
                continue
            fn_names = {n.name for n in node.body if isinstance(n, ast.FunctionDef)}
            if "wrap_model_call" in fn_names and "awrap_model_call" not in fn_names:
                key = f"{py.name}:{node.name}"
                if key in allow_missing_async:
                    continue
                violations.append(key)
    if violations:
        return _fail(f"发现缺少 awrap_model_call 的中间件: {violations}")
    _ok("awrap_model_call 覆盖检查通过")
    return 0


def _check_text_tokens() -> int:
    checks = [
        (
            PROJECT_ROOT / "frontend" / "desktop" / "src" / "components" / "ChatComponents" / "MyRuntimeProvider.tsx",
            ["Thread not found", "switchToThread", "sendMessageWithRetry"],
            "线程失效恢复",
        ),
        (
            PROJECT_ROOT / "frontend" / "desktop" / "src" / "lib" / "api" / "langserveChat.ts",
            ["cancelRun", "AbortController"],
            "流式取消",
        ),
        (
            PROJECT_ROOT / "backend" / "api" / "app.py",
            ["/plugins", "plugin_command", "slash_execute"],
            "插件命令 fallback",
        ),
        (
            PROJECT_ROOT / "backend" / "api" / "routers" / "board_api.py",
            ["/board/tasks/{task_id}/resume", "step-complete", "execution-state"],
            "任务恢复接口",
        ),
    ]
    for path, tokens, label in checks:
        if not path.exists():
            return _fail(f"{label} 文件不存在: {path}")
        text = path.read_text(encoding="utf-8", errors="ignore")
        missing = [t for t in tokens if t not in text]
        if missing:
            return _fail(f"{label} 缺少关键实现标记: {missing}")
        _ok(f"{label} 检查通过")
    return 0


def _check_release_gate_summary() -> int:
    summary_path = PROJECT_ROOT / "backend" / "data" / "release_gate_summary.json"
    if not summary_path.exists():
        return _fail(f"缺少发布门禁摘要: {summary_path}")
    try:
        data = json.loads(summary_path.read_text(encoding="utf-8"))
    except Exception as e:
        return _fail(f"发布门禁摘要解析失败: {e}")
    raw = json.dumps(data, ensure_ascii=False)
    required = [
        "plugins_compat",
        "plugin_runtime_compat",
        "plugin_command_conflicts",
        "skills_compat",
        "knowledge_source_compliance",
        "task_execution_reliability_v2",
        "task_execution_reliability_e2e",
    ]
    missing = [k for k in required if k not in raw]
    if missing:
        return _fail(f"发布门禁摘要缺少兼容项: {missing}")
    _ok("发布门禁摘要检查通过")
    return 0


def _check_unified_observability_snapshot() -> int:
    snap_path = PROJECT_ROOT / "backend" / "data" / "unified_observability_snapshot.json"
    if not snap_path.exists():
        return _fail(f"缺少统一观测快照: {snap_path}")
    try:
        data = json.loads(snap_path.read_text(encoding="utf-8"))
    except Exception as e:
        return _fail(f"统一观测快照解析失败: {e}")
    required_top = [
        "release",
        "reliability_slo",
        "task_status_projection",
        "watcher",
        "ui_stream",
        "memory_scope_contract",
        "memory_quality",
        "memory_quality_trend",
        "policy_decisions",
        "ecosystem",
    ]
    missing_top = [k for k in required_top if not isinstance(data.get(k), dict)]
    if missing_top:
        return _fail(f"统一观测快照缺少关键模块: {missing_top}")
    ui_stream = data.get("ui_stream") if isinstance(data.get("ui_stream"), dict) else {}
    required_ui_fields = [
        "sample_count",
        "ttft_ms_p50",
        "ttft_ms_p95",
        "frontend_first_payload_ms_p50",
        "frontend_first_payload_ms_p95",
        "max_inter_token_gap_ms_p50",
        "max_inter_token_gap_ms_p95",
        "message_channel_fallback_count_p95",
        "partial_suppressed_count_p95",
    ]
    missing_ui = [k for k in required_ui_fields if k not in ui_stream]
    if missing_ui:
        return _fail(f"统一观测快照 ui_stream 缺少关键项: {missing_ui}")
    ecosystem = data.get("ecosystem") if isinstance(data.get("ecosystem"), dict) else {}
    checks = ecosystem.get("checks") if isinstance(ecosystem.get("checks"), dict) else {}
    required_checks = [
        "plugins_compat",
        "plugin_runtime_compat",
        "plugin_command_conflicts",
        "skills_compat",
        "knowledge_source_compliance",
        "task_execution_reliability_v2",
        "task_execution_reliability_e2e",
    ]
    missing_checks = [k for k in required_checks if k not in checks]
    if missing_checks:
        return _fail(f"统一观测快照 ecosystem.checks 缺少关键项: {missing_checks}")
    hygiene = ecosystem.get("plugin_manifest_hygiene") if isinstance(ecosystem.get("plugin_manifest_hygiene"), dict) else {}
    required_hygiene = ["status", "warnings_count", "errors_count", "blocking"]
    missing_hygiene = [k for k in required_hygiene if k not in hygiene]
    if missing_hygiene:
        return _fail(f"统一观测快照 plugin_manifest_hygiene 缺少字段: {missing_hygiene}")
    policy_decisions = data.get("policy_decisions") if isinstance(data.get("policy_decisions"), dict) else {}
    required_policy = ["status", "window_minutes", "denied_total", "by_layer", "by_reason_code", "schema"]
    missing_policy = [k for k in required_policy if k not in policy_decisions]
    if missing_policy:
        return _fail(f"统一观测快照 policy_decisions 缺少关键项: {missing_policy}")
    schema = policy_decisions.get("schema") if isinstance(policy_decisions.get("schema"), dict) else {}
    if "reason_codes" not in schema or not isinstance(schema.get("reason_codes"), list):
        return _fail("统一观测快照 policy_decisions.schema 缺少 reason_codes 列表")
    by_reason = policy_decisions.get("by_reason_code") if isinstance(policy_decisions.get("by_reason_code"), dict) else {}
    invalid_reason_keys = [k for k in by_reason if not (k and str(k).strip())]
    if invalid_reason_keys:
        return _fail("统一观测快照 policy_decisions.by_reason_code 存在空 reason_code 键")
    _ok("统一观测快照检查通过")
    return 0


def _check_knowledge_pipeline_snapshot() -> int:
    snap_path = PROJECT_ROOT / "backend" / "data" / "knowledge_pipeline_snapshot.json"
    if not snap_path.exists():
        return _fail(f"缺少知识链路快照: {snap_path}")
    try:
        data = json.loads(snap_path.read_text(encoding="utf-8"))
    except Exception as e:
        return _fail(f"知识链路快照解析失败: {e}")
    required_top = ["ingest", "index", "search", "ontology"]
    missing = [k for k in required_top if not isinstance(data.get(k), dict)]
    if missing:
        return _fail(f"知识链路快照缺少关键模块: {missing}")
    ontology = data.get("ontology") if isinstance(data.get("ontology"), dict) else {}
    if "entities" not in ontology or "relations" not in ontology:
        return _fail("知识链路快照 ontology 缺少 entities/relations 字段")
    _ok("知识链路快照检查通过")
    return 0


def _check_policy_decision_report() -> int:
    report_path = PROJECT_ROOT / "backend" / "data" / "policy_decision_report.json"
    if not report_path.exists():
        return _fail(f"缺少策略拒绝报告: {report_path}")
    try:
        data = json.loads(report_path.read_text(encoding="utf-8"))
    except Exception as e:
        return _fail(f"策略拒绝报告解析失败: {e}")
    if not isinstance(data, dict):
        return _fail("策略拒绝报告根节点必须为对象")
    required = ["status", "window_minutes", "metrics", "by_layer", "by_reason_code", "schema"]
    missing = [k for k in required if k not in data]
    if missing:
        return _fail(f"策略拒绝报告缺少关键字段: {missing}")
    metrics = data.get("metrics") if isinstance(data.get("metrics"), dict) else {}
    if "denied_total" not in metrics or "unknown_layer_rows" not in metrics or "unknown_reason_rows" not in metrics:
        return _fail("策略拒绝报告 metrics 必须同时包含 denied_total、unknown_layer_rows、unknown_reason_rows")
    schema = data.get("schema") if isinstance(data.get("schema"), dict) else {}
    if "reason_codes" not in schema or not isinstance(schema.get("reason_codes"), list):
        return _fail("策略拒绝报告 schema 缺少 reason_codes 列表")
    if "policy_layers" not in schema or not isinstance(schema.get("policy_layers"), list):
        return _fail("策略拒绝报告 schema 缺少 policy_layers 列表")
    by_reason = data.get("by_reason_code") if isinstance(data.get("by_reason_code"), dict) else {}
    empty_reason = [k for k in by_reason if not (k and str(k).strip())]
    if empty_reason:
        return _fail("策略拒绝报告 by_reason_code 存在空 reason_code 键")
    _ok("策略拒绝结构完整性检查通过")
    return 0


def _check_skills_behavior_report() -> int:
    report_path = PROJECT_ROOT / "backend" / "data" / "skills_compat_smoke_report.json"
    if not report_path.exists():
        return _fail(f"缺少 skills 兼容报告: {report_path}")
    try:
        data = json.loads(report_path.read_text(encoding="utf-8"))
    except Exception as e:
        return _fail(f"skills 兼容报告解析失败: {e}")
    checks = data.get("checks") if isinstance(data.get("checks"), dict) else {}
    required_checks = ["skills_demo_run_api", "skills_trial_list_api", "skills_validate_api"]
    missing = [k for k in required_checks if k not in checks]
    if missing:
        return _fail(f"skills 行为一致性检查项缺失: {missing}")
    if int(((checks.get("skills_demo_run_api") or {}).get("status_code", 0) or 0) != 200):
        return _fail("skills_demo_run_api 未通过")
    if int(((checks.get("skills_trial_list_api") or {}).get("status_code", 0) or 0) != 200):
        return _fail("skills_trial_list_api 未通过")
    _ok("skills 行为一致性检查通过")
    return 0


def _check_skills_semantic_consistency_report() -> int:
    report_path = PROJECT_ROOT / "backend" / "data" / "skills_semantic_consistency_report.json"
    if not report_path.exists():
        return _fail(f"缺少 skills 语义一致性报告: {report_path}")
    try:
        data = json.loads(report_path.read_text(encoding="utf-8"))
    except Exception as e:
        return _fail(f"skills 语义一致性报告解析失败: {e}")
    if "status" not in data or "metrics" not in data or "warnings" not in data:
        return _fail("skills 语义一致性报告缺少 status/metrics/warnings 字段")
    _ok("skills 语义一致性报告检查通过")
    return 0


def _check_plugin_command_conflicts_report() -> int:
    report_path = PROJECT_ROOT / "backend" / "data" / "plugin_command_conflicts_report.json"
    if not report_path.exists():
        return _fail(f"缺少插件命令冲突报告: {report_path}")
    try:
        data = json.loads(report_path.read_text(encoding="utf-8"))
    except Exception as e:
        return _fail(f"插件命令冲突报告解析失败: {e}")
    if "status" not in data or "metrics" not in data or "warnings" not in data:
        return _fail("插件命令冲突报告缺少 status/metrics/warnings 字段")
    _ok("插件命令冲突报告检查通过")
    return 0


def _check_knowledge_source_compliance_report() -> int:
    report_path = PROJECT_ROOT / "backend" / "data" / "knowledge_source_compliance_report.json"
    if not report_path.exists():
        return _fail(f"缺少知识来源合规报告: {report_path}")
    try:
        data = json.loads(report_path.read_text(encoding="utf-8"))
    except Exception as e:
        return _fail(f"知识来源合规报告解析失败: {e}")
    if "status" not in data or "checks" not in data or "warnings" not in data:
        return _fail("知识来源合规报告缺少 status/checks/warnings 字段")
    _ok("知识来源合规报告检查通过")
    return 0


def _check_parity_scorecard() -> int:
    report_path = PROJECT_ROOT / "backend" / "data" / "parity_scorecard.json"
    if not report_path.exists():
        return _fail(f"缺少对标评分卡报告: {report_path}")
    try:
        data = json.loads(report_path.read_text(encoding="utf-8"))
    except Exception as e:
        return _fail(f"对标评分卡解析失败: {e}")
    if "overall_score_100" not in data or "overall_level" not in data:
        return _fail("对标评分卡缺少 overall_score_100/overall_level")
    dims = data.get("dimensions")
    if not isinstance(dims, list) or len(dims) < 4:
        return _fail("对标评分卡 dimensions 不完整")
    _ok("对标评分卡检查通过")
    return 0


def _check_parity_trend_report() -> int:
    report_path = PROJECT_ROOT / "backend" / "data" / "parity_trend_report.json"
    if not report_path.exists():
        return _fail(f"缺少对标趋势报告: {report_path}")
    try:
        data = json.loads(report_path.read_text(encoding="utf-8"))
    except Exception as e:
        return _fail(f"对标趋势报告解析失败: {e}")
    if "status" not in data or "delta" not in data or "regression" not in data:
        return _fail("对标趋势报告缺少 status/delta/regression 字段")
    regression_detected = bool(((data.get("regression") or {}).get("detected")))
    if regression_detected and _RELEASE_PROFILE == "production":
        return _fail("对标趋势报告检测到回退（production 阻断）")
    if regression_detected:
        _ok("对标趋势报告检测到回退（staging 告警放行）")
        return 0
    _ok("对标趋势报告检查通过")
    return 0


def _check_memory_scope_contract_report() -> int:
    report_path = PROJECT_ROOT / "backend" / "data" / "memory_scope_contract_report.json"
    if not report_path.exists():
        return _fail(f"缺少记忆作用域契约报告: {report_path}")
    try:
        data = json.loads(report_path.read_text(encoding="utf-8"))
    except Exception as e:
        return _fail(f"记忆作用域契约报告解析失败: {e}")
    if "status" not in data or "checks" not in data:
        return _fail("记忆作用域契约报告缺少 status/checks 字段")
    _ok("记忆作用域契约报告检查通过")
    return 0


def _check_memory_quality_report() -> int:
    report_path = PROJECT_ROOT / "backend" / "data" / "memory_quality_report.json"
    if not report_path.exists():
        return _fail(f"缺少记忆质量报告: {report_path}")
    try:
        data = json.loads(report_path.read_text(encoding="utf-8"))
    except Exception as e:
        return _fail(f"记忆质量报告解析失败: {e}")
    if "status" not in data or "metrics" not in data or "warnings" not in data:
        return _fail("记忆质量报告缺少 status/metrics/warnings 字段")
    _ok("记忆质量报告检查通过")
    return 0


def _check_memory_quality_trend_report() -> int:
    report_path = PROJECT_ROOT / "backend" / "data" / "memory_quality_trend_report.json"
    if not report_path.exists():
        return _fail(f"缺少记忆质量趋势报告: {report_path}")
    try:
        data = json.loads(report_path.read_text(encoding="utf-8"))
    except Exception as e:
        return _fail(f"记忆质量趋势报告解析失败: {e}")
    if "status" not in data or "delta" not in data or "regression" not in data:
        return _fail("记忆质量趋势报告缺少 status/delta/regression 字段")
    regression_detected = bool(((data.get("regression") or {}).get("detected")))
    if regression_detected and _RELEASE_PROFILE == "production":
        return _fail("记忆质量趋势报告检测到回退（production 阻断）")
    if regression_detected:
        _ok("记忆质量趋势报告检测到回退（staging 告警放行）")
        return 0
    _ok("记忆质量趋势报告检查通过")
    return 0


def _check_task_execution_reliability_e2e_report() -> int:
    report_path = PROJECT_ROOT / "backend" / "data" / "task_execution_reliability_e2e_report.json"
    if not report_path.exists():
        return _fail(f"缺少任务执行可靠性 E2E 报告: {report_path}")
    try:
        data = json.loads(report_path.read_text(encoding="utf-8"))
    except Exception as e:
        return _fail(f"任务执行可靠性 E2E 报告解析失败: {e}")
    if not bool(data.get("ok")):
        return _fail("任务执行可靠性 E2E 报告 ok=false")
    required_fields = ["dedup_first", "dedup_second", "isolation_ok"]
    missing = [k for k in required_fields if k not in data]
    if missing:
        return _fail(f"任务执行可靠性 E2E 报告缺少字段: {missing}")
    if bool(data.get("dedup_first")) is not False:
        return _fail("任务执行可靠性 E2E dedup_first 期望为 false")
    if bool(data.get("dedup_second")) is not True:
        return _fail("任务执行可靠性 E2E dedup_second 期望为 true")
    if bool(data.get("isolation_ok")) is not True:
        return _fail("任务执行可靠性 E2E isolation_ok 期望为 true")
    _ok("任务执行可靠性 E2E 报告检查通过")
    return 0


def _manifest_hygiene_status(warnings_count: int, errors_count: int) -> str:
    if int(errors_count or 0) > 0:
        return "fail"
    if int(warnings_count or 0) > 0:
        return "warn"
    return "pass"


def _check_cost_quality_optional_warn(hard_fail: bool = False) -> int:
    """可选提智/成本门禁：默认仅告警不阻断。hard_fail 或 RELEASE_GATES_STRICT=1 时超阈值则硬阻断。"""
    cost_max = os.environ.get("COST_QUALITY_RUN_COST_MAX", "")
    failure_max_pct = os.environ.get("COST_QUALITY_FAILURE_RATE_MAX_PCT", "")
    if not str(cost_max).strip() and not str(failure_max_pct).strip():
        _ok("提智/成本门禁未配置阈值，跳过可选检查")
        return 0
    cost_max_f = float(cost_max) if str(cost_max).strip() else None
    failure_max_f = float(failure_max_pct) if str(failure_max_pct).strip() else None

    gate_path = PROJECT_ROOT / "backend" / "data" / "cost_quality_gate.json"
    data = None
    if gate_path.exists():
        try:
            data = json.loads(gate_path.read_text(encoding="utf-8"))
        except Exception as e:
            print(f"[ci-release-gates] WARN: 提智/成本门禁文件解析失败（仅告警）: {e}")
            return 0
    if not data or not isinstance(data, dict):
        _ok("提智/成本门禁无数据或未启用，跳过")
        return 0

    warnings_list = []
    if cost_max_f is not None:
        run_cost = data.get("run_cost_estimate_max") if isinstance(data.get("run_cost_estimate_max"), (int, float)) else None
        if run_cost is not None and float(run_cost) > cost_max_f:
            warnings_list.append(f"单次 run 成本估算 {run_cost} 超过阈值 {cost_max_f}")
    if failure_max_f is not None:
        rate = data.get("failure_rate_pct") if isinstance(data.get("failure_rate_pct"), (int, float)) else None
        if rate is not None and float(rate) > failure_max_f:
            warnings_list.append(f"失败率 {rate}% 超过阈值 {failure_max_f}%")

    strict = hard_fail or str(os.environ.get("RELEASE_GATES_STRICT", "")).strip().lower() in {"1", "true", "yes", "on"}
    if warnings_list:
        msg = "提智/成本门禁告警（不阻断）: " + "; ".join(warnings_list)
        _ci_gate_warnings.append(msg)
        print(f"[ci-release-gates] WARN: {msg}")
        if strict:
            _ci_gate_failures.append(msg)
            return _fail("提智/成本门禁硬阻断: " + "; ".join(warnings_list))
        return 0
    _ok("提智/成本门禁可选检查通过")
    return 0


def _warn(msg: str) -> None:
    """仅告警，不阻断。用于提智/成本等可选门禁。"""
    _ci_gate_warnings.append(msg)
    print(f"[ci-release-gates] WARN: {msg}")


def _check_cost_quality_optional(
    min_success_rate: float = 0.0,
    max_failure_rate: float = 1.0,
) -> int:
    """可选提智/成本门禁：读取可靠性指标，超阈值时仅告警不阻断。指标稳定后可改为硬门禁。"""
    snap_path = PROJECT_ROOT / "backend" / "data" / "unified_observability_snapshot.json"
    if not snap_path.exists():
        _warn("提智/成本检查跳过: 缺少 unified_observability_snapshot.json")
        return 0
    try:
        data = json.loads(snap_path.read_text(encoding="utf-8"))
    except Exception as e:
        _warn(f"提智/成本检查跳过: 快照解析失败 ({e})")
        return 0
    reliability = data.get("reliability_slo") if isinstance(data.get("reliability_slo"), dict) else {}
    success_rate = float(reliability.get("success_rate") or 0.0)
    if success_rate < min_success_rate and min_success_rate > 0:
        _warn(f"任务成功率低于阈值: success_rate={success_rate:.4f} < {min_success_rate}（仅告警，不阻断）")
    failure_rate = 1.0 - success_rate
    if failure_rate > max_failure_rate and max_failure_rate < 1.0:
        _warn(f"任务失败率高于阈值: failure_rate={failure_rate:.4f} > {max_failure_rate}（仅告警，不阻断）")
    return 0


def _check_release_signal_consistency() -> int:
    summary_path = PROJECT_ROOT / "backend" / "data" / "release_gate_summary.json"
    unified_path = PROJECT_ROOT / "backend" / "data" / "unified_observability_snapshot.json"
    postcheck_path = PROJECT_ROOT / "backend" / "data" / "release_postcheck_report.json"
    drill_steps_path = PROJECT_ROOT / "backend" / "data" / "release_drill_steps.json"
    if not summary_path.exists() or not unified_path.exists() or not postcheck_path.exists() or not drill_steps_path.exists():
        return _fail("一致性检查缺少关键输入（summary/unified/postcheck/drill_steps）")
    try:
        summary = json.loads(summary_path.read_text(encoding="utf-8"))
        unified = json.loads(unified_path.read_text(encoding="utf-8"))
        postcheck = json.loads(postcheck_path.read_text(encoding="utf-8"))
        drill_steps = json.loads(drill_steps_path.read_text(encoding="utf-8"))
    except Exception as e:
        return _fail(f"一致性检查输入解析失败: {e}")
    summary_overall = str(summary.get("overall_status") or "")
    unified_overall = str(((unified.get("release") or {}).get("overall_status")) or "")
    if summary_overall != unified_overall:
        return _fail(f"overall_status 不一致: summary={summary_overall}, unified={unified_overall}")
    summary_profile = str(summary.get("profile_gate_status") or "")
    unified_profile = str(((unified.get("release") or {}).get("profile_gate_status")) or "")
    if summary_profile != unified_profile:
        return _fail(f"profile_gate_status 不一致: summary={summary_profile}, unified={unified_profile}")
    summary_eco = (summary.get("compatibility_matrix") or {}).get("ecosystem_availability")
    unified_eco = (unified.get("ecosystem") or {}).get("availability")
    if summary_eco != unified_eco:
        return _fail(f"ecosystem_availability 不一致: summary={summary_eco}, unified={unified_eco}")
    required_fail_count = len(collect_required_step_failures(drill_steps if isinstance(drill_steps, dict) else {}))
    post_required_fail_count = (
        ((postcheck.get("drill_steps") or {}).get("required_step_fail_count"))
        if isinstance(postcheck, dict)
        else None
    )
    if post_required_fail_count != required_fail_count:
        return _fail(
            "required_step_fail_count 不一致: "
            f"drill_steps={required_fail_count}, postcheck={post_required_fail_count}"
        )
    summary_h = (
        ((summary.get("evidence") or {}).get("plugin_manifest_hygiene"))
        if isinstance((summary.get("evidence") or {}), dict)
        else {}
    )
    unified_h = (
        ((unified.get("ecosystem") or {}).get("plugin_manifest_hygiene"))
        if isinstance((unified.get("ecosystem") or {}), dict)
        else {}
    )
    post_h = postcheck.get("plugin_manifest_hygiene") if isinstance(postcheck.get("plugin_manifest_hygiene"), dict) else {}
    for key in ("warnings_count", "errors_count"):
        s_val = int((summary_h or {}).get(key, 0) or 0)
        u_val = int((unified_h or {}).get(key, 0) or 0)
        p_val = int((post_h or {}).get(key, 0) or 0)
        if not (s_val == u_val == p_val):
            return _fail(
                f"plugin_manifest_hygiene.{key} 不一致: "
                f"summary={s_val}, unified={u_val}, postcheck={p_val}"
            )
    expected_status = _manifest_hygiene_status(
        int((summary_h or {}).get("warnings_count", 0) or 0),
        int((summary_h or {}).get("errors_count", 0) or 0),
    )
    s_status = str((summary_h or {}).get("status") or "")
    u_status = str((unified_h or {}).get("status") or "")
    p_status = str((post_h or {}).get("status") or "")
    if not (s_status == u_status == p_status == expected_status):
        return _fail(
            "plugin_manifest_hygiene.status 不一致: "
            f"summary={s_status}, unified={u_status}, postcheck={p_status}, expected={expected_status}"
        )
    _ok("release/unified/postcheck 信号一致性检查通过")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="CI release gate checks")
    parser.add_argument(
        "--require-fresh-artifacts",
        action="store_true",
        help="要求关键产物具备新鲜时间戳（默认关闭）",
    )
    parser.add_argument(
        "--max-age-minutes",
        type=int,
        default=120,
        help="产物最大允许陈旧分钟数（仅在 --require-fresh-artifacts 时生效）",
    )
    parser.add_argument(
        "--release-profile",
        default=os.environ.get("RELEASE_PROFILE", "staging"),
        help="发布档位（staging/production），用于趋势回退阻断策略",
    )
    parser.add_argument(
        "--warn-cost-quality",
        action="store_true",
        help="启用可选提智/成本门禁（仅告警不阻断）。成本/失败率: cost_quality_gate.json + COST_QUALITY_RUN_COST_MAX/COST_QUALITY_FAILURE_RATE_MAX_PCT；成功率: unified_observability_snapshot + COST_QUALITY_MIN_SUCCESS_RATE/COST_QUALITY_MAX_FAILURE_RATE",
    )
    parser.add_argument(
        "--hard-fail-cost-quality",
        action="store_true",
        help="提智/成本门禁硬阻断：超阈值时 CI 失败。需同时启用 --warn-cost-quality。也可用环境变量 RELEASE_GATES_STRICT=1",
    )
    args = parser.parse_args()
    global _RELEASE_PROFILE
    _RELEASE_PROFILE = str(args.release_profile or "staging").strip().lower() or "staging"

    checks = [
        _check_compat_matrix,
        _check_awrap_contract,
        _check_text_tokens,
        _check_release_gate_summary,
        _check_policy_decision_report,
        _check_unified_observability_snapshot,
        _check_knowledge_pipeline_snapshot,
        _check_skills_behavior_report,
        _check_skills_semantic_consistency_report,
        _check_plugin_command_conflicts_report,
        _check_knowledge_source_compliance_report,
        _check_task_execution_reliability_e2e_report,
        _check_parity_scorecard,
        _check_parity_trend_report,
        _check_memory_scope_contract_report,
        _check_memory_quality_report,
        _check_memory_quality_trend_report,
        _check_release_signal_consistency,
    ]
    if args.require_fresh_artifacts:
        checks.append(lambda: _check_artifact_freshness(max(1, int(args.max_age_minutes))))
    if getattr(args, "warn_cost_quality", False):
        checks.append(lambda: _check_cost_quality_optional_warn(hard_fail=getattr(args, "hard_fail_cost_quality", False)))
        min_sr = os.environ.get("COST_QUALITY_MIN_SUCCESS_RATE", "")
        max_fr = os.environ.get("COST_QUALITY_MAX_FAILURE_RATE", "")
        checks.append(
            lambda ms=min_sr, mf=max_fr: _check_cost_quality_optional(
                min_success_rate=float(ms) if str(ms).strip() else 0.0,
                max_failure_rate=float(mf) if str(mf).strip() else 1.0,
            )
        )
    for fn in checks:
        code = fn()
        if code != 0:
            _write_ci_summary("FAILED", _ci_gate_failures)
            return code
    if _ci_gate_warnings:
        _write_ci_summary("WARNING", _ci_gate_warnings)
    else:
        _write_ci_summary("PASS", [])
    print("[ci-release-gates] PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
