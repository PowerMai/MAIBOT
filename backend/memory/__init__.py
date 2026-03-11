"""
Memory System - 使用 LangGraph 官方 Memory API

完全基于官方 API，不重复实现：
1. Checkpointer - 短期记忆（会话状态）
2. Store - 长期记忆（跨会话持久化）
3. project_memory - 项目记忆（.maibot/MAIBOT.md, .maibot/rules/*.md）

DeepAgent 原生机制（由框架自动处理）：
- project_memory: deep_agent._load_memory_content() 加载 .maibot/MAIBOT.md, .maibot/rules/*.md
- Skills 工具: 自定义注册 list_skills/match_skills/get_skill_info + BUNDLE.md 内联
"""

from langgraph.checkpoint.memory import MemorySaver
from langgraph.store.memory import InMemoryStore

try:
    from langgraph.checkpoint.sqlite import SqliteSaver
except ImportError:
    SqliteSaver = MemorySaver

# Rules 提取（使用 LangChain Chain）
from .rules_extractor import (
    extract_rules_from_conversation,
    format_rules_for_prompt,
    create_rules_extraction_chain,
)

# MemoryManager（Store API 包装器）
from .memory_manager import MemoryManager, get_memory_manager

__all__ = [
    # LangGraph 官方组件
    "MemorySaver",
    "SqliteSaver",
    "InMemoryStore",
    # Rules 提取
    "extract_rules_from_conversation",
    "format_rules_for_prompt",
    "create_rules_extraction_chain",
    # MemoryManager
    "MemoryManager",
    "get_memory_manager",
]
