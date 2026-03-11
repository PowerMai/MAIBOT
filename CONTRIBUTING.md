# Contributing

感谢对本项目的关注。贡献前请先阅读本说明。

## 开发环境

- **Python**：仅使用 **`backend/.venv`** 作为项目唯一虚拟环境；根目录若有旧 `.venv` 可删除以节省空间。
- **Node**：前端在 `frontend/desktop` 下使用 pnpm 安装依赖。

```bash
# 后端
cd backend && uv sync

# 前端
cd frontend/desktop && pnpm install
```

## 运行与测试

- 统一入口：`./start dev`（开发）、`./start prod`（生产）、`./start status`、`./start stop`。
- 测试与门禁：见根目录 `Makefile`（如 `make test-quick`、`make gate-release`）。

## 提交与推送

- 请勿提交：`.env`、`.venv`、`node_modules`、`knowledge_base/global`、`data/`、`outputs/`、大文件。
- 项目结构说明见 [docs/PROJECT_STRUCTURE.md](docs/PROJECT_STRUCTURE.md)。

## 行为准则

- 保持礼貌、就事论事；遵守仓库与社区规范。

## 开源许可

- 若需开源，请在仓库根目录添加 `LICENSE` 文件（如 MIT、Apache-2.0）并在 README 中注明。
