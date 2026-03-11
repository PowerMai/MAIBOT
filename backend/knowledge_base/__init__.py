"""
Knowledge Base - 知识库模块

REST API 层的知识库管理，使用统一的向量索引。

注意：Agent 工具层使用 tools/base/embedding_tools.py 中的 search_knowledge
"""

from .manager import KnowledgeBaseManager

__all__ = [
    "KnowledgeBaseManager",
]
