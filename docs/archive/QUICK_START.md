# 🚀 CCBAgent LangServe后端快速启动

## 1️⃣ 启动后端

```bash
cd /Users/workspace/DevelopProjects/ccb-v0.378
source .venv/bin/activate
python -m uvicorn backend.gateway.langserve_app:app --host 0.0.0.0 --port 8000
```

预期输出：
```
INFO:     Uvicorn running on http://0.0.0.0:8000
✅ 应用启动完成
```

## 2️⃣ 验证后端健康状态

```bash
curl http://localhost:8000/health | python -m json.tool
```

预期返回：
```json
{
    "status": "healthy",
    "agent_ready": true
}
```

## 3️⃣ 查看系统状态

```bash
curl http://localhost:8000/status | python -m json.tool
```

预期返回系统状态和可用端点列表。

## 4️⃣ 访问Swagger文档

打开浏览器访问：
```
http://localhost:8000/docs
```

可以在此交互式测试所有API端点。

## 5️⃣ 启动LLM服务（必需）

在**另一个终端**启动LM Studio：

```bash
# macOS (使用Homebrew安装后)
lm-studio

# 或者直接启动本地服务器模式
lm-studio --skip-auto-open
```

确保LLM服务运行在：`http://localhost:1234/v1`

## 6️⃣ 测试流式调用

```bash
# 测试同步调用
curl -X POST http://localhost:8000/agent/invoke \
  -H "Content-Type: application/json" \
  -d '{
    "input": {"messages": [{"type": "human", "content": "你好"}]},
    "config": {}
  }'
```

## 📊 后端架构

```
┌─ FastAPI App ─────────────────────┐
│                                   │
│  LangServe add_routes()           │
│  ├─ /agent/invoke  (同步)         │
│  ├─ /agent/stream  (流式SSE)      │
│  ├─ /agent/batch   (批量)         │
│  └─ /agent/playground (测试UI)    │
│                                   │
│  DeepAgent                        │
│  ├─ Orchestrator (主调度)         │
│  └─ Sub-Agents (文档处理)         │
│                                   │
│  Memory System                    │
│  ├─ Checkpointer (MemorySaver)    │
│  └─ Store (InMemoryStore)         │
└───────────────────────────────────┘
```

## ✨ 核心特性

- ✅ **LangServe官方流式** - 使用官方SSE实现
- ✅ **DeepAgent集成** - 完整的文档处理能力
- ✅ **会话管理** - 支持多轮对话
- ✅ **异步接口** - 完整的async/await支持
- ✅ **生产级代码** - 零重复实现

## 🔗 相关文档

- [LANGSERVE_SUCCESS_SUMMARY.md](./LANGSERVE_SUCCESS_SUMMARY.md) - 详细成就总结
- [backend/gateway/langserve_app.py](./backend/gateway/langserve_app.py) - 后端源代码
- [backend/engine/core/main_agent.py](./backend/engine/core/main_agent.py) - Agent配置

## ⚠️ 常见问题

### Q: 502错误？
**A:** LLM服务未启动。请先启动LM Studio或配置OpenAI API密钥。

### Q: 如何关闭后端？
**A:** 按 `Ctrl+C` 或在终端中执行：
```bash
pkill -f "uvicorn backend.gateway.langserve_app"
```

### Q: 如何查看详细日志？
**A:** 后端会自动打印所有调用日志。使用LANGCHAIN_DEBUG获取更多细节：
```bash
LANGCHAIN_DEBUG=1 python -m uvicorn backend.gateway.langserve_app:app --port 8000
```

## 🎉 下一步

完成后端启动后：
1. 集成前端（frontend/desktop）
2. 运行完整系统测试
3. 配置生产环境部署

