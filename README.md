# CCB - AI 编辑器项目

基于 LangChain/LangGraph/DeepAgent 框架的智能编辑器系统。

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

```
ccb-v0.378/
├── backend/                 # 后端服务
│   ├── api/                 # FastAPI 接口
│   ├── engine/              # LangGraph 引擎
│   │   ├── agent/           # DeepAgent 配置
│   │   ├── core/            # 主路由 Graph
│   │   └── prompts/         # 提示词
│   └── tools/               # 工具集
├── frontend/                # 前端应用
│   └── desktop/             # Electron 桌面应用
├── scripts/                 # 脚本
│   └── start.sh             # 统一启动脚本
├── data/                    # 持久化数据（统一存储）
│   ├── checkpoints.db       # 会话检查点 (SQLite)
│   ├── store.db             # 长期记忆 (SQLite)
│   └── vectorstore/         # 向量存储 (FAISS)
│       └── unified/         # 统一向量索引
└── logs/                    # 日志文件
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

详细文档位于 `docs/` 目录：
- [docs/resources-and-capabilities.md](docs/resources-and-capabilities.md) - 资源与能力（Skills 安装、Planning/Ask、自我增强、知识图谱与自我学习、资源放置）
- [docs/operations.md](docs/operations.md) - 运行与调试
- `docs/archive/` - 开发过程文档
- `backend/docs/` - 后端架构文档
