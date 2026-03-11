#!/usr/bin/env python3
"""
范围分析脚本 - Plan 模式专用

功能：
1. 分析任务范围和复杂度
2. 识别涉及的文件和模块
3. 评估影响范围

使用方法：
    python analyze_scope.py <project_dir> --query "添加用户认证功能"
"""

import os
import re
import sys
import json
import argparse
from pathlib import Path
from typing import List, Dict, Any


def scan_project_structure(project_dir: str, max_depth: int = 3) -> Dict[str, Any]:
    """扫描项目结构"""
    structure = {
        "root": project_dir,
        "directories": [],
        "file_counts": {},
        "total_files": 0,
    }
    
    project_path = Path(project_dir)
    
    # 忽略的目录
    ignore_dirs = {'.git', '__pycache__', 'node_modules', '.venv', 'venv', '.idea', '.vscode'}
    
    for root, dirs, files in os.walk(project_path):
        # 过滤忽略的目录
        dirs[:] = [d for d in dirs if d not in ignore_dirs]
        
        rel_path = Path(root).relative_to(project_path)
        depth = len(rel_path.parts)
        
        if depth > max_depth:
            continue
        
        if depth > 0:
            structure["directories"].append(str(rel_path))
        
        # 统计文件类型
        for f in files:
            ext = Path(f).suffix.lower() or '.no_ext'
            structure["file_counts"][ext] = structure["file_counts"].get(ext, 0) + 1
            structure["total_files"] += 1
    
    return structure


def find_relevant_files(project_dir: str, keywords: List[str]) -> List[Dict[str, Any]]:
    """根据关键词查找相关文件"""
    relevant = []
    project_path = Path(project_dir)
    
    # 文件扩展名优先级
    priority_exts = {'.py': 1, '.js': 1, '.ts': 1, '.tsx': 1, '.jsx': 1, '.go': 1, '.java': 1}
    
    # 忽略的目录
    ignore_dirs = {'.git', '__pycache__', 'node_modules', '.venv', 'venv'}
    
    for root, dirs, files in os.walk(project_path):
        dirs[:] = [d for d in dirs if d not in ignore_dirs]
        
        for f in files:
            file_path = Path(root) / f
            rel_path = file_path.relative_to(project_path)
            
            # 检查文件名匹配
            name_lower = f.lower()
            for kw in keywords:
                if kw.lower() in name_lower:
                    relevant.append({
                        "path": str(rel_path),
                        "match_type": "filename",
                        "keyword": kw,
                    })
                    break
            
            # 检查内容匹配（只检查代码文件）
            ext = file_path.suffix.lower()
            if ext in priority_exts:
                try:
                    content = file_path.read_text(encoding='utf-8', errors='ignore')
                    for kw in keywords:
                        if kw.lower() in content.lower():
                            if str(rel_path) not in [r["path"] for r in relevant]:
                                relevant.append({
                                    "path": str(rel_path),
                                    "match_type": "content",
                                    "keyword": kw,
                                })
                            break
                except:
                    pass
    
    return relevant[:20]  # 限制返回数量


def estimate_complexity(query: str, structure: Dict[str, Any], relevant_files: List[Dict]) -> Dict[str, Any]:
    """估计任务复杂度"""
    complexity = {
        "level": "medium",
        "factors": [],
        "estimated_files": len(relevant_files),
    }
    
    # 关键词复杂度指标
    high_complexity_keywords = [
        "重构", "迁移", "架构", "全部", "所有", "重新设计",
        "refactor", "migrate", "architecture", "all", "redesign"
    ]
    
    medium_complexity_keywords = [
        "添加", "修改", "更新", "优化", "集成",
        "add", "modify", "update", "optimize", "integrate"
    ]
    
    query_lower = query.lower()
    
    # 检查高复杂度关键词
    for kw in high_complexity_keywords:
        if kw in query_lower:
            complexity["level"] = "high"
            complexity["factors"].append(f"包含高复杂度关键词: {kw}")
            break
    
    # 文件数量影响
    if len(relevant_files) > 10:
        complexity["level"] = "high"
        complexity["factors"].append(f"涉及文件较多: {len(relevant_files)} 个")
    elif len(relevant_files) > 5:
        if complexity["level"] != "high":
            complexity["level"] = "medium"
        complexity["factors"].append(f"涉及多个文件: {len(relevant_files)} 个")
    else:
        if complexity["level"] != "high":
            complexity["level"] = "low" if len(relevant_files) <= 2 else "medium"
    
    # 项目规模影响
    if structure["total_files"] > 500:
        complexity["factors"].append(f"大型项目: {structure['total_files']} 个文件")
    
    return complexity


def main():
    parser = argparse.ArgumentParser(description="分析任务范围和复杂度")
    parser.add_argument("project_dir", help="项目目录")
    parser.add_argument("--query", required=True, help="任务描述")
    parser.add_argument("--output", help="输出文件路径 (JSON)")
    
    args = parser.parse_args()
    
    # 提取关键词
    keywords = [w for w in re.split(r'[，,\s]+', args.query) if len(w) > 1]
    
    # 分析项目结构
    structure = scan_project_structure(args.project_dir)
    
    # 查找相关文件
    relevant_files = find_relevant_files(args.project_dir, keywords)
    
    # 估计复杂度
    complexity = estimate_complexity(args.query, structure, relevant_files)
    
    # 组装结果
    result = {
        "query": args.query,
        "keywords": keywords,
        "project_structure": {
            "total_files": structure["total_files"],
            "directories": structure["directories"][:10],
            "file_types": dict(sorted(structure["file_counts"].items(), key=lambda x: -x[1])[:5]),
        },
        "relevant_files": relevant_files,
        "complexity": complexity,
        "recommendations": [],
    }
    
    # 生成建议
    if complexity["level"] == "high":
        result["recommendations"].append("建议分阶段实施")
        result["recommendations"].append("建议先进行详细设计评审")
    elif complexity["level"] == "medium":
        result["recommendations"].append("建议明确任务边界和验收标准")
    
    if len(relevant_files) > 0:
        result["recommendations"].append(f"建议先熟悉相关文件: {relevant_files[0]['path']}")
    
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
