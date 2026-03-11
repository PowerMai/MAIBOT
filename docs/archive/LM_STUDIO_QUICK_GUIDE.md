# 🚀 LM Studio 多模型自动适配 - 快速指南

## ✨ 现在可以随意切换模型了！

你的后端已经升级为**自动模型检测**，无需修改代码即可使用 LM Studio 中的任意模型。

---

## 📋 三种使用方式

### 方式 1️⃣：自动检测（推荐）

```bash
# 启动后端
cd /Users/workspace/DevelopProjects/ccb-v0.378
source .venv/bin/activate
langgraph dev

# 后端会自动检测 LM Studio 中当前加载的模型
# 输出类似：
# ✅ 自动检测到模型: qwen-32b
# ✅ LLM 已配置: qwen-32b @ http://localhost:1234/v1
```

**优点**：
- ✅ 无需修改代码
- ✅ 切换模型只需在 LM Studio 中切换
- ✅ 完全自动化

### 方式 2️⃣：指定模型（覆盖）

```bash
# 指定要使用的模型
export LM_STUDIO_MODEL="qwen-32b"
langgraph dev

# 或者一行命令
LM_STUDIO_MODEL="qwen-32b" langgraph dev
```

**优点**：
- ✅ 明确指定使用哪个模型
- ✅ 不受 LM Studio UI 影响

### 方式 3️⃣：查询当前模型

```bash
# 查看 LM Studio 中当前加载的模型
curl http://localhost:1234/v1/models | jq '.data[0].id'

# 输出示例：
# "qwen-32b"
```

---

## 🔄 工作流程

### 场景 1：在 LM Studio 中切换模型

```
1. 在 LM Studio 中加载新模型 (例如：Qwen 32B)
   ↓
2. 启动后端 (langgraph dev)
   ↓
3. 后端自动检测 → "✅ 自动检测到模型: qwen-32b"
   ↓
4. 在前端聊天 → 使用新模型！
```

### 场景 2：模型故障快速切换

```
1. 当前模型出问题
   ↓
2. 在 LM Studio 中加载不同模型
   ↓
3. 重启后端 (Ctrl+C, langgraph dev)
   ↓
4. 自动检测新模型，继续工作
```

---

## 🧪 测试

### 测试 1：查看实际使用的模型

```bash
# 终端中观察后端日志
tail -f /tmp/langgraph.log

# 应该看到：
# ✅ 自动检测到模型: <模型名>
# ✅ LLM 已配置: <模型名> @ http://localhost:1234/v1
```

### 测试 2：聊天验证

```
1. 打开 http://localhost:3000
2. 在聊天框输入：你使用的是什么模型？
3. 模型应该回复其名称
```

### 测试 3：模型切换

```
1. 记录当前模型名称
2. 在 LM Studio 中切换到不同模型
3. 重启后端
4. 查看日志确认新模型
5. 发送消息测试
```

---

## ⚙️ 高级用法

### 环境变量配置

```bash
# 也可以在 .env 文件中设置
export LM_STUDIO_MODEL="auto"              # 自动检测（默认）
export LM_STUDIO_MODEL="llama-2-7b-chat"   # 指定具体模型
```

### 脚本启动

```bash
#!/bin/bash
# start_with_model.sh

# 检测当前模型
MODEL=$(curl -s http://localhost:1234/v1/models | jq -r '.data[0].id')

echo "🚀 启动后端，使用模型: $MODEL"

cd /Users/workspace/DevelopProjects/ccb-v0.378
source .venv/bin/activate
LM_STUDIO_MODEL="$MODEL" langgraph dev
```

---

## 📊 支持的模型

### 已测试
- ✅ Qwen 系列（8B, 32B 等）
- ✅ Llama 2
- ✅ Mistral
- ✅ 其他 OpenAI 兼容模型

### 理论支持
- ✅ LM Studio 能加载的**任意模型**
- ✅ 只要模型支持 OpenAI 兼容 API

---

## 🔍 故障排查

### 问题 1：自动检测失败

**症状**：
```
⚠️  自动检测失败: ...
✅ LLM 已配置: gpt-3.5-turbo
```

**解决**：
1. 检查 LM Studio 是否运行
2. 确保有模型加载
3. 手动指定模型：`export LM_STUDIO_MODEL="qwen-32b"`

### 问题 2：模型不响应

**症状**：
- 聊天无响应
- 后端崩溃

**解决**：
1. 检查模型是否真的在 LM Studio 中加载
2. 查看 LM Studio 日志
3. 切换到已知可工作的模型

### 问题 3：工具调用失败

**症状**：
- 模型无法调用工具
- 工具调用返回错误

**解决**：
1. 确认模型支持工具调用
2. 尝试其他模型
3. 检查后端日志

---

## 🎯 最佳实践

### ✅ 推荐做法

1. **使用自动检测**
   ```bash
   langgraph dev
   # 在 LM Studio 中切换模型，重启后端即可
   ```

2. **为不同场景保存模型**
   - 快速响应：使用较小模型
   - 高质量输出：使用较大模型
   - 工具调用：确保模型支持

3. **监控日志**
   ```bash
   tail -f /tmp/langgraph.log | grep "✅"
   ```

### ❌ 避免做法

1. ❌ 硬编码模型名称（需要修改代码）
2. ❌ 频繁切换模型而不重启后端
3. ❌ 使用完全不兼容的模型

---

## 📈 性能提示

| 模型大小 | 推荐场景 | 优点 | 缺点 |
|--------|--------|------|------|
| **7B** | 快速响应、演示 | ✅ 快 | ⚠️ 质量一般 |
| **13B** | 平衡方案 | ✅ 快且质量好 | - |
| **32B** | 高质量输出 | ✅ 质量优秀 | ⚠️ 速度慢 |
| **70B** | 复杂任务 | ✅ 最佳质量 | ⚠️ 很慢 |

---

## 🎉 总结

现在你可以：

✅ 在 LM Studio 中随意切换任何模型
✅ 后端自动检测并适配
✅ 无需修改任何代码
✅ 完全自动化的工作流

**就这么简单！** 🚀

---

**有问题？** 参考 `LM_STUDIO_MULTI_MODEL_ADAPTATION.md` 了解更多技术细节。

