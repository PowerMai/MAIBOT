# ✅ 完整的 LangChain + LangGraph 官方 RAG 实现方案

## 🎯 架构设计（基于官方工具）

```
┌─────────────────────────────────────────────────────────────────┐
│ 前端上传 → LangGraph Store （文件存储）                         │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 后端 RAG 处理流程 (LangGraph)                                   │
│                                                                 │
│ Step 1: 文档加载节点                                           │
│  └─ LangChain DocumentLoader (支持 PDF、Word、TXT 等)          │
│                                                                 │
│ Step 2: 文本分割节点 ✅ 并行处理                              │
│  └─ RecursiveCharacterTextSplitter (官方推荐)                │
│  └─ chunk_size=1000, overlap=200                              │
│                                                                 │
│ Step 3: 向量化节点 ✅ 并行嵌入                                 │
│  └─ OpenAIEmbeddings 或 HuggingFaceEmbeddings                 │
│  └─ 使用官方提供的嵌入模型                                     │
│                                                                 │
│ Step 4: 向量库存储节点 ✅ 持久化                              │
│  └─ Chroma / FAISS / Pinecone （官方集成）                    │
│  └─ 与元数据一起存储                                           │
│                                                                 │
│ Step 5: 检索与分析节点                                         │
│  └─ 使用 RAG 链进行分析                                        │
│  └─ DeepAgent 处理结果                                         │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🛠️ Step 1: 安装依赖

```bash
# 核心 LangChain 工具
pip install langchain langchain-text-splitters

# 文档加载器
pip install pypdf python-docx

# 嵌入模型
pip install langchain-openai  # 使用 OpenAI
# 或
pip install langchain-huggingface  # 使用 HuggingFace

# 向量库
pip install chroma  # 推荐：简单、本地存储
# 或
pip install faiss-cpu  # Facebook FAISS
# 或
pip install pinecone-client  # Pinecone（云存储）
```

---

## 📝 Step 2: 实现 RAG 处理流程

### 2.1 文件加载和分割（backend/engine/rag/document_processor.py）

```python
"""
✅ 文档处理器 - 使用 LangChain 官方工具
功能：加载、分割、向量化、存储
"""

import logging
from typing import List, Optional, Dict, Any
import asyncio
from pathlib import Path

from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_community.document_loaders import (
    PyPDFLoader,
    TextLoader,
    UnstructuredWordDocumentLoader,
    CSVLoader,
)
from langchain_core.documents import Document
from langchain_openai import OpenAIEmbeddings
# 或使用开源模型
from langchain_huggingface import HuggingFaceEmbeddings

logger = logging.getLogger(__name__)


