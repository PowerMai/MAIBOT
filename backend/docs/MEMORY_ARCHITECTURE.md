# 记忆架构设计

## 一、LangGraph/DeepAgent 记忆层次

```
┌─────────────────────────────────────────────────────────────┐
│                    记忆层次架构                              │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 1. 短期记忆 (Checkpointer)                          │   │
│  │    - 会话状态                                        │   │
│  │    - 消息历史                                        │   │
│  │    - 工具调用记录                                    │   │
│  │    - 生命周期: 单次会话                              │   │
│  │    - 存储: ./data/checkpoints.db (SQLite)           │   │
│  └─────────────────────────────────────────────────────┘   │
│                          ↓                                  │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 2. 长期记忆 (Store)                                 │   │
│  │    - 用户偏好                                        │   │
│  │    - 学习到的规则                                    │   │
│  │    - 跨会话持久化                                    │   │
│  │    - 生命周期: 永久                                  │   │
│  │    - 存储: ./data/store.db (SQLite)                 │   │
│  └─────────────────────────────────────────────────────┘   │
│                          ↓                                  │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 3. 项目记忆 (project_memory)                        │   │
│  │    - CONTEXT.md: 项目级记忆、重要产出路径            │   │
│  │    - .context/rules/*.md: 模块化规则                 │   │
│  │    - 生命周期: 永久（文件系统）                      │   │
│  │    - 存储: {workspace}/.context/                    │   │
│  │    - 注入: deep_agent _load_memory_content()        │   │
│  └─────────────────────────────────────────────────────┘   │
│                          ↓                                  │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 4. 知识库 (Knowledge Base)                          │   │
│  │    - Skills: 工作方法和流程                          │   │
│  │    - Guides: 详细操作指南                           │   │
│  │    - References: 资质、产品、案例                    │   │
│  │    - 生命周期: 永久（系统级）                        │   │
│  │    - 存储: PROJECT_ROOT/knowledge_base/             │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## 二、各层记忆详解

### 1. 短期记忆 (Checkpointer)

**配置位置**: `langgraph.json`

```json
{
  "checkpointer": {
    "class": "langgraph.checkpoint.sqlite.SqliteSaver",
    "config": {
      "db_path": "./data/checkpoints.db"
    }
  }
}
```

**功能**:
- 保存会话状态（断点续传）
- 记录消息历史
- 支持会话恢复

**使用方式**:
- LangGraph Server 自动注入
- 通过 `thread_id` 恢复会话

### 2. 长期记忆 (Store)

**配置位置**: `langgraph.json`

```json
{
  "store": {
    "class": "langgraph.store.sqlite.SQLiteStore",
    "config": {
      "db_path": "./data/store.db"
    }
  }
}
```

**功能**:
- 跨会话持久化
- 用户偏好存储
- 学习规则存储

**使用方式**:
```python
# 在工具中访问 Store
from langgraph.store.base import BaseStore

def my_tool(store: BaseStore):
    # 存储
    store.put(
        namespace=("user", "preferences"),
        key="output_format",
        value={"format": "markdown", "language": "zh"}
    )
    
    # 检索
    items = store.search(
        namespace=("user", "preferences"),
        query="output"
    )
