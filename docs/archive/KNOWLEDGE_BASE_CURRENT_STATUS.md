# 知识库系统现状分析

## ✅ 已有功能（无需重复开发）

### 1. 后端知识库工具（已集成到 DeepAgent）

**位置：** `backend/tools/base/indexing.py`

已实现的工具：
```python
@tool
def search_knowledge_base(query: str, k: int = 3) -> str:
    """知识库向量检索（语义搜索）"""
    # 使用 FAISS + HuggingFace Embeddings
    # 已集成到 Document Agent
    pass

@tool
def search_knowledge_base_hybrid(query: str, k: int = 3) -> str:
    """知识库混合检索（BM25 + Vector）"""
    # 50% 关键词 + 50% 语义
    # 准确率更高
    pass
```

### 2. 知识库管理器

**位置：** `backend/knowledge_base/manager.py`

功能：
- ✅ 自动加载 `backend/knowledge/` 目录下的文档
- ✅ FAISS 向量索引
- ✅ 混合检索（BM25 + Vector）
- ✅ 单例模式，全局可用

### 3. DeepAgent 已注册知识库工具

**位置：** `backend/engine/agent/deep_agent.py:229-230`

```python
document_agent_tools.extend(INDEXING_TOOLS)
print(f"✅ 知识库索引工具已集成: {len(INDEXING_TOOLS)} 个")
```

**结论：DeepAgent 可以自动调用知识库检索！**

---

## 🎯 用户需求：多租户知识库（公司 + 个人）

### 当前架构局限

1. **单一知识库**：
   - 现在只有一个全局知识库（`backend/knowledge/`）
   - 没有用户隔离
   - 没有权限控制

2. **缺少 LangGraph Store 集成**：
   - 当前使用本地文件系统 + FAISS
   - 未使用 LangGraph Server 的 Store API

---

## 🚀 改进方案：多租户知识库架构

### 方案 A：扩展现有 KnowledgeBaseManager（推荐 ⭐）

**优势：**
- ✅ 最小改动，利用现有代码
- ✅ 保留 FAISS 的高性能
- ✅ 2-3 小时完成

**实现：**

```python
# backend/knowledge_base/manager.py

class KnowledgeBaseManager:
    """扩展支持多租户"""
    
    def __init__(self, user_id: Optional[str] = None, team_id: Optional[str] = None):
        self.user_id = user_id
        self.team_id = team_id
        
        # 三个独立的向量存储
        self._global_store = None  # 公司全局知识库
        self._team_store = None    # 团队知识库
        self._user_store = None    # 用户个人知识库
    
    def _load_knowledge_bases(self):
        """加载多个知识库"""
        # 1. 公司全局知识库（所有人可见）
        global_docs = self._load_from_directory("backend/knowledge/global/")
        self._global_store = FAISS.from_documents(global_docs, embeddings)
        
        # 2. 团队知识库（可选）
        if self.team_id:
            team_docs = self._load_from_directory(f"backend/knowledge/teams/{self.team_id}/")
            self._team_store = FAISS.from_documents(team_docs, embeddings)
        
        # 3. 用户个人知识库（可选）
        if self.user_id:
            user_docs = self._load_from_directory(f"backend/knowledge/users/{self.user_id}/")
            self._user_store = FAISS.from_documents(user_docs, embeddings)
    
    def retrieve_multi_source(self, query: str, k: int = 3) -> List[Document]:
        """
        多源检索：同时查询 个人 + 团队 + 全局
        
        优先级：个人 > 团队 > 全局
        """
        all_results = []
        
        # 1. 查询个人知识库（优先级最高）
        if self._user_store:
            user_results = self._user_store.similarity_search(query, k=k)
            for doc in user_results:
                doc.metadata['source_type'] = 'personal'
                doc.metadata['priority'] = 0
            all_results.extend(user_results)
        
        # 2. 查询团队知识库
        if self._team_store:
            team_results = self._team_store.similarity_search(query, k=k)
            for doc in team_results:
                doc.metadata['source_type'] = 'team'
                doc.metadata['priority'] = 1
            all_results.extend(team_results)
        
        # 3. 查询公司全局知识库
        global_results = self._global_store.similarity_search(query, k=k)
        for doc in global_results:
            doc.metadata['source_type'] = 'company'
            doc.metadata['priority'] = 2
        all_results.extend(global_results)
        
        # 4. 按优先级 + 相似度排序
        all_results.sort(key=lambda doc: (
            doc.metadata['priority'],           # 优先级（越小越高）
            -self._get_similarity_score(doc)    # 相似度（越大越高）
        ))
        
        return all_results[:k]
```