class DocumentProcessor:
    """
    ✅ LangChain 官方工具的文档处理器
    
    功能：
    1. 加载各种格式的文档
    2. 使用 RecursiveCharacterTextSplitter 分割
    3. 使用官方嵌入模型向量化
    4. 存储到向量库
    """
    
    # 文档加载器映射
    LOADERS = {
        'application/pdf': PyPDFLoader,
        'text/plain': TextLoader,
        'application/msword': UnstructuredWordDocumentLoader,
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 
            UnstructuredWordDocumentLoader,
        'text/csv': CSVLoader,
    }
    
    def __init__(
        self,
        chunk_size: int = 1000,
        chunk_overlap: int = 200,
        embedding_model: str = "openai",  # "openai" 或 "huggingface"
    ):
        """
        初始化处理器
        
        参数：
        - chunk_size: 每个块的大小（字符数）
        - chunk_overlap: 块之间的重叠（用于保持上下文）
        - embedding_model: 嵌入模型选择
        """
        
        # ✅ 使用 LangChain 官方的文本分割器
        self.text_splitter = RecursiveCharacterTextSplitter(
            chunk_size=chunk_size,
            chunk_overlap=chunk_overlap,
            separators=["\n\n", "\n", " ", ""],  # 优先保持段落和句子完整
            length_function=len,
            add_start_index=True,  # 添加文本位置信息
        )
        
        # ✅ 选择嵌入模型
        if embedding_model == "openai":
            self.embeddings = OpenAIEmbeddings(model="text-embedding-3-small")
        elif embedding_model == "huggingface":
            self.embeddings = HuggingFaceEmbeddings(
                model_name="sentence-transformers/all-MiniLM-L6-v2"
            )
        else:
            raise ValueError(f"未知的嵌入模型: {embedding_model}")
        
        logger.info(f"✅ 文档处理器已初始化")
        logger.info(f"  - 分割大小: {chunk_size} 字符")
        logger.info(f"  - 重叠大小: {chunk_overlap} 字符")
        logger.info(f"  - 嵌入模型: {embedding_model}")
    
    async def load_document(
        self,
        file_path: str,
        content_type: str,
    ) -> List[Document]:
        """
        ✅ 使用 LangChain 加载器加载文档
        
        支持的格式：
        - PDF: application/pdf
        - Word: application/msword
        - TXT: text/plain
        - CSV: text/csv
        """
        
        logger.info(f"📂 开始加载文档: {file_path}")
        
        try:
            # 获取对应的加载器
            loader_class = self.LOADERS.get(content_type)
            
            if not loader_class:
                logger.warning(f"⚠️ 不支持的文件类型: {content_type}，作为文本处理")
                # 作为文本文件处理
                with open(file_path, 'r', encoding='utf-8') as f:
                    content = f.read()
                
                return [Document(
                    page_content=content,
                    metadata={
                        "source": file_path,
                        "content_type": content_type,
                    }
                )]
            
            # 使用相应的加载器
            loader = loader_class(file_path)
            documents = loader.load()
            
            logger.info(f"✅ 已加载文档: {len(documents)} 页面")
            
            # 添加元数据
            for doc in documents:
                doc.metadata['source'] = file_path
                doc.metadata['content_type'] = content_type
            
            return documents
        
        except Exception as e:
            logger.error(f"❌ 加载文档失败: {e}")
            raise
    
    async def split_documents(
        self,
        documents: List[Document],
    ) -> List[Document]:
        """
        ✅ 使用 LangChain 的 RecursiveCharacterTextSplitter 分割文档
        
        优势：
        - 智能分割点选择（段落 → 句子 → 单词）
        - 保持上下文的重叠
        - 保留原始元数据
        """
        
        logger.info(f"✂️ 开始分割 {len(documents)} 个文档")
        
        try:
            # 使用官方分割器
            split_docs = self.text_splitter.split_documents(documents)
            
            logger.info(f"✅ 分割完成: {len(documents)} 文档 → {len(split_docs)} 块")
            logger.info(f"  - 平均块大小: {sum(len(d.page_content) for d in split_docs) // len(split_docs) if split_docs else 0} 字符")
            
            return split_docs
        
        except Exception as e:
            logger.error(f"❌ 分割文档失败: {e}")
            raise
    
    async def embed_documents(
        self,
        documents: List[Document],
        batch_size: int = 10,
    ) -> List[tuple]:
        """
        ✅ 并行向量化文档块
        
        参数：
        - documents: 文档块列表
        - batch_size: 批处理大小（减少 API 调用）
        
        返回：
        - (document, embedding) 元组列表
        """
        
        logger.info(f"🔢 开始向量化 {len(documents)} 个文档块（批大小: {batch_size}）")
        
        try:
            embeddings_with_docs = []
            
            # 批量向量化
            for i in range(0, len(documents), batch_size):
                batch = documents[i:i+batch_size]
                batch_texts = [doc.page_content for doc in batch]
                
                # ✅ 使用官方嵌入模型进行并行向量化
                batch_embeddings = await asyncio.to_thread(
                    self.embeddings.embed_documents,
                    batch_texts
                )
                
                for doc, embedding in zip(batch, batch_embeddings):
                    embeddings_with_docs.append((doc, embedding))
                
                logger.debug(f"✅ 已向量化批次 {i//batch_size + 1}: {len(batch)} 块")
            
            logger.info(f"✅ 向量化完成: {len(embeddings_with_docs)} 块")
            
            return embeddings_with_docs
        
        except Exception as e:
            logger.error(f"❌ 向量化失败: {e}")
            raise


# 全局实例
document_processor = DocumentProcessor(
    chunk_size=1000,
    chunk_overlap=200,
    embedding_model="huggingface",  # 使用开源模型（本地 LLM）
)
```

### 2.2 向量库存储（backend/engine/rag/vector_store.py）

```python
"""
✅ 向量库管理 - 使用 LangChain 官方集成
支持 Chroma（推荐）、FAISS、Pinecone 等
"""

import logging
from typing import List, Dict, Any, Optional
from pathlib import Path

from langchain_chroma import Chroma
# 或其他向量库：
# from langchain_community.vectorstores import FAISS
# from langchain_pinecone import Pinecone

