#!/usr/bin/env python3
"""
合规检查脚本：对照招标要求与己方响应，输出合规检查结果、问题项与高风险项。

用法:
  python compliance_check.py <tender_json_path> <response_json_path> [--output result.json]
  python compliance_check.py --tender <path> --response <path> [-o result.json]

输入：tender 为 parse_tender 产出或含 scoring_criteria/disqualification_clauses 的 JSON；response 为己方响应摘要 JSON（含章节或条款对应关系）。
输出：合规结果 JSON（通过项、缺失项、高风险项、建议）。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def load_json(path: str | Path) -> dict:
    p = Path(path)
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {}


def run_check(tender: dict, response: dict) -> dict:
    """简单对照：要求中的关键键与响应中的键做存在性检查；实际可扩展为条款级比对。"""
    out = {
        "passed": [],
        "missing": [],
        "high_risk": [],
        "suggestions": [],
    }
    # 招标中常见的结构键
    required_keys = ["scoring_criteria", "disqualification_clauses", "qualification_requirements"]
    for key in required_keys:
        if tender.get(key):
            if response.get(key) or response.get("sections", {}).get(key):
                out["passed"].append(key)
            else:
                out["missing"].append(key)
                if key == "disqualification_clauses":
                    out["high_risk"].append(f"未在响应中显式对应：{key}")
    if not out["missing"] and not out["high_risk"]:
        out["suggestions"].append("建议人工复核废标条款与资格要求的逐条响应。")
    else:
        out["suggestions"].append("请补全缺失项并复核高风险项后再提交。")
    out["_meta"] = {"script": "compliance_check.py"}
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description="招投标合规检查")
    parser.add_argument("tender", nargs="?", help="招标结构化 JSON 路径")
    parser.add_argument("response", nargs="?", help="己方响应 JSON 路径")
    parser.add_argument("--tender", "-t", dest="tender_opt", help="招标 JSON 路径")
    parser.add_argument("--response", "-r", dest="response_opt", help="响应 JSON 路径")
    parser.add_argument("--output", "-o", help="输出结果 JSON 路径")
    args = parser.parse_args()

    tender_path = args.tender_opt or args.tender
    response_path = args.response_opt or args.response
    if not tender_path or not response_path:
        parser.print_help()
        return 1

    tender = load_json(tender_path)
    response = load_json(response_path)
    result = run_check(tender, response)

    j = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        Path(args.output).write_text(j, encoding="utf-8")
        print(f"已写入: {args.output}", file=sys.stderr)
    else:
        print(j)
    return 0


if __name__ == "__main__":
    sys.exit(main())
