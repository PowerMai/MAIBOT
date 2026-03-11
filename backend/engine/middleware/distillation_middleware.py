"""Distillation middleware: capture strong-model traces for weak-model improvement."""

from __future__ import annotations

import json
import threading
import re
import logging
import concurrent.futures
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional

from langchain.agents.middleware.types import AgentMiddleware, AgentState
from langgraph.runtime import Runtime

from backend.engine.agent.model_manager import get_model_manager
from backend.tools.base.paths import get_project_root

logger = logging.getLogger(__name__)

# 线程级结晶建议缓存：thread_id -> { skill_name, benefit, cost }，供前端拉取或 stream 事件
_crystallization_suggestions: Dict[str, Dict[str, Any]] = {}
_crystallization_lock = threading.Lock()


def get_crystallization_suggestion(thread_id: str) -> Optional[Dict[str, Any]]:
    """获取并消费该 thread 的结晶建议（取后即删）。"""
    with _crystallization_lock:
        return _crystallization_suggestions.pop(thread_id, None)


def set_crystallization_suggestion(thread_id: str, payload: Dict[str, Any]) -> None:
    with _crystallization_lock:
        _crystallization_suggestions[thread_id] = payload

_RE_JSON_OBJECT = re.compile(r"\{[\s\S]*\}")

try:
    from langsmith import traceable as _traceable
except Exception:  # pragma: no cover
    _traceable = None


def traceable(*args, **kwargs):
    if _traceable is None:
        def _noop(func):
            return func
        return _noop
    return _traceable(*args, **kwargs)


