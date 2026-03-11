# 知识管理架构设计

## 零、关键问题：SKILL.md 是否有价值？

### 问题分析

当前 SKILL.md 存在以下问题：
1. **内容过长** - 官方规范 description 最多 1024 字符，当前远超
2. **与提示词重复** - JSON 结构、工具使用方法已在提示词中定义
3. **没有实际价值** - 如果只是重复提示词内容，就是冗余

### 官方 SKILL.md 规范

```markdown
---
name: skill-name (max 64 chars)
description: What the skill does (max 1024 chars)
license: MIT
---

# Skill Title

## When to Use
- Trigger conditions

## Key Concepts
- Domain-specific knowledge not in prompts
```

### 建议方案

**方案 A: 精简 SKILL.md（推荐）**
- 只保留领域专属知识（如五维分析模型的背景）
- 移除与提示词重复的内容
- 控制在 1024 字符以内

**方案 B: 移除 SKILL.md**
- 如果提示词已经足够，可以完全移除
- 详细指南放在知识库中，通过 Knowledge Agent 检索

**方案 C: 重新定位 SKILL.md**
- 作为"触发条件"的索引
- 指向详细指南的路径映射
- 不包含具体实现细节

## 一、现有实现（不要重复）

### 已有的知识库模块

| 模块 | 路径 | 功能 |
|------|------|------|
| **KnowledgeBaseCore** | `backend/knowledge_base/core.py` | 向量索引、混合检索 |
| **KnowledgeBaseManager** | `backend/knowledge_base/manager.py` | 多租户支持（个人/团队/全局） |
| **UnifiedRetriever** | `backend/tools/internal/retriever.py` | 通用检索器 |
| **embedding_tools** | `backend/tools/base/embedding_tools.py` | LangChain 原生 Embedding + Retriever Tool |

### 已有的前端模块

| 模块 | 路径 | 功能 |
|------|------|------|
| **KnowledgeBasePanel** | `frontend/.../KnowledgeBasePanel.tsx` | 知识库面板 |
| **KnowledgeManager** | `frontend/.../KnowledgeManager.tsx` | 知识库管理 |
| **knowledgeApi** | `frontend/.../knowledgeApi.ts` | LangGraph Store API |

## 二、DeepAgent 原生能力

### Skills 加载机制 - 专业技能（本项目自定义，DeepAgent 无 SkillsMiddleware）

```python
# BUNDLE.md 内联 + Skills 工具按需发现
skills_paths = [
    "/knowledge_base/global/domain/bidding/02_operations/",
    "/knowledge_base/global/domain/contracts/02_operations/",
    "/knowledge_base/global/domain/reports/02_writing_guide/",
]
```

**SKILL.md 的作用**：
- 自动注入到系统提示词
- 提供领域专业知识和工作流程
- 包含触发条件、分析模型、输出规范

**问题：SKILL.md 与知识库指南是否重复？**

答案：**不重复，职责不同**

| 内容 | SKILL.md | 知识库指南 |
|------|----------|-----------|
| 加载方式 | 自动注入提示词 | 按需检索 |
| 内容类型 | 概览、触发条件、工作流 | 详细步骤、模板、案例 |
| 更新频率 | 稳定（核心流程） | 频繁（最佳实践） |
| 大小限制 | 受提示词长度限制 | 无限制 |

### MemoryMiddleware - 记忆注入

```python
memory_paths = [
    ".context/AGENTS.md",   # 用户偏好、工作区结构
    ".context/lessons.md",  # 经验教训
]
```

### Store + Checkpointer - 持久化

- **Store**: 跨会话持久化（知识库、记忆）
- **Checkpointer**: 会话恢复（任务进度）

## 三、正确的架构设计

### 知识层级

```
┌─────────────────────────────────────────────────────────────┐
│                    DeepAgent 系统提示词                      │
├─────────────────────────────────────────────────────────────┤
│ BUNDLE.md 内联 + Skills 工具:                                │
│   - SKILL.md (领域概览、触发条件、工作流)                     │
│                                                             │
│ project_memory 拼入:                                         │
│   - .context/CONTEXT.md (项目规则、工作区结构)                │
│   - .context/rules/*.md (领域规则)                           │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Knowledge Agent 检索                      │
├─────────────────────────────────────────────────────────────┤
│ 向量检索 (search_knowledge):                                 │
│   - 详细操作指南 (*_V2.md)                                   │
│   - 输出模板 (03_templates/)                                 │
│   - 最佳实践 (04_best_practices/)                            │
│   - 案例研究 (05_case_studies/)                              │
│                                                             │
│ 网络搜索 (duckduckgo_search):                                │
│   - 补充信息（标注来源）                                      │
└─────────────────────────────────────────────────────────────┘
```

### SKILL.md 设计原则

