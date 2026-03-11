from __future__ import annotations

from datetime import datetime, timezone
import json
import logging
import threading
from pathlib import Path
from typing import Any, Dict, List

logger = logging.getLogger(__name__)


class CollectiveLearning:
    """
    组织级集体学习（Phase 2 基础实现）：
    - 记录成功模式与失败教训
    - 提供最近经验回放
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._success_patterns: List[Dict[str, Any]] = []
        self._failure_lessons: List[Dict[str, Any]] = []
        self._data_path = Path(__file__).resolve().parents[3] / "data" / "collective_learning.json"
        self._load()

    def _load(self) -> None:
        try:
            if not self._data_path.exists():
                return
            try:
                payload = json.loads(self._data_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError as decode_err:
                logger.warning("collective_learning 加载失败，JSON 解析错误: %s", decode_err)
                return
            if isinstance(payload, dict):
                success = payload.get("success_patterns")
                failure = payload.get("failure_lessons")
                if isinstance(success, list):
                    self._success_patterns = [s for s in success if isinstance(s, dict)][-200:]
                if isinstance(failure, list):
                    self._failure_lessons = [f for f in failure if isinstance(f, dict)][-200:]
        except Exception as err:
            logger.warning("collective_learning 加载失败: %s", err)
            self._success_patterns = self._success_patterns[-200:]
            self._failure_lessons = self._failure_lessons[-200:]

    def _save(self) -> None:
        self._data_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "success_patterns": self._success_patterns[-200:],
            "failure_lessons": self._failure_lessons[-200:],
        }
        self._data_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    def add_success(self, pattern: Dict[str, Any]) -> None:
        with self._lock:
            row = {
                "ts": datetime.now(timezone.utc).isoformat(),
                "type": "success",
                "pattern": pattern or {},
            }
            self._success_patterns.append(row)
            self._success_patterns = self._success_patterns[-200:]
            self._save()

    def add_failure(self, lesson: Dict[str, Any]) -> None:
        with self._lock:
            row = {
                "ts": datetime.now(timezone.utc).isoformat(),
                "type": "failure",
                "lesson": lesson or {},
            }
            self._failure_lessons.append(row)
            self._failure_lessons = self._failure_lessons[-200:]
            self._save()

    def recent(self, limit: int = 20) -> Dict[str, List[Dict[str, Any]]]:
        n = max(1, int(limit))
        with self._lock:
            return {
                "success_patterns": self._success_patterns[-n:],
                "failure_lessons": self._failure_lessons[-n:],
            }

    def agent_recent_score(self, agent_id: str, task_type: str = "", limit: int = 60) -> Dict[str, float]:
        aid = str(agent_id or "").strip()
        ttype = str(task_type or "").strip()
        if not aid:
            return {"success_count": 0.0, "failure_count": 0.0, "score": 0.0}

        succ = 0
        fail = 0
        for row in self._success_patterns[-max(1, int(limit)):]:
            pattern = row.get("pattern") if isinstance(row, dict) else {}
            if not isinstance(pattern, dict):
                continue
            if str(pattern.get("agent_id") or "").strip() != aid:
                continue
            if ttype and str(pattern.get("task_type") or "").strip() != ttype:
                continue
            succ += 1
        for row in self._failure_lessons[-max(1, int(limit)):]:
            lesson = row.get("lesson") if isinstance(row, dict) else {}
            if not isinstance(lesson, dict):
                continue
            if str(lesson.get("agent_id") or "").strip() != aid:
                continue
            if ttype and str(lesson.get("task_type") or "").strip() != ttype:
                continue
            fail += 1
        total = succ + fail
        score = ((succ - fail) / total) if total > 0 else 0.0
        return {"success_count": float(succ), "failure_count": float(fail), "score": float(score)}


_GLOBAL_COLLECTIVE_LEARNING = CollectiveLearning()


def get_collective_learning() -> CollectiveLearning:
    return _GLOBAL_COLLECTIVE_LEARNING

