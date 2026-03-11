#!/usr/bin/env python3
"""Build and score A/B evaluation sets for distillation few-shot."""

from __future__ import annotations

import argparse
import json
import random
import sys
from datetime import datetime, timezone
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path


@dataclass
class Sample:
    sid: str
    user_input: str
    strong_output: str
    model_id: str
    tier: str
    skill_hints: list[str]
    tool_names: list[str]


def _safe_jsonl_load(path: Path) -> list[dict]:
    rows: list[dict] = []
    if not path.exists():
        return rows
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except Exception:
            continue
    return rows


def load_samples(path: Path) -> list[Sample]:
    rows = _safe_jsonl_load(path)
    samples: list[Sample] = []
    for i, row in enumerate(rows):
        user_input = str(row.get("compressed_input", "") or "").strip()
        strong_output = str(row.get("strong_output", "") or "").strip()
        if not user_input or not strong_output:
            continue
        samples.append(
            Sample(
                sid=f"s{i}",
                user_input=user_input,
                strong_output=strong_output,
                model_id=str(row.get("model_id", "") or ""),
                tier=str(row.get("tier", "") or ""),
                skill_hints=[
                    str(x).strip()
                    for x in ((row.get("metadata") or {}).get("skill_hints") or [])
                    if str(x).strip()
                ],
                tool_names=[
                    str(x).strip()
                    for x in ((row.get("metadata") or {}).get("tool_names") or [])
                    if str(x).strip()
                ],
            )
        )
    return samples


def _similarity(a: str, b: str) -> float:
    return SequenceMatcher(a=a, b=b).ratio()


def _infer_intent_tag(text: str) -> str:
    t = str(text or "").lower()
    if any(k in t for k in ["系统状态", "健康", "巡检", "rollout", "gate"]):
        return "system_status"
    if any(k in t for k in ["json", "结构化", "可视化", "ui"]):
        return "json_ui"
    if any(k in t for k in ["资格预审", "资质", "证书"]):
        return "qualification"
    if any(k in t for k in ["报价", "价格", "定价"]):
        return "pricing"
    if any(k in t for k in ["竞争", "胜率", "竞品"]):
        return "competitive"
    if any(k in t for k in ["招标", "投标", "标书"]):
        return "bidding"
    return "general"


def _pick_fewshot(query: str, pool: list[Sample], k: int) -> list[Sample]:
    if k <= 0:
        return []
    query_intent = _infer_intent_tag(query)
    query_len = len(str(query or ""))
    # 短输入更容易被 few-shot 污染，默认降噪到 1 条
    effective_k = 1 if query_len < 80 else k
    min_sim = 0.28 if query_len < 120 else 0.2

    scored: list[tuple[float, Sample]] = []
    for s in pool:
        sim = _similarity(query, s.user_input)
        if sim < min_sim:
            continue
        score = sim
        sample_intent = _infer_intent_tag(s.user_input)
        if sample_intent == query_intent:
            score += 0.2
        # 有 skill_hints/tool_names 的样本更稳定，适当加权
        if s.skill_hints:
            score += 0.05
        if s.tool_names:
            score += 0.03
        scored.append((score, s))

    ranked = [s for _, s in sorted(scored, key=lambda x: x[0], reverse=True)]
    return ranked[: max(0, effective_k)]


