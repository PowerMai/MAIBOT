#!/usr/bin/env python3
"""
错误分析脚本 - Debug 模式专用

功能：
1. 解析错误堆栈
2. 提取关键信息（文件、行号、函数、变量）
3. 生成假设列表

使用方法：
    python analyze_error.py <error_file_or_string>
    cat error.log | python analyze_error.py -
"""

import os
import re
import sys
import json
import argparse
from pathlib import Path
from typing import List, Dict, Any, Optional


def parse_python_traceback(error_text: str) -> Dict[str, Any]:
    """解析 Python 错误堆栈"""
    result = {
        "type": "python_traceback",
        "exception_type": None,
        "exception_message": None,
        "frames": [],
        "root_cause_file": None,
        "root_cause_line": None,
    }
    
    lines = error_text.strip().split('\n')
    
    # 提取堆栈帧
    frame_pattern = r'^\s*File "([^"]+)", line (\d+), in (\w+)'
    for i, line in enumerate(lines):
        match = re.match(frame_pattern, line)
        if match:
            frame = {
                "file": match.group(1),
                "line": int(match.group(2)),
                "function": match.group(3),
            }
            # 尝试获取代码行
            if i + 1 < len(lines):
                code_line = lines[i + 1].strip()
                if not code_line.startswith('File ') and not re.match(r'^[A-Z][\w.]*:', code_line):
                    frame["code"] = code_line
            result["frames"].append(frame)
    
    # 提取异常类型和消息
    for line in reversed(lines):
        exception_match = re.match(r'^([A-Za-z][\w.]*(?:Error|Exception|Warning)): (.+)$', line.strip())
        if exception_match:
            result["exception_type"] = exception_match.group(1)
            result["exception_message"] = exception_match.group(2)
            break
        # 只有异常类型没有消息
        type_only_match = re.match(r'^([A-Za-z][\w.]*(?:Error|Exception|Warning))$', line.strip())
        if type_only_match:
            result["exception_type"] = type_only_match.group(1)
            break
    
    # 根因定位（最后一个非标准库的帧）
    for frame in reversed(result["frames"]):
        file_path = frame["file"]
        if not any(x in file_path for x in ['/lib/python', 'site-packages', '<frozen']):
            result["root_cause_file"] = file_path
            result["root_cause_line"] = frame["line"]
            break
    
    return result


def generate_hypotheses(analysis: Dict[str, Any]) -> List[Dict[str, Any]]:
    """根据错误分析生成假设"""
    hypotheses = []
    
    exception_type = analysis.get("exception_type", "")
    exception_msg = analysis.get("exception_message", "")
    
    # 基于异常类型生成假设
    if exception_type == "KeyError":
        hypotheses.append({
            "hypothesis": "字典键不存在",
            "probability": "high",
            "verification": f"检查访问的键是否存在: {exception_msg}",
            "check_command": f"grep -n '{exception_msg}' <file>",
        })
    
    elif exception_type == "AttributeError":
        hypotheses.append({
            "hypothesis": "对象属性或方法不存在",
            "probability": "high", 
            "verification": f"检查对象类型和可用属性",
            "check_command": "print(type(obj), dir(obj))",
        })
    
    elif exception_type == "TypeError":
        hypotheses.append({
            "hypothesis": "类型不匹配或参数错误",
            "probability": "high",
            "verification": "检查函数签名和传入参数类型",
            "check_command": "print(type(arg) for arg in args)",
        })
    
    elif exception_type == "IndexError":
        hypotheses.append({
            "hypothesis": "索引越界",
            "probability": "high",
            "verification": "检查列表长度和访问的索引",
            "check_command": "print(len(list), index)",
        })
    
    elif exception_type == "FileNotFoundError":
        hypotheses.append({
            "hypothesis": "文件路径错误或文件不存在",
            "probability": "high",
            "verification": f"检查文件路径: {exception_msg}",
            "check_command": f"ls -la {exception_msg}",
        })
    
    elif exception_type == "ImportError" or exception_type == "ModuleNotFoundError":
        hypotheses.append({
            "hypothesis": "模块未安装或路径错误",
            "probability": "high",
            "verification": f"检查模块是否安装: {exception_msg}",
            "check_command": f"pip show {exception_msg.split()[0] if exception_msg else 'module'}",
        })
    
    elif exception_type == "ValueError":
        hypotheses.append({
            "hypothesis": "值不符合预期",
            "probability": "high",
            "verification": f"检查传入值: {exception_msg}",
            "check_command": "print(repr(value))",
        })
    
    # 通用假设
    if analysis.get("root_cause_file"):
        hypotheses.append({
            "hypothesis": "代码逻辑错误",
            "probability": "medium",
            "verification": f"检查 {analysis['root_cause_file']}:{analysis['root_cause_line']}",
            "check_command": f"sed -n '{max(1, analysis['root_cause_line']-5)},{analysis['root_cause_line']+5}p' {analysis['root_cause_file']}",
        })
    
    hypotheses.append({
        "hypothesis": "数据问题（空值、格式错误）",
        "probability": "medium",
        "verification": "检查输入数据的完整性和格式",
        "check_command": "print(data[:5] if hasattr(data, '__len__') else data)",
    })
    
    return hypotheses


def main():
    parser = argparse.ArgumentParser(description="分析错误并生成假设")
    parser.add_argument("input", help="错误文件路径或 '-' 表示从 stdin 读取")
    parser.add_argument("--output", help="输出文件路径 (JSON)")
    
    args = parser.parse_args()
    
    # 读取错误内容
    if args.input == '-':
        error_text = sys.stdin.read()
    elif os.path.exists(args.input):
        with open(args.input, 'r', encoding='utf-8') as f:
            error_text = f.read()
    else:
        # 假设直接传入错误文本
        error_text = args.input
    
    # 分析错误
    analysis = parse_python_traceback(error_text)
    
    # 生成假设
    hypotheses = generate_hypotheses(analysis)
    
    # 组装结果
    result = {
        "analysis": analysis,
        "hypotheses": hypotheses,
        "recommended_action": None,
    }
    
    # 推荐操作
    if hypotheses:
        result["recommended_action"] = {
            "hypothesis": hypotheses[0]["hypothesis"],
            "next_step": hypotheses[0]["verification"],
            "command": hypotheses[0].get("check_command"),
        }
    
    # 输出
    output = json.dumps(result, ensure_ascii=False, indent=2)
    
    if args.output:
        with open(args.output, 'w', encoding='utf-8') as f:
            f.write(output)
        print(f"分析结果已保存到: {args.output}")
    else:
        print(output)


if __name__ == "__main__":
    main()
