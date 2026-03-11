# 🚨 紧急修复 - 立即执行步骤

## 问题已诊断：前端消息指向错误的后端地址

### ✅ 已完成的修复
- ✅ `chat.ts` 中的 URL 已从 `http://localhost:8000` 改为 `http://localhost:2024`
- ✅ `streamChat()` 和 `invokeChat()` 现在使用正确的 LangGraph 端点

## 🏃 立即需要做的（5 分钟）

### 1️⃣ 清除前端缓存
```bash
cd /Users/workspace/DevelopProjects/ccb-v0.378/frontend/desktop
rm -rf .next .dist dist node_modules/.vite
```

### 2️⃣ 确保环境变量正确
编辑 `frontend/desktop/.env.local`，确保包含：
```bash
NEXT_PUBLIC_LANGGRAPH_API_URL=http://localhost:2024
NEXT_PUBLIC_LANGGRAPH_ASSISTANT_ID=orchestrator
```

### 3️⃣ 重启前端
```bash
npm run dev
# 应该看到：
# ➜  Local:   http://localhost:3001/
```

### 4️⃣ 测试发送消息

1. 打开 http://localhost:3001
2. 在聊天框输入 `你好`
3. 发送
4. **按 F12 打开开发者工具 → Console 标签**
5. 应该看到日志：
   ```
   📤 发送流式请求:
   url: http://localhost:2024/threads/.../runs/orchestrator/stream
   ```
6. 应该收到回复

---

## 📊 关于你的其他问题

### Q1：LLM 窗口 (Context Window) 32k 配置

**答**：修改后端配置
```python
# backend/engine/core/main_agent.py，第 104 行
MAX_TOKENS = 32768  # 改这个值
```

然后重启后端：
```bash
langgraph dev
```

**优先级**：后端配置覆盖 LM Studio UI 设置

### Q2：温度 (Temperature) 配置

**答**：也是修改后端
```python
TEMPERATURE = 0.3  # 低 = 确定性强，高 = 随机性强
```

**同样的原则**：后端覆盖 LM Studio

### Q3：网络工具库补充

**可用工具**：
```
✅ 已有: read_file, write_file, delete_file, list_directory, python_run, shell_run
❌ 缺少: web_search, image_generation, pdf_tools 等

需要的操作：
1. 导入 LangChain 的工具
2. 配置 API Key
3. 添加到工具列表
```

我可以帮你添加，但先完成消息对接修复。

---

## 📋 完成检查

- [ ] 清除前端缓存 `rm -rf .next .dist dist node_modules/.vite`
- [ ] 确认环境变量设置
- [ ] 重启前端 `npm run dev`
- [ ] 测试发送消息
- [ ] 打开 F12 看到正确的 URL
- [ ] 收到 AI 回复

完成以上步骤后，消息应该能正常到达！

---

## 🎯 后续

修复完成后，我们可以继续：
1. ✅ 修复工具库（添加网络搜索等）
2. ✅ 优化 LLM 参数（窗口大小、温度等）
3. ✅ 统一所有前端组件的对接方式

**优先处理消息对接问题！** 🚀

