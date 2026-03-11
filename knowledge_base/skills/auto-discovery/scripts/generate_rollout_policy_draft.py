#!/usr/bin/env python3
"""Generate rollout policy draft from latest gate/suggestions signals."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path


def _find_project_root(start: Path) -> Path:
    cur = start.resolve()
    for candidate in [cur] + list(cur.parents):
        if (candidate / "backend").exists() and (candidate / "knowledge_base").exists():
            return candidate
    return start.resolve().parents[5]


def _read_json(path: Path, default: dict) -> dict:
    if not path.exists():
        return default
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else default
    except Exception:
        return default


def _write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _has_p0_suggestion(suggestions: dict) -> bool:
    items = suggestions.get("suggestions", []) if isinstance(suggestions, dict) else []
    for item in items:
        if str(item.get("priority", "")).upper() == "P0":
            return True
    return False


def _ensure_step(policy: dict, step: dict) -> None:
    graph = policy.get("execution_graph") or []
    for node in graph:
        if node.get("type") == "parallel":
            steps = node.get("steps") or []
            if any(s.get("name") == step.get("name") for s in steps):
                return
        elif node.get("name") == step.get("name"):
            return
    # 默认加入到首个 parallel 节点
    for node in graph:
        if node.get("type") == "parallel":
            node.setdefault("steps", []).insert(0, step)
            return
    graph.insert(0, {"type": "step", **step})
    policy["execution_graph"] = graph


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate rollout policy draft")
    parser.add_argument("--policy", default="knowledge_base/learned/auto_upgrade/rollout_policy.json")
    parser.add_argument("--draft", default="knowledge_base/learned/auto_upgrade/rollout_policy_draft.json")
    parser.add_argument("--suggestions", default="knowledge_base/learned/ab_eval/ab_suggestions.json")
    parser.add_argument("--gate", default="knowledge_base/learned/ab_eval/ab_gate.json")
    parser.add_argument("--apply-safe", action="store_true")
    args = parser.parse_args()

    root = _find_project_root(Path(__file__).resolve().parent)
    policy_path = (root / args.policy).resolve() if not Path(args.policy).is_absolute() else Path(args.policy).resolve()
    draft_path = (root / args.draft).resolve() if not Path(args.draft).is_absolute() else Path(args.draft).resolve()
    suggestions_path = (
        (root / args.suggestions).resolve() if not Path(args.suggestions).is_absolute() else Path(args.suggestions).resolve()
    )
    gate_path = (root / args.gate).resolve() if not Path(args.gate).is_absolute() else Path(args.gate).resolve()

    policy = _read_json(policy_path, {})
    suggestions = _read_json(suggestions_path, {})
    gate = _read_json(gate_path, {"passed": False, "reason": "missing"})
    if not policy:
        print(json.dumps({"status": "error", "reason": "policy_not_found_or_empty", "policy": str(policy_path)}, ensure_ascii=False))
        return

    draft = json.loads(json.dumps(policy))
    draft.setdefault("meta", {})
    draft["meta"].update(
        {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "source": "generate_rollout_policy_draft",
            "gate_reason": gate.get("reason", ""),
        }
    )

    # 信号驱动：样本不足时增加数据准备步骤并保持 A/B 可选
    if str(gate.get("reason", "")).strip() == "insufficient_distillation_samples":
        _ensure_step(
            draft,
            {
                "name": "prepare_distillation_dataset",
                "command": (
                    "python3 backend/tools/upgrade/export_distillation_dataset.py "
                    "--input knowledge_base/learned/distillation_samples.jsonl "
                    "--output knowledge_base/learned/distillation_train.jsonl"
                ),
                "optional": True,
            },
        )

    # 若存在 P0 建议，保持严格门禁并降低并行度，避免不稳定扩散
    if _has_p0_suggestion(suggestions):
        draft["max_parallel"] = 2
        draft["halt_on_required_failure"] = True

    # 始终保留系统状态快照步骤，便于对话与监控读取统一报告
    _ensure_step(
        draft,
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

    _write_json(draft_path, draft)

    applied = False
    # apply-safe: 仅在 gate 通过且无 P0 建议时自动应用
    if args.apply_safe and bool(gate.get("passed", False)) and not _has_p0_suggestion(suggestions):
        _write_json(policy_path, draft)
        applied = True

    print(
        json.dumps(
            {
                "status": "ok",
                "policy": str(policy_path),
                "draft": str(draft_path),
                "applied": applied,
                "gate_passed": bool(gate.get("passed", False)),
                "has_p0_suggestion": _has_p0_suggestion(suggestions),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()

