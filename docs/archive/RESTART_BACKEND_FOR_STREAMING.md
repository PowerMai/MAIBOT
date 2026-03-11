# 重启后端以启用流式输出

## 修改内容

已在 `backend/engine/agent/deep_agent.py` 中启用 LLM 流式输出：

```python
llm = ChatOpenAI(
    model=model_name,
    base_url=OrchestratorConfig.MODEL_URL,
    api_key="sk-no-key",
    temperature=OrchestratorConfig.TEMPERATURE,
    max_tokens=OrchestratorConfig.MAX_TOKENS,
    timeout=OrchestratorConfig.TIMEOUT,
    streaming=True,  # ✅ 启用流式输出（LangChain 官方标准）
)
```

## 重启步骤

### 方法 1：在运行后端的终端中重启

1. 找到运行 `langgraph dev` 的终端
2. 按 `Ctrl+C` 停止后端
3. 重新启动：
   ```bash
   cd /Users/workspace/DevelopProjects/ccb-v0.378
   source .venv/bin/activate
   langgraph dev --port 2024 --host 0.0.0.0
   ```

### 方法 2：使用命令行重启

```bash
# 1. 查找并停止后端进程
ps aux | grep "langgraph dev"
# 找到 PID，然后：
kill <PID>

# 2. 重新启动后端
cd /Users/workspace/DevelopProjects/ccb-v0.378
source .venv/bin/activate
langgraph dev --port 2024 --host 0.0.0.0
```

## 验证流式输出

重启后，运行测试脚本验证流式输出是否正常：

```bash
cd /Users/workspace/DevelopProjects/ccb-v0.378
source .venv/bin/activate
python backend/test_streaming.py
```

**预期结果**：
- 应该看到消息逐字符流式显示（而不是一次性显示）
- 消息片段数应该 > 0
- 控制台应显示 "✅ 流式输出正常！"

## 测试前端

后端重启并验证流式输出正常后：

1. **刷新前端页面**（强制刷新：`Cmd+Shift+R`）
2. **发送测试消息**："请用100个字介绍一下 Python"
3. **观察效果**：
   - ✅ 消息应该逐字符流式显示（打字机效果）
   - ✅ `<think>` 标签应该被过滤
   - ✅ 生成式 UI 应该正确渲染

## 故障排除

### 问题：仍然没有流式输出

**检查**：
1. 后端是否已重启
2. 运行 `test_streaming.py` 验证后端流式输出
3. 前端是否已刷新（强制刷新）
4. 浏览器控制台是否有错误

**解决**：
```bash
# 确保后端完全停止
pkill -f "langgraph dev"

# 重新启动
cd /Users/workspace/DevelopProjects/ccb-v0.378
source .venv/bin/activate
langgraph dev --port 2024 --host 0.0.0.0
```

### 问题：LM Studio 模型不支持流式输出

某些模型可能不支持流式输出。尝试切换到支持的模型：
- DeepSeek R1
- Mistral
- Qwen

在 LM Studio 中加载模型后，重启后端即可自动检测。

## 技术说明

### 为什么需要 `streaming=True`？

LangChain 的 `ChatOpenAI` 默认不启用流式输出。需要显式设置 `streaming=True` 才能：

1. **逐 token 生成**：LLM 每生成一个 token 就立即返回
2. **LangGraph 流式传输**：LangGraph Server 可以将这些增量更新传递给前端
3. **前端实时显示**：`assistant-ui` 接收增量更新并实时渲染

### 流式输出的完整链路

```
LLM (streaming=True)
  ↓ 逐 token 生成
DeepAgent Graph
  ↓ 传递增量更新
LangGraph Server (streamMode: "messages")
  ↓ SSE/WebSocket
前端 assistant-ui
  ↓ 实时渲染
用户看到打字机效果
```

### 符合 LangChain 官方标准

✅ **后端**：`ChatOpenAI(streaming=True)`  
✅ **LangGraph**：`streamMode: "messages"`  
✅ **前端**：`useLangGraphRuntime` + `assistant-ui`

这是 LangChain 官方推荐的完整流式输出实现方式。

