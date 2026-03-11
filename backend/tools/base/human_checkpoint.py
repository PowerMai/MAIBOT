"""
人类检查点工具 - 到达检查点时暂停并请求人工审核

利用 LangGraph interrupt() 机制，扩展 ask_user 为结构化的 request_human_review。
前端 InterruptDialog 识别 type: "human_checkpoint" 后展示审核 UI。
"""

import os
from typing import List, Optional
from langchain_core.tools import tool
from langgraph.config import get_config


def _mark_board_waiting_human(checkpoint_id: str, summary: str) -> None:
    """将关联看板任务标记为 waiting_human，保持任务状态与中断一致。"""
    try:
        config = get_config() or {}
        configurable = (config or {}).get("configurable", {}) or {}
        thread_id = str(configurable.get("thread_id") or "").strip()
        if not thread_id:
            return
        from backend.engine.tasks.task_bidding import sync_board_task_by_thread_id

        msg = f"等待人工审核检查点 {checkpoint_id}"
        if summary:
            msg = f"{msg}: {summary[:160]}"
        sync_board_task_by_thread_id(thread_id, "waiting_human", msg)
    except Exception:
        # 非关键路径：不影响 interrupt 行为
        pass


@tool
def request_human_review(
    checkpoint_id: str,
    summary: str,
    options: Optional[List[str]] = None,
    context: str = "",
) -> str:
    """请求人类审核。任务将暂停直到人类做出决策。

    到达任务中预设的人类检查点时调用此工具，提交当前阶段的工作摘要供人工审核；
    审核通过后继续执行，拒绝或要求修改时返回人类反馈。

    Args:
        checkpoint_id: 检查点标识（如 bid_decision、draft_approval）
        summary: 当前阶段的工作摘要，供人类审核
        options: 可选操作（默认 ["approve", "reject", "revise"]），可自定义
        context: 详细上下文（分析结果、数据等），可选

    Returns:
        人类的决策和反馈（approve / reject / revise 及可选说明）
    """
    from langgraph.types import interrupt

    raw_opts = options or ["approve", "reject", "revise"]
    opts = []
    for item in raw_opts:
        text = str(item or "").strip()
        if text and text not in opts:
            opts.append(text)
    if not opts:
        opts = ["approve", "reject", "revise"]
    value = {
        "type": "human_checkpoint",
        "checkpoint_id": checkpoint_id,
        "summary": summary,
        "options": opts,
        "context": context or "",
    }
    _mark_board_waiting_human(checkpoint_id=checkpoint_id, summary=summary)
    result = interrupt(value)
    if result is None:
        return ""
    if isinstance(result, str):
        return result.strip()
    if isinstance(result, dict):
        decision = (result.get("decision") or result.get("response") or "").strip()
        feedback = (result.get("feedback") or result.get("comment") or "").strip()
        # 最佳努力：将人工审核信号写入 LangSmith 反馈（用于后续蒸馏/评估）
        try:
            api_key = os.getenv("LANGSMITH_API_KEY", "").strip()
            run_id = str(result.get("run_id") or "").strip()
            if api_key and run_id:
                from langsmith import Client  # type: ignore

                score_map = {
                    "approve": 1.0,
                    "revise": 0.5,
                    "delegate": 0.6,
                    "skip": 0.4,
                    "reject": 0.0,
                }
                score = score_map.get(decision.lower(), 0.5)
                comment = f"[{checkpoint_id}] {summary[:200]}"
                if feedback:
                    comment = f"{comment} | {feedback[:300]}"
                Client(api_key=api_key).create_feedback(
                    run_id=run_id,
                    key="human_checkpoint_decision",
                    score=score,
                    comment=comment,
                )
        except Exception:
            pass
        if feedback:
            return f"{decision}: {feedback}" if decision else feedback
        return decision
    return str(result).strip()
