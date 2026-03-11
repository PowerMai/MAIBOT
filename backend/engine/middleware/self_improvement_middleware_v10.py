from __future__ import annotations

import json
import os
import uuid
import logging
import threading
import concurrent.futures
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from langchain.agents.middleware.types import AgentMiddleware, AgentState
from langgraph.runtime import Runtime

from backend.tools.base.paths import get_project_root, get_workspace_root

try:
    from langsmith import Client as LangSmithClient
    from langsmith import traceable as _traceable
    from langsmith import evaluate as _langsmith_evaluate
except Exception:  # pragma: no cover
    LangSmithClient = None
    _traceable = None
    _langsmith_evaluate = None


def traceable(*args, **kwargs):
    if _traceable is None:
        def _noop(func):
            return func
        return _noop
    return _traceable(*args, **kwargs)

logger = logging.getLogger(__name__)

# 中文/英文任务描述 -> 标准 domain，用于 expertise_areas 自动积累
_CN_DOMAIN_MAP = {
    ("前端", "界面", "ui", "react", "vue", "css", "html"): "frontend",
    ("后端", "接口", "api", "server", "django", "fastapi"): "backend",
    ("修复", "bug", "错误", "报错", "异常", "fix"): "bugfix",
    ("数据库", "sql", "sqlite", "mysql", "pg", "redis"): "database",
    ("测试", "test", "单测", "coverage"): "testing",
    ("部署", "docker", "k8s", "ci", "cd", "devops"): "devops",
    ("文档", "doc", "readme", "注释"): "documentation",
    ("重构", "优化", "性能", "refactor"): "refactor",
    ("agent", "llm", "ai", "模型", "langchain", "langgraph"): "ai",
}


def _extract_domain(s: str) -> str:
    sl = s.lower()
    for keywords, domain in _CN_DOMAIN_MAP.items():
        if any(kw in sl for kw in keywords):
            return domain
    # 英文空格分词回退
    parts = "".join(c for c in s[:30] if c.isascii() and (c.isalnum() or c in "._- ")).strip().split()
    d = (parts[0] if parts else "general").lower()
    return d if len(d) >= 2 else "general"


