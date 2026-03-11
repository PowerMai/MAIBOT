from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional

import httpx

try:
    from langsmith import Client as LangSmithClient  # type: ignore
except Exception:  # pragma: no cover
    LangSmithClient = None  # type: ignore


def _project_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _eval_log_path() -> Path:
    p = _project_root() / "data" / "langsmith_eval_log.jsonl"
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def langsmith_runtime_status() -> Dict[str, Any]:
    has_api_key = bool(os.getenv("LANGSMITH_API_KEY") or os.getenv("LANGCHAIN_API_KEY"))
    tracing_raw = (os.getenv("LANGCHAIN_TRACING_V2", "") or "").strip().lower()
    if has_api_key and tracing_raw == "":
        # 默认闭环：只要配置了 API Key，就自动开启 tracing 标志。
        os.environ.setdefault("LANGCHAIN_TRACING_V2", "true")
        tracing_raw = "true"
    tracing_flag = tracing_raw in {"1", "true", "yes", "on"}
    endpoint = os.getenv("LANGSMITH_ENDPOINT", "https://api.smith.langchain.com")
    project = os.getenv("LANGCHAIN_PROJECT", "maibot")
    return {
        "enabled": bool(has_api_key and tracing_flag),
        "has_api_key": has_api_key,
        "tracing_v2": tracing_flag,
        "tracing_source": "auto" if has_api_key and tracing_raw == "true" else "env",
        "project": project,
        "endpoint": endpoint,
    }


def _append_eval_row(row: Dict[str, Any]) -> None:
    p = _eval_log_path()
    with p.open("a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")


def _safe_json_read_lines_tail(path: Path, limit: int = 50) -> list[dict]:
    if not path.exists():
        return []
    rows: list[dict] = []
    try:
        content = path.read_text(encoding="utf-8")
        for line in content.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
                if isinstance(obj, dict):
                    rows.append(obj)
            except Exception:
                continue
    except Exception:
        return []
    rows.reverse()
    return rows[: max(1, min(limit, 500))]


def list_eval_logs(limit: int = 50) -> list[dict]:
    return _safe_json_read_lines_tail(_eval_log_path(), limit=limit)


def summarize_eval_logs(limit: int = 200) -> Dict[str, Any]:
    rows = list_eval_logs(limit=limit)
    total = len(rows)
    feedback_sent = sum(1 for row in rows if bool(row.get("feedback_sent")))
    failed = sum(1 for row in rows if str(row.get("task_status") or "").strip().lower() == "failed")
    avg_score = (
        round(
            sum(float(row.get("score", 0) or 0) for row in rows) / max(1, total),
            4,
        )
        if total > 0
        else 0.0
    )
    return {
        "total": total,
        "feedback_sent": feedback_sent,
        "feedback_rate": round(feedback_sent / max(1, total), 4),
        "failed": failed,
        "avg_score": avg_score,
    }


def _estimate_quality_score(task_status: str, result_summary: str, error: str) -> float:
    if task_status == "failed" or error:
        return 0.2
    score = 0.6
    if task_status == "completed":
        score += 0.25
    if len((result_summary or "").strip()) >= 50:
        score += 0.1
    return min(1.0, max(0.0, score))


def _fetch_latest_run_id(thread_id: str) -> str:
    from backend.api.common import is_valid_thread_id_uuid
    if not thread_id or not is_valid_thread_id_uuid(thread_id):
        return ""
    api_url = os.environ.get("LANGGRAPH_API_URL", "http://127.0.0.1:2024").rstrip("/")
    try:
        with httpx.Client(timeout=8.0) as client:
            r = client.get(f"{api_url}/threads/{thread_id}/runs", params={"limit": 1})
            if r.status_code == 200:
                data = r.json()
                runs = data if isinstance(data, list) else data.get("runs", data.get("values", []))
                if isinstance(runs, list) and runs:
                    head = runs[0] if isinstance(runs[0], dict) else {}
                    return str(head.get("run_id") or "")
    except Exception:
        return ""
    return ""


def auto_evaluate_task(
    *,
    thread_id: str,
    mode: str,
    task_status: str,
    result_summary: Optional[dict],
    error: Optional[str],
    request_id: str = "",
    task_id: str = "",
    model_id: str = "",
    session_id: str = "",
    run_id: str = "",
) -> Dict[str, Any]:
    """
    任务完成后自动评估：
    - 总是写本地评估日志
    - LangSmith 可用且能拿到 run_id 时，自动 create_feedback
    """
    runtime = langsmith_runtime_status()
    summary_text = ""
    if isinstance(result_summary, dict):
        summary_text = str(result_summary.get("content") or "")
    err_text = str(error or "")
    score = _estimate_quality_score(task_status=task_status, result_summary=summary_text, error=err_text)
    resolved_run_id = str(run_id or "").strip() or _fetch_latest_run_id(thread_id)

    sent_feedback = False
    feedback_error = ""
    if runtime.get("enabled") and resolved_run_id and LangSmithClient is not None:
        try:
            client = LangSmithClient()
            comment = (
                f"auto-eval mode={mode} status={task_status} "
                f"summary_len={len(summary_text)} error={'yes' if bool(err_text) else 'no'}"
            )
            client.create_feedback(
                run_id=resolved_run_id,
                key="auto_task_quality",
                score=float(score),
                value={
                    "status": task_status,
                    "mode": mode,
                    "thread_id": thread_id,
                    "request_id": request_id,
                    "task_id": task_id,
                    "model_id": model_id,
                    "session_id": session_id,
                },
                comment=comment,
            )
            sent_feedback = True
        except Exception as e:  # pragma: no cover
            feedback_error = str(e)

    row = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "thread_id": thread_id,
        "run_id": resolved_run_id,
        "request_id": request_id,
        "task_id": task_id,
        "model_id": model_id,
        "session_id": session_id,
        "mode": mode,
        "task_status": task_status,
        "score": score,
        "langsmith_enabled": bool(runtime.get("enabled")),
        "feedback_sent": sent_feedback,
        "feedback_error": feedback_error,
        "summary_preview": summary_text[:300],
        "error_preview": err_text[:300],
    }
    _append_eval_row(row)
    return row

