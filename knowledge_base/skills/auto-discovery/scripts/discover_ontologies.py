#!/usr/bin/env python3
"""Discover public ontology resources."""

from __future__ import annotations

import json

from urllib.request import urlopen


def main() -> None:
    targets = [
        "https://lov.linkeddata.es/dataset/lov/",
        "https://schema.org/docs/schemas.html",
    ]
    result = {"targets": [], "recommendation": []}
    for t in targets:
        try:
            with urlopen(t, timeout=20.0) as resp:
                code = int(getattr(resp, "status", 0) or 0)
            result["targets"].append({"url": t, "ok": code == 200, "status_code": code})
        except Exception as e:
            result["targets"].append({"url": t, "ok": False, "error": str(e)})
    result["recommendation"].append("优先导入与当前 domain 直接相关的 ontology，避免过宽泛本体污染。")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()

