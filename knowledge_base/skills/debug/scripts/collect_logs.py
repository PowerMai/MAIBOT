#!/usr/bin/env python3
"""
日志收集脚本 - Debug 模式专用

功能：
1. 扫描指定目录收集日志文件
2. 提取错误和异常信息
3. 生成结构化的日志摘要

使用方法：
    python collect_logs.py <log_dir> [--pattern "*.log"] [--hours 24]
"""

import os
import re
import sys
import json
import argparse
from datetime import datetime, timedelta
from pathlib import Path
from typing import List, Dict, Any


def find_log_files(log_dir: str, pattern: str = "*.log") -> List[Path]:
    """查找日志文件"""
    log_path = Path(log_dir)
    if not log_path.exists():
        return []
    return list(log_path.rglob(pattern))


def extract_errors(file_path: Path, hours: int = 24) -> List[Dict[str, Any]]:
    """从日志文件中提取错误信息"""
    errors = []
    error_patterns = [
        r'(?i)(error|exception|fail|critical|fatal)',
        r'Traceback \(most recent call last\)',
        r'(?i)^\s*(raise|assert)',
    ]
    
    try:
        with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
            lines = f.readlines()
        
        in_traceback = False
        traceback_lines = []
        
        for i, line in enumerate(lines):
            # 检测 Traceback 开始
            if 'Traceback (most recent call last)' in line:
                in_traceback = True
                traceback_lines = [line]
                continue
            
            # 收集 Traceback 内容
            if in_traceback:
                traceback_lines.append(line)
                # 检测 Traceback 结束（以异常类型开头的行）
                if re.match(r'^[A-Za-z][\w.]*Error|Exception:', line.strip()):
                    errors.append({
                        "type": "traceback",
                        "file": str(file_path),
                        "line": i - len(traceback_lines) + 2,
                        "content": ''.join(traceback_lines),
                    })
                    in_traceback = False
                    traceback_lines = []
                continue
            
            # 检测单行错误
            for pattern in error_patterns:
                if re.search(pattern, line):
                    errors.append({
                        "type": "error",
                        "file": str(file_path),
                        "line": i + 1,
                        "content": line.strip(),
                    })
                    break
    
    except Exception as e:
        errors.append({
            "type": "read_error",
            "file": str(file_path),
            "content": f"无法读取文件: {e}",
        })
    
    return errors


def generate_summary(errors: List[Dict[str, Any]]) -> Dict[str, Any]:
    """生成错误摘要"""
    # 按类型分组
    by_type = {}
    for err in errors:
        err_type = err.get("type", "unknown")
        if err_type not in by_type:
            by_type[err_type] = []
        by_type[err_type].append(err)
    
    # 按文件分组
    by_file = {}
    for err in errors:
        file_path = err.get("file", "unknown")
        if file_path not in by_file:
            by_file[file_path] = []
        by_file[file_path].append(err)
    
    return {
        "total_errors": len(errors),
        "by_type": {k: len(v) for k, v in by_type.items()},
        "by_file": {k: len(v) for k, v in by_file.items()},
        "errors": errors[:50],  # 只返回前 50 个
    }


def main():
    parser = argparse.ArgumentParser(description="收集和分析日志文件")
    parser.add_argument("log_dir", help="日志目录路径")
    parser.add_argument("--pattern", default="*.log", help="日志文件匹配模式")
    parser.add_argument("--hours", type=int, default=24, help="只分析最近N小时的日志")
    parser.add_argument("--output", help="输出文件路径 (JSON)")
    
    args = parser.parse_args()
    
    # 查找日志文件
    log_files = find_log_files(args.log_dir, args.pattern)
    
    if not log_files:
        print(json.dumps({
            "status": "no_logs",
            "message": f"在 {args.log_dir} 中未找到匹配 {args.pattern} 的日志文件",
        }, ensure_ascii=False, indent=2))
        return
    
    # 收集错误
    all_errors = []
    for log_file in log_files:
        errors = extract_errors(log_file, args.hours)
        all_errors.extend(errors)
    
    # 生成摘要
    summary = generate_summary(all_errors)
    summary["log_dir"] = args.log_dir
    summary["files_scanned"] = len(log_files)
    summary["timestamp"] = datetime.now().isoformat()
    
    # 输出
    output = json.dumps(summary, ensure_ascii=False, indent=2)
    
    if args.output:
        with open(args.output, 'w', encoding='utf-8') as f:
            f.write(output)
        print(f"日志摘要已保存到: {args.output}")
    else:
        print(output)


if __name__ == "__main__":
    main()
