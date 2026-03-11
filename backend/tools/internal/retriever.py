"""
通用检索工具 - 支持多种检索方式（已集成主流程）

============================================================
使用说明（Claude 风格：避免重复实现）
============================================================

主流程：embedding_tools.py → search_knowledge() / get_knowledge_retriever_tool()
当环境变量 USE_HYBRID_RETRIEVER=true 时，主流程会优先使用本模块的
UnifiedRetriever（BM25 + 向量混合检索），否则使用 VectorIndexManager 纯向量检索。

功能：
1. 向量检索 - 纯语义检索
2. 混合检索 - BM25 关键词 + 向量检索（EnsembleRetriever）
3. 过滤和重排序

遵循 LangChain 官方 API（EnsembleRetriever、BM25Retriever）
"""

import os
from copy import copy
from typing import List, Optional, Dict, Any
from langchain_core.documents import Document

# 解决OpenMP库冲突
os.environ.setdefault('KMP_DUPLICATE_LIB_OK', 'TRUE')

try:
    from langchain.retrievers import EnsembleRetriever
    from langchain_community.retrievers import BM25Retriever
except ImportError:
    EnsembleRetriever = None
    BM25Retriever = None


class UnifiedRetriever:
    """
    通用检索器 - 支持向量检索、混合检索等多种方式
    
    这是一个灵活的检索引擎，可以应用于任何向量存储
    """
    
    def __init__(
        self,
        vectorstore,
        documents: List[Document] = None,
        vector_weight: float = 0.5,
        keyword_weight: float = 0.5,
        k: int = 5
    ):
        """
        初始化通用检索器
        
        Args:
            vectorstore: LangChain 向量存储（FAISS/Chroma 等）
            documents: 文档列表（用于BM25索引，可选）
            vector_weight: 向量检索权重（0-1）
            keyword_weight: 关键词检索权重（0-1）
            k: 返回的文档数量
        """
        self.vectorstore = vectorstore
        self.documents = documents or []
        self.vector_weight = vector_weight
        self.keyword_weight = keyword_weight
        self.k = k
        
        # 创建向量检索器
        self.vector_retriever = vectorstore.as_retriever(
            search_kwargs={"k": k}
        )
        
        # 创建混合检索器与 keyword 专用 BM25（如果有文档），避免 retrieve() 每次重建
        self.hybrid_retriever = None
        self._bm25_retriever = None
        if self.documents and BM25Retriever:
            try:
                bm25_retriever = BM25Retriever.from_documents(self.documents)
                bm25_retriever.k = k
                self._bm25_retriever = bm25_retriever
                if EnsembleRetriever:
                    self.hybrid_retriever = EnsembleRetriever(
                        retrievers=[self.vector_retriever, bm25_retriever],
                        weights=[vector_weight, keyword_weight]
                    )
            except Exception as e:
                print(f"⚠️ 混合检索器初始化失败: {e}")
    
    def retrieve(
        self,
        query: str,
        k: Optional[int] = None,
        method: str = "hybrid"
    ) -> List[Document]:
        """
        执行检索
        
        Args:
            query: 查询字符串
            k: 返回的文档数量（不提供则使用初始化时的值）
            method: 检索方式 ('hybrid' - 混合, 'vector' - 向量, 'keyword' - 关键词)
        
        Returns:
            List[Document]: 检索到的文档列表
        """
        k = k or self.k
        
        if method == "hybrid" and self.hybrid_retriever:
            results = self.hybrid_retriever.invoke(query)
        elif method == "keyword" and self._bm25_retriever:
            bm25 = copy(self._bm25_retriever)
            bm25.k = k
            results = bm25.invoke(query)
        else:
            # 默认向量检索
            results = self.vector_retriever.invoke(query)
        
        # 去重；无 source 时用 id(doc) 保留每份文档
        seen = set()
        unique_results = []
        for doc in results:
            src = doc.metadata.get('source_file') or doc.metadata.get('source')
            chunk_id = getattr(doc, 'id', None) or doc.metadata.get('chunk_id') or doc.metadata.get('id')
            if chunk_id:
                doc_id = chunk_id
            elif src is not None:
                line_s = doc.metadata.get('line_start')
                line_e = doc.metadata.get('line_end')
                if line_s is not None or line_e is not None:
                    doc_id = (src, line_s, line_e)
                else:
                    doc_id = id(doc)
            else:
                doc_id = id(doc)
            if doc_id not in seen:
                seen.add(doc_id)
                # 确保精确 citation：file:line_start:line_end（JIT 验证用）
                if "citation" not in doc.metadata and doc.metadata.get("source"):
                    doc.metadata["citation"] = {
                        "file": doc.metadata.get("source", ""),
                        "line_start": doc.metadata.get("line_start", 1),
                        "line_end": doc.metadata.get("line_end", 1),
                    }
                unique_results.append(doc)
        
        return unique_results[:k]
    
    async def aretrieve(
        self,
        query: str,
        k: Optional[int] = None,
        method: str = "hybrid"
    ) -> List[Document]:
        """
        异步执行检索
        
        Args:
            query: 查询字符串
            k: 返回的文档数量
            method: 检索方式
        
        Returns:
            List[Document]: 检索到的文档列表
        """
        import asyncio
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(
            None,
            self.retrieve,
            query,
            k,
            method
        )
    
    def retrieve_with_filters(
        self,
        query: str,
        filters: Dict[str, Any],
        k: Optional[int] = None,
        method: str = "hybrid"
    ) -> List[Document]:
        """
        执行带过滤条件的检索
        
        Args:
            query: 查询字符串
            filters: 元数据过滤条件 {'key': 'value', ...}
            k: 返回的文档数量
            method: 检索方式
        
        Returns:
            List[Document]: 满足条件的文档列表
        """
        results = self.retrieve(query, k, method)
        
        # 应用过滤条件
        filtered_results = []
        for doc in results:
            match = True
            for key, value in filters.items():
                if doc.metadata.get(key) != value:
                    match = False
                    break
            if match:
                filtered_results.append(doc)
        
        return filtered_results


__all__ = ["UnifiedRetriever"]

