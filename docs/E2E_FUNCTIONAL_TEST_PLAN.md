# 端到端功能测试计划

用于验证：用户输入 → 整条业务链正常处理、聊天面板正常显示、工具正常调用、文档在编辑区可显示与编辑。建议使用**云端 35B 模型**（性能最好）进行验证。

---

## 1. 前置条件

### 1.1 环境

- 后端：LangGraph Server（`langgraph dev`），默认 `http://127.0.0.1:2024`
- 前端：Vite 开发或 Electron，默认 `http://localhost:3000`（浏览器）或 Electron 窗口
- 云端 35B：需配置 `CLOUD_QWEN_API_KEY` 且 `backend/config/models.json` 中 `cloud/qwen3.5-35b-a3b` 已启用；或通过设置页「云端端点」动态发现

### 1.2 使用云端 35B 进行测试

1. **设置 API Key**（二选一）：
   - 环境变量：`export CLOUD_QWEN_API_KEY=sk-你的Key`
   - 或在设置 → 通用 → 云端端点中配置
2. **选择模型**：在聊天界面或设置中将主模型选为「云 35B」（`cloud/qwen3.5-35b-a3b`）
3. 首次使用云端模型时，前端会弹出确认；确认后该模型会加入已同意列表

### 1.3 启动服务

```bash
# 项目根目录
./scripts/start.sh dev
```

或分别启动：

```bash
# 终端 1：后端（backend 目录或项目根，需激活 backend/.venv）
cd backend && langgraph dev --config ../langgraph.json --port 2024 --no-browser --allow-blocking --no-reload

# 终端 2：前端
cd frontend/desktop && pnpm run dev
```

验证：

- 后端：`curl -s http://127.0.0.1:2024/health` 或 `/ok` 返回正常
- 前端：浏览器打开 `http://localhost:3000` 或启动 Electron

### 1.4 首条请求建议

start.sh 启动后，后端需数秒就绪。若**立刻**发首条消息，可能因后端尚未就绪而失败（健康检查或创建线程超时）。建议等状态栏显示「已连接」或启动后等待几秒再发首条；错误时会通过 toast 提示「后端服务不可用…」。

错误码与排查、权限（license）配置见 [ERROR_CODES_AND_TROUBLESHOOTING.md](./ERROR_CODES_AND_TROUBLESHOOTING.md)。

**构建与主题**：`pnpm build` 以 `frontend/desktop/index.html` 为模板生成 `dist/index.html`，首屏主题脚本与源码一致，打包后首屏白/黑行为与开发环境一致。

---

## 2. 测试范围

| 类别           | 项 | 验证点 |
|----------------|----|--------|
| 聊天链路       | 2.1 | 用户输入 → 后端处理 → 流式回复在聊天面板展示 |
| 会话/角色/模式 | 2.2 | 会话切换、角色切换、模式切换后状态正确，session_context 与 EVENTS 一致 |
| 工具调用       | 2.3 | Agent 发起工具调用，前端展示工具名/参数/结果，无报错 |
| 文档与编辑区   | 2.4 | 打开/创建文件在编辑区显示，可编辑；editor_path/editor_content 正确传后端 |
| 模型与配置     | 2.5 | 使用云端 35B 时请求走对应 URL，回复质量与稳定性可接受 |

---

## 3. 详细用例

### 3.1 聊天链路（必测）

- **步骤**：
  1. 打开应用，确认当前模型为「云 35B」（或本地 35B/9B）
  2. 在输入框输入：`你好，请用一句话介绍你自己。`
  3. 发送
- **预期**：
  - 请求发往后端（可看 Network 或后端日志）
  - 回复以流式形式在聊天面板逐字/逐段出现
  - 无 `ERR_CONNECTION_REFUSED`、无 4xx/5xx 未处理报错
  - 若有 session_context，前端应更新当前 thread/mode/role 显示

### 3.1.1 运行状态与步骤展示（Cursor 对齐）

