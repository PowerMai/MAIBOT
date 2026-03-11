# 快速参考卡片 - 统一 API 设计

**打印这张卡片放在桌边！**

---

## 📋 请求类型快速表

### 对话框请求（ChatArea）

```json
{
  "source": "chatarea",
  "request_type": "agent",
  "input": "用户输入",
  "context": {...}
}
```
→ 后端：调用 DeepAgent 多步骤处理

---

### 编辑器 - Agent 操作（需要处理）

```json
{
  "source": "editor",
  "request_type": "agent",
  "operation": "expand|rewrite|modify|analyze|document|test",
  "input": "操作描述",
  "context": {"selectedText": "..."}
}
```
→ 后端：调用 Agent（暂时 DeepAgent，以后可用普通 Agent）

---

### 编辑器 - 直接命令（一次性）

```json
{
  "source": "editor",
  "request_type": "direct_tool",
  "params": {
    "tool": "工具名",
    "...": "参数"
  }
}
```
→ 后端：**直接执行工具**（无需 Agent）

---

### 文件同步

```json
{
  "source": "system",
  "request_type": "file_sync",
  "operation": "apply_changes|get_snapshot",
  "changes": [...]
}
```
→ 后端：文件同步管理器处理

---

## 🎯 后端路由判断树

```
请求来到
  ↓
source = chatarea?
  ├─ YES → request_type = agent? → YES → Agent 处理 ✓
  │                            → NO → 错误
  │
  ├─ NO
  │
  source = editor?
    ├─ YES → request_type = agent? → YES → Agent 处理 ✓
    │                       → direct_tool? → YES → 工具处理 ✓
    │                       → 其他 → 错误
    │
    ├─ NO
    │
    source = system?
      ├─ YES → request_type = file_sync? → YES → 同步处理 ✓
      │                       → 其他 → 错误
      │
      └─ NO → 错误
```

---

## 💡 核心规则

### ✅ DO（应该做）

1. **前端清晰指定** `source` 和 `request_type`
2. **后端无需判断** 业务逻辑，直接路由
3. **使用统一接口** 所有请求都是 POST /api/route
4. **添加新操作** 只需在前端指定新 operation
5. **添加新工具** 在后端注册，前端指定就能用

### ❌ DON'T（不要做）

1. ❌ 在后端用关键词判断
2. ❌ 根据内容猜测用户意图
3. ❌ 在前端处理业务逻辑
4. ❌ 创建多个 API 端点
5. ❌ 工具调用和 Agent 混合

---

## 📊 工具列表（direct_tool）

### 文件操作
- `read_file` - 读取文件
- `write_file` - 写入文件
- `delete_file` - 删除文件

### 文件系统
- `list_files` - 列出文件
- `search_files` - 搜索文件（grep）
- `get_file_info` - 获取文件信息

### 代码操作
- `format_code` - 格式化代码
- `analyze_code` - 分析代码
- `get_function_signature` - 获取函数签名
- `convert_js_to_ts` - JavaScript → TypeScript
- `minify_code` - 代码压缩

---

## 🎭 操作列表（agent operation）

| 操作 | 说明 | 场景 |
|------|------|------|
| **expand** | 扩展功能 | 需要添加更多功能 |
| **rewrite** | 重写代码 | 提高可读性/性能 |
| **modify** | 修改代码 | 满足特定需求 |
| **analyze** | 分析代码 | 理解代码逻辑 |
| **document** | 生成文档 | 为代码添加注释 |
| **test** | 生成测试 | 创建单元测试 |

---

## 🔄 完整流程示例

### 场景：用户想扩写一个函数

```
1️⃣ 前端
   └─ 用户选中代码 → 点击"扩写"按钮
   
2️⃣ 前端发送请求
   └─ {source:"editor", request_type:"agent", operation:"expand", ...}
   
3️⃣ 后端收到请求
   └─ validate() → 检查字段
   └─ route_based_on_type() → 判断：editor + agent → editor_agent
   
4️⃣ 后端处理
   └─ handle_editor_agent_request()
   └─ 调用 Agent（DeepAgent）
   └─ Agent 分析、规划、执行
   
5️⃣ 后端返回结果
   └─ {success:true, source:"agent", output:"扩写后的代码...", ...}
   
6️⃣ 前端显示结果
   └─ ChatArea 显示建议
   └─ 用户可选择应用、拒绝等
```

---

## 🛠️ 前端快速代码片段

### 调用 Agent 操作

```typescript
async function callAgentOperation(operation: string, selectedText: string) {
  return fetch("http://localhost:2024/api/route", {
    method: "POST",
    body: JSON.stringify({
      source: "editor",
      request_type: "agent",
      operation,
      input: `请${operation}以下代码`,
      context: { selectedText }
    })
  }).then(r => r.json());
}

// 使用
callAgentOperation("expand", myCode);
callAgentOperation("rewrite", myCode);
callAgentOperation("analyze", myCode);
```

### 调用直接工具

```typescript
async function callTool(toolName: string, params: any) {
  return fetch("http://localhost:2024/api/route", {
    method: "POST",
    body: JSON.stringify({
      source: "editor",
      request_type: "direct_tool",
      params: { tool: toolName, ...params }
    })
  }).then(r => r.json());
}

// 使用
callTool("format_code", {language: "typescript", code: myCode});
callTool("get_function_signature", {code: myCode});
```

---

## ⚡ 关键区别

### Agent 操作 vs 直接工具

| 方面 | Agent 操作 | 直接工具 |
|------|----------|---------|
| **延迟** | 高（1-5秒） | 低（<100ms） |
| **复杂度** | 高（多步骤） | 低（一步） |
| **智能度** | 高（LLM 参与） | 低（固定逻辑） |
| **操作** | expand, rewrite, modify | format, analyze, convert |
| **何时用** | 需要 AI 建议 | 快速操作 |

---

## 📝 错误处理

所有响应格式：
```json
{
  "success": true/false,
  "error": "错误信息（如果失败）"
}
```

**常见错误**：
- ❌ `缺少 source 字段` - 请检查请求格式
- ❌ `缺少 request_type 字段` - 请检查请求格式
- ❌ `无效的请求组合` - source 和 request_type 搭配错误
- ❌ `工具不存在` - 检查 tool 名称是否正确

---

## 📞 添加新功能的步骤

### 添加新的 Agent 操作

1. 前端：新增一个按钮，点击时发送：
   ```json
   {
     "source": "editor",
     "request_type": "agent",
     "operation": "new_operation",
     "input": "..."
   }
   ```

2. 后端：在 `operation_hints` 添加提示词
3. 完成！后端会自动路由给 Agent

### 添加新的直接工具

1. 后端：注册新工具到 `get_core_tool_by_name()`
2. 前端：调用
   ```json
   {
     "source": "editor",
     "request_type": "direct_tool",
     "params": {"tool": "new_tool", ...}
   }
   ```
3. 完成！路由会自动调用

---

**最重要的规则**：
> 前端明确指定 `source` + `request_type` + `operation` ，后端自动路由和处理。无需任何关键词判断！


