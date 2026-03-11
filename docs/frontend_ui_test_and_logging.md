# 前端 UI 测试与日志说明

## 1. 开发环境错误日志（便于出问题后及时修复）

- **控制台**：所有未捕获错误、未处理 Promise 拒绝、ErrorBoundary 捕获错误均会 `console.error` 输出。
- **内存队列**（仅开发模式）：最近 50 条错误会写入 `window.__DEV_ERRORS__`。
  - 在浏览器控制台输入 `__DEV_ERRORS__` 可查看数组。
  - 每条形如：`{ t: 时间戳, message: string, source?: string, stack?: string }`。
- **自定义事件**：全局错误会派发 `renderer_runtime_error`，可按需监听。
- **运行时详细日志**（可选）：在控制台执行 `localStorage.setItem('maibot_metrics_debug', '1')` 后刷新页面，可开启 MyRuntimeProvider / 线程等组件的更详细 console 输出，便于排查流式、会话等问题。关闭：`localStorage.removeItem('maibot_metrics_debug')`。

## 2. 全局错误处理位置

- `frontend/desktop/src/main.tsx`：`window.onerror`、`window.onunhandledrejection`、`reportFrontendError`、`__DEV_ERRORS__` 收集。
- `frontend/desktop/src/components/common/ErrorBoundary.tsx`：React 组件树错误边界，开发环境下展示错误详情与堆栈。

## 3. 建议的 UI 自测流程

1. **启动**：`./scripts/start.sh dev` 或分别启动后端 + `cd frontend/desktop && pnpm run dev`。
2. **打开**：浏览器访问 `http://localhost:3000`，打开开发者工具 → Console。
3. **检查**：
   - 首屏加载是否有红色报错。
   - 切换会话、角色、模式是否有报错。
   - 发送一条消息，观察流式回复与 RunTracker 是否正常。
   - 打开设置页，切换若干选项卡，确认无报错。
4. **出错时**：在控制台查看 `__DEV_ERRORS__` 或 Console 中的 `[Global]` / `[ErrorBoundary]` / `[App]` 输出；若后端已启动，错误会同时写入项目下的 **`.cursor/frontend-error.log`**（开发/生产均会 POST 到 `POST /log/frontend-error`），可根据该文件定位。

## 4. 构建与 Lint

- 构建：`cd frontend/desktop && pnpm run build`（通过即无编译/类型错误）。
- Lint：按项目配置运行 `pnpm run lint`（若有）。

## 5.1 开发时出现 chunk 404 / 动态 import 失败

若控制台出现 `GET .../chunk-xxx.js 404` 或 `Failed to fetch dynamically imported module`（例如加载 FullEditorV2Enhanced 失败），多为 **Vite 依赖缓存过期** 导致：

1. **停止** 前端 dev 服务（Ctrl+C）。
2. **一键清理并启动**：`cd frontend/desktop && pnpm run dev:fresh`（会先删除 `node_modules/.vite` 再启动 Vite）。  
   Windows 下若 `dev:fresh` 报错，可先手动删除 `frontend/desktop/node_modules/.vite` 文件夹，再执行 `pnpm run dev`。
3. **浏览器硬刷新**：Ctrl+Shift+R（Windows/Linux）或 Cmd+Shift+R（macOS），或清除 localhost:3000 的站点数据后刷新。

App 内对主编辑器的懒加载已做一次失败重试，若仍报错请按上述步骤执行 `dev:fresh` 并硬刷新。

## 5.2 前端崩溃：`Cannot read properties of undefined (reading 'map')` 或 `useSessionContext must be used within SessionContextProvider`

- **原因**：多来自 `@assistant-ui/react-langgraph` 消息转换时 `content`/`message` 为 undefined，或会话上下文未就绪时渲染 Thread。
- **已做加固**：对 `convertLangChainMessages` 做了 patch（`patches/@assistant-ui+react-langgraph+0.7.15.patch`），并对 Thread 外层加了 ErrorBoundary；主进程未捕获异常后会延迟约 5 秒再退出，便于查看崩溃弹窗与日志路径。
- **若仍出现**：
  1. 确认依赖与 patch 已应用：`cd frontend/desktop && pnpm install`（会执行 `patch-package`）。
  2. 清理 Vite 预打包缓存后重启：删除 `frontend/desktop/node_modules/.vite`，再执行 `pnpm run dev` 或 `pnpm run dev:fresh`，使 Vite 从已 patch 的 node_modules 重新预打包。
  3. 崩溃日志位置：Electron 主进程/渲染进程错误会写入 **用户数据目录** 下的 `crash-log.txt`；前端错误会 POST 到后端并写入 **`.cursor/logs/frontend-error-YYYY-MM-DD.log`**，可根据 `thread_id`、`stack` 定位。

## 6. 与 E2E 的配合

- 后端 35B 对话 E2E：`make e2e-chat-35b` 或 `make e2e-chat-35b-tool`（见 [E2E_FUNCTIONAL_TEST_PLAN.md](./E2E_FUNCTIONAL_TEST_PLAN.md)）。
- 前端 UI 的自动化 E2E（如 Playwright）可按需在项目中接入；当前以人工按 §3 自测 + 控制台/`__DEV_ERRORS__` 排查为主。
