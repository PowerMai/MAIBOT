# 参考代码使用说明

本文说明如何将本仓库（MAIBOT/CCB）作为**参考代码**使用：克隆、运行、以及按模块阅读与借鉴。

## 1. 克隆与准备

```bash
git clone https://github.com/PowerMai/MAIBOT.git
cd MAIBOT
```

- 后端：`cd backend && uv sync`（或 `pip install -e ".[dev]"`），使用 **Python 3.12+**。  
- 前端：`cd frontend/desktop && pnpm install`，需要 **Node 20**、**pnpm 9**。  
- 配置：复制 `cp .env.example .env` 并按需修改（如 LM Studio 地址、数据路径等）。

## 2. 运行方式

- **全栈开发**：`./start dev`（需本机已安装 LangGraph CLI 等）。  
- **生产模式**：`./start prod`（SQLite 持久化，推荐本地体验）。  
- **仅后端**：在 `backend` 下配置好 `.env` 后，可通过 `langgraph dev` 或项目提供的 `./start backend` 启动。  
- **仅前端**：`cd frontend/desktop && pnpm run electron:dev`（需后端 API 可用，默认 `http://localhost:2024`）。

详细命令与健康检查见 [README.md](../README.md)。

## 3. 推荐阅读顺序（参考实现）

按「先整体后局部」的方式阅读，便于理解各层职责与契约：

| 顺序 | 内容 | 说明 |
|------|------|------|
| 1 | [README.md](../README.md)、[ARCHIVE.md](../ARCHIVE.md) | 项目定位、归档状态、技术栈 |
| 2 | [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md) | 目录与模块划分 |
| 3 | `backend/engine/core/main_graph.py`（入口与图结构） | LangGraph 主图、节点与边 |
| 4 | `backend/engine/nodes/`、`backend/api/` | 节点实现与 FastAPI 路由 |
| 5 | `backend/engine/agent/`、`backend/engine/middleware/` | DeepAgent 与中间件链 |
| 6 | `frontend/desktop/src/components/ChatComponents/` | 对话 UI 与 LangChain/assistant-ui 集成 |
| 7 | [main_pipeline_and_middleware_rationality.md](main_pipeline_and_middleware_rationality.md) | 主管线与中间件设计说明 |
| 8 | [resources-and-capabilities.md](resources-and-capabilities.md) | Skills、知识库、知识图谱等能力与配置 |

## 4. 关键模块速览

- **LangGraph 引擎**：`backend/engine/core/` — 图定义、状态、路由与检查点。  
- **Agent 与工具**：`backend/engine/agent/`、`backend/tools/` — 工具注册、DeepAgent 配置与调用。  
- **Skills 与知识库**：`knowledge_base/skills/`、`knowledge_base/learned/` — 技能定义与学习产出；能力开关见 `.env` 与 [resources-and-capabilities.md](resources-and-capabilities.md)。  
- **插件**：`plugins/` — 可插拔业务模块；边界与商业/开源划分见 `.module-boundary.json`。  
- **前端对话与工作台**：`frontend/desktop/src/` — 会话、工作区、任务与设置等 UI 与状态。

## 5. 文档与契约

- **架构与运维**：`docs/` 下多份架构、E2E、运维文档；历史过程文档在 `docs/archive/`。  
- **API 契约**：运行后端后访问 `http://localhost:2024/docs` 查看 OpenAPI。  
- **事件与前端契约**：见 `docs/` 中与 event、session、stream 相关的说明。

## 6. 二次使用与许可

- 可在遵守 [LICENSE](../LICENSE) 的前提下 Fork、修改与自用。  
- 本仓库不提供官方维护与支持；若恢复维护，将在仓库中另行公告。
