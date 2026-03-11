#!/usr/bin/env python3
"""
计划保存脚本 - Plan 模式专用

功能：
1. 将计划保存到指定目录
2. 自动生成文件名（带时间戳）
3. 可选添加 YAML frontmatter

使用方法：
    python save_plan.py <plan_content_file> --title "项目计划" --output tmp/plans/
    echo "# 计划内容" | python save_plan.py - --title "快速计划"
"""

import os
import sys
import json
import argparse
from datetime import datetime
from pathlib import Path


PLAN_TEMPLATE = """---
title: {title}
created: {created}
status: draft
mode: plan
---

{content}
"""


def generate_filename(title: str) -> str:
    """生成文件名"""
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    # 清理标题作为文件名一部分
    safe_title = "".join(c if c.isalnum() or c in '-_' else '_' for c in title)
    safe_title = safe_title[:30]  # 限制长度
    return f"{timestamp}_{safe_title}.plan.md"


def save_plan(content: str, title: str, output_dir: str) -> dict:
    """保存计划文件"""
    result = {
        "success": False,
        "file_path": None,
        "message": None,
    }
    
    # 确保输出目录存在
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)
    
    # 生成文件名
    filename = generate_filename(title)
    file_path = output_path / filename
    
    # 准备内容
    created = datetime.now().isoformat()
    
    # 如果内容已经有 frontmatter，不重复添加
    if content.strip().startswith('---'):
        final_content = content
    else:
        final_content = PLAN_TEMPLATE.format(
            title=title,
            created=created,
            content=content,
        )
    
    # 保存文件
    try:
        with open(file_path, 'w', encoding='utf-8') as f:
            f.write(final_content)
        
        result["success"] = True
        result["file_path"] = str(file_path)
        result["message"] = f"计划已保存到: {file_path}"
        
    except Exception as e:
        result["message"] = f"保存失败: {e}"
    
    return result


def main():
    parser = argparse.ArgumentParser(description="保存计划文件")
    parser.add_argument("input", help="计划内容文件或 '-' 从 stdin 读取")
    parser.add_argument("--title", default="未命名计划", help="计划标题")
    parser.add_argument("--output", default="tmp/plans", help="输出目录")
    
    args = parser.parse_args()
    
    # 读取内容
    if args.input == '-':
        content = sys.stdin.read()
    else:
        with open(args.input, 'r', encoding='utf-8') as f:
            content = f.read()
    
    # 保存计划
    result = save_plan(content, args.title, args.output)
    
    # 输出结果
    print(json.dumps(result, ensure_ascii=False, indent=2))
    
    sys.exit(0 if result["success"] else 1)


if __name__ == "__main__":
    main()
