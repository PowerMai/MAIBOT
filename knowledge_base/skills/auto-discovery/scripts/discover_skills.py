#!/usr/bin/env python3
"""Discover external Skill resources."""

from __future__ import annotations

import json


def main() -> None:
    queries = [
        "SKILL.md agent workflow examples",
        "anthropic agent skills",
        "cursor skill template",
    ]
    result = {
        "queries": queries,
        "selection_rules": [
            "优先官方文档或高质量仓库",
            "必须含触发条件、工作流、约束与示例",
            "优先可执行 scripts/ 资源",
        ],
    }
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()

