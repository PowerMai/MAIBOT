"""
🛠️ 工具系统 - 统一入口

设计原则（LangChain/DeepAgent 原生 + Claude 风格）：
1. 单一入口：CoreToolsRegistry 管理所有工具
2. DeepAgent 原生：FilesystemMiddleware, MemoryMiddleware
3. 无冗余：避免重复实现

工具层次：
- DeepAgent 原生: ls, read_file, write_file, edit_file, glob, grep, execute
- 核心工具: python_run, search_knowledge, think_tool, ask_user
- 学习工具: learn_from_doc, report_task_result (可选)
"""

from .base.registry import CoreToolsRegistry, get_all_core_tools

__all__ = [
    "CoreToolsRegistry",
    "get_all_core_tools",
]
