#!/usr/bin/env python3
"""
模型连接验证脚本：请求后端的 /models/list 与 /models/diagnostics，输出列表与探测结果。
用于排查「本地和云端都没有可用模型」：可看到每个模型探测的 URL、状态码或异常。

用法:
  # 后端已启动时（默认 http://127.0.0.1:2024）
  python -m backend.scripts.verify_model_connection
  python -m backend.scripts.verify_model_connection --base-url http://127.0.0.1:2024

  # 使用内部鉴权（若后端要求）
  export LOCAL_AGENT_TOKEN=your_token
  python -m backend.scripts.verify_model_connection
"""
from __future__ import annotations

import argparse
import os
import sys

try:
    import httpx
except ImportError:
    print("请安装 httpx: pip install httpx", file=sys.stderr)
    sys.exit(1)


def main() -> None:
    p = argparse.ArgumentParser(description="验证模型连接：请求 /models/list 与 /models/diagnostics")
    p.add_argument("--base-url", default=os.getenv("BACKEND_BASE_URL", "http://127.0.0.1:2024"), help="后端 base URL")
    p.add_argument("--timeout", type=float, default=15.0, help="请求超时秒数")
    args = p.parse_args()
    base = args.base_url.rstrip("/")
    timeout = args.timeout
    token = os.getenv("LOCAL_AGENT_TOKEN", "").strip()
    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    if token:
        headers["X-Internal-Token"] = token

    print(f"后端: {base}")
    print("-" * 60)

    # 1. GET /models/list
    try:
        r = httpx.get(f"{base}/models/list", headers=headers, timeout=timeout)
        r.raise_for_status()
        data = r.json()
        if not data.get("ok"):
            print(f"[models/list] ok=False, error={data.get('error', '')}")
        else:
            models = data.get("models") or []
            current = data.get("current_model", "")
            print(f"[models/list] 共 {len(models)} 项, current_model={current}")
            for m in models:
                mid = m.get("id", "")
                if mid == "auto":
                    print(f"  - {mid}: available={m.get('available')}, resolved={m.get('resolved_model', '')}")
                else:
                    print(f"  - {mid}: available={m.get('available')}, enabled={m.get('enabled')}, tier={m.get('tier')}")
    except httpx.HTTPStatusError as e:
        print(f"[models/list] HTTP {e.response.status_code}: {e.response.text[:200]}")
    except Exception as e:
        print(f"[models/list] 请求失败: {e}")
        print("  请确认后端已启动且 --base-url 正确（如 http://127.0.0.1:2024）")
        sys.exit(1)

    print("-" * 60)

    # 2. GET /models/diagnostics
    try:
        r = httpx.get(f"{base}/models/diagnostics", headers=headers, timeout=timeout)
        r.raise_for_status()
        data = r.json()
        if not data.get("ok"):
            print(f"[models/diagnostics] ok=False, error={data.get('error', '')}")
        else:
            summary = data.get("summary") or {}
            items = data.get("models") or []
            print(f"[models/diagnostics] 聊天模型数: {summary.get('total', 0)}, 可用: {summary.get('available_count', 0)}")
            for m in items:
                mid = m.get("id", "")
                tier = m.get("tier", "")
                probe_url = m.get("probe_url", "")
                status = m.get("probe_status_code")
                err = m.get("probe_error", "")
                avail = m.get("available", False)
                has_key = m.get("has_api_key", False)
                key_env = m.get("api_key_env", "") or ""
                status_str = str(status) if status is not None else (err or "未探测")
                key_hint = f", has_api_key={has_key}" if key_env else ""
                print(f"  {mid} ({tier}): available={avail}, probe={probe_url} -> {status_str}{key_hint}")
    except httpx.HTTPStatusError as e:
        print(f"[models/diagnostics] HTTP {e.response.status_code}: {e.response.text[:200]}")
    except Exception as e:
        print(f"[models/diagnostics] 请求失败: {e}")

    print("-" * 60)
    print("若 probe 为 Connection refused / 502：请启动对应推理服务（如 LM Studio 或云端端点）并确认 URL 与端口正确。")
    print("若云端 probe 为 401 且 has_api_key=False：请在启动后端的同一环境中设置对应环境变量（如 CLOUD_QWEN_API_KEY）后重启后端。")


if __name__ == "__main__":
    main()
