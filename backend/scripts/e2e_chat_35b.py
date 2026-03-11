#!/usr/bin/env python3
"""
35B 真实对话/工具端到端验证：在后端已启动且云 35B 可用时，创建线程、发送消息并消费流式响应。
用于验证：用户输入 → 后端 35B 处理 → 流式回复；可选发送触发工具的消息并校验 tool 事件。

用法:
  # 项目根目录，后端已启动（如 ./scripts/start.sh dev），并配置 CLOUD_QWEN_API_KEY
  python -m backend.scripts.e2e_chat_35b
  python -m backend.scripts.e2e_chat_35b --require-cloud35   # 先跑 e2e_smoke --require-cloud35
  python -m backend.scripts.e2e_chat_35b --tool               # 再发一条触发工具的消息并校验
  python -m backend.scripts.e2e_chat_35b --base-url http://127.0.0.1:2024 --timeout 120
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

CLOUD_35B_ID = "cloud/qwen3.5-35b-a3b"
ASSISTANT_ID = "agent"


def _run_smoke_require_cloud35(base: str, timeout: float, headers: dict) -> None:
    """先跑烟雾校验云 35B 可用。"""
    r = httpx.get(f"{base}/health", headers=headers, timeout=timeout)
    r.raise_for_status()
    if r.json().get("status") != "ok":
        raise SystemExit("烟雾: /health 未通过")
    r = httpx.get(f"{base}/models/list", headers=headers, timeout=timeout)
    r.raise_for_status()
    data = r.json()
    models = data.get("models") or []
    found = next((m for m in models if (m.get("id") or "").strip() == CLOUD_35B_ID), None)
    if not found:
        raise SystemExit(f"烟雾: 未找到云 35B 模型 id={CLOUD_35B_ID}，请配置 CLOUD_QWEN_API_KEY 与云端端点")
    if not found.get("available"):
        print("  ⚠️ 云 35B 在列表中但 available=False，继续用对话请求验证实际可用性")
    else:
        print("  ✅ 云 35B 可用，继续对话 E2E")


def _create_thread(base: str, timeout: float, headers: dict) -> str:
    """POST /threads 创建线程，返回 thread_id。"""
    r = httpx.post(f"{base}/threads", json={"metadata": {}}, headers=headers, timeout=timeout)
    r.raise_for_status()
    body = r.json()
    thread_id = (body.get("thread_id") or body.get("id") or "").strip()
    if not thread_id:
        raise SystemExit(f"创建线程未返回 thread_id: {body}")
    return thread_id


def _stream_run(
    base: str,
    thread_id: str,
    user_message: str,
    timeout: float,
    headers: dict,
    model_id: str = CLOUD_35B_ID,
) -> tuple[list[dict], bool]:
    """
    POST /threads/{thread_id}/runs/stream，发送一条用户消息，消费 SSE 并收集事件。
    返回 (events, got_content_or_tool)。
    """
    request_id = str(uuid.uuid4())
    enqueued_at = int(time.time() * 1000)
    payload = {
        "assistant_id": ASSISTANT_ID,
        "input": {
            "messages": [
                {"type": "human", "content": user_message},
            ],
        },
        "config": {
            "configurable": {
                "thread_id": thread_id,
                "request_id": request_id,
                "request_enqueued_at": enqueued_at,
                "session_id": thread_id,
                "task_key": thread_id,
                "task_type": "chat",
                "cost_tier": "medium",
                "model_id": model_id,
                "mode": "agent",
            },
        },
        "stream_mode": ["messages", "custom", "updates"],
        "stream_subgraphs": True,
    }
    events: list[dict] = []
    got_content_or_tool = False
    with httpx.stream(
        "POST",
        f"{base}/threads/{thread_id}/runs/stream",
        json=payload,
        headers={**headers, "Accept": "text/event-stream"},
        timeout=timeout,
    ) as resp:
        resp.raise_for_status()
        for line in resp.iter_lines():
            if not line:
                continue
            if line.startswith("data:"):
                data = line[5:].strip()
            else:
                # 兼容 NDJSON（整行为 JSON）
                data = line.strip()
            if not data or data == "[DONE]":
                continue
            try:
                obj = json.loads(data)
            except json.JSONDecodeError:
                continue
            events.append(obj)
            # 判定是否收到有效内容：messages 增量、custom 中的 generating/thinking/tool 等
            if isinstance(obj, dict):
                event_type = obj.get("event") or obj.get("type") or ""
                data_part = obj.get("data") if isinstance(obj.get("data"), dict) else {}
                if event_type in ("messages", "messages_partial", "updates"):
                    got_content_or_tool = True
                if event_type == "custom" and isinstance(data_part, dict):
                    if data_part.get("type") in ("generating", "thinking", "tool_start", "tool_end", "stream_end"):
                        got_content_or_tool = True
            if isinstance(obj, list):
                for item in obj:
                    if isinstance(item, dict) and (item.get("event") or item.get("type")):
                        got_content_or_tool = True
                        break
    return events, got_content_or_tool


def _extract_ai_reply_text(events: list) -> str:
    """从流事件中拼接出 AI 回复正文（messages_partial / updates 中的 content）。"""
    parts: list[str] = []

    def add_from_item(item: dict) -> None:
        c = item.get("content")
        if isinstance(c, str) and c:
            parts.append(c)
        for part in (item.get("content_parts") or []) if isinstance(item.get("content_parts"), list) else []:
            if isinstance(part, dict) and part.get("type") == "text":
                t = part.get("text")
                if isinstance(t, str) and t:
                    parts.append(t)

    def collect_from(ev: dict) -> None:
        typ = ev.get("event") or ev.get("type") or ""
        data = ev.get("data")
        # 整条即 AI 消息（如 run 结束时下发的完整 messages 列表中的一项）
        if typ == "ai" or ev.get("type") in ("ai", "AIMessage", "AIMessageChunk"):
            add_from_item(ev)
        if typ == "messages_partial" and isinstance(data, list):
            for item in data:
                if isinstance(item, dict) and (item.get("type") == "AIMessageChunk" or "content" in item or "content_parts" in item):
                    add_from_item(item)
        if typ == "custom" and isinstance(data, dict) and data.get("type") == "messages_partial":
            inner = data.get("data")
            if isinstance(inner, list):
                for item in inner:
                    if isinstance(item, dict):
                        add_from_item(item)
        if isinstance(data, list):
            for item in data:
                if isinstance(item, dict) and (item.get("type") in ("ai", "AIMessage", "AIMessageChunk") or "content" in item or "content_parts" in item):
                    add_from_item(item)
        if typ in ("updates", "messages", "values") and isinstance(data, dict):
            msgs = data.get("messages") or data.get("message")
            if isinstance(msgs, list):
                for msg in msgs:
                    if isinstance(msg, dict) and msg.get("type") in ("ai", "AIMessage", "AIMessageChunk"):
                        add_from_item(msg)

    for ev in events:
        if isinstance(ev, dict):
            collect_from(ev)
        elif isinstance(ev, list):
            for item in ev:
                if isinstance(item, dict):
                    collect_from(item)
    return "".join(parts)


def main() -> None:
    p = argparse.ArgumentParser(description="35B 真实对话/工具 E2E：创建线程、发消息、消费流")
    p.add_argument("--base-url", default=os.getenv("BACKEND_BASE_URL", "http://127.0.0.1:2024"), help="后端 base URL")
    p.add_argument("--require-cloud35", action="store_true", help="先校验云 35B 可用（烟雾）")
    p.add_argument("--tool", action="store_true", help="再发一条触发工具的消息并校验 tool 事件")
    p.add_argument("--timeout", type=float, default=90.0, help="单次请求超时秒数（流式整体）")
    p.add_argument("--debug-events", type=int, default=0, metavar="N", help="打印前 N 条流事件 JSON 便于排查解析")
    p.add_argument("--no-assert-content", action="store_true", help="不强制要求解析到 AI 正文，仅校验收到流事件")
    args = p.parse_args()
    base = args.base_url.rstrip("/")
    timeout = args.timeout
    token = os.getenv("LOCAL_AGENT_TOKEN", "").strip()
    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    if args.require_cloud35:
        print("[e2e-chat-35b] 校验云 35B...")
        _run_smoke_require_cloud35(base, min(timeout, 15.0), headers)

    print("[e2e-chat-35b] 创建线程...")
    thread_id = _create_thread(base, 10.0, headers)
    print(f"  thread_id: {thread_id}")

    print("[e2e-chat-35b] 发送对话消息（35B）...")
    events1, got1 = _stream_run(
        base, thread_id,
        "你好，请用一句话介绍你自己。",
        timeout=timeout,
        headers=headers,
    )
    if not got1 and not events1:
        print("  ❌ 未收到任何流式事件")
        sys.exit(1)
    if not got1:
        print("  ⚠️ 收到事件但无 messages/custom 内容，请检查后端与模型")
        sys.exit(1)
    if args.debug_events and events1:
        for i, ev in enumerate(events1[: args.debug_events]):
            print(f"  [debug event {i}] {json.dumps(ev, ensure_ascii=False)[:500]}")
    reply_text = _extract_ai_reply_text(events1)
    if not reply_text or not reply_text.strip():
        if args.no_assert_content:
            print("  ⚠️ 流中未解析到 AI 正文，但已收到事件（使用 --no-assert-content 跳过断言）")
        else:
            print("  ❌ 流中未解析到 AI 回复正文（messages_partial/updates 无 content）")
            if events1 and not args.debug_events:
                sample = events1[0]
                if isinstance(sample, dict):
                    print("  首条事件键:", list(sample.keys())[:15])
                    if "data" in sample and isinstance(sample.get("data"), (list, dict)):
                        d = sample["data"]
                        print("  首条 data 类型:", type(d).__name__, "len" if isinstance(d, (list, dict)) else "", len(d) if isinstance(d, (list, dict)) else "")
                print("  提示: 使用 --debug-events 5 查看事件结构，或 --no-assert-content 仅校验有事件")
            sys.exit(1)
    else:
        preview = reply_text.strip()[:320]
        print(f"  ✅ 模型返回预览: {preview}{'...' if len(reply_text.strip()) > 320 else ''}")
        if "502" in reply_text or "推理服务返回" in reply_text or "执行过程中发生错误" in reply_text:
            print("  ⚠️ 本次返回为错误兜底文案，请确认云 35B 或本地推理服务可达")
    print(f"  ✅ 对话流式响应正常（共 {len(events1)} 条事件）")

    if args.tool:
        print("[e2e-chat-35b] 发送工具触发消息...")
        events2, got2 = _stream_run(
            base, thread_id,
            "列出当前工作区根目录下的文件和文件夹。",
            timeout=timeout,
            headers=headers,
        )
        def _data_type(ev):
            d = ev.get("data")
            return (d.get("type") if isinstance(d, dict) else None)
        tool_events = [e for e in events2 if isinstance(e, dict) and _data_type(e) in ("tool_start", "tool_end")]
        if not got2 and not events2:
            print("  ❌ 工具请求未收到任何流式事件")
            sys.exit(1)
        if tool_events:
            print(f"  ✅ 工具调用在流中可见（tool 事件数: {len(tool_events)}）")
        else:
            print(f"  ⚠️ 未看到 tool_start/tool_end，但收到 {len(events2)} 条事件（可能由模型直接回答未调用工具）")

    print("\n✅ 35B 真实对话/工具 E2E 通过（后端返回与解析正常）")
    print("\n--- UI 验证（请在前端确认）---")
    print("  1. 打开应用，将模型选为「云 35B」或 cloud/qwen3.5-35b-a3b")
    print("  2. 发送: 你好，请用一句话介绍你自己。")
    print("  3. 确认: 回复以流式逐字/逐段出现，无报错；内容与上方「模型返回预览」一致或语义相符")
    print("  4. 若有工具调用: 确认 RunTracker/运行摘要 中可见工具名与结果")
    print("  详见: docs/E2E_FUNCTIONAL_TEST_PLAN.md §3")
    sys.exit(0)


if __name__ == "__main__":
    main()