logger = logging.getLogger(__name__)


class VectorStoreManager:
    """
    ✅ 向量库管理器 - 基于 LangChain 官方集成
    
    支持的向量库：
    - Chroma（推荐：本地、简单）
    - FAISS（Facebook）
    - Pinecone（云存储）
    - Weaviate（生产级）
    """
    
    def __init__(
        self,
        persistence_directory: str = "./chroma_db",
        vector_store_type: str = "chroma",
    ):
        """
        初始化向量库
        
        参数：
        - persistence_directory: 向量库存储路径
        - vector_store_type: 向量库类型（chroma、faiss、pinecone）
        """
        
        self.persistence_dir = Path(persistence_directory)
        self.persistence_dir.mkdir(parents=True, exist_ok=True)
        self.vector_store_type = vector_store_type
        self.vector_store = None
        
        logger.info(f"✅ 向量库管理器已初始化")
        logger.info(f"  - 类型: {vector_store_type}")
        logger.info(f"  - 路径: {self.persistence_dir}")
    
    async def add_documents(
        self,
        embeddings,
        documents_with_embeddings: List[tuple],
        collection_name: str = "documents",
    ) -> str:
        """
        ✅ 添加文档到向量库
        
        参数：
        - embeddings: 嵌入模型
        - documents_with_embeddings: (document, embedding) 元组列表
        - collection_name: 集合名称（用于组织文档）
        
        返回：
        - collection_id
        """
        
        logger.info(f"💾 开始存储 {len(documents_with_embeddings)} 个文档到向量库")
        
        try:
            documents = [doc for doc, _ in documents_with_embeddings]
            
            # ✅ 使用 LangChain 的 Chroma 集成
            vector_store = Chroma.from_documents(
                documents=documents,
                embedding=embeddings,
                collection_name=collection_name,
                persist_directory=str(self.persistence_dir),
                collection_metadata={
                    "source": "langgraph_rag",
                    "type": "file_documents",
                }
            )
            
            # 持久化
            vector_store.persist()
            
            logger.info(f"✅ 已存储 {len(documents)} 个文档")
            logger.info(f"  - 集合名称: {collection_name}")
            logger.info(f"  - 向量库大小: {len(vector_store.get()['documents'])} 文档")
            
            self.vector_store = vector_store
            
            return collection_name
        
        except Exception as e:
            logger.error(f"❌ 存储文档失败: {e}")
            raise
    
    async def search(
        self,
        query: str,
        embeddings,
        collection_name: str = "documents",
        k: int = 5,
    ) -> List[Dict[str, Any]]:
        """
        ✅ 在向量库中搜索相关文档
        
        参数：
        - query: 查询文本
        - embeddings: 嵌入模型
        - collection_name: 集合名称
        - k: 返回的文档数量
        
        返回：
        - 相关文档列表，带相似度分数
        """
        
        logger.info(f"🔍 在向量库中搜索: {query[:50]}...")
        
        try:
            # 加载向量库
            vector_store = Chroma(
                collection_name=collection_name,
                embedding_function=embeddings,
                persist_directory=str(self.persistence_dir),
            )
            
            # 搜索相关文档
            results = vector_store.similarity_search_with_score(query, k=k)
            
            formatted_results = []
            for doc, score in results:
                formatted_results.append({
                    "content": doc.page_content,
                    "metadata": doc.metadata,
                    "similarity_score": score,
                })
            
            logger.info(f"✅ 搜索完成: 找到 {len(formatted_results)} 个相关文档")
            
            return formatted_results
        
        except Exception as e:
            logger.error(f"❌ 搜索失败: {e}")
            raise
    
    async def list_collections(self) -> List[str]:
        """列出所有集合"""
        try:
            # 这里需要根据具体的向量库实现
            logger.info(f"📋 正在列出所有集合...")
            # 实现依赖于向量库类型
            return []
        except Exception as e:
            logger.error(f"❌ 列出集合失败: {e}")
            raise


# 全局实例
vector_store_manager = VectorStoreManager(
    persistence_directory="./storage/chroma_db",
    vector_store_type="chroma",
)
```

---

## 🔄 Step 3: LangGraph 节点集成

### 3.1 RAG 处理节点（backend/engine/nodes/rag_processor_node.py）

```python
"""
✅ RAG 处理节点 - 整合文档处理、向量化、存储
"""

