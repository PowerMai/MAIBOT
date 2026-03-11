#!/usr/bin/env python3
"""Discover MCP servers from public sources. Uses retries and fallback URLs."""

from __future__ import annotations

import json
import time

from urllib.request import urlopen, Request
from urllib.error import URLError, HTTPError


def fetch_url(url: str, timeout: float = 20.0, retries: int = 2) -> dict:
    """请求单个 URL，失败时重试 retries 次。"""
    last_error: str | None = None
    for attempt in range(retries + 1):
        try:
            req = Request(url, headers={"User-Agent": "MCP-Discovery/1.0"})
            with urlopen(req, timeout=timeout) as resp:
                code = int(getattr(resp, "status", 0) or 0)
            return {"url": url, "status_code": code, "ok": code == 200}
        except (URLError, HTTPError, OSError) as e:
            last_error = str(e)
            if attempt < retries:
                time.sleep(1.0 * (attempt + 1))
        except Exception as e:
            last_error = str(e)
            break
    return {"url": url, "ok": False, "error": last_error or "unknown"}


def main() -> None:
    keywords = ["mcp server filesystem", "mcp server database", "model context protocol server list"]
    urls = [
        "https://glama.ai/mcp/servers",
        "https://github.com/modelcontextprotocol",
        "https://github.com/modelcontextprotocol/servers",
    ]
    result = {"keywords": keywords, "sources": [], "notes": []}
    for url in urls:
        result["sources"].append(fetch_url(url))
    result["notes"].append("建议优先选官方 MCP 或 star/维护活跃度高的仓库。")
    if not any(s.get("ok") for s in result["sources"]):
        result["notes"].append("所有源均不可用时可使用本地/缓存 MCP 配置。")
    print(json.dumps(result, ensure_ascii=False))