运行中或完成时，聊天区展示应与 Cursor 一致，便于回归与对齐。逐项对比见 [cursor_alignment_checklist.md](cursor_alignment_checklist.md)。

- **步骤进度**：消息内至多一处步骤进度展示（仅时间线或仅单行步骤条，不同时出现两种）。
- **思考展示**：至多一处「思考」相关展示（思考块或思考步骤项），不与多处「思考中」文案重复。
- **中断/确认**：人工确认、输入要求等中断在聊天区 footer 内联展示，无弹窗。
- **idle 状态**：run 结束后 Footer 不显示「执行中」或步骤条；状态行仅在实际 run 进行且存在步骤或 todo 时显示（与 Cursor 一致：无 steps/todos 时不显示空条）。
- **云端思考流**：使用云端推理模型（如 cloud/qwen3.5-35b-a3b）发送需多步推理的问题时，确认思考块与正文按时间顺序展示，与 Cursor 一致（不区分云端/本地）。

### 3.2 会话 / 角色 / 模式

- **步骤**：
  1. 新建会话，发一条消息，确认有回复
  2. 切换角色（如从默认到「知识管理师」），再发一条消息
  3. 切换模式（如 Agent → Ask），再发一条消息
  4. 切回原会话，确认历史与当前角色/模式正确
- **预期**：
  - 会话键优先：当前会话的角色/模式与展示一致
  - 切换后新消息使用的 role_id、mode 与选择一致（可结合后端 configurable 日志核对）

### 3.3 工具调用（必测）

- **步骤**：
  1. 输入会触发工具的任务，例如：
     - `列出当前工作区根目录下的文件和文件夹`
     - `用 python 计算 1 到 10 的和并告诉我结果`
  2. 发送并等待完成
- **预期**：
  - 聊天中能看到工具调用展示（工具名、参数或结果摘要）
  - RunTracker/工具卡片 等 UI 能展示进度或结果
  - 后端无未捕获异常，前端无红框/控制台工具相关报错
  - 若为「列出目录」：回复中应包含目录列表或说明

### 3.4 文档与编辑区

- **步骤**：
  1. 在编辑区打开或新建一个文本文件（如 `test_e2e.md`）
  2. 在聊天中输入：`请读取当前打开的文件，总结前 3 行内容。`
  3. 发送
  4. 再输入：`在刚才的文件末尾追加一行：E2E test passed.`
  5. 发送并等待完成
- **预期**：
  - 后端能拿到正确的 `editor_path`、`editor_content`（或 workspace_path）
  - 回复中的总结与文件前几行一致
  - 文件末尾出现 `E2E test passed.`，编辑区内容与磁盘一致

### 3.5 云端 35B 专项

- **步骤**：
  1. 设置 → 模型选择「云 35B」，保存
  2. 发一条需简单推理的消息，如：`从 1 到 5 中选两个数相乘，得到最大值是多少？请简要说明。`
  3. 观察回复与延迟
- **预期**：
  - 请求的 model 为 `cloud/qwen3.5-35b-a3b`（或端点返回的 id）
  - 回复正确（答案为 20，选 4 和 5）
  - 无「资源包不支持该模型」等错误；若曾配置过云端确认，不再重复弹窗

---

## 4. 契约与回归参考

- 后端入口、configurable、session_context、EVENTS：见 [INTEGRATION_CONTRACTS.md](INTEGRATION_CONTRACTS.md)
- 前端 Base URL、Assistant ID：见 `frontend/desktop/src/lib/api/langserveChat.ts`
- 模型列表与云端端点：`backend/config/models.json`、[cloud_model_config.md](cloud_model_config.md)

---

## 5. 快速检查清单（发布前）

- [ ] 后端 `curl http://127.0.0.1:2024/health` 正常
- [ ] 前端可打开，无白屏/控制台阻塞错误
- [ ] 使用「云 35B」发一条简单对话，有流式回复
- [ ] 至少一次工具调用（如列目录、python 计算）在 UI 可见且无报错
- [ ] 打开一个文件后，对话中能引用该文件并完成一次编辑