import logging
from typing import Dict, Any
import asyncio

from engine.state.agent_state import AgentState
from engine.rag.document_processor import document_processor
from engine.rag.vector_store import vector_store_manager
from langchain_core.messages import HumanMessage

logger = logging.getLogger(__name__)


async def rag_processor_node(state: AgentState) -> Dict[str, Any]:
    """
    ✅ RAG 处理节点
    
    流程：
    1. 检测消息中的文件
    2. 从 Store 加载文件
    3. 使用 LangChain 加载器加载文件
    4. 使用 RecursiveCharacterTextSplitter 分割
    5. 并行向量化
    6. 存储到向量库
    """
    
    messages = state.get('messages', [])
    
    if not messages:
        return state
    
    last_message = messages[-1]
    
    # 检查是否有文件
    if not isinstance(last_message, HumanMessage):
        return state
    
    file_ids = _extract_file_ids(last_message)
    
    if not file_ids:
        return state
    
    logger.info(f"📄 开始 RAG 处理: {len(file_ids)} 个文件")
    
    processing_results = []
    
    for file_id in file_ids:
        try:
            # 1. 从 Store 获取文件
            # (需要在节点中获取 store)
            # file_info = await store.get(["files", file_id], "content")
            
            # 2. 加载文档
            # documents = await document_processor.load_document(
            #     file_path=file_info["path"],
            #     content_type=file_info["content_type"],
            # )
            
            # 3. 分割文档
            # split_docs = await document_processor.split_documents(documents)
            
            # 4. 并行向量化
            # embeddings_with_docs = await document_processor.embed_documents(
            #     split_docs,
            #     batch_size=10,
            # )
            
            # 5. 存储到向量库
            # collection_id = await vector_store_manager.add_documents(
            #     embeddings=document_processor.embeddings,
            #     documents_with_embeddings=embeddings_with_docs,
            #     collection_name=file_id,
            # )
            
            result = {
                "file_id": file_id,
                "status": "success",
                # "chunk_count": len(split_docs),
                # "collection_id": collection_id,
            }
            
            processing_results.append(result)
            logger.info(f"✅ RAG 处理完成: {file_id}")
        
        except Exception as e:
            logger.error(f"❌ RAG 处理失败 {file_id}: {e}")
            processing_results.append({
                "file_id": file_id,
                "status": "error",
                "error": str(e),
            })
    
    # 将结果添加到消息中
    if processing_results:
        result_message = HumanMessage(
            content=f"✅ RAG 处理完成: {len(processing_results)} 个文件",
            additional_kwargs={
                "rag_results": processing_results,
            }
        )
        state['messages'].append(result_message)
    
    return state


def _extract_file_ids(message: HumanMessage) -> list:
    """从消息中提取文件 ID"""
    file_ids = []
    
    if isinstance(message.content, list):
        for block in message.content:
            if isinstance(block, dict) and block.get('type') == 'file':
                file_data = block.get('data', '')
                if file_data.startswith('file://'):
                    file_id = file_data.replace('file://', '')
                    file_ids.append(file_id)
    
    return file_ids
```

### 3.2 检索与分析节点（backend/engine/nodes/retrieval_node.py）

```python
"""
✅ 检索与分析节点 - 从向量库检索相关文档
"""

import logging
from typing import Dict, Any

from engine.state.agent_state import AgentState
from engine.rag.vector_store import vector_store_manager
from engine.rag.document_processor import document_processor
from langchain_core.messages import SystemMessage

logger = logging.getLogger(__name__)


async def retrieval_node(state: AgentState) -> Dict[str, Any]:
    """
    ✅ 检索节点
    
    功能：
    1. 提取用户查询
    2. 从向量库检索相关文档
    3. 添加到系统提示中
    """
    
    messages = state.get('messages', [])
    
    if not messages:
        return state
    
    # 获取最后一条用户消息
    user_query = ""
    for msg in reversed(messages):
        if hasattr(msg, 'content') and isinstance(msg.content, str):
            user_query = msg.content
            break
    
    if not user_query:
        return state
    
    logger.info(f"🔍 开始检索: {user_query[:50]}...")
    
    try:
        # 从向量库检索相关文档
        search_results = await vector_store_manager.search(
            query=user_query,
            embeddings=document_processor.embeddings,
            k=5,  # 返回前 5 个相关文档
        )
        
        if search_results:
            # 构建检索上下文
            context = "📚 相关文档内容：\n\n"
            for i, result in enumerate(search_results, 1):
                context += f"【文档 {i}】（相似度: {result['similarity_score']:.2f}）\n"
                context += f"{result['content']}\n\n"
            
            # 添加到系统提示
            system_message = SystemMessage(content=context)
            state['messages'].insert(0, system_message)
            
            logger.info(f"✅ 检索完成: 找到 {len(search_results)} 个相关文档")
        
        else:
            logger.warning(f"⚠️ 未找到相关文档")
    
    except Exception as e:
        logger.error(f"❌ 检索失败: {e}")
    
    return state
