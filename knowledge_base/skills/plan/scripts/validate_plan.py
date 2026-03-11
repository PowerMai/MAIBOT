#!/usr/bin/env python3
"""
计划验证脚本 - Plan 模式专用

功能：
1. 检查计划文档的完整性
2. 验证必要部分是否存在
3. 评估计划的可执行性

使用方法：
    python validate_plan.py <plan_file.md>
"""

import os
import re
import sys
import json
import argparse
from pathlib import Path
from typing import List, Dict, Any


# 必需的计划部分
REQUIRED_SECTIONS = [
    ("目标", ["目标", "目的", "goal", "objective"]),
    ("现状分析", ["现状", "背景", "current", "context", "分析"]),
    ("方案设计", ["方案", "设计", "实现", "solution", "approach"]),
    ("任务分解", ["任务", "步骤", "清单", "tasks", "steps", "todo"]),
]

# 可选但推荐的部分
OPTIONAL_SECTIONS = [
    ("风险评估", ["风险", "risk", "注意"]),
    ("资源需求", ["资源", "依赖", "resource", "dependency"]),
    ("时间估计", ["时间", "进度", "timeline", "schedule"]),
    ("验收标准", ["验收", "成功", "criteria", "success"]),
]


def extract_sections(content: str) -> Dict[str, str]:
    """提取文档中的各个部分"""
    sections = {}
    
    # 按标题分割
    lines = content.split('\n')
    current_section = None
    current_content = []
    
    for line in lines:
        # 检测 Markdown 标题
        header_match = re.match(r'^(#{1,3})\s+(.+)$', line)
        if header_match:
            # 保存前一个部分
            if current_section:
                sections[current_section] = '\n'.join(current_content).strip()
            
            current_section = header_match.group(2).strip()
            current_content = []
        else:
            current_content.append(line)
    
    # 保存最后一个部分
    if current_section:
        sections[current_section] = '\n'.join(current_content).strip()
    
    return sections


def check_section_exists(sections: Dict[str, str], keywords: List[str]) -> tuple:
    """检查某个部分是否存在"""
    for section_name, content in sections.items():
        section_lower = section_name.lower()
        for keyword in keywords:
            if keyword.lower() in section_lower:
                return True, section_name, content
    return False, None, None


def count_tasks(content: str) -> int:
    """统计任务数量"""
    # 匹配各种任务格式
    patterns = [
        r'^\s*[-*]\s*\[[ x]\]',  # - [ ] 或 - [x]
        r'^\s*\d+\.\s+',  # 1. 2. 3.
        r'^\s*[-*]\s+',  # - 或 *
    ]
    
    count = 0
    for line in content.split('\n'):
        for pattern in patterns:
            if re.match(pattern, line):
                count += 1
                break
    
    return count


def validate_plan(file_path: str) -> Dict[str, Any]:
    """验证计划文档"""
    result = {
        "file": file_path,
        "passed": False,
        "score": 0,
        "max_score": 100,
        "required_checks": [],
        "optional_checks": [],
        "warnings": [],
        "suggestions": [],
    }
    
    # 读取文件
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
    except Exception as e:
        result["error"] = f"无法读取文件: {e}"
        return result
    
    # 基本检查
    if len(content.strip()) < 100:
        result["warnings"].append("计划内容过短，可能不够详细")
    
    # 提取部分
    sections = extract_sections(content)
    
    # 检查必需部分
    required_score = 0
    for section_name, keywords in REQUIRED_SECTIONS:
        exists, found_name, found_content = check_section_exists(sections, keywords)
        check = {
            "section": section_name,
            "required": True,
            "found": exists,
            "found_as": found_name,
        }
        
        if exists:
            required_score += 20
            
            # 检查内容是否足够
            if found_content and len(found_content) < 50:
                result["warnings"].append(f"'{found_name}' 部分内容可能过于简略")
        else:
            result["suggestions"].append(f"建议添加 '{section_name}' 部分")
        
        result["required_checks"].append(check)
    
    # 检查可选部分
    optional_score = 0
    for section_name, keywords in OPTIONAL_SECTIONS:
        exists, found_name, _ = check_section_exists(sections, keywords)
        check = {
            "section": section_name,
            "required": False,
            "found": exists,
            "found_as": found_name,
        }
        
        if exists:
            optional_score += 5
        
        result["optional_checks"].append(check)
    
    # 检查任务分解
    task_count = count_tasks(content)
    result["task_count"] = task_count
    
    if task_count == 0:
        result["warnings"].append("未找到具体任务列表，建议添加可执行的任务清单")
    elif task_count < 3:
        result["warnings"].append("任务数量较少，可能需要进一步分解")
    elif task_count > 20:
        result["warnings"].append("任务数量较多，建议分组或分阶段")
    
    # 计算总分
    result["score"] = min(required_score + optional_score, 100)
    result["passed"] = required_score >= 60  # 至少 3 个必需部分
    
    # 生成总结
    if result["passed"]:
        result["summary"] = f"计划验证通过 (得分: {result['score']}/100)"
    else:
        result["summary"] = f"计划不完整，请补充缺失部分 (得分: {result['score']}/100)"
    
    return result


def main():
    parser = argparse.ArgumentParser(description="验证计划文档完整性")
    parser.add_argument("plan_file", help="计划文件路径 (.md)")
    parser.add_argument("--output", help="输出文件路径 (JSON)")
    parser.add_argument("--strict", action="store_true", help="严格模式（所有必需部分都必须存在）")
    
    args = parser.parse_args()
    
    # 验证计划
    result = validate_plan(args.plan_file)
    
    if args.strict:
        result["passed"] = all(c["found"] for c in result["required_checks"])
    
    # 输出
    output = json.dumps(result, ensure_ascii=False, indent=2)
    
    if args.output:
        with open(args.output, 'w', encoding='utf-8') as f:
            f.write(output)
        print(f"验证结果已保存到: {args.output}")
    else:
        print(output)
    
    # 返回状态码
    sys.exit(0 if result["passed"] else 1)


if __name__ == "__main__":
    main()