完成以上即视为端到端功能测试通过；若发现问题，请记录复现步骤与日志（后端日志、浏览器 Network/Console）便于排查。

---

## 6. 自动化烟雾测试（可选）

**6.1 E2E 烟雾（需先启动后端）**

后端已启动时（如 `./scripts/start.sh dev` 或单独启动 langgraph dev），可跑：

```bash
# 项目根目录
make e2e-smoke
```

或校验「云 35B」在列表中且可用：

```bash
backend/.venv/bin/python -m backend.scripts.e2e_smoke --require-cloud35
```

脚本会请求 `/health`、`/models/list`，通过后再进行人工端到端测试。

**6.2 前后端契约测试（不依赖后端进程）**

使用 TestClient 直连 app，无需真实 HTTP 服务：

```bash
make test-frontend-backend-integration
```

或：

```bash
backend/.venv/bin/python backend/scripts/test_frontend_backend_integration.py
```

该脚本会请求 `/health`、`/models/list`、`/board/tasks`、`/roles/list` 等，与前端使用的接口一致。

---

## 7. 浏览器接管 UI 验证（Cursor 风格）

通过浏览器自动化（如 MCP cursor-ide-browser）接管 UI 进行验证时，可按下述步骤操作，并核对**思考过程**、**流式输出**、**多会话**与 **UI 显示**是否符合 Cursor 业务逻辑与样式。

### 7.1 环境与入口

- 前端已启动：`http://localhost:3000`（Vite 开发）或 Electron 窗口
- 后端已启动：`http://127.0.0.1:2024`
- 可选：主模型选为「云 35B」以验证云端链路

### 7.2 真实用户输入流程（推荐用于验证多次输入与返回正确性）

按**真实用户**操作顺序执行，可复现「多次输入后不响应」等行为：

1. **导航**：`browser_navigate` 到 `http://localhost:3000`，`browser_wait_for` 2–3 秒待页面稳定。
2. **第一次输入**：`browser_fill` 在「消息输入」输入框填入**真实用户文案**（如：`你好，请只回复数字 1`），再点击「发送消息」。
3. **等待首条结束**：`browser_wait_for` 或轮询 `browser_snapshot`，直到工作区出现「最近运行 ： 已结束」或对话区出现完整 AI 回复（不要在上一条仍「思考中」时发下一条）。
4. **校验首条返回**：快照或断言中确认 AI 回复与问题匹配（例如要求「只回复数字 1」时，回复内容应包含数字 1）。
5. **第二次输入**：再次 `browser_fill` 输入框（如：`请再回复数字 2`），点击「发送消息」。
6. **验证多次输入**：确认第二条用户消息出现在对话区且产生第二条 AI 回复；若「发送消息」在运行中为禁用或变为「加入队列」，需等运行结束或收到 `stream_paused`/`run_error` 后再发，否则会表现为「多次输入后不响应」。

### 7.3 操作步骤（自动化脚本可复用）

1. **导航**：`browser_navigate` 到 `http://localhost:3000`
2. **快照**：`browser_snapshot` 获取可交互 ref（如 `消息输入` textbox、`发送消息` / `加入队列` 按钮、`运行摘要`、`模式：Agent`、模型按钮）
3. **输入**：对消息输入框使用 `browser_fill`（推荐）或 `browser_type`。若组件不更新 value，用 `browser_fill` 可保证内容写入后再发送
4. **发送**：点击「发送消息」或「加入队列（当前任务结束后自动发送）」按钮
5. **验证**：
   - 对话区出现用户消息气泡
   - 出现 **思考** 列表项或「思考中 Ns」「正在响应...」等流式状态
   - 出现「运行摘要」且状态为「已结束」或「AI 运行摘要可用」
   - 可点击「运行摘要」查看工具/步骤；可点击「思考」展开思考内容