```

### 3. 项目记忆 (project_memory)

**配置位置**: `deep_agent.py` 中 `_get_memory_paths()` / `_load_memory_content()`

```python
# 记忆路径（相对于工作区根）
memory_paths = [".context/CONTEXT.md"]  # 项目记忆
# + .context/rules/*.md（按需加载）
```

**功能**:
- 将 `.context/CONTEXT.md` 及 `.context/rules/*.md` 内容以 `<project_memory>` 拼入系统提示词
- 用户上下文由 `inject_user_context`（@dynamic_prompt）从 `config.configurable` 注入，不依赖 MemoryMiddleware
- 长期记忆：LangGraph Store（SQLite）+ langmem 工具（manage_memory、search_memory）

### 4. 知识库 (Knowledge Base)

**配置位置**: `deep_agent.py`

```python
# Skills 路径
skills_paths = [
    "/knowledge_base/skills/bidding/",
    "/knowledge_base/skills/contracts/",
    "/knowledge_base/skills/reports/",
]

# CompositeBackend 路由
routes = {
    "/knowledge_base/": knowledge_backend,
}
```

**功能**:
- Skills: 自动加载到系统提示词（Progressive Disclosure）
- Guides: 按需检索（search_knowledge_base）
- References: 向量检索（RAG）

## 三、记忆继承关系

```
短期记忆 (Checkpointer)
    │
    │ 会话结束时，重要信息可以：
    │ 1. 写入 Store（长期记忆）
    │ 2. 写入 .context/CONTEXT.md（项目记忆）
    │
    ↓
长期记忆 (Store)
    │
    │ 跨会话持久化
    │ 可被 Agent 检索和使用（langmem 工具）
    │
    ↓
项目记忆 (project_memory)
    │
    │ .context/CONTEXT.md + .context/rules/*.md
    │ 由 deep_agent 注入，人类可读可编辑
    │
    ↓
知识库 (Knowledge Base)
    │
    │ 系统级知识
    │ Skills 自动加载
    │ 其他内容按需检索
```

## 四、实现长期记忆的方法

### 方法 1: 使用 Store API

```python
# 在 Agent 工具中
def save_learning(store: BaseStore, learning: dict):
    """保存学习到的知识"""
    store.put(
        namespace=("learnings", "bidding"),
        key=f"learning_{datetime.now().isoformat()}",
        value=learning
    )

def get_learnings(store: BaseStore, domain: str) -> list:
    """获取历史学习"""
    items = store.search(
        namespace=("learnings", domain),
        limit=10
    )
    return [item.value for item in items]
```

### 方法 2: 使用项目记忆（文件）

```python
# 项目记忆由 deep_agent._load_memory_content() 在每次请求时读取并拼入系统提示词。
# 本系统未使用 MemoryMiddleware；Agent 通过 write_file/edit_file 更新后，下次请求自动加载。

# .context/CONTEXT.md 示例（项目级记忆、重要产出路径）
"""
# 项目记忆

## 重要产出路径
- 招标分析报告: outputs/reports/xxx.md

## 用户偏好
- 输出格式: Markdown，表格中文表头
- 招标分析: 优先废标条款、评分标准详细展开
"""

# .context/rules/*.md：模块化规则，同上由 _load_memory_content 加载
```

### 方法 3: 使用 StoreBackend

```python
# CompositeBackend 路由到 StoreBackend
routes = {
    "/memories/": store_backend,  # 持久化记忆
}

# Agent 可以通过文件操作访问
# write_file("/memories/learnings/bidding.json", content)
# read_file("/memories/learnings/bidding.json")
```

## 五、知识库索引机制

### 向量检索 (RAG)

```python
# backend/knowledge_base/core.py
class KnowledgeBaseCore:
    def __init__(self):
        self._load_knowledge_base()
    
    def _load_knowledge_base(self):
        # 1. 加载文档
        documents = load_documents(KB_DIR)
        
        # 2. 分块
        splits = text_splitter.split_documents(documents)
        
        # 3. 创建向量索引
        self._vector_store = FAISS.from_documents(splits, embeddings)
    
    def retrieve_hybrid(self, query: str, k: int = 3):
        # 混合检索: 向量 + BM25
        vector_results = self._vector_store.similarity_search(query, k)
        bm25_results = bm25_retriever.get_relevant_documents(query)
        return ensemble_results
```

### 知识库工具

```python
# backend/tools/base/embedding_tools.py
def get_knowledge_retriever_tool():
    """创建知识库检索工具"""
    retriever = kb_core.get_vector_store().as_retriever()
    return create_retriever_tool(
        retriever,
        name="search_knowledge_base",
        description="搜索知识库获取相关信息"
    )
```

## 六、配置总结

### langgraph.json

```json
{
  "store": {
    "class": "langgraph.store.sqlite.SQLiteStore",
    "config": {"db_path": "./data/store.db"}
  },
  "checkpointer": {
    "class": "langgraph.checkpoint.sqlite.SqliteSaver",
    "config": {"db_path": "./data/checkpoints.db"}
  }
}
```

### deep_agent.py

```python
# 项目记忆（由 _get_memory_paths() / _load_memory_content() 读取并拼入系统提示词）
memory_paths = [".context/CONTEXT.md"]  # + .context/rules/*.md（工作区下）

# Skills 由 BUNDLE.md 内联 + list_skills/match_skills 工具按需加载，路径见 paths.py

# Backend 路由
routes = {
    "/knowledge_base/": knowledge_backend,
    "/memories/": store_backend,
}
```

## 七、最佳实践

### 1. 短期 → 长期转换

```python
# 会话结束时，提取重要信息保存到长期记忆
def on_session_end(state, store):
    # 提取学习到的规则
    learnings = extract_learnings(state["messages"])
    
    # 保存到 Store
    for learning in learnings:
        store.put(
            namespace=("learnings",),
            key=learning["id"],
            value=learning
        )
    
    # 可选：写入 .context/CONTEXT.md 作为项目记忆供下次加载
    update_context_file(learnings)
```

### 2. 知识库更新

```python
# 新增知识后重建索引
def update_knowledge_base():
    kb_core = KnowledgeBaseCore()
    kb_core._load_knowledge_base()  # 重新加载
```

### 3. 记忆检索优先级

```
1. 短期记忆 (当前会话上下文，Checkpointer)
2. 项目记忆 (.context/CONTEXT.md、.context/rules/*.md，由 _load_memory_content 注入)
3. 长期记忆 (Store + langmem 工具 manage_memory/search_memory)
4. 知识库 (Skills, Guides, References)
```
