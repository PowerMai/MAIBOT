"""
知识库管理器 - REST API 层

为 knowledge_api.py 提供服务，使用统一的向量索引。

注意：
- Agent 工具层使用 tools/base/embedding_tools.py 中的 search_knowledge
- 本模块为 REST API 提供服务，使用相同的底层索引
"""

import os
from pathlib import Path
from typing import List, Optional, Dict, Any

os.environ.setdefault('KMP_DUPLICATE_LIB_OK', 'TRUE')

from langchain_core.documents import Document

# 知识库路径
KB_ROOT_DIR = Path(__file__).parent.parent.parent / "knowledge_base"


class KnowledgeBaseManager:
    """
    知识库管理器 - REST API 层
    
    使用统一的 VectorIndexManager，不重复实现向量索引。
    支持多租户（user_id, team_id）用于未来扩展。
    """
    
    def __init__(self, user_id: Optional[str] = None, team_id: Optional[str] = None):
        """
        Args:
            user_id: 用户ID（用于个人知识库，未来扩展）
            team_id: 团队ID（用于团队知识库，未来扩展）
        """
        self.user_id = user_id
        self.team_id = team_id
        self._index_manager = None
        self._embeddings = None
    
    def _get_index_manager(self):
        """懒加载索引管理器"""
        if self._index_manager is None:
            try:
                from backend.tools.base.storage_manager import get_index_manager
                self._index_manager = get_index_manager()
            except ImportError:
                pass
        return self._index_manager
    
    def _get_embeddings(self):
        """懒加载嵌入模型"""
        if self._embeddings is None:
            try:
                from backend.tools.base.embedding_tools import get_embeddings
                self._embeddings = get_embeddings()
            except ImportError:
                pass
        return self._embeddings
    
    def retrieve_vector(self, query: str, k: int = 3) -> List[Document]:
        """
        向量检索
        
        Args:
            query: 查询文本
            k: 返回结果数量
            
        Returns:
            Document 列表
        """
        index_manager = self._get_index_manager()
        embeddings = self._get_embeddings()
        
        if not index_manager or not embeddings:
            return []
        
        if not index_manager.index_exists():
            return []
        
        results = index_manager.search(query, embeddings, top_k=k)
        
        return [
            Document(
                page_content=r.get("content", ""),
                metadata={
                    "source": r.get("source", ""),
                    "similarity_score": r.get("score", 0.0),
                    **r.get("metadata", {}),
                }
            )
            for r in results
        ]
    
    def retrieve_hybrid(self, query: str, k: int = 3) -> List[Document]:
        """
        混合检索（当前等同于向量检索）
        
        未来可扩展为 向量 + BM25 混合检索
        """
        return self.retrieve_vector(query, k)
    
    def retrieve_multi_source(self, query: str, k: int = 3) -> List[Document]:
        """
        多源检索
        
        当前等同于向量检索。
        未来可扩展为 个人 + 团队 + 公司 多源检索。
        """
        docs = self.retrieve_vector(query, k)
        
        # 添加来源类型标记
        for doc in docs:
            doc.metadata["source_type"] = "company"  # 当前只有公司级知识库
        
        return docs


__all__ = ["KnowledgeBaseManager"]
