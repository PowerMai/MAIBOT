# Agent 端到端与调试能力说明

本文档描述 Cursor Agent 在本项目中可执行的端到端（E2E）测试与调试能力，便于自动化或人工复现时对齐预期。

---

## 1. 能力概览

| 能力 | 说明 |
|------|------|
| **E2E 烟雾测试** | 通过 `make e2e-smoke` 或 `python -m backend.scripts.e2e_smoke` 校验后端健康与模型列表，可选 `--require-cloud35` 校验云 35B。 |
| **浏览器接管 UI** | 使用 MCP `cursor-ide-browser`：`browser_navigate` → `browser_snapshot` → `browser_fill`/`browser_click` 等，对 `http://localhost:3000` 进行真实交互验证。 |
| **流式与错误调试** | 前端在 `MyRuntimeProvider.tsx` 中针对 `stream_paused`、`run_error` 等事件做 break 并清除 `isStreamingRef`，确保错误/中断后可再次发送；可选通过 ingest 端点或控制台日志追踪流状态。 |
| **首屏主题一致** | `index.html` 内联脚本与 App 统一使用 `maibot_settings_darkMode`（兼容 `ccb_settings_darkMode`），首屏即应用深色/浅色，避免黑屏或白屏不一致。 |

---

## 2. 建议的 E2E 自测流程

1. **启动**：后端 `./scripts/start.sh dev`（或分别启动 backend + frontend）。
2. **烟雾**：`make e2e-smoke`，可选 `--require-cloud35`。
3. **浏览器**：导航至 `http://localhost:3000`，快照后对聊天输入框执行 `browser_fill`，点击发送，验证思考/流式/运行摘要/多会话。
4. **错误路径**：在易触发 502 或 run_error 的环境下发送一条消息，确认出现错误提示后仍可再次发送（第二次输入可处理）。
5. **主题**：在设置中切换深色/浅色并刷新，确认首屏颜色与设置一致（无随机黑/白屏）。

详细步骤与检查点见 [E2E_FUNCTIONAL_TEST_PLAN.md](./E2E_FUNCTIONAL_TEST_PLAN.md)。

---

## 3. 运行状态信息获取

- **后端**：健康 `/health`、模型 `/models/list`、运行日志由 LangGraph Server 输出。
- **前端**：开发模式下控制台可见 `[E2E_DEBUG]`、`[MyRuntimeProvider]` 等日志；可选将调试日志 POST 到配置的 ingest 端点并落盘为 NDJSON，便于分析流进入/暂停/结束与 run_error 分支。
- **浏览器自动化**：`browser_snapshot` 可获取当前 DOM 与可交互元素 ref，用于断言 UI 状态（如按钮可用、运行摘要文案、模型名称等）。

通过上述能力，Agent 可在不依赖人工截图的前提下进行端到端调试并获取完整运行状态信息。

---

## 4. 真实用户输入与多次发送

- **推荐流程**：完全按用户真实输入方式测试：在输入框填写内容 → 发送 → 等待「最近运行 ： 已结束」→ 再填写第二条 → 再发送；并校验每条 AI 回复与问题是否匹配（如要求「只回复数字 1」则回复应含 1）。
- **多次输入**：运行中发送会禁用或变为「加入队列」；等 run 结束或 stream_paused/run_error 后才会恢复。若遇「多次输入后不响应」，确认是否在 run 未结束时点击发送，或后端未正确发送 run_error/stream_paused。

---

## 5. 权限与自动化等级

- 若 Cursor 提示「当前权限级别限制无法写入文件」，通常为自主级别 L1；可提升至 L2/L3 或使用 Plan 模式，由 Agent 输出变更内容供人工确认后写入。
- 浏览器 E2E（只读快照 + 填表/点击）不依赖写文件权限，Agent 在任意级别均可执行以获取完整运行状态。
