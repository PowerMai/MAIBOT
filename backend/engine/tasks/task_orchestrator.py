from __future__ import annotations

import json
from typing import Any, Dict, List
import logging

logger = logging.getLogger(__name__)

_MAX_TASK_TEXT_LEN = 4000


def decompose_task_with_llm(task: Dict[str, Any]) -> List[Dict[str, Any]]:
    """将复杂任务拆分为子任务（LLM 优先，失败回退规则拆分）。"""
    subject = str(task.get("subject") or "").strip()
    description = str(task.get("description") or "").strip()
    if len(subject) > _MAX_TASK_TEXT_LEN:
        logger.info("[TaskOrchestrator] subject too long, truncating: %d", len(subject))
        subject = subject[:_MAX_TASK_TEXT_LEN] + "...(truncated)"
    if len(description) > _MAX_TASK_TEXT_LEN:
        logger.info("[TaskOrchestrator] description too long, truncating: %d", len(description))
        description = description[:_MAX_TASK_TEXT_LEN] + "...(truncated)"
    if not description and subject:
        description = subject
    if not description:
        return []
    try:
        from backend.engine.agent.model_manager import get_model_manager

        manager = get_model_manager()
        llm = manager.create_llm(config={"configurable": {"task_type": "planning"}}, task_type="analysis")
        result = llm.invoke(
            [
                {
                    "role": "system",
                    "content": (
                        "把任务拆分为可并行子任务。输出 JSON 数组，字段：title, description, role_hint, priority。"
                        "最多 5 项。"
                    ),
                },
                {"role": "user", "content": f"标题: {subject}\n描述: {description}"},
            ]
        )
        parsed = json.loads(str(getattr(result, "content", "") or "[]"))
        if isinstance(parsed, list):
            cleaned: List[Dict[str, Any]] = []
            for item in parsed:
                if not isinstance(item, dict):
                    continue
                cleaned.append(
                    {
                        "title": str(item.get("title", "") or "").strip(),
                        "description": str(item.get("description", "") or "").strip(),
                        "role_hint": str(item.get("role_hint", "") or "").strip(),
                        "priority": int(item.get("priority", 1) or 1),
                    }
                )
            return [x for x in cleaned if x["title"]][:5]
    except Exception:
        pass
    # 回退：按分号/换行切分
    parts = [x.strip() for x in description.replace("；", ";").split(";") if x.strip()]
    return [{"title": f"subtask_{idx+1}", "description": part, "role_hint": "", "priority": idx + 1} for idx, part in enumerate(parts[:5])]


def summarize_subtask_results_with_llm(results: List[str]) -> str:
    """将子任务结果汇总为最终结论。"""
    if not results:
        return "暂无子任务结果可汇总。"
    normalized_results = [str(x or "").strip() for x in results if str(x or "").strip()]
    if not normalized_results:
        return "暂无有效的子任务结果可汇总。"
    clipped_results: List[str] = []
    for idx, text in enumerate(normalized_results[:8]):
        if len(text) > _MAX_TASK_TEXT_LEN:
            logger.info("[TaskOrchestrator] result[%d] too long, truncating: %d", idx, len(text))
            text = text[:_MAX_TASK_TEXT_LEN] + "...(truncated)"
        clipped_results.append(text)
    try:
        from backend.engine.agent.model_manager import get_model_manager

        manager = get_model_manager()
        llm = manager.create_llm(config={"configurable": {"task_type": "analysis"}}, task_type="analysis")
        result = llm.invoke(
            [
                {"role": "system", "content": "汇总以下子任务结果，输出执行摘要、风险和下一步建议。"},
                {"role": "user", "content": "\n\n".join(clipped_results)},
            ]
        )
        summary = str(getattr(result, "content", "") or "").strip()
        if summary:
            return summary
    except Exception:
        pass
    return "\n".join(clipped_results[:5])
