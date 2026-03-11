# 统一记忆架构设计 - 业界顶级实现

基于 Cursor、Devin、Claude 等顶级 Agent 产品的实现方式，完全集成到 LangChain/DeepAgent 框架。

## 框架原生 vs 本系统增强（无重复设计）

本系统**未重复实现** LangChain/DeepAgent 的记忆能力，而是在其之上做功能增强。

| 类型 | 能力 | 来源 / 实现 | 说明 |
|------|------|-------------|------|
| **框架原生** | 会话状态 / 消息历史 | LangGraph Checkpointer (SQLite) | main_graph get_checkpointer()，create_deep_agent(..., checkpointer=...) |
| **框架原生** | 跨会话长期存储 | LangGraph Store (SQLite) | get_store()，StoreBackend 挂载 /memories/、/cache/、/user_profiles/ |
| **框架原生** | 对话历史压缩 | DeepAgent SummarizationMiddleware | create_deep_agent 内建 |
| **本系统增强** | 项目记忆 | deep_agent._load_memory_content() | 读 .context/CONTEXT.md、.context/rules/*.md，以 `<project_memory>` 拼入系统提示词（Claude 风格项目级文件记忆） |
| **本系统增强** | 用户上下文 | inject_user_context（@dynamic_prompt） | 从 config.configurable 注入，替代 UserContextMiddleware |
| **本系统增强** | 长期记忆 Agent 入口 | langmem 官方库 (manage_memory/search_memory) | 使用同一 LangGraph Store，仅暴露为工具 |

## 一、架构概览

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     DeepAgent + 统一记忆架构                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────────┐ │
│  │                    DeepAgent 原生中间件 + 本工程注入               │ │
│  ├───────────────────────────────────────────────────────────────────┤ │
│  │ SummarizationMiddleware │ project_memory   │ FilesystemMiddleware │ │
│  │ - 自动压缩对话历史      │ - .context/     │ - ls/read/write/edit │ │
│  │ - 接近 token 限制触发   │   CONTEXT.md    │ - glob/grep          │ │
│  │ - 保留最近 20 条消息    │ - rules/*.md    │ inject_user_context  │ │
│  │                         │ inject_user_ctx │ (@dynamic_prompt)    │ │
│  └───────────────────────────────────────────────────────────────────┘ │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────────┐ │
│  │                    LangGraph 持久化层                              │ │
│  ├───────────────────────────────────────────────────────────────────┤ │
│  │     Checkpointer (SQLite)      │        Store (SQLite)            │ │
│  │     - 会话状态持久化           │        - 跨会话长期存储          │ │
│  │     - 断点续传                 │        - /memories/              │ │
│  │     - messages, todos, files   │        - /user_profiles/         │ │
│  └───────────────────────────────────────────────────────────────────┘ │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────────┐ │
│  │                    统一检索层 (embedding_tools.py)                 │ │
│  ├───────────────────────────────────────────────────────────────────┤ │
│  │  ResourceManager    │  DocMap/Workflow   │  OntologyExtractor     │ │
│  │  - 5个核心资源源    │  - 文档结构映射    │  - 本体关系提取        │ │
│  │  - 配置驱动         │  - 工作流定义      │  - 知识图谱积累        │ │
│  │  - 优先级排序       │  - 快速定位        │  - 查询增强            │ │
│  └───────────────────────────────────────────────────────────────────┘ │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────────┐ │
│  │                    存储层                                          │ │
│  ├───────────────────────────────────────────────────────────────────┤ │
│  │   FAISS VectorStore   │   File System (.context/, .memory/)       │ │
│  │   - 语义检索          │   - CONTEXT.md (项目记忆、产出路径)       │ │
│  │   - 知识库索引        │   - .context/rules/*.md (模块化规则)      │ │
│  │                       │   - 用户上下文由 config 动态注入          │ │
│  │                       │   - ontology/ (本体知识)                  │ │
│  └───────────────────────────────────────────────────────────────────┘ │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

## 二、DeepAgent 原生中间件

### 2.1 SummarizationMiddleware（自动上下文压缩）

```python
from deepagents.graph import SummarizationMiddleware

# DeepAgent 自动配置，无需手动添加
SummarizationMiddleware(
    model=model,
    trigger=None,           # 自动检测 token 限制
    keep=('messages', 20),  # 保留最近 20 条消息
    trim_tokens_to_summarize=None,
)
```

**工作原理**：
1. 监控对话历史的 token 数量
2. 接近限制时自动触发压缩
3. 使用 LLM 生成 summary 替代旧消息
4. 保留最近 20 条消息保持上下文连贯

**注意**：不需要手动创建 summary.md，SummarizationMiddleware 自动管理。

### 2.2 项目记忆与用户上下文（本工程实现，非 MemoryMiddleware）

**项目记忆 (project_memory)**：`deep_agent._load_memory_content(memory_paths)` 读取 `.context/CONTEXT.md` 及 `.context/rules/*.md`，以 `<project_memory>` 拼入系统提示词。

**用户上下文**：`inject_user_context`（@dynamic_prompt）从 `config.configurable` 读取并追加到系统提示词末尾（设备、打开文件、附件、选中内容等）。

**长期记忆**：LangGraph Store（SQLite）+ langmem 工具（manage_memory、search_memory）。

### 2.3 FilesystemMiddleware（文件操作）

提供的工具：
- `ls` - 列出目录
- `read_file` - 读取文件
- `write_file` - 写入文件
- `edit_file` - 编辑文件
- `glob` - 文件搜索
- `grep` - 内容搜索
- `execute` - 执行命令

## 三、记忆层次

| 层次 | 存储位置 | 生命周期 | 管理方式 | 用途 |
|------|----------|----------|----------|------|
| 对话摘要 | state (SummarizationMiddleware) | 会话内 | 自动 | 压缩旧对话 |
| 会话状态 | Checkpointer (SQLite) | 会话周期 | 自动 | 断点续传 |
| 项目记忆 | .context/CONTEXT.md、.context/rules/*.md | 永久 | 手动/Agent 写入 | 项目级记忆、产出路径 |
| 用户上下文 | config.configurable（inject_user_context） | 请求级 | 前端传入 | 打开文件、附件、选中等 |
| 长期存储 | Store (SQLite) + langmem 工具 | 永久 | 自动 | 跨会话数据、语义检索 |
| 本体知识 | .memory/ontology/ | 永久 | 自动 | 知识图谱 |

## 四、统一检索工具

### 4.1 资源配置 (v2.0)

优化后的 5 个核心资源源：

| 优先级 | 资源源 | 说明 |
|--------|--------|------|
| 1.0 | memory | 用户记忆（偏好、经验、项目上下文） |
| 0.95 | skills | 技能定义（工作流程、方法论） |
| 0.80 | domain_knowledge | 领域知识（指南、模板、案例、规则） |
| 0.60 | tools | 工具和优化指南 |
| 0.50 | user_files | 用户上传文件 |

### 4.2 get_docmap

```python
# 获取领域文档映射
get_docmap("bidding")
# 返回: {"skill": "...", "guide": "...", "sections": {...}}
```

**用途**：快速定位领域内的技能文件、指南和各章节路径。

### 4.3 模块化工作流系统

工作流由三层组成，LLM 可自由组合：

```
atoms (原子操作) → patterns (组合模式) → templates (流程模板)
```

#### 原子操作 (Atoms) - 12 个
最小执行单元：read, write, search, extract, analyze, generate, chart, ontology, match, validate, docmap, skill

#### 组合模式 (Patterns) - 4 个
- `understand` = read → ontology → extract
- `research` = docmap → skill → search
- `produce` = generate → chart → write
- `verify` = validate → match

#### 流程模板 (Templates) - 5 个
- `document_analysis` - 文档分析
- `document_generation` - 文档生成
- `bidding_analysis` - 招标分析
- `contract_review` - 合同审查
- `report_writing` - 报告撰写

#### 工作流工具

```python
list_atoms()                              # 列出所有原子操作
list_patterns()                           # 列出所有组合模式
get_workflow("bidding_analysis")          # 获取流程模板
compose_workflow("docmap,skill,read,extract")  # 自定义组合（带依赖验证）
```

### 4.4 search_knowledge

```python
from backend.tools.base.embedding_tools import get_knowledge_retriever_tool

tool = get_knowledge_retriever_tool()
# 使用: search_knowledge("招标分析方法")
```

**检索优先级**：按资源配置的 priority 排序返回结果。

### 4.5 extract_ontology

```python
# 从文本提取实体和关系
extract_ontology(text)
# 返回: {"entities": [...], "relations": [...]}
```

**支持的实体类型**：
- MONEY - 金额
- DATE - 日期
- PERCENT - 百分比
- REQUIREMENT - 技术要求
- QUALIFICATION_REQ - 资质要求
- ORGANIZATION - 组织机构

### 4.6 query_ontology

```python
# 查询相关实体和关系
query_ontology("ISO9001")
# 返回: {"concept": "...", "entities": [...], "relations": [...]}
```

### 4.7 record_failure

```python
# 记录执行失败，用于学习
record_failure(task_id, query, error)
# 返回: {"context_id": "...", "error_type": "...", "suggestions": [...]}
```

## 五、文件结构

```
backend/
├── tmp/                         # 工作区
│   ├── uploads/                 # 用户上传文件
│   ├── outputs/                 # 生成的输出
│   │   ├── reports/
│   │   ├── charts/
│   │   └── documents/
│   ├── .context/                # 上下文文件（MemoryMiddleware 注入）
│   │   ├── AGENTS.md            # 用户偏好
│   │   ├── lessons.md           # 经验教训
│   │   └── projects/            # 项目级记忆
│   │       └── {project_id}.md
│   └── .memory/                 # 系统记忆
│       ├── failures/            # 失败记录
│       └── ontology/            # 本体知识
│           └── ontology.json
│
├── tools/base/
│   ├── embedding_tools.py       # 统一检索实现
│   │   ├── ResourceManager      # 动态资源管理
│   │   ├── FailureRecoveryManager # 失败重试学习
│   │   ├── OntologyExtractor    # 本体关系提取
│   │   └── get_knowledge_retriever_tool
│   └── registry.py              # 工具注册
│
├── engine/agent/
│   └── deep_agent.py            # DeepAgent 配置
│
└── data/                        # LangGraph 持久化
    ├── store.db                 # Store (跨会话)
    └── checkpoints.db           # Checkpointer (会话状态)

knowledge_base/
├── skills/                      # 技能定义
│   ├── bidding/SKILL.md
│   ├── contracts/SKILL.md
│   └── reports/SKILL.md
├── global/domain/               # 领域知识
│   ├── bidding/
│   ├── contracts/
│   └── reports/
├── tools/                       # 工具指南
└── resources.json               # 资源配置
```

## 六、最佳实践

### 6.1 利用 SummarizationMiddleware

- **不需要手动管理 summary.md**：中间件自动压缩
- **保持对话连贯**：最近 20 条消息始终保留
- **长任务自动处理**：接近 token 限制时自动触发

### 6.2 利用 MemoryMiddleware

- **AGENTS.md**：存放用户偏好、工作区结构、代码模板
- **lessons.md**：存放经验教训，Agent 自动追加
- **自动注入**：无需手动读取，系统提示词已包含

### 6.3 项目级记忆

- **跨会话任务**：创建 `.context/projects/{project_id}.md`
- **恢复上下文**：用户提到项目时读取项目记忆
- **更新进度**：每个重要步骤后更新项目文件

### 6.4 本体知识积累

- **复杂文档先提取**：`extract_ontology` 帮助理解结构
- **查询增强**：`query_ontology` 获取相关概念
- **持续积累**：每次分析都更新知识图谱

### 6.5 失败学习

- **记录失败**：`record_failure` 记录错误上下文
- **自动改进**：下次遇到类似问题自动应用改进策略
- **经验积累**：失败经验写入 lessons.md

## 七、与 LangChain/DeepAgent 的关系

### 7.1 使用 DeepAgent 原生

- `SummarizationMiddleware` - 自动上下文压缩
- `FilesystemMiddleware` - 文件操作
- `SubAgentMiddleware` - 子代理委派
- `TodoListMiddleware` - 任务跟踪
- `project_memory` - 项目记忆注入（deep_agent._load_memory_content）
- `Skills 工具` - 技能发现与匹配（registry.py 自定义注册）

### 7.2 使用 LangGraph 原生

- `Checkpointer` - 会话状态持久化
- `Store` - 跨会话长期存储

### 7.3 使用 LangChain 原生

- `OpenAIEmbeddings` - Embedding 模型
- `FAISS` - 向量存储
- `create_retriever_tool` - 检索工具创建
- `@tool` 装饰器 - 工具定义

### 7.4 扩展能力（不重复实现）

| 能力 | 说明 | 为什么需要 |
|------|------|-----------|
| ResourceManager | 动态资源管理 | LangChain 没有任务驱动的资源选择 |
| FailureRecoveryManager | 失败重试学习 | LangChain 没有自适应重试机制 |
| OntologyExtractor | 本体关系提取 | LangChain 没有知识图谱积累 |