class SelfImprovementMiddlewareV10(AgentMiddleware):
    """v10: 6 触发器 + WAL + Pattern Loop + VFM 评分。"""

    CORRECTION_PATTERNS = ("不对", "错了", "其实是", "应该是", "actually", "wrong")
    FEATURE_PATTERNS = ("能不能", "希望", "建议增加", "why can't", "feature")
    KNOWLEDGE_GAP_PATTERNS = ("不确定", "不知道", "不清楚", "unknown", "not sure")
    BETTER_OPTION_PATTERNS = ("更好的方案", "更优", "优化建议", "alternative", "better way")
    REPEAT_REQUEST_PATTERNS = ("每次都", "重复", "又要", "总是要", "recurring", "again")
    SELF_MODIFY_PATTERNS = ("自我修改", "改进自己", "改提示词", "改规则", "self-modify", "self improve")
    DECISION_PATTERNS = (
        "选择", "决定", "偏好", "倾向",
        "我喜欢", "我习惯", "我们一般", "通常用", "我倾向",
        "不用", "不想用", "不喜欢", "避免",
        "prefer", "choose", "decide", "would rather", "i like", "i prefer",
    )
    FEEDBACK_LABELS = (
        "correction",
        "feature",
        "knowledge_gap",
        "better_option",
        "repeat_request",
        "self_modify",
        "decision",
    )

    def __init__(self) -> None:
        ws = get_workspace_root()
        self.learnings_dir = ws / ".learnings"
        self.learnings_dir.mkdir(parents=True, exist_ok=True)
        self.session_state_path = ws / ".maibot" / "SESSION-STATE.md"
        self.working_buffer_path = ws / ".maibot" / "WORKING-BUFFER.md"
        self.maibot_memory_path = ws / ".maibot" / "MAIBOT.md"
        self.prompt_calibration_path = ws / ".maibot" / "prompt_calibration.json"
        self.evolution_scores_path = ws / ".maibot" / "EVOLUTION-SCORES.md"
        self.learn_path = self.learnings_dir / "LEARNINGS.md"
        self.err_path = self.learnings_dir / "ERRORS.md"
        self.feature_path = self.learnings_dir / "FEATURE_REQUESTS.md"
        self.suggestion_path = self.learnings_dir / "AUTOMATION_SUGGESTIONS.md"
        self.pattern_path = self.learnings_dir / "PATTERNS.json"
        self._langsmith_feedback_disabled = False
        self._pattern_cache: dict[str, Any] | None = None
        self._pattern_cache_mtime: float = 0
        self._ensure_templates()

    def _ensure_templates(self) -> None:
        for path, title in [
            (self.learn_path, "# LEARNINGS\n\n"),
            (self.err_path, "# ERRORS\n\n"),
            (self.feature_path, "# FEATURE_REQUESTS\n\n"),
            (self.suggestion_path, "# AUTOMATION_SUGGESTIONS\n\n"),
            (self.session_state_path, "# SESSION-STATE\n\n"),
            (self.working_buffer_path, "# WORKING-BUFFER\n\n"),
            (self.evolution_scores_path, "# EVOLUTION-SCORES\n\n"),
            (self.prompt_calibration_path, "{}"),
            (self.pattern_path, "{}"),
        ]:
            path.parent.mkdir(parents=True, exist_ok=True)
            if not path.exists():
                path.write_text(title, encoding="utf-8")
        if not self.maibot_memory_path.exists():
            self.maibot_memory_path.write_text(
                "# MAIBOT\n\n## 偏好\n\n## 经验\n\n## 规则\n\n",
                encoding="utf-8",
            )

    def _latest_human(self, messages: list[Any]) -> str:
        for msg in reversed(messages):
            if getattr(msg, "type", "") == "human":
                return str(getattr(msg, "content", "") or "").strip()
        return ""

    def _latest_ai(self, messages: list[Any]) -> str:
        for msg in reversed(messages):
            if getattr(msg, "type", "") == "ai":
                return str(getattr(msg, "content", "") or "").strip()
        return ""

    def _has_tool_error(self, messages: list[Any]) -> bool:
        for msg in reversed(messages):
            if getattr(msg, "type", "") != "tool":
                continue
            content = str(getattr(msg, "content", "") or "").lower()
            if any(tok in content for tok in ("error", "exception", "traceback", "failed", "失败")):
                return True
        return False

    def _append_md(self, path: Path, title: str, body: str) -> None:
        now = datetime.now(timezone.utc).isoformat()
        with path.open("a", encoding="utf-8") as f:
            f.write(f"## {title}\n\n**Logged**: {now}\n\n{body.strip()}\n\n---\n\n")

    def _append_session_state(self, category: str, text: str) -> None:
        now = datetime.now(timezone.utc).isoformat()
        with self.session_state_path.open("a", encoding="utf-8") as f:
            f.write(f"- [{now}] [{category}] {text[:320]}\n")

    def _append_maibot_memory(self, section: str, line: str) -> None:
        """将高价值模式沉淀到 .maibot/MAIBOT.md 的结构化段落。"""
        target_section = section if section in {"偏好", "经验", "规则"} else "经验"
        now = datetime.now(timezone.utc).isoformat()
        bullet = f"- [{now}] {line.strip()}"
        content = self.maibot_memory_path.read_text(encoding="utf-8")
        marker = f"## {target_section}"
        if marker not in content:
            content = content.rstrip() + f"\n\n{marker}\n\n{bullet}\n"
            self.maibot_memory_path.write_text(content, encoding="utf-8")
            return
        parts = content.split(marker, 1)
        before = parts[0]
        after = parts[1]
        split_idx = after.find("\n## ")
        if split_idx == -1:
            section_body = after.strip()
            tail = ""
        else:
            section_body = after[:split_idx].strip()
            tail = after[split_idx:]
        updated_body = f"{section_body}\n{bullet}\n".strip("\n")
        merged = f"{before}{marker}\n{updated_body}{tail}"
        self.maibot_memory_path.write_text(merged, encoding="utf-8")

    def _compact_working_buffer_if_needed(self) -> None:
        """Compaction Recovery：语义压缩，保留 guardrails/progress，提炼失败教训。"""
        try:
            lines = self.working_buffer_path.read_text(encoding="utf-8").splitlines()
        except Exception as e:
            logger.debug("[SelfImprovementV10] 读取 working buffer 失败: %s", e)
            return
        if len(lines) <= 180:
            return

        # 仅保留高价值状态：guardrail/progress/success，以及最近窗口
        high_value = []
        low_value_failures = []
        for ln in lines:
            low = (ln or "").lower()
            if any(k in low for k in ("guardrail", "progress", "promoted", "success", "完成", "已完成")):
                high_value.append(ln)
                continue
            if any(k in low for k in ("error", "failed", "失败", "exception", "traceback")):
                low_value_failures.append(ln)

        lessons = []
        for ln in low_value_failures[-6:]:
            raw = ln.strip()
            if not raw:
                continue
            lessons.append(f"- lesson: 试过 {raw[:120]}，结果失败；下次先换参数/工具再重试。")

        recent_tail = lines[-40:]
        keep = ["# WORKING-BUFFER", ""]
        keep.extend(high_value[-30:])
        if lessons:
            keep.extend(["## distilled_lessons", ""])
            keep.extend(lessons[:6])
            self._append_session_state("distilled_lesson", f"count={len(lessons[:6])}")
        keep.extend(["", "## recent_tail", ""])
        keep.extend(recent_tail)
        summary = f"working_buffer_compacted total={len(lines)} kept={len(keep)} high_value={len(high_value)}"
        self._append_session_state("compaction_recovery", summary)
        self.working_buffer_path.write_text("\n".join(keep).rstrip() + "\n", encoding="utf-8")

    def _extract_task_key(self, state: AgentState, runtime: Runtime[Any]) -> str:
        try:
            runtime_ctx = getattr(runtime, "context", {}) or {}
            configurable = runtime_ctx.get("configurable", {}) if isinstance(runtime_ctx, dict) else {}
            for k in ("task_id", "thread_id", "conversation_id", "session_id"):
                v = configurable.get(k) if isinstance(configurable, dict) else None
                if v:
                    return str(v)
        except Exception as e:
            logger.debug("[SelfImprovementV10] 提取 runtime task key 失败: %s", e)
        for k in ("task_id", "thread_id", "conversation_id", "run_id"):
            v = state.get(k)
            if v:
                return str(v)
        return datetime.now(timezone.utc).strftime("fallback-%Y%m%d")

    def _load_patterns(self) -> dict[str, Any]:
        try:
            mtime = self.pattern_path.stat().st_mtime
            if self._pattern_cache is not None and mtime == self._pattern_cache_mtime:
                return self._pattern_cache
        except OSError:
            return self._pattern_cache or {}
        try:
            data = json.loads(self.pattern_path.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                data = {}
        except Exception as e:
            logger.debug("[SelfImprovementV10] 读取 pattern 文件失败，使用空数据: %s", e)
            data = {}
        now = datetime.now(timezone.utc).isoformat()
        migrated: dict[str, Any] = {}
        for key, value in data.items():
            if isinstance(value, int):
                migrated[key] = {"count": value, "first_seen": now, "last_seen": now, "tasks": []}
            elif isinstance(value, dict):
                migrated[key] = {
                    "count": int(value.get("count", 0) or 0),
                    "first_seen": str(value.get("first_seen", now) or now),
                    "last_seen": str(value.get("last_seen", now) or now),
                    "tasks": [str(x) for x in (value.get("tasks", []) or []) if str(x).strip()],
                }
        self._pattern_cache = migrated
        try:
            self._pattern_cache_mtime = self.pattern_path.stat().st_mtime
        except OSError as e:
            logger.debug("[SelfImprovementV10] 获取 pattern mtime 失败: %s", e)
        return migrated

    def _update_pattern(self, key: str, task_key: str) -> dict[str, Any]:
        data = self._load_patterns()
        now = datetime.now(timezone.utc).isoformat()
        row = data.get(key, {"count": 0, "first_seen": now, "last_seen": now, "tasks": []})
        row["count"] = int(row.get("count", 0) or 0) + 1
        row["last_seen"] = now
        tasks = [str(x) for x in (row.get("tasks", []) or []) if str(x).strip()]
        if task_key and task_key not in tasks:
            tasks.append(task_key)
        row["tasks"] = tasks[-20:]
        data[key] = row
        self.pattern_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        self._pattern_cache = None
        return row

    def _should_promote(self, row: dict[str, Any]) -> bool:
        if int(row.get("count", 0) or 0) < 3:
            return False
        if len(set(str(x) for x in (row.get("tasks", []) or []))) < 2:
            return False
        try:
            first_seen = datetime.fromisoformat(str(row.get("first_seen")))
            last_seen = datetime.fromisoformat(str(row.get("last_seen")))
            return last_seen - first_seen <= timedelta(days=30)
        except Exception as e:
            logger.debug("[SelfImprovementV10] pattern 时间窗口解析失败: %s", e)
            return False

    def _promote_if_needed(self, key: str, row: dict[str, Any], summary: str) -> None:
        if not self._should_promote(row):
            return
        ws = get_workspace_root()
        soul = ws / ".maibot" / "SOUL.md"
        agents = ws / ".maibot" / "AGENTS.md"
        tools = ws / ".maibot" / "TOOLS.md"
        for p in (soul, agents, tools):
            p.parent.mkdir(parents=True, exist_ok=True)
            if not p.exists():
                p.write_text(f"# {p.stem}\n\n", encoding="utf-8")
        target = soul if key.startswith("correction:") else tools if key.startswith("tool_error:") else agents
        with target.open("a", encoding="utf-8") as f:
            f.write(
                f"- [PROMOTED] {summary} "
                f"(recurrence={int(row.get('count', 0) or 0)}, tasks={len(set(row.get('tasks', [])))}, within=30d)\n"
            )
        section = "规则"
        if key.startswith("feature:"):
            section = "偏好"
        elif key.startswith("tool_error:"):
            section = "经验"
        self._append_maibot_memory(
            section,
            f"[PROMOTED:{key}] {summary} "
            f"(recurrence={int(row.get('count', 0) or 0)}, tasks={len(set(row.get('tasks', [])))}, within=30d)",
        )

    def _extract_skill_if_needed(self, key: str, summary: str, row: dict[str, Any]) -> None:
        if not self._should_promote(row):
            return
        ws = get_project_root()
        safe_name = (
            key.replace(":", "-").replace("/", "-").replace("\\", "-").replace(" ", "-")
        )[:60].strip("-") or "auto-skill"
        skill_dir = ws / "knowledge_base" / "skills" / "learned" / safe_name
        skill_dir.mkdir(parents=True, exist_ok=True)
        skill_file = skill_dir / "SKILL.md"
        if skill_file.exists():
            return
        content = (
            "---\n"
            f"name: {safe_name}\n"
            "description: \"Auto-extracted from recurring pattern.\"\n"
            "metadata:\n"
            "  source: self_improvement_middleware_v10\n"
            "  quality_gate: recurrence>=3 && task_span>=2 && within_30_days\n"
            "---\n\n"
            f"# {safe_name}\n\n"
            "## Summary\n"
            f"{summary}\n\n"
            "## Workflow\n"
            "- 先检查约束。\n"
            "- 再执行最小必要改动。\n"
            "- 最后验证并沉淀。\n"
        )
        skill_file.write_text(content, encoding="utf-8")

    def _append_automation_suggestion(self, key: str, summary: str, row: dict[str, Any]) -> None:
        if int(row.get("count", 0) or 0) < 3:
            return
        with self.suggestion_path.open("a", encoding="utf-8") as f:
            f.write(
                "## recurring_pattern\n\n"
                f"- key: `{key}`\n"
                f"- summary: {summary[:160]}\n"
                f"- recurrence: {int(row.get('count', 0) or 0)}\n"
                f"- task_span: {len(set(row.get('tasks', [])))}\n"
                "- suggestion: 提取为 Skill 或自动化脚本。\n\n---\n\n"
            )

    def _vfm_score(self, text: str) -> dict[str, int]:
        t = (text or "").lower()
        frequency = 80 if any(k in t for k in ("每次", "重复", "高频", "always", "recurring")) else 40
        fail_reduce = 80 if any(k in t for k in ("失败", "错误", "不稳定", "error", "fail")) else 35
        user_burden = 80 if any(k in t for k in ("手动", "麻烦", "耗时", "manual", "friction")) else 35
        self_cost = 80 if any(k in t for k in ("小改", "最小改动", "低成本", "minimal")) else 40
        weighted = int(frequency * 0.35 + fail_reduce * 0.3 + user_burden * 0.2 + self_cost * 0.15)
        return {
            "frequency": frequency,
            "fail_reduction": fail_reduce,
            "user_burden": user_burden,
            "self_cost": self_cost,
            "weighted": weighted,
        }

    def _record_vfm(self, text: str, task_key: str) -> None:
        s = self._vfm_score(text)
        now = datetime.now(timezone.utc).isoformat()
        with self.evolution_scores_path.open("a", encoding="utf-8") as f:
            f.write(
                f"## {now}\n\n"
                f"- task: {task_key}\n"
                f"- frequency: {s['frequency']}\n"
                f"- fail_reduction: {s['fail_reduction']}\n"
                f"- user_burden: {s['user_burden']}\n"
                f"- self_cost: {s['self_cost']}\n"
                f"- weighted: {s['weighted']}\n"
                f"- decision: {'proceed' if s['weighted'] >= 50 else 'skip'}\n\n---\n\n"
            )
        if s["weighted"] < 50:
            self._append_session_state("vfm_guardrail", "拟议自我修改加权分<50，建议不执行。")

    def _latest_user_satisfaction(self, user_text: str) -> float:
        low = user_text.lower()
        if any(k in low for k in ("不对", "错误", "有问题", "bad", "wrong", "失败")):
            return 0.2
        if any(k in low for k in ("谢谢", "很好", "通过", "ok", "great", "nice")):
            return 0.9
        return 0.6

    def _llm_classify_feedback(self, user_text: str) -> set[str]:
        """批量分类 6 类反馈，失败时返回空集合。"""
        try:
            from backend.engine.agent.model_manager import get_model_manager
            manager = get_model_manager()
            llm = manager.create_llm(config={"configurable": {"task_type": "quick_answer"}}, task_type="fast")
            prompt = (
                "你是反馈分类器。把用户文本映射到标签数组，标签仅可从："
                "correction, feature, knowledge_gap, better_option, repeat_request, self_modify, decision。"
                "decision = 用户表达个人偏好、习惯或决策倾向（如我喜欢/不用/倾向于）。"
                "仅输出 JSON 数组，不要解释。"
            )
            def _invoke():
                return llm.invoke(
                    [
                        {"role": "system", "content": prompt},
                        {"role": "user", "content": user_text[:1200]},
                    ]
                )

            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
                future = executor.submit(_invoke)
                result = future.result(timeout=15.0)
            payload = json.loads(str(getattr(result, "content", "") or "[]"))
            if isinstance(payload, list):
                labels = {str(x).strip() for x in payload if str(x).strip() in self.FEEDBACK_LABELS}
                return labels
        except (concurrent.futures.TimeoutError, json.JSONDecodeError, ValueError) as e:
            logger.debug("[SelfImprovementV10] feedback classify fallback: %s", e)
        except Exception as e:
            logger.warning("[SelfImprovementV10] feedback classify failed: %s", e)
        return set()

    def _run_llm_classify_and_update(self, user_text: str, task_key: str, now: str) -> None:
        """后台执行 LLM 分类，避免阻塞 after_agent。含异常捕获。"""
        try:
            self._llm_classify_feedback(user_text)
        except Exception as e:
            logger.warning("[SelfImprovementV10] _run_llm_classify_and_update 出错（已忽略）: %s", e)

    def _send_langsmith_feedback(self, run_id: str, score: float, comment: str) -> None:
        if not run_id or LangSmithClient is None or self._langsmith_feedback_disabled:
            return
        if not os.getenv("LANGSMITH_API_KEY"):
            return
        try:
            uuid.UUID(str(run_id))
        except Exception as e:
            logger.debug("[SelfImprovementV10] run_id 非法，跳过 LangSmith 反馈: %s", e)
            return
        try:
            client = LangSmithClient()
            client.create_feedback(
                run_id=run_id,
                key="user_satisfaction",
                score=float(max(0.0, min(1.0, score))),
                comment=comment[:500],
            )
        except Exception as e:
            logger.debug("[SelfImprovementV10] LangSmith 反馈失败，后续将禁用: %s", e)
            self._langsmith_feedback_disabled = True
            return

    def _update_prompt_calibration(self, model_id: str, success: bool) -> None:
        try:
            data = json.loads(self.prompt_calibration_path.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                data = {}
        except Exception as e:
            logger.debug("[SelfImprovementV10] 读取 prompt calibration 失败，使用空数据: %s", e)
            data = {}
        bucket = data.setdefault(model_id or "unknown", {"success": 0, "fail": 0})
        bucket["success" if success else "fail"] = int(bucket.get("success" if success else "fail", 0)) + 1
        self.prompt_calibration_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    def _evaluate_distillation_quality(self, user_text: str, ai_text: str) -> bool:
        if _langsmith_evaluate is not None:
            try:
                def _predict(inputs: dict[str, Any]) -> dict[str, Any]:
                    _ = inputs
                    return {"output": ai_text}

                def _evaluator(run: dict[str, Any], example: dict[str, Any]) -> dict[str, Any]:
                    output = str((run or {}).get("output", "") or "")
                    _ = example
                    score = 1.0 if len(output.strip()) >= 60 else 0.0
                    return {"key": "min_quality", "score": score}

                _langsmith_evaluate(
                    _predict,
                    data=[{"inputs": {"input": user_text}, "outputs": {"output": ai_text}}],
                    evaluators=[_evaluator],
                    experiment_prefix="maibot-distill-gate",
                )
                return True
            except Exception as e:
                logger.debug("[SelfImprovementV10] distillation quality evaluate 失败，回退到启发式: %s", e)
        return len(user_text.strip()) >= 8 and len(ai_text.strip()) >= 60

    @traceable(name="maibot.self_improvement.after_agent")
    def after_agent(self, state: AgentState, runtime: Runtime[Any]) -> dict[str, Any] | None:  # noqa: ARG002
        try:
            messages = state.get("messages", [])
            if not messages:
                return None
            user_text = self._latest_human(messages)
            if not user_text:
                return None

            low = user_text.lower()
            task_key = self._extract_task_key(state, runtime)
            now = datetime.now(timezone.utc).isoformat()
            self._append_session_state("wal", f"{task_key}: {user_text[:240]}")
            with self.working_buffer_path.open("a", encoding="utf-8") as f:
                f.write(f"- [{now}] [{task_key}] {user_text[:180]}\n")
            self._compact_working_buffer_if_needed()

            def _hit(patterns: tuple[str, ...]) -> bool:
                return any(p in user_text for p in patterns) or any(p in low for p in patterns)
            t = threading.Thread(
                target=self._run_llm_classify_and_update,
                args=(user_text, task_key, now),
                daemon=True,
            )
            t.start()
            llm_labels = set()
            def _matched(label: str, patterns: tuple[str, ...]) -> bool:
                return (label in llm_labels) or _hit(patterns)

            if _matched("correction", self.CORRECTION_PATTERNS):
                key = f"correction:{_extract_domain(user_text)}"
                row = self._update_pattern(key, task_key)
                self._append_md(self.learn_path, "correction", f"### Summary\n{user_text}\n\n### Pattern-Key\n{key}")
                self._append_session_state("correction", user_text)
                self._promote_if_needed(key, row, user_text[:120])
                self._extract_skill_if_needed(key, user_text[:120], row)
                self._append_automation_suggestion(key, user_text, row)

            if _matched("feature", self.FEATURE_PATTERNS):
                key = f"feature:{_extract_domain(user_text)}"
                row = self._update_pattern(key, task_key)
                self._append_md(self.feature_path, "feature_request", f"### Requested Capability\n{user_text}\n\n### Pattern-Key\n{key}")
                self._append_session_state("feature", user_text)
                self._promote_if_needed(key, row, user_text[:120])
                self._extract_skill_if_needed(key, user_text[:120], row)
                self._append_automation_suggestion(key, user_text, row)

            if _matched("knowledge_gap", self.KNOWLEDGE_GAP_PATTERNS):
                key = f"knowledge_gap:{_extract_domain(user_text)}"
                row = self._update_pattern(key, task_key)
                self._append_md(self.err_path, "knowledge_gap", f"### Summary\n{user_text}\n\n### Pattern-Key\n{key}\n### Recurrence\n{row.get('count', 0)}")
                self._append_session_state("knowledge_gap", user_text)
                self._promote_if_needed(key, row, user_text[:120])
                self._extract_skill_if_needed(key, user_text[:120], row)
                self._append_automation_suggestion(key, user_text, row)

            if _matched("better_option", self.BETTER_OPTION_PATTERNS):
                key = f"better_option:{_extract_domain(user_text)}"
                row = self._update_pattern(key, task_key)
                self._append_md(self.learn_path, "better_option", f"### Summary\n{user_text}\n\n### Pattern-Key\n{key}\n### Recurrence\n{row.get('count', 0)}")
                self._append_session_state("better_option", user_text)
                self._promote_if_needed(key, row, user_text[:120])
                self._extract_skill_if_needed(key, user_text[:120], row)
                self._append_automation_suggestion(key, user_text, row)

            if _matched("repeat_request", self.REPEAT_REQUEST_PATTERNS):
                key = f"repeat_request:{_extract_domain(user_text)}"
                row = self._update_pattern(key, task_key)
                self._append_automation_suggestion(key, user_text, row)

            run_success = True
            if self._has_tool_error(messages):
                key = "tool_error:generic"
                row = self._update_pattern(key, task_key)
                self._append_md(self.err_path, "tool_error", f"### Summary\n工具调用失败或返回异常。\n\n### Pattern-Key\n{key}")
                self._promote_if_needed(key, row, "工具调用失败/异常")
                self._extract_skill_if_needed(key, "工具调用失败/异常", row)
                run_success = False

            if _matched("self_modify", self.SELF_MODIFY_PATTERNS):
                self._record_vfm(user_text, task_key)

            run_id = str(state.get("run_id", "") or "")
            self._send_langsmith_feedback(run_id, self._latest_user_satisfaction(user_text), user_text)
            model_id = str(state.get("model", "") or state.get("model_id", "") or "")
            self._update_prompt_calibration(model_id, run_success)

            ai_text = self._latest_ai(messages)
            if ai_text:
                ok = self._evaluate_distillation_quality(user_text, ai_text)
                self._append_session_state("distill_quality_gate", f"{task_key}: {'pass' if ok else 'fail'}")

            runtime_ctx = getattr(runtime, "context", {}) or {}
            configurable = runtime_ctx.get("configurable", {}) if isinstance(runtime_ctx, dict) else {}
            store = configurable.get("store")
            ws_id = (configurable.get("workspace_id") or configurable.get("workspace_path") or "").strip() or "default"
            if store and ws_id:
                try:
                    import time as _time
                    from backend.memory.user_model import get_user_profile, save_user_profile
                    profile = get_user_profile(store, ws_id)
                    if _matched("knowledge_gap", self.KNOWLEDGE_GAP_PATTERNS):
                        new_intent = {"id": str(int(_time.time())), "title": (task_key or user_text[:80])[:80], "created_at": now}
                        existing_titles = {i.get("title", "") for i in (profile.unsolved_intents or []) if isinstance(i, dict)}
                        if new_intent["title"] not in existing_titles:
                            profile.unsolved_intents = (profile.unsolved_intents or [])[-9:] + [new_intent]
                    if run_success:
                        trajectory_entry = user_text[:60] if user_text and user_text.strip() else (task_key or "task")[:60]
                        profile.learning_trajectory = (profile.learning_trajectory or [])[-19:] + [trajectory_entry]
                        profile.tool_breadth = len(set(profile.learning_trajectory or []))
                        if _matched("decision", self.DECISION_PATTERNS):
                            entry = (user_text or "")[:80].strip()
                            if entry:
                                existing = list(profile.decision_patterns or [])
                                if entry not in existing:
                                    profile.decision_patterns = (existing + [entry])[-20:]
                        traj = profile.learning_trajectory or []
                        from collections import Counter
                        domains = []
                        for t in traj:
                            s = (t or "").strip()
                            if not s:
                                continue
                            domain = _extract_domain(s)
                            if domain != "general":
                                domains.append(domain)
                        for domain, cnt in Counter(domains).items():
                            if cnt >= 3 and domain not in ("task", "general"):
                                level = "beginner" if cnt < 5 else ("intermediate" if cnt < 8 else "expert")
                                if not isinstance(profile.expertise_areas, dict):
                                    profile.expertise_areas = {}
                                if domain not in profile.expertise_areas or (
                                    (profile.expertise_areas.get(domain) == "beginner" and level != "beginner") or
                                    (profile.expertise_areas.get(domain) == "intermediate" and level == "expert")
                                ):
                                    profile.expertise_areas = dict(profile.expertise_areas)
                                    profile.expertise_areas[domain] = level
                    save_user_profile(store, ws_id, profile)
                except Exception as _e:
                    logger.debug("self_improvement profile update failed: %s", _e)
            return None
        except Exception as e:
            _tid = ""
            try:
                ctx = getattr(runtime, "context", None) or {}
                cfg = ctx.get("configurable", {}) if isinstance(ctx, dict) else {}
                _tid = str(cfg.get("thread_id") or "").strip()
            except Exception:
                pass
            logger.warning(
                "SelfImprovementMiddleware.after_agent 出错（已忽略，不阻断链）: %s thread_id=%s",
                e, _tid or "(none)",
            )
        return None
