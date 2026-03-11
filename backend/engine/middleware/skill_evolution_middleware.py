"""Skill evolution middleware for self-learning loops.

Tracks skill usage, diagnoses performance (roses/buds/thorns),
applies lightweight ZERA-like quality scoring, auto-crystallizes
high-frequency patterns, and keeps a structured REMO-style notebook.
"""

from __future__ import annotations

import concurrent.futures
import json
import logging
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from langchain.agents.middleware.types import AgentMiddleware, AgentState
from langgraph.runtime import Runtime

from backend.tools.base.paths import get_project_root

logger = logging.getLogger(__name__)

CRYSTALLIZE_FREQ_THRESHOLD = 5
CRYSTALLIZE_SUCCESS_RATE = 0.7
QUALITY_ALERT_THRESHOLD = 0.5
PATTERN_MIN_TOOL_CALLS = 3
GROWTH_RADAR_INTERVAL = 50


@dataclass
class SkillStats:
    frequency: int = 0
    success: int = 0
    failures: int = 0
    completeness: float = 1.0
    correctness: float = 1.0
    reasoning_quality: float = 1.0
    user_satisfaction: float = 1.0


class SkillEvolutionMiddleware(AgentMiddleware):
    """Track usage, write insights, and trigger crystallization suggestions."""

    def __init__(self) -> None:
        root = get_project_root() / "knowledge_base" / "learned"
        self.stats_dir = root / "skill_stats"
        self.insights_dir = root / "insights"
        self.mistakes_dir = root / "mistakes"
        self.patterns_dir = root / "patterns"
        self.skills_draft_dir = root / "skills"
        self.review_queue_path = root / "human_review_queue.jsonl"
        self.state_path = root / "skill_evolution_state.json"
        for p in (self.stats_dir, self.insights_dir, self.mistakes_dir, self.patterns_dir, self.skills_draft_dir):
            p.mkdir(parents=True, exist_ok=True)
        self._stats_cache: dict[str, tuple[SkillStats, float]] = {}
        self._review_queue_cache: tuple[set[str], float] | None = None
        self._state = self._load_state()

    def _load_state(self) -> dict[str, Any]:
        if not self.state_path.exists():
            return {"interaction_count": 0}
        try:
            data = json.loads(self.state_path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return {"interaction_count": int(data.get("interaction_count", 0))}
        except Exception:
            pass
        return {"interaction_count": 0}

    def _save_state(self) -> None:
        import os
        import tempfile
        data = json.dumps(self._state, ensure_ascii=False, indent=2)
        tmp: str | None = None
        try:
            fd, tmp = tempfile.mkstemp(suffix=".tmp", dir=self.state_path.parent, prefix="evo_state_")
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self.state_path)
        except Exception:
            if tmp is not None:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
            self.state_path.write_text(data, encoding="utf-8")

    def _load_stats(self, skill: str) -> SkillStats:
        path = self.stats_dir / f"{skill}.json"
        if not path.exists():
            return SkillStats()
        try:
            mtime = path.stat().st_mtime
        except OSError:
            return SkillStats()
        cached = self._stats_cache.get(skill)
        if cached and cached[1] == mtime:
            return cached[0]
        try:
            stats = SkillStats(**json.loads(path.read_text(encoding="utf-8")))
        except Exception:
            return SkillStats()
        self._stats_cache[skill] = (stats, mtime)
        return stats

    def _save_stats(self, skill: str, stats: SkillStats) -> None:
        path = self.stats_dir / f"{skill}.json"
        path.write_text(json.dumps(asdict(stats), ensure_ascii=False, indent=2), encoding="utf-8")
        try:
            self._stats_cache[skill] = (stats, path.stat().st_mtime)
        except OSError:
            self._stats_cache.pop(skill, None)

    def _normalize_skill_name(self, raw: str) -> str:
        text = (raw or "").strip().replace("\\", "/")
        if not text:
            return "run_skill_script"
        if "/skills/" in text:
            try:
                return text.split("/skills/", 1)[1].strip("/") or "run_skill_script"
            except Exception:
                return text
        return text

    def _extract_skill_signals(self, messages: list[Any]) -> list[tuple[str, bool]]:
        """Extract (skill_name, success) tuples from message history.

        Strategy: first pass collects call-id → skill_name from AI tool_calls;
        second pass reads tool-return messages and resolves success/failure.
        Unmatched tool_calls (no return yet) are ignored.
        """
        call_id_to_skill: dict[str, str] = {}
        out: list[tuple[str, bool]] = []

        for msg in messages:
            msg_type = getattr(msg, "type", "")

            if msg_type != "tool":
                for call in getattr(msg, "tool_calls", None) or []:
                    try:
                        name = str(call.get("name", "") or "")
                        if name != "run_skill_script":
                            continue
                        args = call.get("args", {}) or {}
                        skill_path = str(
                            args.get("skill_path")
                            or args.get("script_path")
                            or args.get("path")
                            or "run_skill_script"
                        )
                        cid = str(call.get("id", "") or "")
                        call_id_to_skill[cid] = self._normalize_skill_name(skill_path)
                    except Exception:
                        pass
                continue

            content = str(getattr(msg, "content", "") or "")
            lower = content.lower()
            if "run_skill_script" not in lower:
                continue

            ok = (
                "失败" not in content
                and "error" not in lower
                and "traceback" not in lower
                and "exception" not in lower
            )

            tool_call_id = str(getattr(msg, "tool_call_id", "") or "")
            skill_name = call_id_to_skill.pop(tool_call_id, "run_skill_script")
            out.append((skill_name, ok))

        return out

    def _build_diagnosis(self, signals: list[tuple[str, bool]]) -> dict[str, list[str]]:
        by_skill: dict[str, dict[str, int]] = {}
        for skill, success in signals:
            item = by_skill.setdefault(skill, {"total": 0, "ok": 0, "fail": 0})
            item["total"] += 1
            if success:
                item["ok"] += 1
            else:
                item["fail"] += 1

        roses: list[str] = []
        buds: list[str] = []
        thorns: list[str] = []
        for skill, stat in by_skill.items():
            total = stat["total"]
            ok = stat["ok"]
            fail = stat["fail"]
            success_rate = ok / total if total else 0.0
            if fail == 0 and total >= 1:
                roses.append(f"{skill}: 本轮执行稳定（成功率 {success_rate:.0%}）")
            if total >= 3 and success_rate >= 0.6:
                buds.append(f"{skill}: 形成可复用模式（{ok}/{total}）")
            if fail > 0:
                thorns.append(f"{skill}: 存在失败样本（{fail} 次）")

        if not roses:
            roses.append("暂无显著稳定模式")
        if not buds:
            buds.append("暂无达到结晶阈值的候选模式")
        if not thorns:
            thorns.append("暂无明显失败模式")
        return {"roses": roses, "buds": buds, "thorns": thorns}

    def _latest_user_feedback(self, messages: list[Any]) -> tuple[str, float]:
        """Return (feedback_text, satisfaction_score in [0, 1])."""
        for msg in reversed(messages):
            if getattr(msg, "type", "") != "human":
                continue
            text = str(getattr(msg, "content", "") or "").strip()
            if not text:
                continue
            low = text.lower()
            negative_tokens = ("不对", "错误", "有问题", "不行", "返工", "重做", "wrong", "incorrect", "bug")
            positive_tokens = ("谢谢", "很好", "ok", "可以", "通过", "accept", "nice")
            if any(t in low for t in negative_tokens):
                return text, 0.3
            if any(t in low for t in positive_tokens):
                return text, 0.9
            return text, 0.7
        return "", 0.7

    def _update_quality_scores(
        self,
        stats: SkillStats,
        *,
        success: bool,
        user_satisfaction: float,
    ) -> SkillStats:
        if success:
            stats.completeness = min(1.0, stats.completeness + 0.01)
            stats.correctness = min(1.0, stats.correctness + 0.01)
            stats.reasoning_quality = min(1.0, stats.reasoning_quality + 0.01)
        else:
            stats.completeness = max(0.0, stats.completeness - 0.04)
            stats.correctness = max(0.0, stats.correctness - 0.05)
            stats.reasoning_quality = max(0.0, stats.reasoning_quality - 0.03)

        if user_satisfaction < 0.5:
            stats.completeness = max(0.0, stats.completeness - 0.03)
            stats.correctness = max(0.0, stats.correctness - 0.03)
            stats.reasoning_quality = max(0.0, stats.reasoning_quality - 0.02)
        elif user_satisfaction > 0.8:
            stats.completeness = min(1.0, stats.completeness + 0.01)
            stats.correctness = min(1.0, stats.correctness + 0.01)
            stats.reasoning_quality = min(1.0, stats.reasoning_quality + 0.01)

        stats.user_satisfaction = max(0.0, min(1.0, ((stats.user_satisfaction * 3) + user_satisfaction) / 4))
        return stats

    def _get_tool_chain(self, messages: list[Any]) -> list[str]:
        names: list[str] = []
        for msg in messages:
            msg_type = getattr(msg, "type", "")
            if msg_type == "tool":
                nm = str(getattr(msg, "name", "") or "tool")
                names.append(nm)
                continue
            for call in getattr(msg, "tool_calls", None) or []:
                try:
                    names.append(str(call.get("name", "") or "tool"))
                except Exception:
                    continue
        return names

    def _extract_citation_from_messages(self, messages: list[Any]) -> dict[str, Any] | None:
        """从最近工具调用中提取 file 路径，用于 mistakes/patterns 的 citation（JIT 验证用）。"""
        for msg in reversed(messages):
            for call in getattr(msg, "tool_calls", None) or []:
                try:
                    name = str(call.get("name", "") or "")
                    args = call.get("args") or {}
                    if name == "read_file" and args.get("path"):
                        path = str(args["path"]).strip()
                        if path:
                            return {"file": path, "line_start": 1, "line_end": 1}
                except Exception:
                    continue
        return None

    def _extract_pattern_topic(self, skills: list[str], tool_chain: list[str]) -> str:
        if skills:
            return skills[0].replace("/", "-")
        if tool_chain:
            return tool_chain[0]
        return "general"

    def _append_pattern_markdown(self, ts: datetime, topic: str, tool_chain: list[str]) -> None:
        path = self.patterns_dir / f"{ts.strftime('%Y%m%d')}_{topic}.md"
        section = [
            f"## {ts.strftime('%H:%M:%S')} UTC",
            f"- Tool calls: {len(tool_chain)}",
            "- Pattern chain:",
        ]
        for idx, name in enumerate(tool_chain, start=1):
            section.append(f"  {idx}. {name}")
        section.append("")
        header = ""
        if not path.exists():
            header = f"# Reusable Patterns ({topic})\n\n"
        with path.open("a", encoding="utf-8") as f:
            f.write(header + "\n".join(section) + "\n")

    def _enqueue_human_review(self, now: str, skill: str, stats: SkillStats) -> bool:
        low_dims: list[str] = []
        if stats.completeness < QUALITY_ALERT_THRESHOLD:
            low_dims.append("completeness")
        if stats.correctness < QUALITY_ALERT_THRESHOLD:
            low_dims.append("correctness")
        if stats.reasoning_quality < QUALITY_ALERT_THRESHOLD:
            low_dims.append("reasoning_quality")
        if stats.user_satisfaction < QUALITY_ALERT_THRESHOLD:
            low_dims.append("user_satisfaction")
        if not low_dims:
            return False
        if self._recently_enqueued(skill):
            return True
        self._append_jsonl(
            self.review_queue_path,
            {
                "timestamp": now,
                "skill_name": skill,
                "low_dimensions": low_dims,
                "action": "human_review_required",
                "recommendation": "请人工复核此技能的步骤描述、证据约束和回退策略后再继续自动结晶。",
            },
        )
        return True

    def _recently_enqueued(self, skill: str, max_lines: int = 50) -> bool:
        """Check if skill was already enqueued recently to avoid flooding."""
        if not self.review_queue_path.exists():
            return False
        try:
            mtime = self.review_queue_path.stat().st_mtime
        except OSError:
            return False
        if self._review_queue_cache and self._review_queue_cache[1] == mtime:
            return skill in self._review_queue_cache[0]
        try:
            names: set[str] = set()
            lines = self.review_queue_path.read_text(encoding="utf-8").splitlines()
            for line in reversed(lines[-max_lines:]):
                line = line.strip()
                if not line:
                    continue
                row = json.loads(line)
                name = row.get("skill_name")
                if name:
                    names.add(name)
            self._review_queue_cache = (names, mtime)
            return skill in names
        except Exception:
            pass
        return False

    def _append_jsonl(self, path: Path, row: dict[str, Any]) -> None:
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
        if path == self.review_queue_path:
            self._review_queue_cache = None

    def _append_daily_insight_markdown(self, ts: datetime, insight: dict[str, Any]) -> None:
        """Write a human-readable daily insight log for quick review."""
        day = ts.strftime("%Y-%m-%d")
        md_path = self.insights_dir / f"{day}.md"
        lines: list[str] = []
        if not md_path.exists():
            lines.append(f"# MAIBOT 自我生长洞察日志（{day}）\n")
        lines.append(f"## {ts.strftime('%H:%M:%S')} UTC")
        lines.append(f"- 信号数量：{insight.get('signals_count', 0)}")
        lines.append(f"- 交互计数：{insight.get('interaction_count', '?')}")
        for section, key in [("Roses", "roses"), ("Buds", "buds"), ("Thorns", "thorns")]:
            items = insight.get(key) or []
            lines.append(f"- {section}:")
            for item in items:
                lines.append(f"  - {item}")
        quality_alerts = insight.get("quality_alerts") or []
        if quality_alerts:
            lines.append("- Quality Alerts:")
            for alert in quality_alerts:
                lines.append(f"  - {alert}")
        review_required = insight.get("human_review_required") or []
        if review_required:
            lines.append(f"- Human Review Required: {', '.join(review_required)}")
        crystallized = insight.get("crystallized") or []
        if crystallized:
            lines.append(f"- Crystallized: {', '.join(crystallized)}")
        lines.append("")
        with md_path.open("a", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")

    def _extract_error_context(self, messages: list[Any], skill: str) -> str:
        """Extract last few messages around the failure for the error notebook."""
        snippets: list[str] = [f"[skill] {skill}"]
        for msg in messages[-6:]:
            t = getattr(msg, "type", "?")
            c = str(getattr(msg, "content", "") or "")[:300]
            snippets.append(f"[{t}] {c}")
        return "\n".join(snippets)

    def _auto_crystallize(self, skill: str, stats: SkillStats, now: str) -> None:
        """Create a Skill draft when crystallization threshold is met."""
        draft_path = self.skills_draft_dir / skill.replace("/", "_")
        if draft_path.exists():
            return
        if self._has_similar_crystallized_skill(skill):
            return
        draft_path.mkdir(parents=True, exist_ok=True)
        skill_md = draft_path / "SKILL.md"
        success_rate = stats.success / stats.frequency if stats.frequency else 0
        generated = self._generate_skill_markdown_with_llm(skill, stats, now, success_rate)
        if not generated:
            generated = (
                f"# {skill} (auto-crystallized)\n\n"
                f"> Crystallized at {now} | freq={stats.frequency} | "
                f"success_rate={success_rate:.0%}\n\n"
                f"## Quality Snapshot\n\n"
                f"| Dimension | Score |\n"
                f"|-----------|-------|\n"
                f"| Completeness | {stats.completeness:.2f} |\n"
                f"| Correctness | {stats.correctness:.2f} |\n"
                f"| Reasoning Quality | {stats.reasoning_quality:.2f} |\n"
                f"| User Satisfaction | {stats.user_satisfaction:.2f} |\n\n"
                f"## Description\n\n"
                "Automatically extracted skill pattern from repeated successful usage.\n"
                "Review and refine before promoting to production.\n\n"
                "## Steps\n\n"
                "1. (fill in based on observed usage patterns)\n\n"
                "## Status\n\n"
                "- [x] Auto-crystallized\n"
                "- [ ] Reviewed by user\n"
                "- [ ] Promoted to production\n"
            )
        skill_md.write_text(generated, encoding="utf-8")
        logger.info("[SkillEvolution] Auto-crystallized skill draft: %s", skill)

    def _has_similar_crystallized_skill(self, skill: str) -> bool:
        candidate = skill.replace("/", "_").lower()
        try:
            for p in self.skills_draft_dir.glob("*/SKILL.md"):
                if candidate in p.parent.name.lower():
                    return True
        except Exception:
            return False
        return False

    def _generate_skill_markdown_with_llm(self, skill: str, stats: SkillStats, now: str, success_rate: float) -> str:
        try:
            from backend.engine.agent.model_manager import get_model_manager
            manager = get_model_manager()
            llm = manager.create_llm(config={"configurable": {"task_type": "planning"}}, task_type="analysis")
            messages = [
                {
                    "role": "system",
                    "content": "生成高质量 SKILL.md，包含：前提条件、输入、步骤、验证、失败回退。输出 markdown。",
                },
                {
                    "role": "user",
                    "content": (
                        f"skill={skill}\ncrystallized_at={now}\nfrequency={stats.frequency}\n"
                        f"success_rate={success_rate:.2f}\ncompleteness={stats.completeness:.2f}\n"
                        f"correctness={stats.correctness:.2f}\nreasoning={stats.reasoning_quality:.2f}\n"
                    ),
                },
            ]
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
                future = executor.submit(llm.invoke, messages)
                result = future.result(timeout=30.0)
            text = str(getattr(result, "content", "") or "").strip()
            if text and len(text) > 120:
                return text
        except concurrent.futures.TimeoutError:
            logger.warning("[SkillEvolution] _generate_skill_markdown_with_llm timeout")
        except Exception:
            pass
        return ""

    def _write_growth_radar_snapshot(self, ts: datetime) -> None:
        """Write a lightweight growth radar snapshot for proactive review."""
        rows: list[tuple[str, SkillStats, float]] = []
        for f in self.stats_dir.glob("*.json"):
            try:
                stat = SkillStats(**json.loads(f.read_text(encoding="utf-8")))
                rate = (stat.success / stat.frequency) if stat.frequency else 0.0
                rows.append((f.stem, stat, rate))
            except Exception:
                continue

        healthy = [
            (name, stat, rate)
            for name, stat, rate in rows
            if stat.frequency >= 3 and rate >= 0.7 and stat.correctness >= 0.8
        ]
        weak = [
            (name, stat, rate)
            for name, stat, rate in rows
            if stat.frequency >= 2 and (rate < 0.7 or stat.correctness < 0.8 or stat.reasoning_quality < 0.8)
        ]
        low_quality = [
            (name, stat)
            for name, stat, _ in rows
            if min(stat.completeness, stat.correctness, stat.reasoning_quality, stat.user_satisfaction) < QUALITY_ALERT_THRESHOLD
        ]
        top_mistakes: list[tuple[str, int]] = []
        for f in sorted(self.mistakes_dir.glob("*.jsonl")):
            try:
                cnt = len([ln for ln in f.read_text(encoding="utf-8").splitlines() if ln.strip()])
                if cnt > 0:
                    top_mistakes.append((f.stem, cnt))
            except Exception:
                continue

        day = ts.strftime("%Y-%m-%d")
        out = self.insights_dir / f"growth_radar_{day}.md"
        lines: list[str] = [
            f"# Growth Radar Snapshot ({day})",
            "",
            "## Healthy Skills",
        ]
        if healthy:
            for name, stat, rate in sorted(healthy, key=lambda x: x[2], reverse=True)[:10]:
                lines.append(f"- {name}: success={rate:.0%}, freq={stat.frequency}, correctness={stat.correctness:.2f}")
        else:
            lines.append("- none")

        lines.extend(["", "## Skills To Improve"])
        if weak:
            for name, stat, rate in sorted(weak, key=lambda x: x[2])[:10]:
                lines.append(
                    f"- {name}: success={rate:.0%}, freq={stat.frequency}, "
                    f"correctness={stat.correctness:.2f}, reasoning={stat.reasoning_quality:.2f}"
                )
        else:
            lines.append("- none")

        lines.extend(["", "## Low Quality Alerts"])
        if low_quality:
            for name, stat in sorted(
                low_quality,
                key=lambda x: min(x[1].completeness, x[1].correctness, x[1].reasoning_quality, x[1].user_satisfaction),
            )[:10]:
                lines.append(
                    f"- {name}: C={stat.completeness:.2f}, K={stat.correctness:.2f}, "
                    f"R={stat.reasoning_quality:.2f}, S={stat.user_satisfaction:.2f}"
                )
        else:
            lines.append("- none")

        lines.extend(["", "## Frequent Mistakes"])
        if top_mistakes:
            for name, cnt in sorted(top_mistakes, key=lambda x: x[1], reverse=True)[:10]:
                lines.append(f"- {name}: {cnt}")
        else:
            lines.append("- none")

        lines.extend([
            "",
            "## Next Actions",
            "- Review mistakes/*.jsonl for top weak skills.",
            "- Promote validated auto-crystallized drafts from learned/skills/ to production skills.",
            "- For any metric < 0.5, require human review before further auto-crystallization.",
            "",
        ])
        out.write_text("\n".join(lines), encoding="utf-8")

    def after_agent(self, state: AgentState, runtime: Runtime[Any]) -> dict[str, Any] | None:  # noqa: ARG002
        try:
            return self._after_agent_impl(state)
        except Exception:
            logger.exception("[SkillEvolution] after_agent failed; swallowing to avoid breaking main flow")
            return None

    def _after_agent_impl(self, state: AgentState) -> dict[str, Any] | None:
        messages = state.get("messages", [])
        signals = self._extract_skill_signals(messages)
        now_dt = datetime.now(timezone.utc)
        now = now_dt.isoformat()
        self._state["interaction_count"] = int(self._state.get("interaction_count", 0)) + 1
        interaction_count = int(self._state["interaction_count"])
        self._save_state()

        latest_user_text, user_satisfaction = self._latest_user_feedback(messages)
        low_text = latest_user_text.lower().replace(" ", "")
        should_force_radar = any(
            k in low_text for k in ("能力盘点", "检查系统能力", "growthradar", "自检")
        )
        if should_force_radar or (interaction_count % GROWTH_RADAR_INTERVAL == 0):
            self._write_growth_radar_snapshot(now_dt)

        if not signals:
            return None

        diagnosis = self._build_diagnosis(signals)
        crystallized: list[str] = []
        review_required: list[str] = []
        quality_alerts: list[str] = []
        tool_chain = self._get_tool_chain(messages)

        for skill, success in signals:
            stats = self._load_stats(skill)
            stats.frequency += 1
            stats.success += 1 if success else 0
            stats.failures += 0 if success else 1
            stats = self._update_quality_scores(
                stats,
                success=success,
                user_satisfaction=user_satisfaction,
            )
            self._save_stats(skill, stats)

            if not success:
                ctx = self._extract_error_context(messages, skill)
                error_type = "logic_error" if user_satisfaction < 0.5 else "tool_failure"
                row: dict[str, Any] = {
                    "timestamp": now,
                    "skill_name": skill,
                    "error_type": error_type,
                    "user_correction": latest_user_text if user_satisfaction < 0.5 else "",
                    "root_cause": "tool execution reported failure" if error_type == "tool_failure" else "user reported correction required",
                    "context_snapshot": ctx,
                    "suggested_fix": "refine skill script args or fallback strategy; add stricter evidence/calculation checks",
                    "preventive_rule": "Before running the same skill again, validate inputs and fallback path.",
                    "severity": "medium",
                    "resolved": False,
                }
                citation = self._extract_citation_from_messages(messages)
                if citation:
                    row["citation"] = citation
                self._append_jsonl(self.mistakes_dir / f"{skill.replace('/', '_')}.jsonl", row)

            if self._enqueue_human_review(now, skill, stats):
                review_required.append(skill)
                quality_alerts.append(
                    f"{skill}: C={stats.completeness:.2f}, K={stats.correctness:.2f}, "
                    f"R={stats.reasoning_quality:.2f}, S={stats.user_satisfaction:.2f}"
                )

            success_rate = (stats.success / stats.frequency) if stats.frequency else 0.0
            min_quality = min(stats.completeness, stats.correctness, stats.reasoning_quality, stats.user_satisfaction)
            if stats.frequency >= CRYSTALLIZE_FREQ_THRESHOLD and success_rate >= CRYSTALLIZE_SUCCESS_RATE:
                cand_row: dict[str, Any] = {
                    "timestamp": now,
                    "skill_name": skill,
                    "frequency": stats.frequency,
                    "success_rate": round(success_rate, 3),
                    "min_quality": round(min_quality, 3),
                }
                cand_citation = self._extract_citation_from_messages(messages)
                if cand_citation:
                    cand_row["citation"] = cand_citation
                self._append_jsonl(self.patterns_dir / "crystallization_candidates.jsonl", cand_row)
                if min_quality >= QUALITY_ALERT_THRESHOLD:
                    self._auto_crystallize(skill, stats, now)
                    crystallized.append(skill)
                else:
                    logger.info(
                        "[SkillEvolution] Crystallization blocked for %s: min_quality=%.2f < %.2f",
                        skill, min_quality, QUALITY_ALERT_THRESHOLD,
                    )

        if len(tool_chain) >= PATTERN_MIN_TOOL_CALLS and all(ok for _, ok in signals):
            topic = self._extract_pattern_topic([s for s, _ in signals], tool_chain)
            self._append_pattern_markdown(now_dt, topic, tool_chain)

        insight = {
            "timestamp": now,
            "signals_count": len(signals),
            "interaction_count": interaction_count,
            "roses": diagnosis["roses"],
            "buds": diagnosis["buds"],
            "thorns": diagnosis["thorns"],
            "quality_alerts": quality_alerts,
            "human_review_required": review_required,
            "crystallized": crystallized,
        }
        self._append_jsonl(self.insights_dir / "auto_insights.jsonl", insight)
        self._append_daily_insight_markdown(now_dt, insight)
        return None

