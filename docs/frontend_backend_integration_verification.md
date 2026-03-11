# 前后端联调验证说明

## 一、自动化契约测试（无需启动服务）

用 TestClient 调用前端实际使用的后端接口，校验状态码与响应结构。

```bash
# 项目根目录执行
make test-frontend-backend-integration
```

覆盖接口（13 项）：

| 接口 | 前端用途 |
|------|----------|
| GET /health | 健康检查、连接状态横幅 |
| GET /board/tasks | 看板任务列表、工作区仪表盘 |
| GET /models/list | 模型列表、设置页、Composer 模型选择 |
| GET /config/list | 工作区配置、工作区路径 |
| GET /roles/list | 角色列表、角色切换、能力摘要 |
| GET /agent/profile | Agent 档案、看板能力 |
| GET /skills/profiles | Skills 按场景加载、技能配置 |
| GET /skills/list | Skills 管理页、技能列表 |
| GET /files/list | 已上传文件列表 |
| GET /modes/descriptions | 模式描述、模式切换 UI |
| GET /autonomous/schedule-state | 自治任务调度状态 |
| GET /knowledge/structure | 知识库结构、知识库页 |
| GET /board/metrics/reliability | 可靠性指标、看板/仪表盘 |

## 二、完整联调流程（前后端同时运行）

### 1. 启动后端

```bash
# 方式一：uv（若项目使用 uv）
uv run fastapi dev backend/api/app.py

# 方式二：项目既定启动脚本（如 scripts/start.sh）
# 确保后端监听端口与前端配置一致（默认 2024）
```

### 2. 启动前端

```bash
cd frontend/desktop && pnpm run dev
```

前端默认请求 `http://127.0.0.1:2024`（或设置/注入的 `VITE_LANGGRAPH_API_URL`）。

### 3. UI 功能验证清单

在浏览器中逐项确认以下功能与后端一致。

#### 连接与健康

- [ ] 页面加载后连接状态正常（无“连接失败”横幅或连接恢复后横幅消失）
- [ ] 设置页可修改 API Base URL，修改后健康检查使用新地址

#### 会话与模式

- [ ] 切换会话后，当前角色、模式按会话正确展示（状态栏/欢迎卡/Composer）
- [ ] 切换模式（Agent/Plan/Ask/Debug/Review）后，发送按钮样式与模式一致
- [ ] 新建会话继承上一会话的角色与模式

#### 聊天与运行

- [ ] 发送消息后流式输出正常，运行状态栏显示“运行中”
- [ ] 运行中点击停止可中断；运行结束后状态栏恢复
- [ ] 运行中有输入时显示“排队发送”，发送后消息入队并 toasts 提示；运行结束后队首自动发送
- [ ] 状态栏展示“队列 N”（当 N>0 时）

#### 看板与任务

- [ ] 工作区仪表盘/看板可打开，任务列表与 GET /board/tasks 一致
- [ ] 任务详情可查看（状态、人审检查点、交付物等）
- [ ] 创建任务、更新状态、人审通过/驳回等操作与后端一致

#### 角色与技能

- [ ] 角色列表与 GET /roles/list 一致，切换角色后能力摘要更新
- [ ] Skills 管理页可列出/安装/更新技能，与 /skills/* 一致

#### 知识库

- [ ] 知识库页可打开，结构树与 GET /knowledge/structure 一致
- [ ] 文档上传、刷新、搜索等与 /knowledge/* 一致

#### 模型与配置

- [ ] 设置页模型列表与 GET /models/list 一致，切换模型生效
- [ ] 工作区配置（config/list、config/read、config/write）读写正常

#### 其他

- [ ] 已上传文件列表与 GET /files/list 一致
- [ ] 自治任务/调度状态展示与 /autonomous/schedule-state 一致（若 UI 有入口）
- [ ] 可靠性指标与 GET /board/metrics/reliability 一致（若仪表盘展示）

## 三、推荐验证顺序

1. **先跑契约测试**：`make test-frontend-backend-integration`，确认后端接口与前端预期一致。
2. **再跑后端核心与快速回归**：`make test-backend-core-regression && make test-quick`。
3. **最后启动前后端做 UI 联调**：按第二节启动，按清单逐项勾选。

## 四、常见问题

### 「一个可用的模型都没有」/ 0 个模型可用

- **原因**：后端未发现任何可用模型（未配置或本地/云端服务未启动）。
- **处理**：
  1. **本地**：安装并启动 [Ollama](https://ollama.com) 或 [LM Studio](https://lmstudio.ai)，在设置页确认模型服务地址正确并点击「刷新」。
  2. **云端**：在设置页「云端端点」添加 OpenAI 兼容的 Base URL 与 API Key，保存后刷新模型列表。
  3. 后端模型配置位于 `backend/.env` 或 `backend/config/`，可参考项目文档配置 `OPENAI_API_BASE`、`LM_STUDIO_BASE` 等。

### 控制台警告是否要处理？

| 警告 | 建议 |
|------|------|
| **Electron preload script loaded** / **Vite connecting/connected** | 开发环境正常日志，无需处理。 |
| **React DevTools** | 可选安装浏览器扩展以调试 React，不处理不影响功能。 |
| **Electron Security Warning (Insecure Content-Security-Policy)** | 开发模式下常见；打包后不会出现。若需加固生产包，可在 Electron 主进程为生产构建配置更严格的 CSP（禁用 `unsafe-eval` 等）。 |
| **[Violation] Forced reflow** | 性能提示：某段 JS 触发了强制布局。若界面无明显卡顿可暂不处理；若需优化，可用 React DevTools Profiler 或 Chrome Performance 定位触发 reflow 的代码并改为批量读/写 DOM。 |

## 五、相关命令汇总

| 命令 | 说明 |
|------|------|
| `make test-frontend-backend-integration` | 前后端 API 契约测试（13 项） |
| `make test-backend-core-regression` | 后端核心 pytest 回归 |
| `make test-quick` | 后端快速系统改进验证 |
| `make test-single-agent-api` | 单 Agent API 验收（任务/人审/artifacts） |
| `pnpm --dir frontend/desktop test:run` | 前端单元测试 |
| `pnpm --dir frontend/desktop check:session-state` | 前端会话状态契约检查 |
