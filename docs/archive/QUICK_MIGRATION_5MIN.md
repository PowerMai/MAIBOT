# 🎯 LangGraph SDK 迁移 - 5 分钟快速指南

## 就这 3 步！

### 1️⃣ 设置前端环境变量

编辑 `frontend/desktop/.env.local`（或 `.env`）：

```bash
# ✅ 新配置（覆盖旧的 http://localhost:8000）
NEXT_PUBLIC_LANGGRAPH_API_URL=http://localhost:2024
NEXT_PUBLIC_LANGGRAPH_ASSISTANT_ID=orchestrator
```

### 2️⃣ 启动后端

```bash
cd /Users/workspace/DevelopProjects/ccb-v0.378
source .venv/bin/activate
langgraph dev

# 期望看到：
# ✅ Listening on http://127.0.0.1:2024
```

### 3️⃣ 启动前端

```bash
cd /Users/workspace/DevelopProjects/ccb-v0.378/frontend/desktop
rm -rf .next .dist dist  # 清除缓存
npm run dev

# 期望看到：
# ➜  Local:   http://localhost:3000
```

## 🧪 测试

1. 打开 `http://localhost:3000`
2. 在聊天框输入 `你好`
3. 发送
4. ✅ 应该看到 AI 的回复

完成！🎉

---

## 📚 详细文档

- **迁移计划**：`MIGRATION_TO_LANGGRAPH_SDK.md`
- **完整检查清单**：`MIGRATION_CHECKLIST.md`
- **快速启动**：`QUICK_START_GUIDE.md`
- **集成状态**：`FRONTEND_BACKEND_INTEGRATION_STATUS.md`

## 🚀 一键启动（可选）

```bash
chmod +x start_dev.sh
./start_dev.sh
```

---

## 📋 架构对比

### ❌ 旧架构
```
前端 → http://localhost:8000 (REST API)
  ↓
后端 (FastAPI)
  ↓
LLM
```

### ✅ 新架构
```
前端 → LangGraph SDK Client
  ↓
LangGraph Server (http://localhost:2024)
  ↓
后端 DeepAgent
  ↓
LLM (LM Studio)
```

---

## 🔍 验证清单

- [ ] 环境变量已设置
- [ ] 后端启动成功（显示 "Listening on http://127.0.0.1:2024"）
- [ ] 前端启动成功（显示 "Local: http://localhost:3000"）
- [ ] 可以访问 http://localhost:3000
- [ ] 可以发送消息
- [ ] 收到 AI 回复
- [ ] 没有错误日志

---

## 🆘 问题排查

| 问题 | 解决方案 |
|------|--------|
| 前端无法连接 | 检查环境变量、后端是否运行 |
| 后端启动失败 | 检查 LM Studio 是否运行、Python 环境 |
| 消息不显示 | 检查浏览器控制台错误、F12 Network 标签 |
| 环境变量未生效 | 清除 `.next` 文件夹，重启前端 |

---

**准备好了？开始吧！** 🚀