6. **多会话**：点击「新建对话」创建新会话；若被其他元素遮挡，可先点击「对话区」再点「新建对话」，或从「历史对话」中切换会话后在新会话中发送消息

### 7.4 验证要点（与 Cursor 业务逻辑对齐）

| 项 | 预期 |
|----|------|
| 思考过程 | 聊天中可见「思考」折叠块或「思考中 Ns」；支持流式展开、完成后可折叠 |
| 流式输出 | 回复逐字/逐段出现；RunTracker/运行摘要可展示步骤与工具调用 |
| 多会话同时操作 | 会话列表可切换；新建对话后在新会话发消息，状态与历史互不串线 |
| UI 显示 | 消息气泡、模式/模型选择器、状态「已连接」/「已结束」、责任泳道/可继续任务等与设计一致 |
| 工具调用 | 工具名/参数/结果在运行摘要或消息区可见，无未捕获报错 |

### 7.5 已通过浏览器验证项（示例）

- 对话区展示用户消息与 **思考** listitem
- 工作区显示「最近运行 ： 已结束」「运行摘要」「状态：AI 运行摘要可用」
- 模型选择器显示「qwen3.5-35b-a3b」
- 输入框使用 `browser_fill` 后出现「发送消息」或「加入队列」按钮并可点击发送
- 截图可见「思考中 66s」「正在响应...」、任务等待提示、Agent/模型等 Cursor 风格元素

### 7.6 常见问题

- **是否使用云端 35B**：在聊天区或设置中将主模型选为「云 35B」或 `qwen3.5-35b-a3b` 即会使用；模型选择器与运行摘要中会显示当前模型 id。
- **响应慢**：云端 35B 依赖 `CLOUD_QWEN_API_KEY` 与端点（如 `http://39.170.37.25:63000/v1`），延迟受网络与端点负载影响；思考链较长时首 token 会更晚。
- **第二次输入不处理**：若 run 在 Plan 确认或 human_checkpoint 处暂停，后端会发送 `stream_paused`，前端会退出流循环并清除 `isStreamingRef`，即可再次发送；若仍无法发送，请检查是否未收到 `stream_paused` 或控制台是否有报错。
- **聊天面板重复/混乱**：前端仅使用单一消息通道（custom 或 SDK 二选一）；思考内容仅展示一块（原生 reasoning 或 <think> 内联，不重复）。若仍见重复，请提供截图与复现步骤。
- **首屏黑屏/白屏不一致**：首屏主题由 `index.html` 内联脚本与 App 共同保证，统一读取 `maibot_settings_darkMode`（兼容 `ccb_settings_darkMode`）。若仍出现随机黑/白，请确认未在其他处写入冲突的 storage key，或通过设置页切换一次深色/浅色后刷新验证。
- **Agent 自测**：建议由 Agent 使用浏览器 MCP 对 `http://localhost:3000` 进行 E2E 自测（导航 → 快照 → 填表 → 发送 → 断言），可获取完整运行状态；能力说明见 [AGENT_E2E_CAPABILITIES.md](./AGENT_E2E_CAPABILITIES.md)。
- **返回信息正确性**：测试时用明确指令（如「请只回复数字 1」），在快照或断言中检查 AI 回复是否包含预期内容；若回复与问题无关或为空，需查后端日志与 Network 是否 4xx/5xx 或 run_error。
- **多次输入后不响应**：运行中「发送消息」会禁用或变为「加入队列」；必须等当前 run 结束（状态「已结束」）或收到 `stream_paused`/`run_error` 后，前端才会清除 `isStreamingRef` 并恢复发送。若 run 未正常结束（如后端挂起、未发 run_error），会出现「第二次输入不处理」；已修复 run_error 时 break 并清 isStreamingRef。
- **权限/自动化等级**：若提示「当前权限级别限制无法写入文件」，多为 Cursor Agent 自主级别为 L1；可尝试在设置中将自主级别提升至 L2/L3，或切换到 Plan 模式由 Agent 输出变更内容供人工确认后写入。
