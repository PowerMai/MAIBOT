"""
内部模块：统一文档加载器（不暴露给 LLM）

这是一个内部工具类，为基础工具提供支撑。
LLM 应该使用 backend/tools/base/document_ops.py 中的工具。
"""

import os
from pathlib import Path
from typing import List, Optional
from langchain_core.documents import Document

# 解决 OpenMP 冲突
os.environ.setdefault('KMP_DUPLICATE_LIB_OK', 'TRUE')

try:
    from langchain_community.document_loaders import (
        PDFPlumberLoader,
        UnstructuredWordDocumentLoader,
        UnstructuredExcelLoader,
        TextLoader,
        CSVLoader,
    )
except ImportError:
    print("⚠️ LangChain document loaders not available. Installing dependencies...")
    import subprocess
    subprocess.run(
        ["pip", "install", "pdfplumber", "unstructured", "pdf2image"],
        capture_output=True
    )
    from langchain_community.document_loaders import (
        PDFPlumberLoader,
        UnstructuredWordDocumentLoader,
        UnstructuredExcelLoader,
        TextLoader,
        CSVLoader,
    )


class UnifiedDocumentLoader:
    """
    统一的文档加载器，支持多种格式
    遵循 LangChain 官方 API
    """
    
    LOADER_MAP = {
        '.pdf': PDFPlumberLoader,
        '.docx': UnstructuredWordDocumentLoader,
        '.doc': UnstructuredWordDocumentLoader,
        '.xlsx': UnstructuredExcelLoader,
        '.xls': UnstructuredExcelLoader,
        '.txt': TextLoader,
        '.csv': CSVLoader,
        '.md': TextLoader,
    }
    
    SUPPORTED_FORMATS = list(LOADER_MAP.keys())
    
    @staticmethod
    def load(file_path: str) -> List[Document]:
        """
        同步加载文档
        
        Args:
            file_path: 文件路径
            
        Returns:
            List[Document]: 文档列表
        """
        path = Path(file_path)
        
        if not path.exists():
            raise FileNotFoundError(f"文件不存在: {file_path}")
        
        # 获取文件扩展名
        ext = path.suffix.lower()
        
        # 选择合适的 Loader
        loader_class = UnifiedDocumentLoader.LOADER_MAP.get(ext)
        
        if not loader_class:
            raise ValueError(
                f"不支持的文件格式: {ext}\n"
                f"支持的格式: {', '.join(UnifiedDocumentLoader.SUPPORTED_FORMATS)}"
            )
        
        # 创建 Loader
        try:
            if loader_class == TextLoader:
                # TextLoader 需要指定编码
                loader = loader_class(file_path, encoding='utf-8')
            else:
                loader = loader_class(file_path)
            
            # 加载文档
            docs = loader.load()
            
            # 添加元数据
            for doc in docs:
                doc.metadata['source_file'] = file_path
                doc.metadata['file_type'] = ext
                doc.metadata['file_name'] = path.name
            
            print(f"✅ 加载 {path.name}: {len(docs)} 个文档块")
            return docs
            
        except Exception as e:
            print(f"❌ 加载 {path.name} 失败: {e}")
            raise
    
    @staticmethod
    async def aload(file_path: str) -> List[Document]:
        """
        异步加载文档
        
        Args:
            file_path: 文件路径
            
        Returns:
            List[Document]: 文档列表
        """
        import asyncio
        
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(
            None,
            UnifiedDocumentLoader.load,
            file_path
        )
    
    @staticmethod
    def load_directory(dir_path: str, pattern: str = "**/*") -> List[Document]:
        """
        加载目录中的所有支持的文档
        
        Args:
            dir_path: 目录路径
            pattern: 文件匹配模式
            
        Returns:
            List[Document]: 所有文档
        """
        dir_path = Path(dir_path)
        all_docs = []
        
        if not dir_path.is_dir():
            raise ValueError(f"不是有效的目录: {dir_path}")
        
        # 查找所有支持的文件
        for ext in UnifiedDocumentLoader.SUPPORTED_FORMATS:
            for file_path in dir_path.glob(f"{pattern}{ext}"):
                try:
                    docs = UnifiedDocumentLoader.load(str(file_path))
                    all_docs.extend(docs)
                except Exception as e:
                    print(f"⚠️ 加载失败 {file_path}: {e}")
                    continue
        
        print(f"✅ 加载目录完成: {len(all_docs)} 个文档块")
        return all_docs
    
    @staticmethod
    async def aload_directory(dir_path: str, pattern: str = "**/*") -> List[Document]:
        """
        异步加载目录中的所有支持的文档
        
        Args:
            dir_path: 目录路径
            pattern: 文件匹配模式
            
        Returns:
            List[Document]: 所有文档
        """
        import asyncio
        
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(
            None,
            UnifiedDocumentLoader.load_directory,
            dir_path,
            pattern
        )


__all__ = ["UnifiedDocumentLoader"]



__all__ = ["UnifiedDocumentLoader"]

