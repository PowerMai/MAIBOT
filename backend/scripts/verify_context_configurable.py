#!/usr/bin/env python3
"""
装配校验脚本：向 /threads/{id}/runs/stream 发送带 workspace_path、editor_path、open_files 的 config，
用于验证 configurable 是否从 API → _prepare_agent_config → inject_runtime_context 正确传递。

用法（后端已启动且可连）:
  cd 项目根目录
  LOG_LEVEL=DEBUG python -m backend.scripts.verify_context_configurable
  LOG_LEVEL=DEBUG python -m backend.scripts.verify_context_configurable --base-url http://127.0.0.1:2024

验证方式：运行后查看后端日志，应出现：
  [context_verify] _prepare_agent_config 出口: ... has workspace_path=True, has editor_path=True, open_files=1
  [context_verify] _collect_dynamic_prompt_snapshot configurable: workspace_path=True, editor_path=True, ...
若出现 [context_verify] inject_runtime_context: get_config() 返回的 configurable 为空，说明中间件未拿到 config。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import uuid

try:
    import httpx
except ImportError:
    print("请安装 httpx: pip install httpx", file=sys.stderr)
    sys.exit(1)

ASSISTANT_ID = "agent"


def main() -> None:
    p = argparse.ArgumentParser(description="发送带完整 configurable 的 stream 请求，验证装配链")
    p.add_argument("--base-url", default=os.getenv("LANGGRAPH_API_URL", "http://127.0.0.1:2024"), help="后端 base URL")
    p.add_argument("--timeout", type=float, default=90, help="请求超时秒数")
    args = p.parse_args()
    base = args.base_url.rstrip("/")
    timeout = args.timeout
    headers = {"Content-Type": "application/json", "Accept": "text/event-stream"}

    # 1. 创建线程
    print("创建线程...")
    r = httpx.post(f"{base}/threads", json={"metadata": {}}, headers={**headers, "Accept": "application/json"}, timeout=timeout)
    r.raise_for_status()
    body = r.json()
    thread_id = (body.get("thread_id") or body.get("id") or "").strip()
    if not thread_id:
        print("创建线程未返回 thread_id:", body, file=sys.stderr)
        sys.exit(1)
    print("thread_id:", thread_id[:16], "...")

    # 2. 发送带完整 configurable 的 stream 请求（与 e2e 结构一致，仅增加 workspace_path/editor_path）
    request_id = str(uuid.uuid4())
    enqueued_at = int(time.time() * 1000)
    workspace_path = os.path.abspath(os.getcwd())
    editor_path = f"{workspace_path}/README.md"
    configurable = {
        "thread_id": thread_id,
        "request_id": request_id,
        "request_enqueued_at": enqueued_at,
        "session_id": thread_id,
        "task_key": thread_id,
        "task_type": "chat",
        "cost_tier": "medium",
        "mode": "agent",
        "workspace_path": workspace_path,
        "editor_path": editor_path,
    }
    payload = {
        "input": {"messages": [{"type": "human", "content": "请回复：收到。"}]},
        "config": {"configurable": configurable},
        "stream_mode": ["messages", "custom", "updates"],
        "stream_subgraphs": True,
    }
    print("发送 stream（configurable 含 workspace_path, editor_path, open_files）...")
    events: list[dict] = []
    start = time.time()
    with httpx.stream(
        "POST",
        f"{base}/threads/{thread_id}/runs/stream",
        json=payload,
        headers=headers,
        timeout=timeout,
    ) as resp:
        resp.raise_for_status()
        for line in resp.iter_lines():
            if time.time() - start > 60:
                print("已收 60s 事件，停止")
                break
            if not line or not (line.startswith("data:") or line.strip().startswith("{")):
                continue
            data = line[5:].strip() if line.startswith("data:") else line.strip()
            if not data or data == "[DONE]":
                continue
            try:
                obj = json.loads(data)
            except json.JSONDecodeError:
                continue
            events.append(obj)
            if len(events) >= 20:
                print("已收 20 条事件，停止")
                break
    print("收到事件数:", len(events))
    print("请查看后端日志中的 [context_verify] 行，确认 _prepare_agent_config 与 _collect_dynamic_prompt_snapshot 的 configurable 是否含 workspace_path/editor_path。")


if __name__ == "__main__":
    main()
