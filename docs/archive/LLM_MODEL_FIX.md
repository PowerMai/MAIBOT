# LLM 模型错误修复指南

## 🔴 问题

后端日志显示错误：
```
openai.BadRequestError: Error code: 400 - {'error': 'Error in iterating prediction stream: NotImplementedError: RotatingKVCache Quantization NYI'}
```

**原因**: 当前选择的模型 `openai/gpt-oss-20b` 不支持某些功能（RotatingKVCache Quantization）

## ✅ 解决方案

### 方案1: 在 LM Studio 中切换模型（推荐）

1. **打开 LM Studio**
2. **切换到其他模型**，例如：
   - `deepseek/deepseek-r1-0528-qwen3-8b` ✅
   - `mistralai/ministral-3-14b-reasoning` ✅
3. **重启后端**（如果模型已切换，后端会自动检测新模型）

### 方案2: 通过环境变量指定模型

在 `backend/.env` 文件中添加：

```bash
# 指定使用 deepseek 模型
LM_STUDIO_MODEL=deepseek/deepseek-r1-0528-qwen3-8b

# 或使用 mistral 模型
# LM_STUDIO_MODEL=mistralai/ministral-3-14b-reasoning
```

然后重启后端。

### 方案3: 修改代码中的模型选择逻辑

修改 `backend/engine/agent/deep_agent.py` 中的模型选择逻辑：

```python
# 当前代码（第154行）
best_model = next((m for m in available_models if "gpt" in m), available_models[0])

# 修改为：优先选择 deepseek 或 mistral，避免 gpt-oss-20b
best_model = next(
    (m for m in available_models if "deepseek" in m or "mistral" in m),
    available_models[0]
)
```

## 🔍 当前可用模型

根据后端日志，LM Studio 中可用的模型：
- ✅ `deepseek/deepseek-r1-0528-qwen3-8b` - 推荐
- ✅ `mistralai/ministral-3-14b-reasoning` - 推荐
- ❌ `openai/gpt-oss-20b` - 当前使用，有问题
- ⚠️ `text-embedding-nomic-embed-text-v1.5` - 这是嵌入模型，不是LLM

## 📝 验证

修复后，重新发送消息，应该看到：
- ✅ 路由决策正常：`🎯 路由决策: chatarea → deepagent（智能对话）`
- ✅ LLM 调用成功，没有 400 错误
- ✅ 前端收到流式响应

---

*更新时间: 2024-12-19*