**应该包含**：
- 领域概览（一句话描述）
- 触发条件（关键词、文件类型）
- 分析模型（如五维分析模型）
- 工作流程（高层步骤）
- 指南映射（指向详细文档）

**不应该包含**：
- 详细操作步骤（放在指南中）
- 完整模板（放在 templates 中）
- 案例研究（放在 case_studies 中）

### 示例：精简的 SKILL.md

```markdown
---
name: bidding-analysis
version: "3.0"
triggers: [招标, 投标, 评分, 资质]
---

# 招标文件分析技能

## 概述
分析招标文件，提取关键信息，生成投标策略。

## 五维分析模型
1. PROJECT - 项目维度
2. QUALIFY - 资格维度
3. TECHNICAL - 技术维度
4. COMMERCIAL - 商务维度
5. SCORING - 评分维度

## 工作流程
1. 解析文档结构
2. 提取五维信息
3. 分析符合性/风险
4. 生成报告/策略

## 详细指南
| 任务 | 指南文件 |
|------|----------|
| 分析招标文件 | `01_ANALYZE_BIDDING_DOCUMENT_V2.md` |
| 解析评分标准 | `02_PARSE_SCORING_CRITERIA_V2.md` |
| 识别强制要求 | `03_IDENTIFY_MANDATORY_REQUIREMENTS_V2.md` |
```

## 四、工具与知识库的职责划分

### 工具（Tools）- 执行能力

| 工具 | 职责 | 来源 |
|------|------|------|
| read_file | 读取文件 | FilesystemMiddleware |
| write_file | 写入文件 | FilesystemMiddleware |
| python_run | 执行代码 | 自定义工具 |
| search_knowledge | 向量检索 | embedding_tools.py |
| duckduckgo_search | 网络搜索 | LangChain 工具 |

### 知识库（Knowledge Base）- 存储内容

| 类型 | 路径 | 用途 |
|------|------|------|
| 操作指南 | `02_operations/*.md` | 详细步骤 |
| 输出模板 | `03_templates/*.md` | 格式规范 |
| 最佳实践 | `04_best_practices/*.md` | 经验总结 |
| 案例研究 | `05_case_studies/*.md` | 成功/失败案例 |

## 五、基础资料、本体与前后端联动

### 基础资料管理

- 目录结构（与 PATH_ARCHITECTURE 一致）：`knowledge_base/global/`、`teams/{id}/`、`users/{id}/`、`skills/`、`learned/`。
- 前端 KnowledgeBasePanel：按 scope（个人/团队/全局）筛选结构树；上传/新建文件夹/删除；左侧文件树含 knowledge_base 根下 global、learned、skills、tools 及 teams/users。

### 知识图谱/本体

- **自动生成**：沿用 `extract_entities` / 知识图谱写入（embedding_tools、registry），产出写入 `knowledge_base/learned/ontology/`（entities.json、relations.json）。
- **上传/导入与图谱**：上传或导入后默认仅刷新向量索引；**不会自动构建本体/图谱**。如需生成知识图谱，可：(1) 上传时传 `build_ontology=true` 或导入时传 `build_ontology: true`；(2) 设置环境变量 `AUTO_BUILD_ONTOLOGY_AFTER_UPLOAD=true` 使上传/导入后自动触发；(3) 执行构建任务（ops 含 `ontology`）或调用 `POST /knowledge/ontology/build`。响应中会提示「如需生成知识图谱，请执行构建任务…」。
- **人工编辑**：本体管理通过 API 提供 CRUD：
  - `GET /knowledge/metadata`：各 scope 文档数、entity_count、relation_count。
  - `GET/POST/PUT/DELETE /knowledge/ontology/entities`、`GET/POST /knowledge/ontology/relations`、`DELETE /knowledge/ontology/relations/{index}`。
- 前端：KnowledgeBasePanel 内「本体管理」入口，列表/查看实体与关系，支持增删改并调用上述 API。

### 与对话/展示区联动

- **对话**：发送时可把当前知识库条目或本体片段作为 context_items 传入；检索结果（search_knowledge/query_kg）在消息中可带来源引用。
- **聊天区**：对 search_knowledge/query_kg 结果做差异化样式，完成时显示「来自知识库」标签，提供「在展示区查看」按钮，派发 `open_knowledge_ref` 事件。
- **展示区**：监听 `open_knowledge_ref`，用虚拟 Tab 在中央展示区打开引用内容（知识库片段或知识图谱结果）。

### 执行日志（Debug 模式）

- `GET /execution-logs?thread_id=...&limit=...&status=...`：返回指定 thread 的最近执行记录，供 Debug 模式分析。主图 deepagent_node 在执行时写入 execution_log，由本 API 读取返回。

## 六、前端集成

### 知识库管理页面

使用现有的 `KnowledgeManager.tsx` 和 `knowledgeApi.ts`：

