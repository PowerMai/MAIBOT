#!/usr/bin/env python3
"""
知识缺口检测脚本：对照 schema/实体与未命中查询生成 gap_report.json 与可调度任务建议。

用法:
  python detect_gaps.py [--input path_to_entities_or_dir] [--output gap_report.json]
  python detect_gaps.py --output knowledge_base/learned/audits/gap_report.json

无 --input 时基于占位结构输出示例报告，便于 run_skill_script 调用后由 Agent 基于结果继续写 gap_tasks.json。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def build_placeholder_report() -> dict:
    """无实体数据时产出符合交付模板的占位报告，供后续人工或 Agent 替换为真实分析。"""
    return {
        "scope": {"description": "知识缺口分析", "time_window": "近30天"},
        "gaps_by_group": [],
        "impact_scores": {},
        "priority_summary": {"P0": 0, "P1": 0, "P2": 0},
        "suggested_tasks": [],
        "closed_and_regression": [],
        "_meta": {"script": "detect_gaps.py", "note": "建议提供 --input 指向 entities.jsonl 或 learned 目录以生成真实缺口"},
    }


def run_detect(input_path: Path | None, output_path: Path) -> dict:
    """执行缺口检测：若有 input 则尝试解析并统计，否则返回占位报告。"""
    if input_path and input_path.exists():
        # 最小实现：仅统计行数作为占位，实际可解析 entities/relations 做覆盖分析
        if input_path.is_file() and input_path.suffix == ".jsonl":
            line_count = sum(1 for _ in input_path.open(encoding="utf-8", errors="replace"))
            report = build_placeholder_report()
            report["_meta"]["input_file"] = str(input_path)
            report["_meta"]["entity_lines"] = line_count
            report["priority_summary"] = {"P0": 0, "P1": 0, "P2": 0}
            return report
        if input_path.is_dir():
            report = build_placeholder_report()
            report["_meta"]["input_dir"] = str(input_path)
            return report
    return build_placeholder_report()


def main() -> int:
    parser = argparse.ArgumentParser(description="知识缺口检测，输出 gap_report.json")
    parser.add_argument("--input", "-i", help="实体文件(.jsonl)或 learned 目录路径")
    parser.add_argument("--output", "-o", default="gap_report.json", help="输出 JSON 路径")
    args = parser.parse_args()

    input_path = Path(args.input).resolve() if args.input else None
    output_path = Path(args.output).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    report = run_detect(input_path, output_path)
    output_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"已写入: {output_path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
