#!/usr/bin/env python3
"""Policy-driven auto rollout orchestrator for validated upgrades."""

from __future__ import annotations

import argparse
import json
import shlex
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path


def _find_project_root(start: Path) -> Path:
    cur = start.resolve()
    for candidate in [cur] + list(cur.parents):
        if (candidate / "backend").exists() and (candidate / "knowledge_base").exists():
            return candidate
    return start.resolve().parents[5]


def _write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _read_json(path: Path, default: dict) -> dict:
    if not path.exists():
        return default
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else default
    except Exception:
        return default


def _append_jsonl(path: Path, row: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")


def _read_last_jsonl_row(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        lines = [ln.strip() for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip()]
        if not lines:
            return {}
        data = json.loads(lines[-1])
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _template_context(state: dict, gate: dict, root: Path) -> dict[str, str]:
    return {
        "stage": str(state.get("stage", "canary") or "canary"),
        "gate_passed": "true" if bool(gate.get("passed", False)) else "false",
        "passed_consecutive": str(int(state.get("passed_consecutive", 0) or 0)),
        "root": str(root),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


def _render_template(text: str, context: dict[str, str]) -> str:
    out = str(text or "")
    for k, v in context.items():
        out = out.replace("{{" + k + "}}", str(v))
    return out


def _run_command(cmd: str, cwd: Path, timeout_sec: int = 180) -> dict:
    args = shlex.split(cmd)
    if args:
        exe = Path(args[0]).name.lower()
        if exe in {"python", "python3"}:
            args[0] = sys.executable
    try:
        out = subprocess.run(
            args,
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=timeout_sec,
            check=False,
        )
        return {
            "command": cmd,
            "exit_code": out.returncode,
            "stdout": out.stdout[:4000],
            "stderr": out.stderr[:2000],
        }
    except Exception as e:
        return {"command": cmd, "error": str(e)}


def _normalize_optional_result(name: str, optional: bool, result: dict, root: Path) -> dict:
    """对可选步骤的非0退出码做语义归一，避免报告噪音。"""
    if not optional:
        return result
    exit_code = int(result.get("exit_code", 0) or 0)
    if exit_code == 0:
        return result

    # 针对 ab_eval_gate：优先读取 gate 文件判断是否为“数据不足导致的可预期阻断”
    if name == "ab_eval_gate":
        gate_path = root / "knowledge_base" / "learned" / "ab_eval" / "ab_gate.json"
        gate = _read_json(gate_path, {"passed": False, "reason": "gate_file_missing"})
        if not bool(gate.get("passed", False)):
            reasons = gate.get("reasons") or []
            reason = str(gate.get("reason", "") or "")
            if "insufficient_distillation_samples" in [str(x) for x in reasons]:
                reason = "insufficient_distillation_samples"
            elif not reason and reasons:
                reason = str(reasons[0])
            result["normalized_status"] = (
                "blocked_by_data" if reason == "insufficient_distillation_samples" else "blocked_by_gate"
            )
            result["effective_exit_code"] = 0
            result["gate_reason"] = reason
            result["gate_path"] = str(gate_path)
            return result
        reason = str(gate.get("reason", "") or "")
        reasons = [str(x) for x in (gate.get("reasons") or [])]
        if "insufficient_distillation_samples" in reasons:
            reason = "insufficient_distillation_samples"
        elif not reason and reasons:
            reason = reasons[0]
        if reason in {"insufficient_distillation_samples", "ab_eval_failed"}:
            result["normalized_status"] = (
                "blocked_by_data" if reason == "insufficient_distillation_samples" else "blocked_by_gate"
            )
            result["effective_exit_code"] = 0
            result["gate_reason"] = reason
            result["gate_path"] = str(gate_path)
            return result

    # 其他可选步骤统一标记为 soft-fail，不影响主流程
    result["normalized_status"] = "optional_soft_fail"
    result["effective_exit_code"] = 0
    return result


def _build_health_summary(runs: list[dict]) -> dict:
    """构建执行健康汇总，便于前端/监控直接消费。"""
    summary = {
        "success": 0,
        "blocked": 0,
        "soft_fail": 0,
        "hard_fail": 0,
        "skipped": 0,
    }
    details = {
        "blocked_steps": [],
        "soft_fail_steps": [],
        "hard_fail_steps": [],
    }

    for run in runs:
        if bool(run.get("skipped", False)):
            summary["skipped"] += 1
            continue
        status = str(run.get("normalized_status", "") or "")
        eff_exit = int(run.get("effective_exit_code", run.get("exit_code", 0)) or 0)
        name = str(run.get("name", "unknown") or "unknown")

        if status in {"blocked_by_data", "blocked_by_gate"}:
            summary["blocked"] += 1
            details["blocked_steps"].append(
                {"name": name, "status": status, "reason": run.get("gate_reason", "")}
            )
        elif status == "optional_soft_fail":
            summary["soft_fail"] += 1
            details["soft_fail_steps"].append({"name": name, "exit_code": run.get("exit_code", 0)})
        elif eff_exit == 0:
            summary["success"] += 1
        else:
            summary["hard_fail"] += 1
            details["hard_fail_steps"].append(
                {"name": name, "exit_code": run.get("exit_code", 0), "stderr": str(run.get("stderr", ""))[:200]}
            )

    total = sum(summary.values())
    return {"counts": summary, "total_steps": total, "details": details}


def _write_health_summary_markdown(path: Path, report: dict) -> None:
    health = report.get("health_summary") or {}
    counts = health.get("counts") or {}
    details = health.get("details") or {}

    lines = [
        "# Rollout Health Summary",
        "",
        f"- Timestamp: `{report.get('timestamp', '')}`",
        f"- Stage: `{report.get('stage', '')}`",
        f"- Rollout Percentage: `{report.get('rollout_percentage', 0)}%`",
        f"- Total Steps: `{health.get('total_steps', 0)}`",
        "",
        "## Counts",
        "",
        f"- success: `{counts.get('success', 0)}`",
        f"- blocked: `{counts.get('blocked', 0)}`",
        f"- soft_fail: `{counts.get('soft_fail', 0)}`",
        f"- hard_fail: `{counts.get('hard_fail', 0)}`",
        f"- skipped: `{counts.get('skipped', 0)}`",
        "",
    ]
    trend = report.get("health_trend") or {}
    delta = trend.get("delta") or {}
    if delta:
        lines.extend(
            [
                "## Trend vs Previous Run",
                "",
                f"- success: `{delta.get('success', 0):+d}`",
                f"- blocked: `{delta.get('blocked', 0):+d}`",
                f"- soft_fail: `{delta.get('soft_fail', 0):+d}`",
                f"- hard_fail: `{delta.get('hard_fail', 0):+d}`",
                f"- skipped: `{delta.get('skipped', 0):+d}`",
                "",
            ]
        )

    blocked = details.get("blocked_steps") or []
    lines.append("## Blocked Steps")
    lines.append("")
    if blocked:
        for item in blocked:
            lines.append(
                f"- `{item.get('name', 'unknown')}` ({item.get('status', 'blocked')}): {item.get('reason', '')}"
            )
    else:
        lines.append("- none")
    lines.append("")

    soft_fail = details.get("soft_fail_steps") or []
    lines.append("## Soft Fail Steps")
    lines.append("")
    if soft_fail:
        for item in soft_fail:
            lines.append(f"- `{item.get('name', 'unknown')}` (exit={item.get('exit_code', 0)})")
    else:
        lines.append("- none")
    lines.append("")

    hard_fail = details.get("hard_fail_steps") or []
    lines.append("## Hard Fail Steps")
    lines.append("")
    if hard_fail:
        for item in hard_fail:
            lines.append(
                f"- `{item.get('name', 'unknown')}` (exit={item.get('exit_code', 0)}): {item.get('stderr', '')}"
            )
    else:
        lines.append("- none")
    lines.append("")

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines), encoding="utf-8")


def _default_policy() -> dict:
    # 保持策略数据化，后续可由 LLM 直接改 policy，而不是改代码
    return {
        "enabled": True,
        "promote_when_passed_consecutive": 3,
        "rollback_on_fail_after_global": True,
        "max_parallel": 3,
        "halt_on_required_failure": True,
        "execution_graph": [
            {
                "type": "parallel",
                "name": "discovery_phase",
                "steps": [
                    {
                        "name": "generate_policy_draft",
                        "command": "python3 backend/tools/upgrade/generate_rollout_policy_draft.py --apply-safe",
                        "optional": True,
                    },
                    {
                        "name": "rollout_runtime_summary",
                        "command": "python3 backend/tools/upgrade/rollout_runtime_summary.py",
                        "optional": True,
                    },
                    {
                        "name": "system_status_report",
                        "command": (
                            "python3 backend/tools/upgrade/system_status_report.py "
                            "--section all "
                            "--output-json knowledge_base/learned/auto_upgrade/system_status_report.json"
                        ),
                        "optional": True,
                    },
                    {
                        "name": "prompt_module_healthcheck",
                        "command": (
                            "python3 backend/tools/upgrade/prompt_module_healthcheck.py "
                            "--output-json knowledge_base/learned/auto_upgrade/prompt_module_healthcheck.json "
                            "--output-md docs/PROMPT_MODULE_HEALTHCHECK.md"
                        ),
                        "optional": True,
                    },
                    {
                        "name": "status_command_regression",
                        "command": (
                            "python3 knowledge_base/skills/auto-discovery/scripts/"
                            "status_command_regression.py --strict "
                            "--output knowledge_base/learned/auto_upgrade/status_command_regression.json"
                        ),
                        "optional": True,
                    },
                    {
                        "name": "model_discovery_scan",
                        "command": (
                            "python3 backend/tools/upgrade/model_discovery_scan.py "
                            "--output knowledge_base/learned/auto_upgrade/model_discovery_scan.json"
                        ),
                        "optional": True,
                    },
                    {
                        "name": "distillation_skill_hit_audit",
                        "command": "python3 backend/tools/upgrade/distillation_skill_hit_audit.py",
                        "optional": True,
                    },
                    {
                        "name": "build_capability_registry",
                        "command": "python3 backend/tools/upgrade/build_capability_registry.py",
                        "optional": True,
                    },
                    {
                        "name": "knowledge_system_audit",
                        "command": "python3 backend/tools/upgrade/knowledge_system_audit.py",
                        "optional": True,
                    },
                    {
                        "name": "auto_discovery",
                        "command": "python3 backend/tools/upgrade/auto_upgrade.py",
                        "optional": False,
                    }
                ],
            },
            {
                "type": "if",
                "name": "ab_eval_branch",
                "when": {"stage_in": ["canary", "global"]},
                "then": [
                    {
                        "type": "step",
                        "name": "ab_eval_gate",
                        "command": (
                            "python3 backend/tools/upgrade/evaluate_distillation_ab.py "
                            "--mode run --strict --fail-on-gate --allow-insufficient-samples "
                            "--regression-set knowledge_base/learned/ab_eval/ab_regression_set.jsonl"
                        ),
                        "optional": True,
                    }
                ],
                "else": [
                    {
                        "type": "step",
                        "name": "skip_ab_eval_log",
                        "command": "python3 -c \"print('skip ab eval in stage={{stage}}')\"",
                        "optional": True,
                    }
                ],
            },
        ],
    }


def _rewrite_upgrade_command(cmd: str) -> str:
    src_prefix = "knowledge_base/skills/auto-discovery/scripts/"
    dst_prefix = "backend/tools/upgrade/"
    out = str(cmd or "")
    if src_prefix in out:
        out = out.replace(src_prefix, dst_prefix)
    return out


def _migrate_policy(policy: dict) -> dict:
    """在线迁移旧策略：补齐 execution_graph 与 draft 生成步骤。"""
    pol = json.loads(json.dumps(policy or {}))
    if not pol.get("execution_graph") and pol.get("steps"):
        pol["execution_graph"] = [{"type": "step", **s} for s in (pol.get("steps") or [])]
    graph = pol.get("execution_graph") or []
    # 确保 generate_policy_draft 存在（插入首个 parallel 节点）
    found = False
    for node in graph:
        if node.get("type") == "parallel":
            steps = node.get("steps") or []
            if any(s.get("name") == "generate_policy_draft" for s in steps):
                found = True
                break
    if not found:
        for node in graph:
            if node.get("type") == "parallel":
                node.setdefault("steps", []).insert(
                    0,
                    {
                        "name": "generate_policy_draft",
                        "command": (
                            "python3 backend/tools/upgrade/"
                            "generate_rollout_policy_draft.py --apply-safe"
                        ),
                        "optional": True,
                    },
                )
                found = True
                break
    if not found:
        graph.insert(
            0,
            {
                "type": "step",
                "name": "generate_policy_draft",
                "command": (
                    "python3 backend/tools/upgrade/"
                    "generate_rollout_policy_draft.py --apply-safe"
                ),
                "optional": True,
            },
        )
    # 确保 rollout_runtime_summary 存在
    found_summary = False
    for node in graph:
        if node.get("type") == "parallel":
            steps = node.get("steps") or []
            if any(s.get("name") == "rollout_runtime_summary" for s in steps):
                found_summary = True
                break
    if not found_summary:
        for node in graph:
            if node.get("type") == "parallel":
                node.setdefault("steps", []).insert(
                    1,
                    {
                        "name": "rollout_runtime_summary",
                        "command": (
                            "python3 backend/tools/upgrade/"
                            "rollout_runtime_summary.py"
                        ),
                        "optional": True,
                    },
                )
                found_summary = True
                break
    if not found_summary:
        graph.insert(
            0,
            {
                "type": "step",
                "name": "rollout_runtime_summary",
                "command": (
                    "python3 backend/tools/upgrade/"
                    "rollout_runtime_summary.py"
                ),
                "optional": True,
            },
        )
    # 确保 system_status_report 存在
    found_status_report = False
    for node in graph:
        if node.get("type") == "parallel":
            steps = node.get("steps") or []
            if any(s.get("name") == "system_status_report" for s in steps):
                found_status_report = True
                break
    if not found_status_report:
        for node in graph:
            if node.get("type") == "parallel":
                node.setdefault("steps", []).insert(
                    2,
                    {
                        "name": "system_status_report",
                        "command": (
                            "python3 backend/tools/upgrade/system_status_report.py "
                            "--section all "
                            "--output-json knowledge_base/learned/auto_upgrade/system_status_report.json"
                        ),
                        "optional": True,
                    },
                )
                found_status_report = True
                break
    if not found_status_report:
        graph.insert(
            0,
            {
                "type": "step",
                "name": "system_status_report",
                "command": (
                    "python3 backend/tools/upgrade/system_status_report.py "
                    "--section all "
                    "--output-json knowledge_base/learned/auto_upgrade/system_status_report.json"
                ),
                "optional": True,
            },
        )
    # 确保 prompt_module_healthcheck 存在
    found_prompt_module_healthcheck = False
    for node in graph:
        if node.get("type") == "parallel":
            steps = node.get("steps") or []
            if any(s.get("name") == "prompt_module_healthcheck" for s in steps):
                found_prompt_module_healthcheck = True
                break
    if not found_prompt_module_healthcheck:
        for node in graph:
            if node.get("type") == "parallel":
                node.setdefault("steps", []).insert(
                    3,
                    {
                        "name": "prompt_module_healthcheck",
                        "command": (
                            "python3 backend/tools/upgrade/prompt_module_healthcheck.py "
                            "--output-json knowledge_base/learned/auto_upgrade/prompt_module_healthcheck.json "
                            "--output-md docs/PROMPT_MODULE_HEALTHCHECK.md"
                        ),
                        "optional": True,
                    },
                )
                found_prompt_module_healthcheck = True
                break
    if not found_prompt_module_healthcheck:
        graph.insert(
            0,
            {
                "type": "step",
                "name": "prompt_module_healthcheck",
                "command": (
                    "python3 backend/tools/upgrade/prompt_module_healthcheck.py "
                    "--output-json knowledge_base/learned/auto_upgrade/prompt_module_healthcheck.json "
                    "--output-md docs/PROMPT_MODULE_HEALTHCHECK.md"
                ),
                "optional": True,
            },
        )
    # 确保 status_command_regression 存在
    found_status_command_regression = False
    for node in graph:
        if node.get("type") == "parallel":
            steps = node.get("steps") or []
            if any(s.get("name") == "status_command_regression" for s in steps):
                found_status_command_regression = True
                break
    if not found_status_command_regression:
        for node in graph:
            if node.get("type") == "parallel":
                node.setdefault("steps", []).insert(
                    4,
                    {
                        "name": "status_command_regression",
                        "command": (
                            "python3 knowledge_base/skills/auto-discovery/scripts/"
                            "status_command_regression.py --strict "
                            "--output knowledge_base/learned/auto_upgrade/status_command_regression.json"
                        ),
                        "optional": True,
                    },
                )
                found_status_command_regression = True
                break
    if not found_status_command_regression:
        graph.insert(
            0,
            {
                "type": "step",
                "name": "status_command_regression",
                "command": (
                    "python3 knowledge_base/skills/auto-discovery/scripts/"
                    "status_command_regression.py --strict "
                    "--output knowledge_base/learned/auto_upgrade/status_command_regression.json"
                ),
                "optional": True,
            },
        )
    # 确保 model_discovery_scan 存在
    found_model_discovery_scan = False
    for node in graph:
        if node.get("type") == "parallel":
            steps = node.get("steps") or []
            if any(s.get("name") == "model_discovery_scan" for s in steps):
                found_model_discovery_scan = True
                break
    if not found_model_discovery_scan:
        for node in graph:
            if node.get("type") == "parallel":
                node.setdefault("steps", []).insert(
                    5,
                    {
                        "name": "model_discovery_scan",
                        "command": (
                            "python3 backend/tools/upgrade/model_discovery_scan.py "
                            "--output knowledge_base/learned/auto_upgrade/model_discovery_scan.json"
                        ),
                        "optional": True,
                    },
                )
                found_model_discovery_scan = True
                break
    if not found_model_discovery_scan:
        graph.insert(
            0,
            {
                "type": "step",
                "name": "model_discovery_scan",
                "command": (
                    "python3 backend/tools/upgrade/model_discovery_scan.py "
                    "--output knowledge_base/learned/auto_upgrade/model_discovery_scan.json"
                ),
                "optional": True,
            },
        )
    # 确保 distillation_skill_hit_audit 存在
    found_hit_audit = False
    for node in graph:
        if node.get("type") == "parallel":
            steps = node.get("steps") or []
            if any(s.get("name") == "distillation_skill_hit_audit" for s in steps):
                found_hit_audit = True
                break
    if not found_hit_audit:
        for node in graph:
            if node.get("type") == "parallel":
                node.setdefault("steps", []).insert(
                    2,
                    {
                        "name": "distillation_skill_hit_audit",
                        "command": (
                            "python3 backend/tools/upgrade/"
                            "distillation_skill_hit_audit.py"
                        ),
                        "optional": True,
                    },
                )
                found_hit_audit = True
                break
    if not found_hit_audit:
        graph.insert(
            0,
            {
                "type": "step",
                "name": "distillation_skill_hit_audit",
                "command": (
                    "python3 backend/tools/upgrade/"
                    "distillation_skill_hit_audit.py"
                ),
                "optional": True,
            },
        )
    # 确保 build_capability_registry 存在
    found_capability_registry = False
    for node in graph:
        if node.get("type") == "parallel":
            steps = node.get("steps") or []
            if any(s.get("name") == "build_capability_registry" for s in steps):
                found_capability_registry = True
                break
    if not found_capability_registry:
        for node in graph:
            if node.get("type") == "parallel":
                node.setdefault("steps", []).insert(
                    3,
                    {
                        "name": "build_capability_registry",
                        "command": (
                            "python3 backend/tools/upgrade/"
                            "build_capability_registry.py"
                        ),
                        "optional": True,
                    },
                )
                found_capability_registry = True
                break
    if not found_capability_registry:
        graph.insert(
            0,
            {
                "type": "step",
                "name": "build_capability_registry",
                "command": (
                    "python3 backend/tools/upgrade/"
                    "build_capability_registry.py"
                ),
                "optional": True,
            },
        )
    # 确保 knowledge_system_audit 存在
    found_knowledge_audit = False
    for node in graph:
        if node.get("type") == "parallel":
            steps = node.get("steps") or []
            if any(s.get("name") == "knowledge_system_audit" for s in steps):
                found_knowledge_audit = True
                break
    if not found_knowledge_audit:
        for node in graph:
            if node.get("type") == "parallel":
                node.setdefault("steps", []).insert(
                    4,
                    {
                        "name": "knowledge_system_audit",
                        "command": (
                            "python3 backend/tools/upgrade/"
                            "knowledge_system_audit.py"
                        ),
                        "optional": True,
                    },
                )
                found_knowledge_audit = True
                break
    if not found_knowledge_audit:
        graph.insert(
            0,
            {
                "type": "step",
                "name": "knowledge_system_audit",
                "command": (
                    "python3 backend/tools/upgrade/"
                    "knowledge_system_audit.py"
                ),
                "optional": True,
            },
        )
    pol["execution_graph"] = graph
    pol.setdefault("max_parallel", 3)
    pol.setdefault("halt_on_required_failure", True)
    pol.setdefault("rollout_tiers", [10, 30, 60, 100])
    pol.setdefault("rollout_passes_per_tier", 1)
    # 去重：按 step name 全局去重，避免迁移叠加重复执行
    seen_names: set[str] = set()
    deduped_graph: list[dict] = []
    for node in pol.get("execution_graph") or []:
        ntype = str(node.get("type", "step") or "step")
        if ntype == "parallel":
            steps = []
            for s in node.get("steps") or []:
                n = str(s.get("name", "") or "")
                if n and n in seen_names:
                    continue
                if n:
                    seen_names.add(n)
                steps.append(s)
            new_node = dict(node)
            new_node["steps"] = steps
            deduped_graph.append(new_node)
        elif ntype == "step":
            n = str(node.get("name", "") or "")
            if n and n in seen_names:
                continue
            if n:
                seen_names.add(n)
            deduped_graph.append(node)
        else:
            deduped_graph.append(node)
    pol["execution_graph"] = deduped_graph
    # 兼容修正：老策略中的脚本路径统一改为 backend/tools/upgrade
    for node in pol["execution_graph"]:
        if str(node.get("type", "step") or "step") == "parallel":
            for s in node.get("steps") or []:
                s["command"] = _rewrite_upgrade_command(str(s.get("command", "") or ""))
        elif "command" in node:
            node["command"] = _rewrite_upgrade_command(str(node.get("command", "") or ""))
    # 兼容修正：ab_eval_gate 默认启用样本不足安全模式，避免 traceback 噪音
    for node in pol["execution_graph"]:
        if str(node.get("type", "step") or "step") == "parallel":
            for s in node.get("steps") or []:
                if s.get("name") == "ab_eval_gate":
                    cmd = str(s.get("command", "") or "")
                    if "--allow-insufficient-samples" not in cmd:
                        s["command"] = f"{cmd} --allow-insufficient-samples".strip()
        elif node.get("name") == "ab_eval_gate":
            cmd = str(node.get("command", "") or "")
            if "--allow-insufficient-samples" not in cmd:
                node["command"] = f"{cmd} --allow-insufficient-samples".strip()
    return pol


def _evaluate_when(when: dict, state: dict, root: Path, gate: dict) -> tuple[bool, str]:
    if not when:
        return True, ""
    stage = str(state.get("stage", "canary") or "canary")
    if "stage_in" in when:
        allowed = when.get("stage_in") or []
        if allowed and stage not in allowed:
            return False, f"stage_not_in_{allowed}"
    if "gate_passed" in when:
        expected = bool(when.get("gate_passed"))
        actual = bool(gate.get("passed", False))
        if actual != expected:
            return False, f"gate_passed_expected_{expected}"
    if "file_exists" in when:
        rel = str(when.get("file_exists") or "").strip()
        if rel and not (root / rel).exists():
            return False, f"file_missing_{rel}"
    if "min_passed_consecutive" in when:
        min_pc = int(when.get("min_passed_consecutive", 0) or 0)
        cur = int(state.get("passed_consecutive", 0) or 0)
        if cur < min_pc:
            return False, f"passed_consecutive_lt_{min_pc}"
    return True, ""


def _execute_single_step(step: dict, root: Path, state: dict, gate: dict) -> dict:
    name = str(step.get("name", "unnamed_step") or "unnamed_step")
    optional = bool(step.get("optional", False))
    should_run, reason = _evaluate_when(step.get("when") or {}, state, root, gate)
    if not should_run:
        return {"name": name, "optional": optional, "skipped": True, "skip_reason": reason}
    tpl_ctx = _template_context(state, gate, root)
    cmd = _render_template(str(step.get("command", "") or "").strip(), tpl_ctx)
    if not cmd:
        return {"name": name, "optional": optional, "skipped": True, "skip_reason": "empty_command"}
    result = _run_command(cmd, cwd=root)
    result["name"] = name
    result["optional"] = optional
    return _normalize_optional_result(name, optional, result, root)


def _execute_policy_graph(policy: dict, root: Path, state: dict, gate: dict) -> tuple[list[dict], bool]:
    runs: list[dict] = []
    graph = policy.get("execution_graph")
    halt_on_required_failure = bool(policy.get("halt_on_required_failure", True))
    max_parallel = int(policy.get("max_parallel", 3) or 3)
    required_failed = False

    # 兼容旧版 steps 配置
    if not graph and policy.get("steps"):
        graph = [{"type": "step", **s} for s in (policy.get("steps") or [])]
    graph = graph or []

    for node in graph:
        ntype = str(node.get("type", "step") or "step")
        if ntype == "if":
            branch_when = node.get("when") or {}
            ok, reason = _evaluate_when(branch_when, state, root, gate)
            branch_nodes = node.get("then") if ok else node.get("else")
            branch_nodes = branch_nodes or []
            runs.append(
                {
                    "name": str(node.get("name", "if_branch")),
                    "type": "if",
                    "branch": "then" if ok else "else",
                    "skipped": False,
                    "reason": "" if ok else reason,
                }
            )
            branch_policy = dict(policy)
            branch_policy["execution_graph"] = branch_nodes
            branch_runs, branch_failed = _execute_policy_graph(branch_policy, root, state, gate)
            runs.extend(branch_runs)
            if branch_failed:
                required_failed = True
        elif ntype == "parallel":
            steps = node.get("steps") or []
            futures = []
            with ThreadPoolExecutor(max_workers=max(1, max_parallel)) as executor:
                for step in steps:
                    futures.append(executor.submit(_execute_single_step, step, root, state, gate))
                for fut in as_completed(futures):
                    res = fut.result()
                    runs.append(res)
                    failed = int(res.get("exit_code", 0) or 0) != 0 and not bool(res.get("optional", False))
                    if failed:
                        required_failed = True
        else:
            res = _execute_single_step(node, root, state, gate)
            runs.append(res)
            failed = int(res.get("exit_code", 0) or 0) != 0 and not bool(res.get("optional", False))
            if failed:
                required_failed = True

        if required_failed and halt_on_required_failure:
            runs.append(
                {
                    "name": "policy_halt",
                    "skipped": True,
                    "skip_reason": "required_step_failed",
                    "optional": False,
                }
            )
            break

    return runs, required_failed


def _stage_from_percentage(pct: int) -> str:
    if pct >= 100:
        return "global"
    if pct >= 60:
        return "broad"
    if pct >= 30:
        return "limited"
    return "canary"


def _update_rollout_progress(state: dict, policy: dict, gate_passed: bool) -> dict:
    tiers = policy.get("rollout_tiers") or [10, 30, 60, 100]
    tiers = sorted({int(x) for x in tiers if int(x) > 0})
    if not tiers:
        tiers = [100]
    passes_per_tier = max(1, int(policy.get("rollout_passes_per_tier", 1) or 1))
    rollback_enabled = bool(policy.get("rollback_on_fail_after_global", True))

    rollout_index = int(state.get("rollout_index", 0) or 0)
    rollout_index = min(max(0, rollout_index), len(tiers) - 1)
    tier_pass_count = int(state.get("tier_pass_count", 0) or 0)

    action = "keep_stage"
    if gate_passed:
        tier_pass_count += 1
        if tier_pass_count >= passes_per_tier and rollout_index < len(tiers) - 1:
            rollout_index += 1
            tier_pass_count = 0
            action = "promote_rollout_tier"
    else:
        tier_pass_count = 0
        if rollback_enabled and rollout_index > 0:
            rollout_index -= 1
            action = "rollback_rollout_tier"

    pct = int(tiers[rollout_index])
    state["rollout_tiers"] = tiers
    state["rollout_index"] = rollout_index
    state["tier_pass_count"] = tier_pass_count
    state["rollout_percentage"] = pct
    state["stage"] = _stage_from_percentage(pct)
    state["last_action"] = action
    return state


def _compute_health_trend(current_counts: dict, previous_counts: dict) -> dict:
    keys = ["success", "blocked", "soft_fail", "hard_fail", "skipped"]
    if not previous_counts:
        return {"has_previous": False, "delta": {}}
    delta = {
        k: int(current_counts.get(k, 0) or 0) - int(previous_counts.get(k, 0) or 0)
        for k in keys
    }
    return {
        "has_previous": True,
        "previous_counts": {k: int(previous_counts.get(k, 0) or 0) for k in keys},
        "delta": delta,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Policy-driven auto rollout upgrade")
    parser.add_argument(
        "--policy",
        default="knowledge_base/learned/auto_upgrade/rollout_policy.json",
        help="Rollout policy json path",
    )
    parser.add_argument(
        "--state",
        default="knowledge_base/learned/auto_upgrade/rollout_state.json",
        help="Rollout state json path",
    )
    parser.add_argument(
        "--execution-report",
        default="knowledge_base/learned/auto_upgrade/rollout_execution.json",
        help="Execution report path",
    )
    parser.add_argument(
        "--history",
        default="knowledge_base/learned/auto_upgrade/rollout_history.jsonl",
        help="History jsonl path",
    )
    parser.add_argument(
        "--health-summary-md",
        default="knowledge_base/learned/auto_upgrade/rollout_health_summary.md",
        help="Health summary markdown path",
    )
    args = parser.parse_args()

    root = _find_project_root(Path(__file__).resolve().parent)
    policy_path = (root / args.policy).resolve() if not Path(args.policy).is_absolute() else Path(args.policy).resolve()
    state_path = (root / args.state).resolve() if not Path(args.state).is_absolute() else Path(args.state).resolve()
    report_path = (
        (root / args.execution_report).resolve()
        if not Path(args.execution_report).is_absolute()
        else Path(args.execution_report).resolve()
    )
    history_path = (root / args.history).resolve() if not Path(args.history).is_absolute() else Path(args.history).resolve()
    health_summary_md_path = (
        (root / args.health_summary_md).resolve()
        if not Path(args.health_summary_md).is_absolute()
        else Path(args.health_summary_md).resolve()
    )

    if not policy_path.exists():
        _write_json(policy_path, _default_policy())
    policy = _migrate_policy(_read_json(policy_path, _default_policy()))
    # 将迁移后的策略回写，确保后续运行一致
    _write_json(policy_path, policy)
    state = _read_json(
        state_path,
        {
            "stage": "canary",
            "passed_consecutive": 0,
            "last_gate_passed": None,
            "last_updated": None,
            "rollout_index": 0,
            "tier_pass_count": 0,
            "rollout_percentage": 10,
        },
    )

    runs = []
    if policy.get("enabled", True):
        # 先读取上一轮 gate（供 when 条件判断），本轮执行后会再次读取最新 gate
        prev_gate = _read_json(root / "knowledge_base/learned/ab_eval/ab_gate.json", {"passed": False})
        runs, _ = _execute_policy_graph(policy, root, state, prev_gate)

    gate_path = root / "knowledge_base/learned/ab_eval/ab_gate.json"
    # 若 A/B 可选步骤失败且尚未产出 gate，写入可解释 fallback，保证编排可观测
    if not gate_path.exists():
        for run in runs:
            if run.get("name") == "ab_eval_gate" and int(run.get("exit_code", 0) or 0) != 0:
                stderr = str(run.get("stderr", "") or "")
                if "样本过少" in stderr or "distillation 样本" in stderr:
                    _write_json(
                        gate_path,
                        {
                            "passed": False,
                            "reason": "insufficient_distillation_samples",
                            "details": "A/B 评测样本不足，待累积样本后自动重试。",
                        },
                    )
                else:
                    _write_json(
                        gate_path,
                        {
                            "passed": False,
                            "reason": "ab_eval_failed",
                            "details": stderr[:500],
                        },
                    )
                break
    gate = _read_json(gate_path, {"passed": False, "reason": "gate_file_missing"})
    gate_passed = bool(gate.get("passed", False))

    if gate_passed:
        state["passed_consecutive"] = int(state.get("passed_consecutive", 0) or 0) + 1
    else:
        state["passed_consecutive"] = 0
    state["last_gate_passed"] = gate_passed
    state = _update_rollout_progress(state, policy, gate_passed)

    state["last_updated"] = datetime.now(timezone.utc).isoformat()
    _write_json(state_path, state)

    release_profile_path = root / "knowledge_base/learned/auto_upgrade/release_profile.json"
    _write_json(
        release_profile_path,
        {
            "timestamp": state["last_updated"],
            "stage": state.get("stage"),
            "rollout_percentage": int(state.get("rollout_percentage", 10) or 10),
            "gate_passed": gate_passed,
            "policy_path": str(policy_path),
            "state_path": str(state_path),
        },
    )

    health_summary = _build_health_summary(runs)
    previous_history = _read_last_jsonl_row(history_path)
    health_trend = _compute_health_trend(health_summary.get("counts", {}), previous_history.get("health_counts", {}))

    report = {
        "status": "ok",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "executor": "policy_graph_v2",
        "policy_path": str(policy_path),
        "state_path": str(state_path),
        "gate_path": str(gate_path),
        "gate": gate,
        "stage": state.get("stage"),
        "rollout_percentage": int(state.get("rollout_percentage", 10) or 10),
        "release_profile_path": str(release_profile_path),
        "runs": runs,
        "health_summary": health_summary,
        "health_trend": health_trend,
    }
    _write_json(report_path, report)
    _write_health_summary_markdown(health_summary_md_path, report)
    _append_jsonl(
        history_path,
        {
            "timestamp": report["timestamp"],
            "stage": report["stage"],
            "gate_passed": gate_passed,
            "last_action": state.get("last_action"),
            "passed_consecutive": state.get("passed_consecutive"),
            "rollout_percentage": int(state.get("rollout_percentage", 10) or 10),
            "health_counts": health_summary.get("counts", {}),
        },
    )
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()