```typescript
// 使用 LangGraph Store API
import { Client } from "@langchain/langgraph-sdk";

// 添加知识
await client.store.putItem(
  ["knowledge", organization, team, domain],
  docId,
  document
);

// 搜索知识
const result = await client.store.searchItems(namespace);
```

### 与 Agent 集成

Knowledge Agent 使用 `search_knowledge` 工具检索：

```python
# 使用现有的 embedding_tools.py
from backend.tools.base.embedding_tools import get_knowledge_retriever_tool

retriever_tool = get_knowledge_retriever_tool()
# 工具名称: search_knowledge
# 描述: 语义搜索知识库
```

## 六点五、刷新与重建语义（统一约定）

知识库索引更新以 **POST /knowledge/refresh** 为**唯一推荐入口**；以下语义为权威约定，避免混用 refresh/rebuild 造成歧义。

| 操作 | 入口 | 语义 |
|------|------|------|
| **仅清缓存** | `POST /knowledge/refresh?mode=cache-only` | 只清内存缓存，不重建索引；检索立即看到已有索引。 |
| **增量刷新** | `POST /knowledge/refresh?mode=incremental`（默认） | 增量重建向量索引（仅处理新增/变更）+ 清缓存。 |
| **全量重建** | `POST /knowledge/refresh?mode=full` | 全量重建向量索引 + 清缓存，耗时较长。 |
| **重建（别名）** | `POST /vectorstore/rebuild?force=false|true` | 与 refresh 等价：force=false 等价于 mode=incremental，force=true 等价于 mode=full。建议统一使用 `/knowledge/refresh`。 |

实现上均由 `embedding_tools.rebuild_index(..., force=...)` 完成索引写入；`force=True` 表示全量，`force=False` 表示增量。

## 六.1、search_knowledge 工具与路径单一来源

### 工具名与实现分支

| 约定项 | 说明 |
|--------|------|
| **唯一对外工具名** | Agent 可见的工具名为 `search_knowledge`，由 `backend/tools/base/registry.py` 注册，不重复注册。 |
| **主路径** | `ENABLE_KNOWLEDGE_RETRIEVER=true` 时，通过 `embedding_tools.get_knowledge_retriever_tool()` 获取检索器并封装为 `search_knowledge`（向量 + 可选混合检索）。 |
| **Fallback** | 向量不可用时 `_register_fallback_search()` 注册同名的 `search_knowledge`，实现为 KG 扩展 + 文件索引（`00_KB_INDEX.md` 等），与主路径为同一工具名的两种实现分支。 |
| **embedding_tools** | 仅实现检索逻辑（`get_knowledge_retriever_tool()` 返回可 invoke 的 tool），不在 registry 外重复注册工具。 |

### 路径单一来源

- **KB_PATH、ONTOLOGY_PATH**：统一从 `backend/tools/base/paths.py` 导入；禁止在 registry、knowledge_api、embedding_tools 等处硬编码 `Path(...)/ "knowledge_base"` 或 `.../ "learned" / "ontology"`。
- **knowledge_api**：`KB_ROOT` / `ONTOLOGY_DIR` 从 `paths` 导入，ImportError 时回退到与 paths 默认一致的路径；API 用于前端直接搜索与管理，工具层用于 Agent 调用，二者可共用同一检索实现或按需分工。

## 七、总结

### 不要重复实现

- ✅ 使用 `backend/knowledge_base/core.py` 的向量检索
- ✅ 使用 `backend/tools/base/embedding_tools.py` 的 Retriever Tool
- ✅ 使用 `frontend/.../knowledgeApi.ts` 的 LangGraph Store API
- ✅ 使用 BUNDLE.md 内联 + Skills 工具加载 SKILL.md

### 职责清晰

- **SKILL.md**: 领域概览、工作流程（自动注入）
- **知识库指南**: 详细步骤、模板（按需检索）
- **工具**: 执行能力（read_file, python_run, search_knowledge）
- **Store**: 持久化存储（跨会话）

### Skills：BUNDLE 与 runtime_index 同源

- **BUNDLE 内联**：由 [deep_agent](backend/engine/agent/deep_agent.py) 按 skill_profile 从 [SkillRegistry](backend/engine/skills/skill_registry.py) 加载的 skill 路径拼接能力速查并注入系统提示词。
- **list_skills / match_skills / get_skill_info**：工具层同样使用 SkillRegistry（discover_skills、match_skills_by_query、get_skill_info），与 BUNDLE 同源，避免提示词中的能力描述与工具返回不一致。
- **build_runtime_index**：供 API 或提示词内联使用，与 BUNDLE 所用数据源一致；可考虑缓存 build_runtime_index 结果与 list/by-profile API 共用，减少重复扫描。

### 业界最佳实践

1. **知识库不包含工具实现** - 仅存储内容
2. **工具模块化** - 由 Agent 调用
3. **配置化** - 分类、权限通过配置管理
4. **版本控制** - Prompt、知识库都需要版本管理
