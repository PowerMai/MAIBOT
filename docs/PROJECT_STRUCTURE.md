# 项目结构说明 (Project Structure)

本仓库按国际主流开源项目惯例组织，便于协作与 CI/CD。

## 顶层目录 (Root)

```
.
├── .github/              # GitHub 配置（Actions、ISSUE_TEMPLATE 等）
├── backend/              # 后端服务（Python / LangGraph）
├── docs/                 # 项目文档（非 API 文档）
├── frontend/             # 前端工程
├── knowledge_base/       # 知识库（Skills、Ontology、领域数据）
├── plugins/              # 可插拔能力模块
├── scripts/              # 运维与开发脚本
├── .env.example          # 环境变量模板（提交）；.env 本地配置（不提交）
├── .gitignore
├── langgraph.json        # LangGraph Server 配置
├── Makefile              # 常用命令（test、release、gate）
├── package.json          # 根 package（monorepo 脚本）
├── README.md
├── uv.lock               # Python 依赖锁（backend 使用）
└── start                 # 统一入口：./start dev | prod | status | stop
```

## 后端 (backend/)

- **唯一 Python 虚拟环境**：`backend/.venv`（全项目统一，根目录不再保留 `.venv`）
- 依赖与锁文件：`backend/pyproject.toml`、根目录 `uv.lock`（在 backend 下执行 `uv sync`）

```
backend/
├── .venv/                # Python 虚拟环境（不提交）
├── api/                  # FastAPI 路由与接口
├── config/               # 运行时配置（JSON/YAML）
├── engine/               # LangGraph 引擎、Agent、中间件
├── scripts/              # 后端脚本（测试、发布门禁、数据构建）
├── tests/                # 单元/集成测试
├── tools/                # 工具实现
└── pyproject.toml        # 依赖与工具配置
```

## 前端 (frontend/)

```
frontend/
└── desktop/              # Electron 桌面应用
    ├── src/
    ├── package.json
    └── node_modules/     # 依赖（不提交，pnpm install 安装）
```

## 知识库 (knowledge_base/)

- 提交：`skills/`、`ontology/`、`roles/`、`tools/` 等**结构与小文件**
- 不提交：`global/`（向量/索引，体积大）、`learned/.vectorstore/`

## 数据与运行时（不提交）

| 路径 | 说明 |
|------|------|
| `data/` | 持久化数据（SQLite、向量等） |
| `outputs/` | 生成物、报告 |
| `uploads/` | 用户上传 |
| `logs/` | 日志 |
| `tmp/` | 临时文件 |
| `backend/data/` | 后端产出与缓存 |

## 开发与发布

- **后端**：`cd backend && uv sync` 创建/更新 `backend/.venv`，然后 `./start backend` 或通过 `./start dev` 启动。
- **前端**：`cd frontend/desktop && pnpm install && pnpm run electron:dev`。
- **全栈**：`./start dev`（开发）或 `./start prod`（生产）。

详见 [README.md](../README.md) 与 [CONTRIBUTING.md](../CONTRIBUTING.md)。
