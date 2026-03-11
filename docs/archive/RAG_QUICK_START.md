# ✅ 官方 RAG 实现 - 快速启动

## 🎯 核心原则

✅ **遵循 LangChain + LangGraph 官方标准**
- 使用官方工具，不自己实现
- RecursiveCharacterTextSplitter + DocumentLoaders + Embeddings + VectorStores
- 完整的 RAG 流程

---

## 📦 需要的 LangChain 组件

### 1. 文本分割
```python
from langchain_text_splitters import RecursiveCharacterTextSplitter
# ✅ 官方推荐，智能分割，保持上下文
```

### 2. 文档加载
```python
from langchain_community.document_loaders import (
    PyPDFLoader,           # PDF
    UnstructuredWordDocumentLoader,  # Word
    TextLoader,            # 文本
    CSVLoader,             # CSV
)
# ✅ 支持所有主要格式
```

### 3. 向量化
```python
from langchain_huggingface import HuggingFaceEmbeddings  # ✅ 推荐（本地）
# 或
from langchain_openai import OpenAIEmbeddings  # OpenAI
# ✅ 官方集成，即插即用
```

### 4. 向量库
```python
from langchain_chroma import Chroma  # ✅ 推荐（本地、简单）
# 或
from langchain_community.vectorstores import FAISS  # Facebook
# 或 Pinecone、Weaviate 等
```

---

## 🚀 实现步骤

### 1. 文档处理
```python
# Step 1: 加载
loader = PyPDFLoader("document.pdf")
documents = loader.load()

# Step 2: 分割
splitter = RecursiveCharacterTextSplitter(
    chunk_size=1000,
    chunk_overlap=200,
)
chunks = splitter.split_documents(documents)

# Step 3: 向量化
embeddings = HuggingFaceEmbeddings()
# 自动并行处理

# Step 4: 存储
vector_store = Chroma.from_documents(
    chunks,
    embeddings,
    persist_directory="./chroma_db"
)
```

### 2. 搜索与检索
```python
# 查询
results = vector_store.similarity_search(
    "用户查询",
    k=5
)

# 使用检索结果
context = "\n".join([r.page_content for r in results])
```

### 3. LangGraph 集成
```python
# 在 LangGraph 中使用
async def rag_node(state):
    # 文档处理 → 向量化 → 存储
    # 检索 → 增强提示 → 分析
    return state
```

---

## 📋 文件清单

需要创建的文件：
- ✅ `backend/engine/rag/document_processor.py`（文档加载+分割+向量化）
- ✅ `backend/engine/rag/vector_store.py`（向量库管理）
- ✅ `backend/engine/nodes/rag_processor_node.py`（RAG 节点）
- ✅ `backend/engine/nodes/retrieval_node.py`（检索节点）

需要修改的文件：
- ✅ `backend/engine/core/main_graph.py`（集成节点）

需要删除的文件：
- ❌ `backend/engine/utils/file_chunker.py`（已删除）
- ❌ `backend/engine/nodes/chunked_message_handler.py`（已删除）

---

## 💡 关键特性

### ✅ 分块处理
- RecursiveCharacterTextSplitter 智能分割
- 保留段落和句子完整性
- 块之间有重叠保持上下文

### ✅ 并行向量化
- 批处理优化
- 自动并行嵌入
- 支持多种嵌入模型

### ✅ 持久化存储
- Chroma 本地存储
- 支持集合管理
- 快速检索

### ✅ 语义搜索
- 相似度计算
- 上下文感知
- 排名优化

---

## 🎓 最佳实践

```python
# ✅ 好做法
- 使用官方的 RecursiveCharacterTextSplitter
- 使用官方的 DocumentLoaders
- 使用官方的 Embeddings
- 使用官方的 VectorStores

# ❌ 避免
- 自己实现分拆逻辑
- 自己实现加载器
- 自己实现向量化
- 自己实现向量库
```

---

## 📊 完整流程图

```
上传文件
  ↓
[LangChain Loader] → 加载（PDF、Word、TXT）
  ↓
[RecursiveCharacterTextSplitter] → 分割
  ↓
[HuggingFaceEmbeddings] → 并行向量化
  ↓
[Chroma VectorStore] → 存储
  ↓
用户查询
  ↓
[Similarity Search] → 检索前 5 个相关文档
  ↓
[Enhanced Prompt] → 添加上下文
  ↓
[DeepAgent] → 分析和响应
  ↓
返回答案
```

**这就是官方标准的 RAG 实现！** 🎉