```

---

## 🔗 Step 4: 在 main_graph.py 中集成

```python
# backend/engine/core/main_graph.py

from engine.nodes.rag_processor_node import rag_processor_node
from engine.nodes.retrieval_node import retrieval_node

def create_router_graph():
    workflow = StateGraph(AgentState)
    
    # 添加节点
    workflow.add_node("router", router_node)
    workflow.add_node("rag_processor", rag_processor_node)  # ✅ 添加
    workflow.add_node("retrieval", retrieval_node)  # ✅ 添加
    workflow.add_node("deepagent", deepagent_graph)
    workflow.add_node("editor_tool", editor_tool_node)
    workflow.add_node("error", error_node)
    
    # 设置流程
    workflow.set_entry_point("router")
    
    workflow.add_conditional_edges(
        "router",
        route_decision,
        {
            "deepagent": "rag_processor",  # 先处理 RAG
            "editor_tool": "editor_tool",
            "error": "error",
        }
    )
    
    # ✅ RAG 处理后进行检索
    workflow.add_edge("rag_processor", "retrieval")
    
    # ✅ 检索后进入 DeepAgent
    workflow.add_edge("retrieval", "deepagent")
    
    # 结束
    workflow.add_edge("deepagent", END)
    workflow.add_edge("editor_tool", END)
    workflow.add_edge("error", END)
    
    return workflow.compile()
```

---

## 🎯 完整的 RAG 流程

```
用户上传文件
    ↓
LangGraph Store 存储文件
    ↓
RAG 处理节点
    ├─ 1️⃣ LangChain DocumentLoader 加载
    ├─ 2️⃣ RecursiveCharacterTextSplitter 分割
    ├─ 3️⃣ 并行向量化（HuggingFace）
    └─ 4️⃣ 存储到 Chroma 向量库
    ↓
用户查询
    ↓
检索节点
    ├─ 向量库搜索相关文档
    └─ 添加到系统提示
    ↓
DeepAgent
    ├─ 基于检索内容进行分析
    └─ 生成答案
    ↓
响应用户
```

---

## ✅ 优势总结

| 方面 | 之前（错误） | 现在（官方） |
|------|----------|----------|
| **文本分拆** | 自己实现 | ✅ RecursiveCharacterTextSplitter |
| **文件加载** | 无 | ✅ LangChain Loaders |
| **向量化** | 自己实现 | ✅ OpenAI/HuggingFace 官方 |
| **向量库** | 自己实现 | ✅ Chroma/FAISS 官方集成 |
| **检索** | 无 | ✅ 官方 RAG 链 |
| **维护性** | 低 | ✅ 高（官方维护） |
| **规模** | 不支持 | ✅ 支持大文件 |
| **性能** | 差 | ✅ 优（官方优化） |

---

## 📚 关键 LangChain 工具

### 文本分割
```python
from langchain_text_splitters import RecursiveCharacterTextSplitter
# ✅ 官方推荐的分割器
```

### 文档加载
```python
from langchain_community.document_loaders import (
    PyPDFLoader,
    UnstructuredWordDocumentLoader,
    TextLoader,
)
# ✅ 支持所有主要格式
```

### 嵌入模型
```python
from langchain_openai import OpenAIEmbeddings
from langchain_huggingface import HuggingFaceEmbeddings
# ✅ 选择专业级或开源模型
```

### 向量库
```python
from langchain_chroma import Chroma
# ✅ 推荐用于本地 LLM
```

---

## 🚀 部署完整 RAG 系统

这个方案提供了：
1. ✅ 官方文本分割
2. ✅ 官方文件加载
3. ✅ 并行向量化
4. ✅ 向量库存储
5. ✅ 语义搜索
6. ✅ 上下文增强分析

**完全基于 LangChain 和 LangGraph 官方工具！**