def build_sets(input_path: Path, out_dir: Path, eval_size: int, fewshot_k: int, seed: int) -> dict:
    samples = load_samples(input_path)
    if len(samples) < 4:
        raise ValueError("样本过少，至少需要 4 条 distillation 样本。")

    rng = random.Random(seed)
    shuffled = samples[:]
    rng.shuffle(shuffled)

    eval_rows = shuffled[: min(eval_size, len(shuffled) // 2)]
    pool = shuffled[min(eval_size, len(shuffled) // 2):]
    if not pool:
        pool = shuffled[:]

    out_dir.mkdir(parents=True, exist_ok=True)
    control_path = out_dir / "ab_control_requests.jsonl"
    treatment_path = out_dir / "ab_treatment_requests.jsonl"
    gold_path = out_dir / "ab_gold.jsonl"

    control_lines: list[str] = []
    treatment_lines: list[str] = []
    gold_lines: list[str] = []

    for s in eval_rows:
        fewshots = _pick_fewshot(s.user_input, [p for p in pool if p.sid != s.sid], fewshot_k)
        control = {
            "id": s.sid,
            "messages": [{"role": "user", "content": s.user_input}],
            "meta": {"variant": "control"},
        }
        treatment_messages = [
            {
                "role": "system",
                "content": (
                    "你将看到历史高质量示例。仅借鉴表达结构，不要引入与当前问题无关的信息；"
                    "优先保持事实保守与可验证，无法确认时明确说明不确定。"
                ),
            }
        ]
        for fs in fewshots:
            treatment_messages.append({"role": "user", "content": fs.user_input})
            treatment_messages.append({"role": "assistant", "content": fs.strong_output})
        treatment_messages.append({"role": "user", "content": s.user_input})
        treatment = {
            "id": s.sid,
            "messages": treatment_messages,
            "meta": {"variant": "treatment", "fewshot_count": len(fewshots)},
        }
        gold = {
            "id": s.sid,
            "user_input": s.user_input,
            "input_length": len(s.user_input),
            "gold_output": s.strong_output,
            "meta": {"model_id": s.model_id, "tier": s.tier},
        }
        control_lines.append(json.dumps(control, ensure_ascii=False))
        treatment_lines.append(json.dumps(treatment, ensure_ascii=False))
        gold_lines.append(json.dumps(gold, ensure_ascii=False))

    control_path.write_text("\n".join(control_lines) + "\n", encoding="utf-8")
    treatment_path.write_text("\n".join(treatment_lines) + "\n", encoding="utf-8")
    gold_path.write_text("\n".join(gold_lines) + "\n", encoding="utf-8")

    return {
        "status": "ok",
        "eval_size": len(eval_rows),
        "fewshot_k": fewshot_k,
        "control_path": str(control_path),
        "treatment_path": str(treatment_path),
        "gold_path": str(gold_path),
    }


def _load_predictions(path: Path) -> dict[str, str]:
    pred: dict[str, str] = {}
    for row in _safe_jsonl_load(path):
        sid = str(row.get("id", "") or "").strip()
        if not sid:
            continue
        out = (
            row.get("output")
            or row.get("assistant_output")
            or row.get("response")
            or row.get("text")
            or ""
        )
        pred[sid] = str(out or "").strip()
    return pred


def _bucket_by_input_length(length: int) -> str:
    if length < 200:
        return "short_lt_200"
    if length < 800:
        return "medium_200_799"
    return "long_ge_800"


def _truncate(text: str, max_len: int = 220) -> str:
    text = str(text or "").strip()
    if len(text) <= max_len:
        return text
    return text[:max_len] + "..."


def _safe_avg(values: list[float]) -> float:
    if not values:
        return 0.0
    return sum(values) / len(values)


def score_sets(control_pred: Path, treatment_pred: Path, gold_path: Path, out_path: Path) -> dict:
    control = _load_predictions(control_pred)
    treatment = _load_predictions(treatment_pred)
    gold_rows = _safe_jsonl_load(gold_path)
    gold: dict[str, dict] = {}
    for row in gold_rows:
        sid = str(row.get("id", "") or "").strip()
        if not sid:
            continue
        gold[sid] = {
            "gold_output": str(row.get("gold_output", "") or "").strip(),
            "user_input": str(row.get("user_input", "") or "").strip(),
            "input_length": int(row.get("input_length", 0) or 0),
        }

    sids = sorted(set(gold.keys()) & set(control.keys()) & set(treatment.keys()))
    if not sids:
        raise ValueError("无可评分样本，请检查预测文件与 gold 的 id 是否一致。")

    control_scores: list[float] = []
    treatment_scores: list[float] = []
    tie_count = 0
    treatment_win = 0
    control_win = 0
    control_error_count = 0
    treatment_error_count = 0
    bucket_stats: dict[str, dict] = {}
    samples: list[dict] = []

    for sid in sids:
        ref = str(gold[sid]["gold_output"] or "")
        control_out = control[sid]
        treatment_out = treatment[sid]
        c_score = _similarity(control_out, ref)
        t_score = _similarity(treatment_out, ref)
        delta = t_score - c_score
        control_scores.append(c_score)
        treatment_scores.append(t_score)

        if control_out.startswith("[ERROR]"):
            control_error_count += 1
        if treatment_out.startswith("[ERROR]"):
            treatment_error_count += 1
        if delta > 0:
            treatment_win += 1
        elif delta < 0:
            control_win += 1
        else:
            tie_count += 1

        input_len = int(gold[sid].get("input_length", 0) or 0)
        bucket = _bucket_by_input_length(input_len)
        stats = bucket_stats.setdefault(
            bucket,
            {"count": 0, "control_scores": [], "treatment_scores": [], "deltas": []},
        )
        stats["count"] += 1
        stats["control_scores"].append(c_score)
        stats["treatment_scores"].append(t_score)
        stats["deltas"].append(delta)

        samples.append(
            {
                "id": sid,
                "input_length": input_len,
                "bucket": bucket,
                "control_similarity": round(c_score, 4),
                "treatment_similarity": round(t_score, 4),
                "delta": round(delta, 4),
                "user_input": _truncate(gold[sid].get("user_input", "")),
                "control_output": _truncate(control_out),
                "treatment_output": _truncate(treatment_out),
            }
        )

    control_avg = sum(control_scores) / len(control_scores)
    treatment_avg = sum(treatment_scores) / len(treatment_scores)
    by_bucket: dict[str, dict] = {}
    for bucket, stats in bucket_stats.items():
        c_avg = _safe_avg(stats["control_scores"])
        t_avg = _safe_avg(stats["treatment_scores"])
        by_bucket[bucket] = {
            "count": int(stats["count"]),
            "control_avg_similarity": round(c_avg, 4),
            "treatment_avg_similarity": round(t_avg, 4),
            "delta": round(t_avg - c_avg, 4),
            "treatment_win_rate": round(
                sum(1 for d in stats["deltas"] if d > 0) / max(1, len(stats["deltas"])),
                4,
            ),
        }

    # hardest/tops: 便于定向修复 prompt 或 skills
    hardest_cases = sorted(samples, key=lambda x: x["treatment_similarity"])[:5]
    regressions = [s for s in samples if s["delta"] < 0]
    improvements = [s for s in samples if s["delta"] > 0]
    top_regressions = sorted(regressions, key=lambda x: x["delta"])[:5]
    top_improvements = sorted(improvements, key=lambda x: x["delta"], reverse=True)[:5]

    report = {
        "status": "ok",
        "count": len(sids),
        "control_avg_similarity": round(control_avg, 4),
        "treatment_avg_similarity": round(treatment_avg, 4),
        "delta": round(treatment_avg - control_avg, 4),
        "winner": "treatment" if treatment_avg >= control_avg else "control",
        "win_stats": {
            "treatment_win": treatment_win,
            "control_win": control_win,
            "tie": tie_count,
            "treatment_win_rate": round(treatment_win / len(sids), 4),
        },
        "error_stats": {
            "control_error_count": control_error_count,
            "treatment_error_count": treatment_error_count,
        },
        "by_input_length_bucket": by_bucket,
        "hardest_cases_by_treatment": hardest_cases,
        "top_regressions": top_regressions,
        "top_improvements": top_improvements,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return report


def generate_optimization_suggestions(report: dict) -> dict:
    """根据 A/B 报告自动生成下一轮优化建议（可直接转任务清单）。"""
    suggestions: list[dict] = []
    delta = float(report.get("delta", 0.0) or 0.0)
    win_stats = report.get("win_stats", {}) or {}
    error_stats = report.get("error_stats", {}) or {}
    by_bucket = report.get("by_input_length_bucket", {}) or {}
    top_regressions = report.get("top_regressions", []) or []
    hardest_cases = report.get("hardest_cases_by_treatment", []) or []

    if delta < 0:
        suggestions.append(
            {
                "priority": "P0",
                "area": "fewshot_strategy",
                "action": "暂时降低 few-shot 注入强度（减少 k 或仅对高相似样本注入），避免整体退化。",
                "evidence": {"delta": round(delta, 4)},
            }
        )
    elif delta < 0.01:
        suggestions.append(
            {
                "priority": "P1",
                "area": "fewshot_strategy",
                "action": "整体提升有限，建议提高样本质量阈值并过滤低相似 few-shot。",
                "evidence": {"delta": round(delta, 4)},
            }
        )
    else:
        suggestions.append(
            {
                "priority": "P2",
                "area": "rollout",
                "action": "增益稳定，可扩大评测集并逐步灰度启用 few-shot 策略。",
                "evidence": {"delta": round(delta, 4)},
            }
        )

    treatment_errors = int(error_stats.get("treatment_error_count", 0) or 0)
    control_errors = int(error_stats.get("control_error_count", 0) or 0)
    if treatment_errors > control_errors:
        suggestions.append(
            {
                "priority": "P0",
                "area": "stability",
                "action": "treatment 错误数更高，需缩短上下文并增加输出格式约束，减少超长输入导致的失败。",
                "evidence": {"treatment_error_count": treatment_errors, "control_error_count": control_errors},
            }
        )

    for bucket, stats in by_bucket.items():
        b_delta = float(stats.get("delta", 0.0) or 0.0)
        if b_delta < -0.02:
            suggestions.append(
                {
                    "priority": "P1",
                    "area": "bucket_targeting",
                    "action": f"{bucket} 分桶退化明显，建议为该长度区间定制 prompt 模板与示例压缩规则。",
                    "evidence": {"bucket": bucket, "delta": round(b_delta, 4), "count": stats.get("count", 0)},
                }
            )

    if top_regressions:
        suggestions.append(
            {
                "priority": "P1",
                "area": "regression_cases",
                "action": "将 top_regressions 样本加入负例集，建立回归测试并作为后续 prompt 迭代门禁。",
                "evidence": {"sample_ids": [s.get("id") for s in top_regressions[:5]]},
            }
        )

    if hardest_cases:
        suggestions.append(
            {
                "priority": "P2",
                "area": "skill_enhancement",
                "action": "针对 hardest_cases 提取共性，补充对应领域 skill 的 workflow 示例与 Avoid when。",
                "evidence": {"sample_ids": [s.get("id") for s in hardest_cases[:5]]},
            }
        )

    return {
        "status": "ok",
        "summary": {
            "delta": round(delta, 4),
            "winner": report.get("winner", "unknown"),
            "treatment_win_rate": win_stats.get("treatment_win_rate", 0),
        },
        "suggestions": suggestions,
    }


def write_suggestions_files(suggestions: dict, json_path: Path, md_path: Path) -> dict:
    json_path.parent.mkdir(parents=True, exist_ok=True)
    json_path.write_text(json.dumps(suggestions, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    lines = [
        "# A/B 优化建议",
        "",
        f"- winner: `{suggestions.get('summary', {}).get('winner', 'unknown')}`",
        f"- delta: `{suggestions.get('summary', {}).get('delta', 0)}`",
        f"- treatment_win_rate: `{suggestions.get('summary', {}).get('treatment_win_rate', 0)}`",
        "",
        "## 建议清单",
        "",
    ]
    for i, s in enumerate(suggestions.get("suggestions", []), 1):
        lines.append(
            f"{i}. [{s.get('priority', 'P2')}] {s.get('area', 'general')} - {s.get('action', '')}"
        )
    lines.append("")
    md_path.write_text("\n".join(lines), encoding="utf-8")
    return {"json": str(json_path), "markdown": str(md_path)}


def evaluate_gate(
    report: dict,
    min_delta: float,
    min_win_rate: float,
    max_treatment_errors: int,
    regression_ok: bool = True,
) -> dict:
    """根据阈值做自动门禁判定；regression_ok 为 False 时回归门禁不通过。"""
    delta = float(report.get("delta", 0.0) or 0.0)
    win_rate = float((report.get("win_stats", {}) or {}).get("treatment_win_rate", 0.0) or 0.0)
    treatment_errors = int((report.get("error_stats", {}) or {}).get("treatment_error_count", 0) or 0)

    checks = {
        "delta_ok": delta >= min_delta,
        "win_rate_ok": win_rate >= min_win_rate,
        "error_ok": treatment_errors <= max_treatment_errors,
        "regression_ok": regression_ok,
    }
    passed = all(checks.values())
    reasons = []
    if not checks["delta_ok"]:
        reasons.append(f"delta({delta:.4f}) < min_delta({min_delta:.4f})")
    if not checks["win_rate_ok"]:
        reasons.append(f"win_rate({win_rate:.4f}) < min_win_rate({min_win_rate:.4f})")
    if not checks["error_ok"]:
        reasons.append(f"treatment_error_count({treatment_errors}) > max_treatment_errors({max_treatment_errors})")
    if not checks["regression_ok"]:
        reasons.append("regression_set_fail: 至少一样本 treatment 得分低于 control")

    return {
        "passed": passed,
        "checks": checks,
        "reasons": reasons,
        "thresholds": {
            "min_delta": min_delta,
            "min_win_rate": min_win_rate,
            "max_treatment_errors": max_treatment_errors,
        },
    }


def load_regression_set(path: Path) -> list[dict]:
    """加载回归集（与 ab_gold 同格式：id, user_input, gold_output, input_length, meta）。"""
    rows = _safe_jsonl_load(path)
    out: list[dict] = []
    for row in rows:
        sid = str(row.get("id", "") or "").strip()
        user_input = str(row.get("user_input", "") or "").strip()
        gold_output = str(row.get("gold_output", "") or "").strip()
        if not sid or not user_input or not gold_output:
            continue
        out.append({
            "id": sid,
            "user_input": user_input,
            "gold_output": gold_output,
            "input_length": int(row.get("input_length", 0) or len(user_input)),
            "meta": row.get("meta") or {},
        })
    return out


def build_regression_requests(
    regression_rows: list[dict],
    pool_samples: list[Sample],
    fewshot_k: int,
    out_dir: Path,
) -> tuple[Path, Path]:
    """为回归集构建 control/treatment 请求文件，返回 (control_path, treatment_path)。"""
    control_lines: list[str] = []
    treatment_lines: list[str] = []
    for row in regression_rows:
        sid = row["id"]
        user_input = row["user_input"]
        control = {"id": sid, "messages": [{"role": "user", "content": user_input}]}
        fewshots = _pick_fewshot(user_input, pool_samples, fewshot_k)
        treatment_messages: list[dict] = [
            {
                "role": "system",
                "content": (
                    "你将看到历史高质量示例。仅借鉴表达结构，不要引入与当前问题无关的信息；"
                    "优先保持事实保守与可验证，无法确认时明确说明不确定。"
                ),
            }
        ]
        for fs in fewshots:
            treatment_messages.append({"role": "user", "content": fs.user_input})
            treatment_messages.append({"role": "assistant", "content": fs.strong_output})
        treatment_messages.append({"role": "user", "content": user_input})
        treatment = {
            "id": sid,
            "messages": treatment_messages,
            "meta": {"variant": "treatment", "fewshot_count": len(fewshots)},
        }
        control_lines.append(json.dumps(control, ensure_ascii=False))
        treatment_lines.append(json.dumps(treatment, ensure_ascii=False))

    out_dir.mkdir(parents=True, exist_ok=True)
    control_path = out_dir / "ab_regression_control_requests.jsonl"
    treatment_path = out_dir / "ab_regression_treatment_requests.jsonl"
    control_path.write_text("\n".join(control_lines) + "\n", encoding="utf-8")
    treatment_path.write_text("\n".join(treatment_lines) + "\n", encoding="utf-8")
    return control_path, treatment_path


def score_regression_set(
    control_pred_path: Path,
    treatment_pred_path: Path,
    regression_rows: list[dict],
) -> dict:
    """对回归集评分：任一样本 treatment 得分低于 control 则 regression_ok=False。"""
    control = _load_predictions(control_pred_path)
    treatment = _load_predictions(treatment_pred_path)
    gold_by_id = {r["id"]: r["gold_output"] for r in regression_rows}
    sids = sorted(set(gold_by_id.keys()) & set(control.keys()) & set(treatment.keys()))
    details: list[dict] = []
    regression_ok = True
    for sid in sids:
        ref = gold_by_id[sid]
        c_out = control[sid]
        t_out = treatment[sid]
        c_score = _similarity(c_out, ref)
        t_score = _similarity(t_out, ref)
        if t_score < c_score:
            regression_ok = False
        details.append({
            "id": sid,
            "control_similarity": round(c_score, 4),
            "treatment_similarity": round(t_score, 4),
            "regression": t_score < c_score,
        })
    return {"regression_ok": regression_ok, "details": details, "count": len(sids)}


def resolve_gate_thresholds(
    preset: str,
    strict: bool,
    min_delta: float,
    min_win_rate: float,
    max_treatment_errors: int,
) -> tuple[float, float, int, str]:
    """解析门禁阈值：preset/strict 先给默认值，再由显式参数覆盖。"""
    effective_preset = "strict" if strict else (preset or "default")
    defaults = {
        "default": (0.0, 0.5, 0),
        "strict": (0.01, 0.6, 0),
        "relaxed": (-0.01, 0.45, 2),
    }
    if effective_preset not in defaults:
        effective_preset = "default"
    p_delta, p_win, p_err = defaults[effective_preset]

    # CLI 仍可覆盖 preset 值
    return float(min_delta if min_delta is not None else p_delta), float(
        min_win_rate if min_win_rate is not None else p_win
    ), int(max_treatment_errors if max_treatment_errors is not None else p_err), effective_preset


def append_history(history_path: Path, record: dict) -> str:
    """追加一条评测历史记录（jsonl）。"""
    history_path.parent.mkdir(parents=True, exist_ok=True)
    row = dict(record)
    row["timestamp"] = datetime.now(timezone.utc).isoformat()
    with history_path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")
    return str(history_path)


def _to_lc_messages(messages: list[dict]) -> list:
    from langchain_core.messages import HumanMessage, AIMessage, SystemMessage

    result: list = []
    for m in messages:
        role = str(m.get("role", "") or "").strip().lower()
        content = str(m.get("content", "") or "")
        if not content:
            continue
        if role == "system":
            result.append(SystemMessage(content=content))
        elif role == "assistant":
            result.append(AIMessage(content=content))
        else:
            result.append(HumanMessage(content=content))
    return result


def run_predictions(
    requests_path: Path,
    output_path: Path,
    model_id: str,
    task_type: str = "analysis",
) -> dict:
    root = Path(__file__).resolve().parents[5]
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))

    from backend.engine.agent.model_manager import get_model_manager

    req_rows = _safe_jsonl_load(requests_path)
    if not req_rows:
        raise ValueError(f"请求文件为空或不存在: {requests_path}")

    manager = get_model_manager()
    llm = manager.create_llm(
        config={"configurable": {"model": model_id, "escalation_enabled": False}},
        task_type=task_type,
    )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    lines: list[str] = []
    for row in req_rows:
        sid = str(row.get("id", "") or "").strip()
        msgs = row.get("messages") or []
        if not sid or not isinstance(msgs, list):
            continue
        lc_messages = _to_lc_messages(msgs)
        if not lc_messages:
            continue
        try:
            resp = llm.invoke(lc_messages)
            text = str(getattr(resp, "content", "") or "").strip()
        except Exception as e:
            text = f"[ERROR] {e}"
        lines.append(json.dumps({"id": sid, "output": text}, ensure_ascii=False))

    output_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return {"status": "ok", "count": len(lines), "output": str(output_path)}


def run_ab(
    input_path: Path,
    out_dir: Path,
    eval_size: int,
    fewshot_k: int,
    seed: int,
    model_id: str,
    task_type: str,
    min_delta: float = 0.0,
    min_win_rate: float = 0.5,
    max_treatment_errors: int = 0,
    history_path: Path | None = None,
    allow_insufficient_samples: bool = False,
    regression_set_path: Path | None = None,
) -> dict:
    # 样本不足时自动跳过门禁（不阻塞灰度），仅输出建议。
    try:
        sample_count = len(load_samples(input_path))
    except Exception:
        sample_count = 0
    if sample_count < 20:
        report_path = out_dir / "ab_report.json"
        gate_path = out_dir / "ab_gate.json"
        suggestions_json = out_dir / "ab_suggestions.json"
        suggestions_md = out_dir / "ab_suggestions.md"
        report = {
            "status": "skipped",
            "reason": "insufficient_distillation_samples",
            "detail": f"当前样本数 {sample_count}，低于建议门槛 20。",
            "count": sample_count,
        }
        gate = {
            "passed": True,
            "skipped": True,
            "checks": {"delta_ok": True, "win_rate_ok": True, "error_ok": True},
            "reasons": ["insufficient_distillation_samples_skip_gate"],
            "thresholds": {
                "min_delta": min_delta,
                "min_win_rate": min_win_rate,
                "max_treatment_errors": max_treatment_errors,
                "min_samples": 20,
            },
        }
        suggestions = {
            "status": "ok",
            "summary": {"delta": 0.0, "winner": "skipped", "treatment_win_rate": 0.0},
            "suggestions": [
                {
                    "priority": "P0",
                    "area": "data_collection",
                    "action": "继续累积真实蒸馏样本，达到 20 条后自动恢复 A/B 门禁评估。",
                    "evidence": {"current_samples": sample_count, "required_min": 20},
                }
            ],
        }
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        gate_path.write_text(json.dumps(gate, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        suggestion_files = write_suggestions_files(suggestions, suggestions_json, suggestions_md)
        history_file = history_path or (out_dir / "ab_history.jsonl")
        history_record_path = append_history(
            history_file,
            {
                "mode": "run",
                "report": {"count": sample_count, "delta": 0.0, "winner": "skipped", "treatment_win_rate": 0.0},
                "gate": gate,
                "artifacts": {
                    "report_path": str(report_path),
                    "gate_path": str(gate_path),
                    "suggestions_json": suggestion_files.get("json"),
                },
            },
        )
        return {
            "status": "ok",
            "build": {"status": "skipped", "reason": "insufficient_distillation_samples"},
            "report": report,
            "report_path": str(report_path),
            "suggestions": suggestions,
            "suggestions_files": suggestion_files,
            "gate": gate,
            "gate_path": str(gate_path),
            "history_path": history_record_path,
        }

    try:
        build_result = build_sets(
            input_path=input_path,
            out_dir=out_dir,
            eval_size=eval_size,
            fewshot_k=fewshot_k,
            seed=seed,
        )
    except ValueError as e:
        msg = str(e)
        if allow_insufficient_samples and "样本过少" in msg:
            report_path = out_dir / "ab_report.json"
            gate_path = out_dir / "ab_gate.json"
            suggestions_json = out_dir / "ab_suggestions.json"
            suggestions_md = out_dir / "ab_suggestions.md"
            report = {
                "status": "skipped",
                "reason": "insufficient_distillation_samples",
                "detail": msg,
            }
            gate = {
                "passed": True,
                "skipped": True,
                "checks": {"delta_ok": False, "win_rate_ok": False, "error_ok": True},
                "reasons": ["insufficient_distillation_samples_skip_gate"],
                "thresholds": {
                    "min_delta": min_delta,
                    "min_win_rate": min_win_rate,
                    "max_treatment_errors": max_treatment_errors,
                },
            }
            suggestions = {
                "status": "ok",
                "summary": {"delta": 0.0, "winner": "unknown", "treatment_win_rate": 0.0},
                "suggestions": [
                    {
                        "priority": "P0",
                        "area": "data_collection",
                        "action": "蒸馏样本不足，先累积至少 4 条样本后再执行 A/B 评测。",
                        "evidence": {"required_min": 4},
                    }
                ],
            }
            report_path.parent.mkdir(parents=True, exist_ok=True)
            report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            gate_path.write_text(json.dumps(gate, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            suggestion_files = write_suggestions_files(suggestions, suggestions_json, suggestions_md)
            history_file = history_path or (out_dir / "ab_history.jsonl")
            history_record_path = append_history(
                history_file,
                {
                    "mode": "run",
                    "report": report,
                    "gate": gate,
                    "artifacts": {
                        "report_path": str(report_path),
                        "gate_path": str(gate_path),
                        "suggestions_json": suggestion_files.get("json"),
                    },
                },
            )
            return {
                "status": "ok",
                "build": {"status": "skipped", "reason": "insufficient_distillation_samples"},
                "report": report,
                "report_path": str(report_path),
                "suggestions": suggestions,
                "suggestions_files": suggestion_files,
                "gate": gate,
                "gate_path": str(gate_path),
                "history_path": history_record_path,
            }
        raise
    control_req = Path(build_result["control_path"])
    treatment_req = Path(build_result["treatment_path"])
    gold_path = Path(build_result["gold_path"])

    control_pred = out_dir / "ab_control_predictions.jsonl"
    treatment_pred = out_dir / "ab_treatment_predictions.jsonl"
    report_path = out_dir / "ab_report.json"
    suggestions_json = out_dir / "ab_suggestions.json"
    suggestions_md = out_dir / "ab_suggestions.md"
    gate_path = out_dir / "ab_gate.json"

    pred_a = run_predictions(control_req, control_pred, model_id=model_id, task_type=task_type)
    pred_b = run_predictions(treatment_req, treatment_pred, model_id=model_id, task_type=task_type)
    report = score_sets(control_pred, treatment_pred, gold_path, report_path)
    suggestions = generate_optimization_suggestions(report)
    suggestion_files = write_suggestions_files(suggestions, suggestions_json, suggestions_md)

    regression_ok = True
    if regression_set_path and regression_set_path.exists():
        regression_rows = load_regression_set(regression_set_path)
        if regression_rows:
            pool = load_samples(input_path)
            reg_control_req, reg_treatment_req = build_regression_requests(
                regression_rows, pool, fewshot_k, out_dir
            )
            reg_control_pred = out_dir / "ab_regression_control_predictions.jsonl"
            reg_treatment_pred = out_dir / "ab_regression_treatment_predictions.jsonl"
            run_predictions(reg_control_req, reg_control_pred, model_id=model_id, task_type=task_type)
            run_predictions(reg_treatment_req, reg_treatment_pred, model_id=model_id, task_type=task_type)
            reg_result = score_regression_set(reg_control_pred, reg_treatment_pred, regression_rows)
            regression_ok = reg_result["regression_ok"]

    gate = evaluate_gate(
        report,
        min_delta=min_delta,
        min_win_rate=min_win_rate,
        max_treatment_errors=max_treatment_errors,
        regression_ok=regression_ok,
    )
    gate_path.write_text(json.dumps(gate, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    history_file = history_path or (out_dir / "ab_history.jsonl")
    history_record_path = append_history(
        history_file,
        {
            "mode": "run",
            "report": {
                "count": report.get("count", 0),
                "delta": report.get("delta", 0.0),
                "winner": report.get("winner", "unknown"),
                "treatment_win_rate": (report.get("win_stats", {}) or {}).get("treatment_win_rate", 0.0),
            },
            "gate": gate,
            "artifacts": {
                "report_path": str(report_path),
                "gate_path": str(gate_path),
                "suggestions_json": suggestion_files.get("json"),
            },
        },
    )

    return {
        "status": "ok",
        "build": build_result,
        "control_predict": pred_a,
        "treatment_predict": pred_b,
        "report": report,
        "report_path": str(report_path),
        "suggestions": suggestions,
        "suggestions_files": suggestion_files,
        "gate": gate,
        "gate_path": str(gate_path),
        "history_path": history_record_path,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Distillation few-shot A/B evaluation helper")
    parser.add_argument("--mode", choices=["build", "score", "run"], required=True)

    parser.add_argument("--input", default="knowledge_base/learned/distillation_samples.jsonl")
    parser.add_argument("--out-dir", default="knowledge_base/learned/ab_eval")
    parser.add_argument("--eval-size", type=int, default=20)
    parser.add_argument("--fewshot-k", type=int, default=2)
    parser.add_argument("--seed", type=int, default=42)

    parser.add_argument("--control-pred", default="")
    parser.add_argument("--treatment-pred", default="")
    parser.add_argument("--gold", default="knowledge_base/learned/ab_eval/ab_gold.jsonl")
    parser.add_argument("--report", default="knowledge_base/learned/ab_eval/ab_report.json")
    parser.add_argument("--suggestions-json", default="knowledge_base/learned/ab_eval/ab_suggestions.json")
    parser.add_argument("--suggestions-md", default="knowledge_base/learned/ab_eval/ab_suggestions.md")
    parser.add_argument("--gate", default="knowledge_base/learned/ab_eval/ab_gate.json")
    parser.add_argument("--history", default="knowledge_base/learned/ab_eval/ab_history.jsonl")
    parser.add_argument("--preset", choices=["default", "strict", "relaxed"], default="default")
    parser.add_argument("--strict", action="store_true")
    parser.add_argument("--min-delta", type=float, default=None)
    parser.add_argument("--min-win-rate", type=float, default=None)
    parser.add_argument("--max-treatment-errors", type=int, default=None)
    parser.add_argument("--allow-insufficient-samples", action="store_true")
    parser.add_argument("--fail-on-gate", action="store_true")
    parser.add_argument(
        "--regression-set",
        default="knowledge_base/learned/ab_eval/ab_regression_set.jsonl",
        help="回归集 jsonl 路径（与 ab_gold 同格式）；空则不做回归门禁",
    )
    parser.add_argument("--model", default="auto")
    parser.add_argument("--task-type", default="analysis")
    args = parser.parse_args()

    min_delta, min_win_rate, max_treatment_errors, effective_preset = resolve_gate_thresholds(
        preset=args.preset,
        strict=args.strict,
        min_delta=args.min_delta,
        min_win_rate=args.min_win_rate,
        max_treatment_errors=args.max_treatment_errors,
    )

    if args.mode == "build":
        result = build_sets(
            input_path=Path(args.input).resolve(),
            out_dir=Path(args.out_dir).resolve(),
            eval_size=args.eval_size,
            fewshot_k=args.fewshot_k,
            seed=args.seed,
        )
    elif args.mode == "score":
        if not args.control_pred or not args.treatment_pred:
            raise ValueError("score 模式必须提供 --control-pred 与 --treatment-pred。")
        result = score_sets(
            control_pred=Path(args.control_pred).resolve(),
            treatment_pred=Path(args.treatment_pred).resolve(),
            gold_path=Path(args.gold).resolve(),
            out_path=Path(args.report).resolve(),
        )
        suggestions = generate_optimization_suggestions(result)
        files = write_suggestions_files(
            suggestions,
            Path(args.suggestions_json).resolve(),
            Path(args.suggestions_md).resolve(),
        )
        gate = evaluate_gate(
            result,
            min_delta=min_delta,
            min_win_rate=min_win_rate,
            max_treatment_errors=max_treatment_errors,
        )
        gate_path = Path(args.gate).resolve()
        gate_path.parent.mkdir(parents=True, exist_ok=True)
        gate_path.write_text(json.dumps(gate, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        history_path = append_history(
            Path(args.history).resolve(),
            {
                "mode": "score",
                "report": {
                    "count": result.get("count", 0),
                    "delta": result.get("delta", 0.0),
                    "winner": result.get("winner", "unknown"),
                    "treatment_win_rate": (result.get("win_stats", {}) or {}).get("treatment_win_rate", 0.0),
                },
                "gate": gate,
                "gate_preset": effective_preset,
                "artifacts": {
                    "report_path": str(Path(args.report).resolve()),
                    "gate_path": str(gate_path),
                    "suggestions_json": files.get("json"),
                },
            },
        )
        result = {
            "status": "ok",
            "report": result,
            "report_path": str(Path(args.report).resolve()),
            "suggestions": suggestions,
            "suggestions_files": files,
            "gate": gate,
            "gate_path": str(gate_path),
            "history_path": history_path,
            "gate_preset": effective_preset,
        }
    else:
        regression_set = Path(args.regression_set).resolve() if args.regression_set else None
        result = run_ab(
            input_path=Path(args.input).resolve(),
            out_dir=Path(args.out_dir).resolve(),
            eval_size=args.eval_size,
            fewshot_k=args.fewshot_k,
            seed=args.seed,
            model_id=args.model,
            task_type=args.task_type,
            min_delta=min_delta,
            min_win_rate=min_win_rate,
            max_treatment_errors=max_treatment_errors,
            history_path=Path(args.history).resolve(),
            allow_insufficient_samples=bool(args.allow_insufficient_samples),
            regression_set_path=regression_set if (regression_set and regression_set.exists()) else None,
        )
        if isinstance(result, dict):
            result["gate_preset"] = effective_preset
    print(json.dumps(result, ensure_ascii=False, indent=2))

    # CI 场景：门禁失败时返回非 0，便于流水线阻断
    if args.fail_on_gate:
        gate = result.get("gate") if isinstance(result, dict) else None
        if isinstance(gate, dict) and not bool(gate.get("passed", False)):
            sys.exit(2)


if __name__ == "__main__":
    main()

