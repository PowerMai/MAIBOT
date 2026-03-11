# 桌面应用 - 运行与打包

本目录为 CCB 数字员工工作台 Electron 桌面应用。应用通过 `http://localhost:2024` 连接后端 LangGraph 服务。

## 一键启动（推荐）

在**项目根目录**执行，可同时启动后端与桌面应用：

```bash
# 开发模式（后端 + Vite + Electron）
./scripts/start.sh dev

# 或：后端 + 已构建前端（无需 Vite，启动更快）
./scripts/start.sh dev-built
```

启动完成后，Electron 窗口会自动打开；后端 API 地址为 `http://localhost:2024`。

## 仅启动桌面（后端已运行时）

若已通过 `./scripts/start.sh backend` 启动后端，可只启动前端：

```bash
# 使用 Vite 开发服务器
./scripts/start.sh frontend

# 或使用已构建的 dist（需先 build）
./scripts/start.sh frontend-built
```

或在当前目录：

```bash
pnpm install
pnpm run electron:dev    # 开发：Vite + Electron
pnpm run build && pnpm exec electron .   # 使用已构建产物
```

## 打包（双击即用安装包）

打包前请先构建前端，再执行 electron-builder：

```bash
cd frontend/desktop
pnpm install
pnpm run build
pnpm run electron:build:mac    # macOS: DMG + ZIP (x64/arm64)
# 或
pnpm run electron:build:win   # Windows: NSIS + Portable
pnpm run electron:build:linux # Linux: AppImage + deb + rpm
```

产物输出在 `frontend/desktop/release/`。

**安装后使用**：安装包仅包含桌面客户端。使用前需先启动后端（在项目根目录执行 `./scripts/start.sh backend`），再双击打开「AI智能助手」。后端默认端口为 2024；若修改后端端口，需在打包前于 `vite.config.ts` 中修改 `VITE_API_BASE_URL` / `VITE_LANGGRAPH_API_URL` 并重新 build。

## 首次启动引导

应用内已集成 WelcomeGuide 组件，首次启动可引导用户完成基本设置与工作区选择。

## 状态与日志

- 查看服务状态：`./scripts/start.sh status`（项目根）
- 停止所有服务：`./scripts/start.sh stop`
- 后端日志：`./scripts/start.sh logs backend` 或查看 `logs/backend.log`

## CSP 与开发环境

- **生产构建**：Electron main 在非开发环境下会注入 `Content-Security-Policy`（`setupProductionCSP`），禁用 `unsafe-eval`，符合安全最佳实践。
- **开发环境**：Vite HMR 依赖 `eval`/动态脚本，因此开发时不会注入上述 CSP，否则热更新会失败；控制台可能出现 Electron 的 CSP 相关提示，属预期行为，打包后不再出现。
- 若需在开发时关闭 CSP 相关警告，可依赖当前逻辑（仅生产注入）；或通过环境变量在 main 中跳过 CSP 注入（保持默认即可）。

---

## 数字员工平台功能（与规划对应）

- **角色与技能**：Composer 左侧选择数字员工（解决方案专家等），技能市场在「知识库」面板 →「技能」→「技能市场」：按领域浏览、从 URL 安装、本地已安装管理。
- **任务看板**：任务面板支持「个人 / 组织 / 市场」三级；在市场看板发布的任务可被其他实例竞标（需开启 A2A）。
- **知识库同步**：后端提供 `GET /knowledge/sync/status`、`POST /knowledge/sync/trigger`（当前云端为 stub，可扩展为真实云端后接入）。
- **A2A 跨实例**：设置 `BOARD_BROADCAST_INVITE=true` 后，创建任务会向已注册节点广播邀请；各节点需实现或已提供 `POST /board/task-invite` 接收邀请，并向回调 URL 提交竞标。节点注册：`POST /network/nodes`，列表：`GET /network/nodes`。
