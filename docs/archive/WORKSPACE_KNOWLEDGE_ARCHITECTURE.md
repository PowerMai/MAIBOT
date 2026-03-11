# LangGraph Server 工作区和知识库完整架构

## 1. 架构原则

### ❌ 错误做法（之前）
- 在前端手动处理文件上传
- 重复实现 LangGraph Server 已有的功能
- 前端直接管理知识库

### ✅ 正确做法（现在）
- **LangGraph Server 负责所有存储和管理**
- 前端只负责展示和调用 API
- 充分利用 Store API 的层级命名空间

---

## 2. LangGraph Server 端架构

### 2.1 Store 层级结构

```
Store 根命名空间
├─ workspaces/                    # 工作区
│   ├─ {workspace_id}/
│   │   ├─ metadata               # 工作区元信息
│   │   └─ files/                 # 工作区文件
│   │       └─ {file_path}        # 文件内容
│
├─ knowledge/                     # 知识库（多租户）
│   ├─ {organization}/
│   │   ├─ {team}/
│   │   │   └─ {domain}/
│   │   │       └─ {doc_id}       # 文档内容 + 向量
│
└─ memory/                        # 项目记忆
    └─ {project_id}/
        └─ {memory_key}           # 长期记忆
```

### 2.2 初始化脚本（后端）

需要在后端创建初始化脚本，预加载知识库：

**backend/scripts/init_knowledge_base.py**
- 扫描 `backend/knowledge/` 目录
- 将所有 `.md`、`.txt` 文档加载到 Store
- 对文档进行向量化（使用 LangChain 的 Embeddings）
- 存储到 Store 中

### 2.3 向量化处理

**使用 LangChain 的原生能力：**
```python
from langchain.embeddings import HuggingFaceEmbeddings
from langchain.vectorstores import FAISS
from langchain.text_splitter import RecursiveCharacterTextSplitter

# 1. 加载文档
# 2. 分块
# 3. 向量化
# 4. 存储到 Store（包含向量）
```

**存储格式：**
```json
{
  "id": "doc_001",
  "title": "招投标指南",
  "content": "...",
  "chunks": [
    {
      "text": "...",
      "embedding": [0.1, 0.2, ...],
      "metadata": {}
    }
  ],
  "organization": "acme",
  "team": "sales",
  "domain": "proposals"
}
```

---

## 3. 前端架构

### 3.1 文件上传（assistant-ui 原生支持）

**无需自定义代码**，assistant-ui 会自动处理：

1. 用户上传文件 → `ComposerAttachments`
2. assistant-ui 将文件转换为 LangChain 消息格式
3. LangGraph Server 接收并处理

**MyRuntimeProvider.tsx（简化版）：**
```typescript
export function MyRuntimeProvider({ children }) {
  const runtime = useLangGraphRuntime({
    stream: async function* (messages, { initialize }) {
      const { externalId } = await initialize();
      
      // ✅ 直接传递消息，不做任何处理
      // LangGraph Server 会自动处理文件
      yield* sendMessage({
        threadId: externalId,
        messages,  // 包含文件的消息
      });
    },
    create: async () => {
      const thread = await createThread();
      return { externalId: thread.thread_id };
    },
    load: async (externalId) => {
      const state = await getThreadState(externalId);
      return {
        messages: state.values.messages ?? [],
        interrupts: state.tasks[0]?.interrupts ?? [],
      };
    },
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children}
    </AssistantRuntimeProvider>
  );
}
```

### 3.2 工作区管理（基于 Store API）

**WorkspaceManager 组件：**
- 列出所有工作区：`client.store.search(["workspaces"])`
- 创建工作区：`client.store.put(["workspaces", id, "metadata"], {...})`
- 删除工作区：`client.store.delete(["workspaces", id])`

### 3.3 知识库浏览（只读）

**KnowledgeBrowser 组件：**
- 浏览层级：组织 → 团队 → 领域 → 文档
- 搜索：`client.store.search(["knowledge", org, team, domain])`
- 查看内容：`client.store.get(["knowledge", org, team, domain, docId])`

**不支持上传**（知识库由后端管理员维护）

---

## 4. 实施计划

### Phase 1: 后端初始化（2-3小时）
1. 创建 `backend/scripts/init_knowledge_base.py`
2. 创建 `backend/scripts/init_workspaces.py`
3. 添加向量化支持（使用现有的 HuggingFace Embeddings）
4. 运行初始化脚本

### Phase 2: 前端简化（1小时）
1. 恢复 `MyRuntimeProvider` 到简洁版
2. 删除 `fileApi.ts`（不需要）
3. 删除 `knowledgeApi.ts` 中的写操作（只保留读）

### Phase 3: 工作区功能（2小时）
1. 创建 `WorkspaceManager` 组件
2. 集成到侧边栏
3. 支持创建/切换/删除工作区

### Phase 4: 知识库浏览（1-2小时）
1. 创建 `KnowledgeBrowser` 组件
2. 显示层级结构
3. 支持搜索和查看

### Phase 5: 测试和优化（1小时）
1. 端到端测试
2. 性能优化
3. 文档完善

**总工作量：7-10 小时**

---

## 5. 关键决策

### ✅ LangGraph Server 负责
- ✅ 文件存储和管理
- ✅ 知识库向量化
- ✅ 工作区管理
- ✅ 持久化存储

### ✅ 前端负责
- ✅ UI 展示
- ✅ 调用 Store API
- ✅ 用户交互

### ❌ 不做的事情
- ❌ 前端不做向量化
- ❌ 前端不直接管理文件
- ❌ 不在前端实现复杂的文件处理逻辑
- ❌ 不重复实现 LangGraph Server 已有的功能

---

## 6. LM Studio 兼容性

**问题：** LM Studio 不支持 `file` block

**解决方案（后端）：**
在 DeepAgent 的工具中添加 `FileContentExtractor` 工具：
```python
class FileContentExtractor(BaseTool):
    """提取文件内容并转换为文本"""
    def _run(self, file_reference: str):
        # 从 Store 中获取文件
        # 如果是文本文件，直接返回内容
        # 如果是二进制文件，返回元信息
        return file_text_content
```

DeepAgent 在收到包含文件的消息时：
1. 检测到文件引用
2. 调用 `FileContentExtractor` 工具
3. 将文件内容注入到上下文中
4. 传递给 LM Studio（纯文本）

---

## 7. 下一步行动

1. **立即：** 创建后端初始化脚本
2. **然后：** 简化前端代码
3. **最后：** 实现工作区和知识库 UI

是否开始实施？