class DistillationMiddleware(AgentMiddleware):
    """Record (compressed_input, strong_output) style samples into JSONL."""

    def __init__(self) -> None:
        root = get_project_root() / "knowledge_base" / "learned"
        root.mkdir(parents=True, exist_ok=True)
        self.dataset_path = root / "distillation_samples.jsonl"
        self._write_lock = threading.Lock()

    def _latest_texts(self, messages: list[Any]) -> tuple[str, str]:
        latest_user = ""
        latest_ai = ""
        for msg in reversed(messages):
            t = getattr(msg, "type", "")
            if not latest_ai and t == "ai":
                latest_ai = str(getattr(msg, "content", "") or "").strip()
            if not latest_user and t == "human":
                latest_user = str(getattr(msg, "content", "") or "").strip()
            if latest_user and latest_ai:
                break
        return latest_user, latest_ai

    def _compress_input(self, text: str, max_len: int = 2000) -> str:
        text = text.strip()
        if len(text) <= max_len:
            return text
        return text[:max_len] + "\n...(truncated)"

    def _compress_input_with_llm(self, text: str) -> str:
        try:
            manager = get_model_manager()
            llm = manager.create_llm(config={"configurable": {"task_type": "quick_answer"}}, task_type="fast")
            prompt = "将输入压缩为蒸馏样本摘要，保留任务目标、约束、验收标准。输出纯文本，不超过600字。"
            def _invoke():
                return llm.invoke(
                    [
                        {"role": "system", "content": prompt},
                        {"role": "user", "content": text[:4000]},
                    ]
                )

            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
                future = executor.submit(_invoke)
                result = future.result(timeout=15.0)
            summary = str(getattr(result, "content", "") or "").strip()
            if summary:
                return summary[:2000]
        except concurrent.futures.TimeoutError as e:
            logger.debug("[Distillation] compress_input timeout fallback: %s", e)
        except Exception as e:
            logger.warning("[Distillation] compress_input failed: %s", e)
        return self._compress_input(text)

    def _recent_tool_names(self, messages: list[Any], max_items: int = 8) -> list[str]:
        names: list[str] = []
        for msg in messages:
            t = getattr(msg, "type", "")
            if t == "ai":
                for call in getattr(msg, "tool_calls", []) or []:
                    n = str((call or {}).get("name", "") or "").strip()
                    if n:
                        names.append(n)
        if not names:
            return []
        return names[-max_items:]

    def _infer_skill_hints(self, user_text: str, ai_text: str, tool_names: list[str]) -> list[str]:
        hints: list[str] = []
        blob = f"{user_text}\n{ai_text}".lower()
        kws = [
            "自动发现",
            "能力扩展",
            "自我生长",
            "自动升级",
            "auto-discovery",
            "self-growth",
            "mcp",
            "ontology",
        ]
        if any(k in blob for k in kws):
            hints.append("foundation/auto-discovery")
        if any(n in {"match_skills", "list_skills", "ontology_import"} for n in tool_names):
            hints.append("skills-or-ontology-discovery")
        return sorted(set(hints))

    # 结论性关键词：含其一且长度适中时可作为 fallback 通过质量门（与长度条件或关系）
    _CONCLUSION_KEYWORDS = (
        "综上", "因此", "建议", "结论", "推荐", "应当", "可以", "总结",
        "recommendation", "conclusion", "summary", "therefore", "suggest", "should",
    )

    def _quality_gate_passed(self, user_text: str, ai_text: str) -> bool:
        # 蒸馏样本质量门：避免过短/无信息输出污染样本池
        user_stripped = user_text.strip()
        ai_stripped = ai_text.strip()
        if len(user_stripped) < 8:
            return False
        if len(ai_stripped) < 60:
            # fallback：含结论性关键词且有一定长度时也通过
            ai_lower = ai_stripped.lower()
            if len(ai_stripped) >= 30 and any(
                (kw in ai_stripped) or (kw in ai_lower) for kw in self._CONCLUSION_KEYWORDS
            ):
                return True
            return False
        return True

    def _llm_quality_score(self, user_text: str, ai_text: str) -> float:
        try:
            manager = get_model_manager()
            llm = manager.create_llm(config={"configurable": {"task_type": "quick_answer"}}, task_type="fast")
            prompt = (
                "给回答质量打分(0-10)，评估维度：正确性、完整性、可执行性。"
                "仅输出 JSON: {\"score\": number}。"
            )
            def _invoke():
                return llm.invoke(
                    [
                        {"role": "system", "content": prompt},
                        {"role": "user", "content": f"用户输入: {user_text[:1000]}\n回答: {ai_text[:3000]}"},
                    ]
                )

            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
                future = executor.submit(_invoke)
                result = future.result(timeout=15.0)
            content = str(getattr(result, "content", "") or "").strip()
            if not content:
                return 0.0
            match = _RE_JSON_OBJECT.search(content)
            parsed = json.loads(match.group(0) if match else content)
            return float(parsed.get("score", 0.0) or 0.0)
        except (concurrent.futures.TimeoutError, json.JSONDecodeError, ValueError) as e:
            logger.debug("[Distillation] quality score fallback: %s", e)
            return 0.0
        except Exception as e:
            logger.warning("[Distillation] quality score failed: %s", e)
            return 0.0

    def _is_positive_feedback(self, user_text: str) -> bool:
        t = (user_text or "").strip().lower()
        if not t:
            return False
        positive_kws = [
            "谢谢",
            "感谢",
            "很好",
            "太棒",
            "满意",
            "good",
            "great",
            "nice",
            "works",
            "looks good",
            "perfect",
        ]
        return any(k in t for k in positive_kws)

    def _has_task_success_signal(self, messages: list[Any], ai_text: str) -> bool:
        text = (ai_text or "").strip().lower()
        if any(k in text for k in ("已完成", "完成如下", "completed", "done", "交付", "deliverable")):
            return True

        for msg in messages[-20:]:
            if getattr(msg, "type", "") != "ai":
                continue
            for call in getattr(msg, "tool_calls", []) or []:
                name = str((call or {}).get("name", "") or "").strip().lower()
                if name not in {"update_task", "report_progress", "write_todos"}:
                    continue
                args = (call or {}).get("args", {})
                if isinstance(args, str):
                    try:
                        args = json.loads(args)
                    except Exception:
                        args = {}
                if not isinstance(args, dict):
                    continue
                status = str(args.get("status", "") or "").strip().lower()
                progress = args.get("progress")
                if status == "completed":
                    return True
                if isinstance(progress, (int, float)) and float(progress) >= 100:
                    return True
        return False

    def _local_capture_reason(self, messages: list[Any], user_text: str, ai_text: str) -> str | None:
        if self._is_positive_feedback(user_text):
            return "user_positive_feedback"
        if self._has_task_success_signal(messages, ai_text):
            return "task_success_signal"
        return None

    def _extract_preference_pair(self, messages: list[Any], ai_text: str) -> dict[str, str] | None:
        """若用户紧随其后给出纠正文本，记录偏好对。"""
        try:
            latest_user = ""
            for msg in reversed(messages):
                if getattr(msg, "type", "") == "human":
                    latest_user = str(getattr(msg, "content", "") or "").strip()
                    break
            if not latest_user:
                return None
            low = latest_user.lower()
            if any(k in low for k in ("应该", "不是", "错了", "不对", "改成", "应为", "should")):
                prev_ai_text = ""
                found_user = False
                for msg in reversed(messages):
                    mtype = getattr(msg, "type", "")
                    if not found_user and mtype == "human":
                        found_user = True
                        continue
                    if found_user and mtype == "ai":
                        prev_ai_text = str(getattr(msg, "content", "") or "").strip()
                        break
                if prev_ai_text:
                    return {"chosen": ai_text[:8000], "rejected": prev_ai_text[:8000]}
                return None
        except Exception:
            return None
        return None

    @traceable(name="maibot.distillation.after_agent")
    def after_agent(self, state: AgentState, runtime: Runtime[Any]) -> dict[str, Any] | None:  # noqa: ARG002
        try:
            messages = state.get("messages", [])
            if not messages:
                return None

            manager = get_model_manager()
            model_id = manager.get_current_model()
            model_info = manager.get_model_info(model_id)
            tier = getattr(model_info, "tier", "local") if model_info else "local"

            user_text, ai_text = self._latest_texts(messages)
            if not user_text or not ai_text:
                return None
            if not self._quality_gate_passed(user_text, ai_text):
                return None
            llm_score = self._llm_quality_score(user_text, ai_text)
            tool_names = self._recent_tool_names(messages)
            skill_hints = self._infer_skill_hints(user_text, ai_text, tool_names)
            if llm_score >= 5.0:
                thread_id = ""
                try:
                    ctx = getattr(runtime, "context", None) or {}
                    configurable = ctx.get("configurable", {}) if isinstance(ctx, dict) else {}
                    thread_id = str(configurable.get("thread_id") or "").strip()
                except Exception:
                    pass
                if thread_id:
                    skill_name = (skill_hints or ["general"])[0] if skill_hints else "general"
                    set_crystallization_suggestion(
                        thread_id,
                        {
                            "skill_name": skill_name,
                            "benefit": "可复用为 Skill，下次类似任务一键触发",
                            "cost": "低",
                            "quality_score": llm_score,
                        },
                    )
            if llm_score < 6.0:
                return None

            capture_reason = "cloud_tier"
            # 默认仅记录云模型；对本地模型，仅在「好评/任务成功」场景提升为蒸馏样本
            if not str(tier).startswith("cloud"):
                promoted_reason = self._local_capture_reason(messages, user_text, ai_text)
                if not promoted_reason:
                    return None
                capture_reason = promoted_reason

            # 若配置了蒸馏教师模型，仅当本次运行模型等于该 id 时才写入
            policy = manager.get_escalation_policy() or {}
            distillation_model = (policy.get("distillation_model") or "").strip()
            if distillation_model and model_id != distillation_model:
                return None

            row = {
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "model_id": model_id,
                "tier": tier,
                "compressed_input": self._compress_input_with_llm(user_text),
                "strong_output": ai_text[:8000],
                "quality_score": llm_score,
                "metadata": {
                    "source": "distillation_middleware",
                    "capture_reason": capture_reason,
                    "message_count": len(messages),
                    "tool_names": tool_names,
                    "skill_hints": skill_hints,
                },
            }
            pref_pair = self._extract_preference_pair(messages, ai_text)
            if pref_pair:
                row["preference_pair"] = pref_pair
            with self._write_lock:
                with self.dataset_path.open("a", encoding="utf-8") as f:
                    f.write(json.dumps(row, ensure_ascii=False) + "\n")
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
                "DistillationMiddleware.after_agent 出错（已忽略，不阻断链）: %s thread_id=%s",
                e, _tid or "(none)",
            )
        return None