**更新工具：**

```python
# backend/tools/base/indexing.py

@tool
def search_knowledge_base_multi_source(
    query: str,
    user_id: str,
    team_id: Optional[str] = None,
    k: int = 3
) -> str:
    """
    多源知识库检索（个人 + 团队 + 公司）
    
    自动查询：
    1. 用户个人知识库（优先级最高）
    2. 团队共享知识库（如果提供 team_id）
    3. 公司全局知识库
    
    返回最相关的 k 条结果，按优先级排序
    """
    from backend.knowledge_base.manager import KnowledgeBaseManager
    
    kb = KnowledgeBaseManager(user_id=user_id, team_id=team_id)
    results = kb.retrieve_multi_source(query, k=k)
    
    # 格式化输出
    output = []
    for i, doc in enumerate(results, 1):
        source_icon = {
            'personal': '👤',
            'team': '👥',
            'company': '🏢',
        }[doc.metadata['source_type']]
        
        output.append(
            f"{i}. {source_icon} {doc.metadata.get('source', '未知')}\n"
            f"   {doc.page_content[:200]}..."
        )
    
    return "\n\n".join(output)
```

### 方案 B：集成 LangGraph Store（长期）

**优势：**
- ✅ 统一存储（文件 + 知识库 + 记忆）
- ✅ 原生多租户支持
- ✅ 更灵活的命名空间

**缺点：**
- ❌ 需要更多时间（5-8 小时）
- ❌ 可能需要自定义向量存储

---

## 📊 方案对比

| 项目 | 方案 A（扩展现有）| 方案 B（Store）|
|------|----------------|---------------|
| **开发时间** | 2-3 小时 | 5-8 小时 |
| **性能** | 高（FAISS）| 中（取决于 Store 实现）|
| **多租户** | ✅ 支持 | ✅ 原生支持 |
| **统一存储** | ❌ 分离 | ✅ 统一 |
| **LangChain 生态** | ✅ 100% | ✅ 100% |
| **推荐度** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ |

---

## 🎯 推荐实施路径

### Phase 1：扩展现有知识库（立即实施）

1. **修改 `backend/knowledge_base/manager.py`**（1.5 小时）
   - 添加 `user_id` 和 `team_id` 参数
   - 实现 `retrieve_multi_source()` 方法
   - 支持三层目录结构

2. **添加新工具 `search_knowledge_base_multi_source`**（30 分钟）
   - 在 `backend/tools/base/indexing.py` 中添加
   - 自动注册到 DeepAgent

3. **创建目录结构**（30 分钟）
   ```
   backend/knowledge/
   ├─ global/           # 公司全局知识库（所有人可见）
   │   ├─ proposals/
   │   └─ contracts/
   ├─ teams/            # 团队知识库
   │   └─ {team_id}/
   └─ users/            # 用户个人知识库
       └─ {user_id}/
   ```

4. **测试和验证**（30 分钟）

**总工作量：2.5-3 小时**

### Phase 2：前端 UI（之后实施）

1. **WorkspaceTree.tsx**（用户私有工作区）
2. **KnowledgeTree.tsx**（知识库浏览）
3. **SidebarTabs.tsx**（Tab 切换）

---

## 🚨 关键发现

1. **✅ 无需重复开发**：
   - DeepAgent 已经有完整的知识库检索工具
   - 工具已注册并可用
   - LLM 可以自动调用

2. **✅ 只需扩展多租户支持**：
   - 当前是单一知识库
   - 扩展为 个人 + 团队 + 公司 三层
   - 2-3 小时即可完成

3. **✅ LangChain 生态充分利用**：
   - FAISS 向量存储（高性能）
   - HuggingFace Embeddings（中文支持）
   - BM25 混合检索（高准确率）

---

## 下一步行动

是否立即实施 **Phase 1：扩展现有知识库为多租户架构**？

这是最高效的方案，充分利用现有代码，无重复开发。

