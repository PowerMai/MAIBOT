# MAIBOT - AI 编辑器项目（参考代码）

**Reference implementation of a full-stack AI editor** using LangChain / LangGraph / DeepAgent + FastAPI + Electron. 基于 LangChain / LangGraph / DeepAgent 的智能编辑器系统，**已归档**，以**参考实现**形式公开发布，供学习、借鉴与合作交流。

> **归档说明**：开发已暂停，不提供维护与功能更新。详见 **[ARCHIVE.md](ARCHIVE.md)**。  
> **参考使用**：克隆、运行与阅读顺序见 **[docs/REFERENCE_USAGE.md](docs/REFERENCE_USAGE.md)**。  
> **项目优势与合作**：技术优势、适用场景与交流方式见 **[docs/ADVANTAGES.md](docs/ADVANTAGES.md)**。

## 技术栈与定位

- **后端**：Python、LangGraph、FastAPI、DeepAgent 中间件与 Skills  
- **前端**：Electron、React、LangChain Chat UI、@assistant-ui  
- **用途**：全栈 AI 对话/工作台/任务管线、知识库与可插拔插件的**可运行参考实现**

## 项目优势（摘要）

| 优势 | 说明 |
|------|------|
| **主流生态** | LangChain / LangGraph / DeepAgent 与官方及社区实践对齐，便于迁移与二次开发。 |
| **全栈可运行** | 后端 + Electron 前端完整打通，流式对话、工作区、任务管线可直接克隆运行体验。 |
| **生产级设计** | SQLite 持久化、向量懒加载、TTL 清理、中间件链与门禁脚本齐全，可作部署参考。 |
| **文档与契约** | 架构、运维、管线与中间件、Skills/知识库等文档集中，推荐阅读路径清晰。 |

更完整的优势说明、适用场景与**合作交流方式**见 **[docs/ADVANTAGES.md](docs/ADVANTAGES.md)**。  

## 快速开始

```bash
# 开发模式
./start dev

# 生产模式（推荐，使用 SQLite 持久化）
./start prod

# 查看服务状态
./start status

# 健康检查
./start health

# 清理内存
./start cleanup

# 查看日志
./start logs backend

# 停止服务
./start stop
```

## 项目结构

- **Python 环境**：全项目统一使用 **`backend/.venv`**，根目录无需再保留 `.venv`（若有可删除以节省约 1.1G）。
- 完整目录说明见 **[docs/PROJECT_STRUCTURE.md](docs/PROJECT_STRUCTURE.md)**。

```
├── backend/                 # 后端（Python，唯一 venv: backend/.venv）
│   ├── api/                 # FastAPI 接口
│   ├── engine/              # LangGraph 引擎
│   └── tools/               # 工具集
├── frontend/desktop/        # Electron 桌面前端
├── knowledge_base/          # 知识库（skills、ontology 等）
├── plugins/                 # 可插拔模块
├── scripts/                 # 脚本（start.sh 等）
├── docs/                    # 文档
├── data/                    # 持久化数据（不提交）
└── logs/                    # 日志（不提交）
```

## 存储架构（生产级）

| 存储类型 | 位置 | 说明 |
|---------|------|------|
| 会话检查点 | `data/checkpoints.db` | SQLite，支持会话恢复 |
| 长期记忆 | `data/store.db` | SQLite，跨会话持久化 |
| 向量索引 | `data/vectorstore/unified/` | FAISS 文件，按需加载 |

### 性能优化策略

#### 内存优化
1. **SQLite 存储**：会话状态和长期记忆使用 SQLite 文件数据库，不常驻内存
2. **向量存储懒加载**：FAISS 索引存储在文件中，每次查询时加载，查询后释放
3. **TTL 自动清理**：7 天自动清理过期数据
4. **定期清理任务**：每小时自动检查并清理过大的缓存文件

#### 运行效率
1. **连接池复用**：HTTP 客户端连接池，减少连接开销
2. **Prompt 缓存**：LM Studio `cache_prompt=True`，重复提示词只计算一次
3. **响应缓存**：相同请求直接返回缓存结果（LRU，最多 1000 条）
4. **流式输出**：减少首字节延迟，提升用户体验
5. **SQLite WAL 模式**：提升数据库并发性能

#### 资源管理
1. **Agent 缓存**：避免重复创建（LRU，最多 5 个配置）
2. **LLM 单例**：可配置 LLM 实例复用
3. **优雅关闭**：应用关闭时正确释放所有资源

## 服务地址

| 服务 | 地址 |
|------|------|
| 后端 API | http://localhost:2024 |
| API 文档 | http://localhost:2024/docs |
| 前端 | http://localhost:3000 |
| LM Studio | http://localhost:1234 |

## 管理 API

```bash
# 查看内存状态
curl http://localhost:2024/memory/health

# 详细统计
curl http://localhost:2024/memory/stats

# 清理内存
curl -X POST http://localhost:2024/memory/cleanup

# 激进清理（内存紧张时）
curl -X POST "http://localhost:2024/memory/cleanup?aggressive=true"

# 向量存储统计
curl http://localhost:2024/vectorstore/stats

# 重建向量索引
curl -X POST http://localhost:2024/vectorstore/rebuild

# 查看当前配置
curl http://localhost:2024/system/config

# 系统信息
curl http://localhost:2024/system/info
```

## 安全与运行环境

本系统提供 `python_run`、`shell_run` 等代码/命令执行能力，当前**未做进程级沙箱**，仅适合在**受信环境或内网**使用。请勿在对不可信用户开放的生产环境中依赖此类能力；若需对外服务，请关闭或严格限制相关工具。沙箱化方案见 [docs/SYSTEM_REVIEW_AND_OPTIMIZATION.md](docs/SYSTEM_REVIEW_AND_OPTIMIZATION.md) 第 1.1 节。

