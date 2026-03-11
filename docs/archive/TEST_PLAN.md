# 前后端全面功能测试计划

## 🎯 测试目标

验证以下功能是否正常工作：
1. 路由逻辑（所有路由规则）
2. 文件同步机制（DeepAgent调用write_file后前端自动刷新）
3. 编辑器复杂操作（complex_operation）
4. 编辑器快速工具（tool_command）

---

## 📋 测试场景

### 场景1: 对话框聊天（chatarea → deepagent）

**步骤**:
1. 在右侧聊天区域输入消息
2. 观察是否路由到 `deepagent`
3. 检查是否有流式输出
4. 检查生成式UI是否正常显示

**预期结果**:
- ✅ 消息路由到 `deepagent`
- ✅ 有流式输出显示
- ✅ 生成式UI（table, code, markdown等）正常显示

---

### 场景2: 编辑器复杂操作（editor + complex_operation → deepagent）

**步骤**:
1. 在主编辑器中选择一段文本
2. 使用AI快捷操作（扩写、重写、修复、解释）
3. 观察是否路由到 `deepagent`
4. 检查AI生成的内容
5. 测试应用到编辑器功能

**预期结果**:
- ✅ 路由到 `deepagent`（不是 `editor_tool`）
- ✅ AI生成的内容正确
- ✅ 可以应用到编辑器

---

### 场景3: 编辑器快速工具（editor + tool_command → editor_tool）

**步骤**:
1. 在主编辑器中打开一个文件
2. 使用 `readFile` API读取文件
3. 使用 `writeFile` API写入文件
4. 观察是否路由到 `editor_tool`（无LLM）
5. 检查文件操作是否成功

**预期结果**:
- ✅ 路由到 `editor_tool`（不是 `deepagent`）
- ✅ 文件读取成功
- ✅ 文件写入成功
- ✅ 响应速度快（无LLM推理）

---

### 场景4: 文件同步（DeepAgent调用write_file后前端自动刷新）

**步骤**:
1. 在聊天区域请求AI修改文件（例如："请修改 workspace/test.txt 文件，添加一行'Hello World'"）
2. 观察DeepAgent是否调用 `write_file` 工具
3. 检查前端是否自动检测到文件变更
4. 检查编辑器是否自动刷新显示最新内容

**预期结果**:
- ✅ DeepAgent调用 `write_file` 工具
- ✅ `generative_ui_node` 检测到工具调用
- ✅ 自动添加 `editor_action` UI事件
- ✅ 前端 `MyRuntimeProvider` 检测到 `editor_action`
- ✅ 编辑器自动刷新显示最新内容

---

### 场景5: 文件同步（editor_tool调用write_file后前端自动刷新）

**步骤**:
1. 在主编辑器中保存文件（使用 `writeFile` API）
2. 观察是否路由到 `editor_tool`
3. 检查前端是否自动检测到文件变更
4. 检查编辑器是否自动刷新

**预期结果**:
- ✅ 路由到 `editor_tool`
- ✅ 文件写入成功
- ✅ 前端自动检测到文件变更
- ✅ 编辑器自动刷新

---

## 🔍 检查点

### 后端日志检查

1. **路由决策日志**:
   ```
   🎯 路由决策: chatarea → deepagent（智能对话）
   🎯 路由决策: editor + complex → deepagent（智能编辑）
   🎯 路由决策: editor + tool → editor_tool（快速工具）
   🎯 路由决策: system + file_sync → editor_tool（文件同步）
   ```

2. **工具调用日志**:
   ```
   ✨ 已为write_file工具调用添加editor_action: <文件路径>
   ```

3. **文件操作日志**:
   ```
   ✓ 文件写入完成: <文件路径>
   ```

### 前端日志检查

1. **路由信息日志**:
   ```
   [LangGraph] 发送消息(流式): ...
   [MyRuntimeProvider] 检测到文件写入: <文件路径>
   [FullEditorV2] 收到文件操作通知: { type: 'refresh', filePath: '...' }
   ```

2. **文件刷新日志**:
   ```
   [FullEditorV2] 文件已刷新: <文件名>
   ```

---

## 🚀 启动命令

### 后端启动
```bash
cd /Users/workspace/DevelopProjects/ccb-v0.378/backend
python -m langgraph dev --port 2024 --host 0.0.0.0
```

### 前端启动
```bash
cd /Users/workspace/DevelopProjects/ccb-v0.378/frontend/desktop
npm run dev
```

---

## ✅ 测试检查清单

- [ ] 场景1: 对话框聊天
- [ ] 场景2: 编辑器复杂操作
- [ ] 场景3: 编辑器快速工具
- [ ] 场景4: DeepAgent文件同步
- [ ] 场景5: editor_tool文件同步

---

*测试计划生成时间: 2024-12-19*


