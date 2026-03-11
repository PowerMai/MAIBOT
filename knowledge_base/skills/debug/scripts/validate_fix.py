#!/usr/bin/env python3
"""
修复验证脚本 - Debug 模式专用

功能：
1. 验证修复是否有效
2. 检查是否引入新问题
3. 生成验证报告

使用方法：
    python validate_fix.py --test <test_command> --expected <expected_result>
    python validate_fix.py --file <file_to_check> --syntax
"""

import os
import re
import sys
import json
import argparse
import subprocess
from pathlib import Path
from typing import List, Dict, Any, Optional


def check_python_syntax(file_path: str) -> Dict[str, Any]:
    """检查 Python 文件语法"""
    result = {
        "file": file_path,
        "check": "syntax",
        "passed": False,
        "errors": [],
    }
    
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            source = f.read()
        
        compile(source, file_path, 'exec')
        result["passed"] = True
        result["message"] = "语法检查通过"
        
    except SyntaxError as e:
        result["errors"].append({
            "line": e.lineno,
            "offset": e.offset,
            "message": e.msg,
            "text": e.text.strip() if e.text else None,
        })
        result["message"] = f"语法错误: 第 {e.lineno} 行"
    
    except Exception as e:
        result["errors"].append({
            "type": type(e).__name__,
            "message": str(e),
        })
        result["message"] = f"检查失败: {e}"
    
    return result


def run_test_command(command: str, expected: str = None, timeout: int = 30) -> Dict[str, Any]:
    """运行测试命令并验证结果"""
    result = {
        "command": command,
        "check": "execution",
        "passed": False,
        "output": None,
        "error": None,
        "return_code": None,
    }
    
    try:
        proc = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        
        result["output"] = proc.stdout
        result["error"] = proc.stderr
        result["return_code"] = proc.returncode
        
        # 检查返回码
        if proc.returncode == 0:
            result["passed"] = True
            result["message"] = "命令执行成功"
        else:
            result["message"] = f"命令失败，返回码: {proc.returncode}"
        
        # 检查预期输出
        if expected and proc.returncode == 0:
            if expected in proc.stdout:
                result["expected_found"] = True
            else:
                result["passed"] = False
                result["expected_found"] = False
                result["message"] = f"输出不包含预期内容: {expected}"
        
    except subprocess.TimeoutExpired:
        result["message"] = f"命令超时 ({timeout}秒)"
        result["error"] = "TimeoutExpired"
    
    except Exception as e:
        result["message"] = f"执行失败: {e}"
        result["error"] = str(e)
    
    return result


def check_regression(file_path: str) -> Dict[str, Any]:
    """检查是否引入回归问题"""
    result = {
        "file": file_path,
        "check": "regression",
        "warnings": [],
    }
    
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
        
        # 检查常见问题
        patterns = [
            (r'print\s*\(.*[Dd]ebug', "发现调试打印语句"),
            (r'#\s*TODO', "发现 TODO 注释"),
            (r'#\s*FIXME', "发现 FIXME 注释"),
            (r'pass\s*$', "发现空 pass 语句"),
            (r'raise\s+Exception\s*\(', "发现通用 Exception"),
            (r'except:\s*$', "发现裸 except 语句"),
            (r'import\s+pdb', "发现 pdb 导入"),
            (r'breakpoint\(\)', "发现 breakpoint() 调用"),
        ]
        
        lines = content.split('\n')
        for i, line in enumerate(lines, 1):
            for pattern, message in patterns:
                if re.search(pattern, line):
                    result["warnings"].append({
                        "line": i,
                        "message": message,
                        "content": line.strip()[:50],
                    })
        
        result["passed"] = len(result["warnings"]) == 0
        result["message"] = "未发现回归问题" if result["passed"] else f"发现 {len(result['warnings'])} 个潜在问题"
        
    except Exception as e:
        result["passed"] = False
        result["message"] = f"检查失败: {e}"
    
    return result


def generate_report(checks: List[Dict[str, Any]]) -> Dict[str, Any]:
    """生成验证报告"""
    all_passed = all(c.get("passed", False) for c in checks)
    
    return {
        "status": "passed" if all_passed else "failed",
        "total_checks": len(checks),
        "passed_checks": sum(1 for c in checks if c.get("passed", False)),
        "failed_checks": sum(1 for c in checks if not c.get("passed", False)),
        "checks": checks,
        "recommendation": "修复已验证，可以提交" if all_passed else "修复验证失败，请检查上述问题",
    }


def main():
    parser = argparse.ArgumentParser(description="验证修复是否有效")
    parser.add_argument("--test", help="测试命令")
    parser.add_argument("--expected", help="预期输出内容")
    parser.add_argument("--file", help="要检查的文件")
    parser.add_argument("--syntax", action="store_true", help="检查语法")
    parser.add_argument("--regression", action="store_true", help="检查回归问题")
    parser.add_argument("--output", help="输出文件路径 (JSON)")
    
    args = parser.parse_args()
    
    checks = []
    
    # 语法检查
    if args.file and args.syntax:
        checks.append(check_python_syntax(args.file))
    
    # 回归检查
    if args.file and args.regression:
        checks.append(check_regression(args.file))
    
    # 命令测试
    if args.test:
        checks.append(run_test_command(args.test, args.expected))
    
    if not checks:
        print("错误: 请指定至少一种检查方式 (--test, --syntax, --regression)")
        sys.exit(1)
    
    # 生成报告
    report = generate_report(checks)
    
    # 输出
    output = json.dumps(report, ensure_ascii=False, indent=2)
    
    if args.output:
        with open(args.output, 'w', encoding='utf-8') as f:
            f.write(output)
        print(f"验证报告已保存到: {args.output}")
    else:
        print(output)
    
    # 返回状态码
    sys.exit(0 if report["status"] == "passed" else 1)


if __name__ == "__main__":
    main()