### 内部 API 鉴权（INTERNAL_API_TOKEN）

写类内部 API（云端端点、模型切换、配置/技能/插件、文件操作等）由 `INTERNAL_API_TOKEN` 保护。**未设置**该环境变量时，仅接受来自 loopback（127.0.0.1、::1）的请求，便于本机零配置开发；**已设置**时，请求须带与之一致的 `X-Internal-Token` 或 `Authorization: Bearer`，前端可通过 `VITE_INTERNAL_API_TOKEN` 或 `VITE_LOCAL_AGENT_TOKEN` 注入。何时必须配置、localhost 放行的适用场景与风险见 [docs/product_analysis_2026-03-04.md](docs/product_analysis_2026-03-04.md) 第 9.5 节。

## 可选能力：自我学习与知识

| 配置项 | 说明 | 推荐用法 |
|--------|------|----------|
| `ENABLE_SELF_LEARNING` | 任务完成后记录成功/失败模式与推理路径，供经验检索与导出微调 | 稳定使用一段时间后开启；学习数据存于工作区 `.memory/learning/` |
| `ENABLE_KNOWLEDGE_RETRIEVER` | 启用知识库检索（search_knowledge） | 需要从 knowledge_base 检索时开启 |
| `ENABLE_KNOWLEDGE_GRAPH` | 启用知识图谱（knowledge_graph：抽取实体/关系、查询图谱） | 需要按领域沉淀或过滤经验时开启 |

本体相关工具（少工具原则）：ontology（schema 查询/实例抽取）、ontology_import（LOV/Wikidata/OWL 等外部导入与合并至主 KG）、knowledge_graph（见上）。**为何默认关闭、开启后具体行为**见 [docs/resources-and-capabilities.md](docs/resources-and-capabilities.md)。知识学习与 KG：先开知识库检索，再按需开知识图谱；自我学习会从 configurable 读取 skill_profile/workspace_domain 做模式分段，便于按场景复用经验。

## 开发 vs 生产模式

| 特性 | 开发模式 (dev) | 生产模式 (prod) |
|------|---------------|-----------------|
| 命令 | `langgraph dev` | `langgraph up` |
| 存储 | Pickle (内存) | SQLite (文件) |
| 持久化 | ❌ 重启丢失 | ✅ 持久保存 |
| 内存 | ⚠️ 可能暴涨 | ✅ 稳定 |

**推荐使用生产模式**：`./start prod`

## 配置文件

- `.env.example` - 配置示例（复制为 `.env` 使用）
- `langgraph.json` - LangGraph 服务配置
- `backend/pyproject.toml` - Python 依赖

### 关键配置项

```bash
# 复制配置示例
cp .env.example .env

# 编辑配置
vim .env
```

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `CHECKPOINT_TTL_DAYS` | 7 | 检查点保留天数 |
| `STORE_TTL_DAYS` | 30 | Store 数据保留天数 |
| `CLEANUP_INTERVAL_SECONDS` | 3600 | 清理任务间隔（秒） |
| `LLM_CACHE_MAX_SIZE` | 1000 | LLM 响应缓存大小 |
| `AGENT_CACHE_MAX_SIZE` | 5 | Agent 实例缓存大小 |
| `HTTP_MAX_CONNECTIONS` | 20 | HTTP 最大连接数 |
| `SQLITE_CACHE_SIZE_KB` | 64000 | SQLite 缓存大小（KB） |

完整配置项请参考 `.env.example`。

## 文档

| 文档 | 说明 |
|------|------|
| [ARCHIVE.md](ARCHIVE.md) | 项目归档说明与参考用途 |
| [docs/ADVANTAGES.md](docs/ADVANTAGES.md) | **项目优势、适用场景与合作交流**（推荐对外介绍时引用） |
| [docs/REFERENCE_USAGE.md](docs/REFERENCE_USAGE.md) | 参考代码使用说明（克隆、运行、阅读顺序） |
| [docs/PROJECT_STRUCTURE.md](docs/PROJECT_STRUCTURE.md) | 项目结构 |
| [docs/resources-and-capabilities.md](docs/resources-and-capabilities.md) | 资源与能力（Skills、知识图谱、自我学习等） |
| [docs/operations.md](docs/operations.md) | 运行与调试 |
| [docs/main_pipeline_and_middleware_rationality.md](docs/main_pipeline_and_middleware_rationality.md) | 主链路与中间件设计 |
| [docs/README.md](docs/README.md) | 文档索引（入口） |
| `docs/archive/` | 开发过程与历史文档 |
| `backend/docs/` | 后端架构文档 |

## 合作与交流

本仓库以**参考代码**形式公开发布，欢迎借鉴与交流，以增加可见度与协作机会：

- **使用心得与衍生项目**：若你基于本仓库做了学习总结或二次开发，欢迎在 [GitHub Issues](https://github.com/PowerMai/MAIBOT/issues) 中分享链接或简要说明。  
- **架构与实现讨论**：对 LangGraph/DeepAgent 集成、中间件、Skills 与知识库等设计问题，可在 Issues 中发起讨论。  
- **Fork 与链接**：在遵守 [LICENSE](LICENSE) 的前提下欢迎 Fork；若形成公开项目，可考虑在 README 或 [docs/ADVANTAGES.md](docs/ADVANTAGES.md) 中交换链接。  

详见 [docs/ADVANTAGES.md](docs/ADVANTAGES.md) 第五部分。

## 许可

本仓库以参考代码形式公开发布，使用许可见 [LICENSE](LICENSE)。
