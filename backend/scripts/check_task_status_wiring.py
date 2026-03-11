from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import List


ROOT = Path(__file__).resolve().parents[2]


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _extract_function_block(content: str, function_name: str) -> str:
    pattern = re.compile(rf"^\s*(?:async\s+def|def)\s+{re.escape(function_name)}\s*\(", re.MULTILINE)
    match = pattern.search(content)
    if not match:
        return ""
    # 轻量窗口匹配，兼容嵌套函数（例如 tool 工厂中的内部 def）
    start = match.start()
    return content[start : min(len(content), start + 12000)]


def _check_required_call(file_path: Path, function_name: str, required_token: str) -> List[str]:
    content = _read_text(file_path)
    block = _extract_function_block(content, function_name)
    if not block:
        return [f"{file_path}: 未找到函数 `{function_name}`"]
    if required_token not in block:
        return [f"{file_path}: `{function_name}` 缺少 `{required_token}`"]
    return []


def _check_file_contains(file_path: Path, required_tokens: List[str], context_name: str) -> List[str]:
    content = _read_text(file_path)
    missing = [t for t in required_tokens if t not in content]
    if not missing:
        return []
    return [f"{file_path}: {context_name} 缺少 {', '.join(missing)}"]


def _check_file_not_contains(file_path: Path, forbidden_tokens: List[str], context_name: str) -> List[str]:
    content = _read_text(file_path)
    existed = [t for t in forbidden_tokens if t in content]
    if not existed:
        return []
    return [f"{file_path}: {context_name} 不应包含 {', '.join(existed)}"]


def main() -> int:
    rules = [
        ("backend/api/routers/board_api.py", "board_update_task", "project_board_task_status"),
        ("backend/api/routers/board_api.py", "board_accept_bid", "project_board_task_status"),
        ("backend/api/routers/board_api.py", "board_submit_human_review", "project_board_task_status"),
        ("backend/api/routers/board_api.py", "board_report_blocked", "project_board_task_status"),
        ("backend/engine/tasks/task_bidding.py", "submit_bid", "project_board_task_status"),
        ("backend/engine/tasks/task_bidding.py", "resolve_bids", "project_board_task_status"),
        ("backend/engine/tasks/task_relay.py", "accept_relay", "project_board_task_status"),
        ("backend/engine/tasks/task_relay.py", "complete_relay", "project_board_task_status"),
        ("backend/api/knowledge_api.py", "_board_task_complete", "project_board_task_status"),
        ("backend/api/knowledge_api.py", "_board_task_fail", "project_board_task_status"),
        ("backend/engine/tasks/task_bidding.py", "sync_board_task_by_thread_id", "project_board_task_status"),
    ]
    errors: List[str] = []
    for rel_path, function_name, required_token in rules:
        errors.extend(_check_required_call(ROOT / rel_path, function_name, required_token))

    errors.extend(
        _check_file_contains(
            ROOT / "backend/api/routers/board_api.py",
            ["is_task_single_source_enabled", "if is_task_single_source_enabled():"],
            "board_report_blocked 单一真源守卫",
        )
    )
    errors.extend(
        _check_file_contains(
            ROOT / "backend/api/routers/board_api.py",
            ['if "claimed_by" in body:', "任务已被其他角色认领"],
            "board 状态守卫与 claimed_by 清空语义",
        )
    )
    errors.extend(
        _check_file_contains(
            ROOT / "backend/api/routers/board_api.py",
            ["status_changed = status_after_review != prev_status", "if status_changed:"],
            "human-review 状态变更单写入口守卫",
        )
    )
    errors.extend(
        _check_file_contains(
            ROOT / "backend/engine/tasks/task_relay.py",
            [
                '_ACCEPT_ALLOWED_STATUSES = {"available", "bidding", "claimed"}',
                '当前状态不允许 relay',
            ],
            "relay 状态机守卫",
        )
    )
    errors.extend(
        _check_file_contains(
            ROOT / "frontend/desktop/src/lib/api/boardApi.ts",
            [
                "status_projection_source?: string",
                "status_projection_at?: string",
                "skill_match?: number",
                "dispatch_state?: string",
            ],
            "BoardTask 前后端字段契约",
        )
    )
    errors.extend(
        _check_file_contains(
            ROOT / "backend/engine/core/main_graph.py",
            [
                "_STREAM_EVENT_SURFACE",
                '"type": "runtime_stats"',
                "_EMIT_LEGACY_STATS_EVENTS",
            ],
            "流式统计事件面契约",
        )
    )
    errors.extend(
        _check_file_contains(
            ROOT / "frontend/desktop/src/components/ChatComponents/MyRuntimeProvider.tsx",
            [
                'let runtimeStatsPreferred = false;',
                "d?.type === 'messages_partial'",
                "event.event === 'runtime_stats'",
            ],
            "前端流式主通道与统计事件契约",
        )
    )
    errors.extend(
        _check_file_not_contains(
            ROOT / "frontend/desktop/src/components/ChatComponents/MyRuntimeProvider.tsx",
            [
                "maibot_plan_confirmed_thread_",
                "plan_confirmed: true",
            ],
            "Plan 确认多源输入",
        )
    )

    if errors:
        print("[check:task-status-wiring] FAIL")
        for err in errors:
            print(f"- {err}")
        return 1

    print("[check:task-status-wiring] OK: 关键状态写路径已接入统一入口。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
