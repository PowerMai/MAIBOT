# 🔄 重启后端以应用模型修复

## ✅ 已完成的修复

已修改 `backend/engine/agent/deep_agent.py` 中的模型选择逻辑：
- **之前**: 优先选择包含 "gpt" 的模型 → 选择了有问题的 `gpt-oss-20b`
- **现在**: 优先选择 `deepseek` 或 `mistral` 模型 → 将选择 `deepseek/deepseek-r1-0528-qwen3-8b` 或 `mistralai/ministral-3-14b-reasoning`

## 🔄 重启步骤

### 方法1: 停止并重启后端进程

```bash
# 1. 停止当前后端进程
pkill -f "langgraph.*2024"

# 2. 等待几秒
sleep 2

# 3. 重新启动后端
cd /Users/workspace/DevelopProjects/ccb-v0.378
source .venv/bin/activate
langgraph dev --port 2024 --host 0.0.0.0
```

### 方法2: 如果使用后台运行

```bash
# 1. 查找进程ID
ps aux | grep langgraph | grep 2024

# 2. 停止进程（替换 PID）
kill <PID>

# 3. 重新启动
cd /Users/workspace/DevelopProjects/ccb-v0.378
source .venv/bin/activate
langgraph dev --port 2024 --host 0.0.0.0 > /tmp/langgraph.log 2>&1 &
```

## ✅ 验证修复

重启后，检查后端日志，应该看到：

```
✅ 自动检测到可用模型: ['deepseek/deepseek-r1-0528-qwen3-8b', 'mistralai/ministral-3-14b-reasoning', ...]
✅ 选择最合适的模型: deepseek/deepseek-r1-0528-qwen3-8b
✅ LLM 已配置: deepseek/deepseek-r1-0528-qwen3-8b @ http://localhost:1234/v1
```

## 🧪 测试

重启后端后：
1. **刷新前端页面**
2. **发送测试消息**（例如："你好"）
3. **检查是否正常工作**：
   - ✅ 没有 400 错误
   - ✅ 收到 AI 回复
   - ✅ 流式输出正常

---

*更新时间: 2024-12-19*


