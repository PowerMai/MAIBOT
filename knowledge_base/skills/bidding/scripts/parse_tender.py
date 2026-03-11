#!/usr/bin/env python3
"""
招标文件解析脚本：从已提取的文本中抽取结构化信息（项目信息、资格要求、评分标准、废标条款、技术规格等），输出 JSON。

用法:
  python parse_tender.py <path_to_txt>
  python parse_tender.py --stdin   # 从 stdin 读取全文

输出写入 stdout 或 --output 指定路径；格式为 JSON，供阶段 1 风险清单、评分权重表、响应缺口使用。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


def extract_sections(text: str) -> dict:
    """从招标文本中做简单段落/关键词抽取，产出结构化占位。实际生产可接入 PDF/Word 解析或 NLU。"""
    text = text or ""
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    out = {
        "project_info": {},
        "qualification_requirements": [],
        "scoring_criteria": [],
        "disqualification_clauses": [],
        "tech_spec_summary": [],
        "raw_excerpts": {},
    }
    # 常见关键词触发
    key_qual = re.compile(r"资格|资质|要求|条件|具备")
    key_score = re.compile(r"评分|分值|得分|权重|标准")
    key_disq = re.compile(r"废标|无效|否决|不予受理")
    key_tech = re.compile(r"技术|规格|参数|性能|方案")
    for i, line in enumerate(lines):
        if key_qual.search(line):
            out["qualification_requirements"].append({"source_line": i + 1, "text": line[:200]})
        if key_score.search(line):
            out["scoring_criteria"].append({"source_line": i + 1, "text": line[:200]})
        if key_disq.search(line):
            out["disqualification_clauses"].append({"source_line": i + 1, "text": line[:200]})
        if key_tech.search(line):
            out["tech_spec_summary"].append({"source_line": i + 1, "text": line[:200]})
    # 限制条数避免过长
    for key in ("qualification_requirements", "scoring_criteria", "disqualification_clauses", "tech_spec_summary"):
        out[key] = out[key][:30]
    out["raw_excerpts"]["first_500"] = text[:500].replace("\n", " ")
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description="招标文件解析，输出结构化 JSON")
    parser.add_argument("path", nargs="?", help="招标文件文本路径（或已提取的 .txt）")
    parser.add_argument("--stdin", action="store_true", help="从 stdin 读取")
    parser.add_argument("--output", "-o", help="输出 JSON 路径，默认 stdout")
    args = parser.parse_args()

    if args.stdin:
        text = sys.stdin.read()
    elif args.path:
        p = Path(args.path)
        if not p.exists():
            print(f"文件不存在: {p}", file=sys.stderr)
            return 1
        text = p.read_text(encoding="utf-8", errors="replace")
    else:
        parser.print_help()
        return 1

    data = extract_sections(text)
    data["_meta"] = {"script": "parse_tender.py", "note": "建议结合 read_file/pdf/docx 获取原文后传入"}

    j = json.dumps(data, ensure_ascii=False, indent=2)
    if args.output:
        Path(args.output).write_text(j, encoding="utf-8")
        print(f"已写入: {args.output}", file=sys.stderr)
    else:
        print(j)
    return 0


if __name__ == "__main__":
    sys.exit(main())
