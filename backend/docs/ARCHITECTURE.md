# 系统架构文档

## 设计原则

基于 LangChain/DeepAgent 原生方法 + Claude 风格：

1. **不重复实现** - 优先使用框架原生能力
2. **单一职责** - 每个组件只做一件事
3. **分层清晰** - Agent 工具层 vs REST API 层
4. **懒加载** - 按需加载资源

## 架构总览

```
┌─────────────────────────────────────────────────────────────────┐
│                         前端 (Electron + React)                  │
├─────────────────────────────────────────────────────────────────┤
│                         REST API (FastAPI)                       │
│  - /knowledge/* → knowledge_api.py                              │
│  - /files/* → app.py                                            │
├─────────────────────────────────────────────────────────────────┤
│                      LangGraph Server (2024)                     │
│  - main_graph.py → router → deepagent                           │
├─────────────────────────────────────────────────────────────────┤
│                         DeepAgent 框架                           │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 原生中间件（自动处理，不重复实现）                         │   │
│  │ - FilesystemMiddleware: ls, read_file, write_file...    │   │
│  │ - project_memory: .context/CONTEXT.md, rules/*.md       │   │
│  │ - Skills 工具: list_skills/match_skills + BUNDLE.md     │   │
│  │ - SummarizationMiddleware: 上下文压缩                    │   │
│  └─────────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 自定义工具（补充能力）                                    │   │
│  │ - python_run: 代码执行                                   │   │
│  │ - search_knowledge: 知识检索（统一入口）                  │   │
│  │ - think_tool, ask_user: 思考和交互                       │   │
│  └─────────────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────────────┤
│                         存储层                                   │
│  - Checkpointer: 会话状态 (短期记忆)                            │
│  - Store: 跨会话持久化 (长期记忆)                               │
│  - VectorIndexManager: FAISS 向量索引                           │
│  - SQLite: 元数据存储                                           │
└─────────────────────────────────────────────────────────────────┘
```

## 目录结构

```
backend/
├── engine/
│   ├── agent/
│   │   └── deep_agent.py      # DeepAgent 配置（核心）
│   ├── core/
│   │   └── main_graph.py      # LangGraph 路由
│   └── prompts/
│       └── agent_prompts.py   # 提示词
├── tools/
│   ├── __init__.py            # 统一入口
│   └── base/
│       ├── registry.py        # 工具注册（单一入口）
│       ├── embedding_tools.py # 知识检索（统一实现）
│       ├── storage_manager.py # 向量索引持久化
│       └── learning_middleware.py # 自学习
├── memory/
│   ├── __init__.py            # LangGraph 官方组件导出
│   ├── memory_manager.py      # Store API 包装器
│   └── rules_extractor.py     # Rules 提取（LangChain Chain）
├── knowledge_base/
│   ├── __init__.py
│   └── manager.py             # REST API 层（使用统一索引）
└── api/
    ├── app.py
    └── knowledge_api.py       # REST API
```

## 组件职责

### 1. 记忆系统（DeepAgent 原生）

| 层次 | 机制 | 存储位置 | 职责 |
|------|------|----------|------|
| 短期记忆 | Checkpointer | `data/checkpoints.db` | 会话状态、消息历史 |
| 长期记忆 | Store | `data/store.db` | 规则、决策、上下文 |
| 项目记忆 | project_memory | `.context/CONTEXT.md, rules/*.md` | 项目规则、经验教训 |
| 技能知识 | Skills 工具 + BUNDLE.md | `knowledge_base/skills/` | 工作方法论 |

### 2. 知识检索系统

```
┌─────────────────────────────────────────────────────────────┐
│                    search_knowledge (统一入口)               │
│                    embedding_tools.py                        │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────┐ │
│  │ VectorIndexMgr  │  │ ResourceManager │  │ KnowledgeGraph│ │
│  │ (FAISS 索引)    │  │ (资源发现)      │  │ (实体关系)   │ │
│  └─────────────────┘  └─────────────────┘  └─────────────┘ │
├─────────────────────────────────────────────────────────────┤
│                    LM Studio Embeddings                      │
└─────────────────────────────────────────────────────────────┘
```

### 3. 工具注册（单一入口）

```python
# backend/tools/base/registry.py
CoreToolsRegistry
├── python_run          # 代码执行
├── search_knowledge    # 知识检索（统一）
├── think_tool          # 思考记录
├── ask_user            # 用户交互
├── batch_read_files    # 批量读取
├── extract_entities    # 实体提取
├── query_kg            # 知识图谱查询
└── ...
```

**注意**：DeepAgent 原生工具（ls, read_file, write_file 等）由框架自动注册。

## 数据流

### Agent 执行流程

```
用户输入 → LangGraph Server → main_graph.py
                                    ↓
                              router 节点
                                    ↓
                              deepagent 节点
                                    ↓
                            ┌───────────────┐
                            │  Orchestrator │
                            └───────┬───────┘
                    ┌───────────────┼───────────────┐
                    ↓               ↓               ↓
              Planning        Executor        Knowledge
              Agent           Agent           Agent
                    ↓               ↓               ↓
                 工具调用        工具调用        工具调用
                    ↓               ↓               ↓
                    └───────────────┴───────────────┘
                                    ↓
                              综合响应 → 用户
```

### 知识检索流程

```
search_knowledge(query)
        ↓
  ResourceManager.get_sources_for_task()  # 资源发现
        ↓
  VectorIndexManager.search()              # 向量检索
        ↓
  KnowledgeGraph.expand_query()            # 查询扩展（可选）
        ↓
  结果排序和格式化
        ↓
  返回给 Agent
```

## 配置文件

| 文件 | 用途 |
|------|------|
| `.env` | 环境变量（API 地址、开关等） |
| `langgraph.json` | LangGraph Server 配置 |
| `config/models.json` | LLM 模型配置 |
| `knowledge_base/.indexignore` | 索引排除规则 |

## 最佳实践

### 1. 添加新工具

```python
# 在 registry.py 中注册
@tool
def my_new_tool(arg: str) -> str:
    """工具描述"""
    pass

# 在 _register_xxx_tools() 方法中添加
self.tools['my_new_tool'] = my_new_tool
```

### 2. 使用记忆

```python
# ❌ 错误：自己实现记忆
class MyMemory:
    def save(self): ...

# ✅ 正确：使用 DeepAgent 原生机制
# - 通过 edit_file 更新 AGENTS.md/lessons.md
# - 通过 Store API 保存长期记忆
```

### 3. 知识检索

```python
# ❌ 错误：直接实现检索
from langchain_community.vectorstores import FAISS
vectorstore = FAISS.from_documents(...)

# ✅ 正确：使用统一的 search_knowledge 工具
# Agent 自动调用 search_knowledge
# 或通过 API: GET /knowledge/search?query=xxx
```

---
*最后更新: 2026-01-22*
