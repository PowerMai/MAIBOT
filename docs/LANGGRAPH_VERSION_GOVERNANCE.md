# LangGraph 版本治理与升级回归清单

## 目标

- 解决 `langgraph-api` 处于 EOL 版本带来的兼容性和安全维护风险。
- 保证升级前后核心链路行为一致：会话、流式输出、工具调用、看板任务、模型切换。

## 升级原则

- 采用“成组升级”，避免单包半升级：
  - `langgraph-api`
  - `langgraph-cli[inmem]`
  - `langgraph-runtime-inmem`
  - `langgraph-sdk`
- 升级后统一执行最小回归集，未通过则回滚 lockfile。

## 执行步骤

1. 进入后端目录并激活环境：

```bash
cd backend
source .venv/bin/activate
```

2. 记录当前版本基线：

```bash
python -m pip show langgraph-api langgraph-cli langgraph-runtime-inmem langgraph-sdk
```

3. 成组升级并更新锁文件：

```bash
uv add -U "langgraph-cli[inmem]" langgraph-api langgraph-runtime-inmem langgraph-sdk
uv sync
```

4. 启动后端并执行回归：

```bash
bash scripts/start.sh backend
```

## 最小回归清单

- `/health` 可用且响应正常。
- `/board/tasks` create/list/patch/progress/human-review 均可执行，异常输入返回 4xx 而非 500。
- 前端发送消息可正常流式返回。
- 模型切换 `auto` 与指定模型可用，`supports_images` 行为与 UI 展示一致。
- 关键命令：`/status`、`/skills`、`/memory` 不回归。

## 回滚条件

- 任一 P0 链路失败（无法对话、看板创建失败、连续 500）。
- 触发不可接受的性能退化（请求显著超时或阻塞）。

## 回滚方式

```bash
git checkout -- backend/uv.lock backend/pyproject.toml
uv sync
bash scripts/start.sh restart
```

