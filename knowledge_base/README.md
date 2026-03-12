# 知识库说明

**说明**：本仓库中 `domain/`、`learned/`、`docs/`、`global/` 等资料与学习产出**不纳入版本控制**（见根目录 `.gitignore`），克隆后需从本地归档或自行按需生成。

## 向量化

- **执行位置**：在 MAIBOT 项目内完成，由 `backend/tools/base/embedding_tools.py` 与 `storage_manager.py` 负责。
- **Embedding 模型**：使用项目配置的模型，默认 `text-embedding-qwen3-embedding-0.6b`，API 地址 `http://localhost:1234/v1`（本地服务，如 Ollama 等）。可通过环境变量覆盖：
  - `EMBEDDING_MODEL`
  - `EMBEDDING_BASE_URL`
- **索引方式**：按需索引（首次检索或调用重建索引时生成）；支持 `.md`、`.txt`、`.pdf`、`.docx`、`.xlsx`。

## 向量化管理

- **已向量化不重做**：检索时只加载已有 FAISS 索引，不会对已索引文件重新做向量化。
- **增量更新**：调用重建索引且未传 `force=True` 时，仅对**新增或内容变更**的文件做向量化（按文件内容 hash 判断）；未变更文件跳过，避免重复计算。
- **强制重建**：`rebuild_index(force=True)` 会清空索引与元数据后全量重建，仅在需要彻底刷新时使用。
- **触发方式**：Python 调用 `rebuild_index(force=False)` 做增量、`rebuild_index(force=True)` 做全量；或 HTTP `POST /vectorstore/rebuild`（默认增量）、`POST /vectorstore/rebuild?force=true` 全量。

## Rerank 说明

- **Qwen3-Embedding 不包含 rerank**；Qwen3-Reranker 为独立模型，需单独部署。
- **可选 Rerank API**：若在 LM Studio 或其它服务中加载了 rerank 模型，可启用检索后精排：
  - `RERANK_ENABLED=true`
  - `RERANK_BASE_URL`：rerank 接口地址（默认同 `EMBEDDING_BASE_URL`，如 `http://localhost:1234/v1`）
  - `RERANK_MODEL`：模型名（若服务需指定）
  - 接口约定：POST `{RERANK_BASE_URL}/rerank`，body 含 `query`、`documents`、`top_n`；响应含 `results: [{index, relevance_score}]` 或 `data: [{index, score}]`。
- **未启用或调用失败时**：自动回退到**知识图谱启发式排序**（关键词 + KG 扩展词 + 位置 + 资源优先级），无需额外模型。

## 向量存储位置

| 配置 | 路径 | 说明 |
|------|------|------|
| 默认 | `项目根/data/vectorstore/` | 与 checkpoints、数据库等统一放在 `data/` |
| 知识库内 | `knowledge_base/.vectorstore/` | 设置 `VECTOR_STORE_IN_KB=true` 后，向量索引放在知识库内，便于备份与迁移 |
| 自定义 | 任意路径 | 设置环境变量 `VECTOR_STORE_PATH` 为绝对路径 |

索引元数据（已索引文件、hash 等）默认在 `项目根/data/index_metadata.db`，与上述路径无关。

## 如何找到资料（Agent 与人工共用）

1. **确定领域**：如招投标、合同、报告等，对应 `global/domain/<领域>/` 或 `domain/<领域>/`。
2. **查入口**：读 `global/domain/00_KB_INDEX.md` 或 `domain/<领域>/README.md` 获取路径与说明；或查 `resources.json` 中对应资源的 `path`。
3. **取内容**：用 `search_knowledge`（向量检索）或 `read_file`（已知路径）获取。**边界**：知识库=领域内容（模板、案例、规则、数据）；方法论与流程在 `skills/`，找「怎么做」用 list_skills/match_skills，不在此检索。

## 目录约定（与 PATH_ARCHITECTURE 一致）

三个主区域互不混淆：

| 区域 | 路径 | 用途 |
|------|------|------|
| **技能** | `skills/` | 仅 SKILL.md 与配套文件；方法论、步骤、输出格式；由 list_skills/match_skills + BUNDLE 内联加载 |
| **领域知识** | `global/domain/` | 指南、模板、案例、规则、数据；由 search_knowledge 检索；不放大段 SKILL |
| **学习产出** | `learned/` | ontology/（知识图谱）、skills/（自动生成 SKILL 草稿）、DocMap 等 |

```
knowledge_base/
├── resources.json      # 资源与排除规则
├── global/domain/      # 领域内容（参与向量检索）：bidding/, contracts/, reports/ 等
├── skills/             # 仅技能（SKILL.md），按 profile 加载，不参与向量索引
├── learned/            # 学习产出：ontology/, skills/（草稿）, 其他
├── tools/              # 工具与优化类说明
├── teams/ users/       # 团队与个人知识
└── .vectorstore/       # 仅当 VECTOR_STORE_IN_KB=true 时存在
```

- **根目录 `domain/`**：已弃用，请将领域知识统一放在 `global/domain/`。
- **参与向量化**：`global/domain/` 下按 `resources.json` 的 `domain_knowledge` 配置处理。
- **不参与向量化**：`skills/`、`learned/` 中的 SKILL 由 Skills 工具与 profile 路径加载。

## 资料摆放建议

- 领域**内容**（模板、案例、规则、数据）：放在 `global/domain/<领域>/` 或 `domain/<领域>/`（如招投标见 `domain/procurement/`，索引见其 README.md）。
- 领域**方法论/流程**：放在 `skills/` 下对应 SKILL.md，不放在 `global/domain/` 的 `02_operations/` 中重复。

新增领域或目录时，在 `resources.json` 的 `resources` 与 `docmap` 中补充 path、file_types、exclude_patterns，保持与上述约定一致即可。
