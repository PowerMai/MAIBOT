# 启动测试指南

## 🚀 启动步骤

### 1. 启动后端 (LangGraph Server)

```bash
cd /Users/workspace/DevelopProjects/ccb-v0.378/backend

# 激活虚拟环境（如果存在）
source venv/bin/activate  # 或 source .venv/bin/activate

# 启动 LangGraph Server
python -m langgraph dev --port 2024 --host 0.0.0.0
```

**验证后端启动**:
```bash
curl http://localhost:2024/health
```

**预期输出**: 应该返回健康检查信息

---

### 2. 启动前端 (Vite Dev Server)

```bash
cd /Users/workspace/DevelopProjects/ccb-v0.378/frontend/desktop

# 启动开发服务器
npm run dev
```

**访问地址**: 
- 前端: http://localhost:3001 (或 Vite 显示的端口)
- 后端: http://localhost:2024

---

## ✅ 功能验证清单

### 路由逻辑验证

1. **对话框聊天** (`chatarea` → `deepagent`)
   - [ ] 在右侧聊天区域输入消息
   - [ ] 检查后端日志: `🎯 路由决策: chatarea → deepagent`
   - [ ] 检查是否有流式输出
   - [ ] 检查生成式UI是否正常显示

2. **编辑器复杂操作** (`editor + complex_operation` → `deepagent`)
   - [ ] 在主编辑器中选择文本
   - [ ] 使用AI快捷操作（扩写、重写、修复、解释）
   - [ ] 检查后端日志: `🎯 路由决策: editor + complex → deepagent`
   - [ ] 检查AI生成的内容
   - [ ] 测试应用到编辑器功能

3. **编辑器快速工具** (`editor + tool_command` → `editor_tool`)
   - [ ] 在主编辑器中打开文件
   - [ ] 使用 `readFile` API读取文件
   - [ ] 使用 `writeFile` API写入文件
   - [ ] 检查后端日志: `🎯 路由决策: editor + tool → editor_tool`
   - [ ] 检查响应速度（应该很快，无LLM推理）

### 文件同步验证

4. **DeepAgent文件同步**
   - [ ] 在聊天区域请求AI修改文件
   - [ ] 检查后端日志: `✨ 已为write_file工具调用添加editor_action`
   - [ ] 检查前端日志: `[MyRuntimeProvider] 检测到文件写入`
   - [ ] 检查编辑器是否自动刷新显示最新内容

5. **editor_tool文件同步**
   - [ ] 在主编辑器中保存文件
   - [ ] 检查后端日志: `✓ 文件写入完成`
   - [ ] 检查前端是否自动检测到文件变更
   - [ ] 检查编辑器是否自动刷新

---

## 🔍 日志检查

### 后端日志位置
- 控制台输出（如果直接运行）
- `/tmp/langgraph.log` (如果使用后台运行)

### 前端日志位置
- 浏览器控制台 (F12)
- `/tmp/frontend.log` (如果使用后台运行)

### 关键日志信息

**后端**:
```
🎯 路由决策: chatarea → deepagent（智能对话）
🎯 路由决策: editor + complex → deepagent（智能编辑）
🎯 路由决策: editor + tool → editor_tool（快速工具）
✨ 已为write_file工具调用添加editor_action: <文件路径>
✓ 文件写入完成: <文件路径>
```

**前端**:
```
[LangGraph] 发送消息(流式): ...
[MyRuntimeProvider] 检测到文件写入: <文件路径>
[FullEditorV2] 收到文件操作通知: { type: 'refresh', filePath: '...' }
[FullEditorV2] 文件已刷新: <文件名>
```

---

## 🐛 常见问题

### 后端无法启动

1. **检查虚拟环境**:
   ```bash
   cd backend
   source venv/bin/activate  # 或 source .venv/bin/activate
   ```

2. **检查依赖**:
   ```bash
   pip install -r requirements.txt
   ```

3. **检查端口占用**:
   ```bash
   lsof -i :2024
   ```

### 前端无法连接后端

1. **检查后端是否启动**:
   ```bash
   curl http://localhost:2024/health
   ```

2. **检查环境变量**:
   ```bash
   # frontend/desktop/.env
   VITE_LANGGRAPH_API_URL=http://localhost:2024
   ```

### 路由不正确

1. **检查前端代码**:
   - `langgraphApi.ts` 中的 `source` 和 `request_type` 设置
   - `FullEditorV2Enhanced.tsx` 中的 `handleAIAction` 使用 `performEditorAction`

2. **检查后端日志**:
   - 查看路由决策日志
   - 确认路由规则匹配

---

## 📝 测试报告模板

测试完成后，请填写以下信息:

```
测试日期: ___________
测试人员: ___________

路由逻辑测试:
- [ ] 对话框聊天: ✅/❌
- [ ] 编辑器复杂操作: ✅/❌
- [ ] 编辑器快速工具: ✅/❌

文件同步测试:
- [ ] DeepAgent文件同步: ✅/❌
- [ ] editor_tool文件同步: ✅/❌

发现问题:
1. ___________
2. ___________

备注:
___________
```

---

*指南生成时间: 2024-12-19*


