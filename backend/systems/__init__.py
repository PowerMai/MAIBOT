"""DeepAgents 系统模块

提供研究工作流的完整系统支持：
- 文件管理 (Research lifecycle)
- TODO管理 (Task decomposition)
- 缓存系统 (Query deduplication)
- 知识库集成 (Domain knowledge)
- 迭代管理 (Quality improvement)
- 流式报告 (Real-time updates)
- 响应规范化 (Sub-agent consolidation)
- 指标收集 (Performance tracking)
- 质量评分 (Research quality)
"""

from .file_manager import (
    ResearchFileManager,
    ResearchStage,
    get_research_file_manager,
)

__all__ = [
    "ResearchFileManager",
    "ResearchStage",
    "get_research_file_manager",
]

__version__ = "0.1.0"

