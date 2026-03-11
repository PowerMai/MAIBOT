#!/usr/bin/env python3
"""
E2E 烟雾测试：在后端已启动时，校验健康检查与模型列表，可选校验云端 35B 是否可用。
用于端到端功能测试前快速确认后端与模型配置就绪。

用法:
  # 项目根目录，后端已启动（如 ./scripts/start.sh dev）
  python -m backend.scripts.e2e_smoke
  python -m backend.scripts.e2e_smoke --require-cloud35   # 要求云 35B 在列表中
  python -m backend.scripts.e2e_smoke --base-url http://127.0.0.1:2024
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

CLOUD_35B_ID = "cloud/qwen3.5-35b-a3b"


def main() -> None:
    p = argparse.ArgumentParser(description="E2E 烟雾：健康检查 + 模型列表，可选校验云 35B")
    p.add_argument("--base-url", default=os.getenv("BACKEND_BASE_URL", "http://127.0.0.1:2024"), help="后端 base URL")
    p.add_argument("--require-cloud35", action="store_true", help="要求云 35B 在模型列表中且可用")
    p.add_argument("--timeout", type=float, default=10.0, help="请求超时秒数")
    args = p.parse_args()
    base = args.base_url.rstrip("/")
    timeout = args.timeout
    token = os.getenv("LOCAL_AGENT_TOKEN", "").strip()
    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    failed = []

    # 1. Health
    try:
        r = httpx.get(f"{base}/health", headers=headers, timeout=timeout)
        r.raise_for_status()
        data = r.json()
        if data.get("status") != "ok":
            failed.append(f"/health 返回 status={data.get('status')}")
        else:
            print("  ✅ /health")
    except Exception as e:
        failed.append(f"/health: {e}")
        print(f"  ❌ /health: {e}")
        print("  请先启动后端，例如: ./scripts/start.sh dev")
        sys.exit(1)

    # 2. Models list
    try:
        r = httpx.get(f"{base}/models/list", headers=headers, timeout=timeout)
        r.raise_for_status()
        data = r.json()
        models = data.get("models") or []
        if not data.get("ok"):
            failed.append("/models/list ok=False")
        else:
            print(f"  ✅ /models/list ({len(models)} 个模型)")
        if args.require_cloud35:
            found = next((m for m in models if (m.get("id") or "").strip() == CLOUD_35B_ID), None)
            if not found:
                failed.append(f"未找到云 35B 模型 id={CLOUD_35B_ID}，请检查 cloud_endpoints 与 CLOUD_QWEN_API_KEY")
            elif not found.get("available"):
                failed.append(f"云 35B ({CLOUD_35B_ID}) 在列表中但不可用 (available=False)")
            else:
                print(f"  ✅ 云 35B ({CLOUD_35B_ID}) 可用")
    except Exception as e:
        failed.append(f"/models/list: {e}")
        print(f"  ❌ /models/list: {e}")

    if failed:
        print("\n失败:", "; ".join(failed))
        sys.exit(1)
    print("\n✅ E2E 烟雾通过，可进行人工端到端测试（见 docs/E2E_FUNCTIONAL_TEST_PLAN.md）")
    sys.exit(0)


if __name__ == "__main__":
    main()
