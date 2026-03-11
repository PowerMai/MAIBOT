# ✅ 快速启动指南：LangGraph Files API 实现

## 🎯 完整方案确认

**已确认采用：LangGraph SDK Files API 路径传递方案**

## 📋 关键点

### 文件去重
✅ **前端**：可选计算文件哈希用于本地检查
✅ **后端**：LangGraph Server 自动处理存储和去重
✅ **结论**：无需担心重复，直接上传即可

### 路径处理
✅ **获得**：LangGraph Server 返回的路径 `/files/{id}`
✅ **转换**：转换为完整 Server 路径或前端格式
✅ **发送**：在消息中以纯文本形式包含

### router_node
✅ **角色**：可选检测路径进行日志
✅ **不处理**：不需要处理文件
✅ **转发**：直接转发给 DeepAgent

---

## 🚀 实施步骤

### Step 1: 前端文件上传工具

**创建文件**：`frontend/desktop/src/lib/api/fileUpload.ts`

```typescript
// 实现 uploadFileToLangGraph() 函数
// 调用 POST /files 上传
// 返回 { fileId, filePath, serverUrl, ... }
```

### Step 2: 前端修改 AttachmentAdapter

**修改文件**：`frontend/desktop/src/components/ChatComponents/MyRuntimeProvider.tsx`

```typescript
async send(attachment) {
  // 调用 uploadFileToLangGraph()
  // 返回纯文本路径（不是 file block）
  // 格式：file:///files/{id}|name|size
}
```

### Step 3: 后端文件操作工具

**创建/修改文件**：`backend/tools/file_operations.py`

```python
# 实现 read_file_from_langgraph() 函数
# 从 LangGraph Server 读取文件
# 解析不同的路径格式
# 返回文件内容给 LLM
```

### Step 4: 后端 router_node 可选修改

**修改文件**：`backend/engine/nodes/router_node.py`

```python
# 可选：添加日志检测文件路径
# 无需处理文件，直接返回
```

---

## 📝 文件路径格式

```
前端生成：
file:///files/{id}|{filename}|{filesize}

消息中呈现：
📎 已上传文件：document.pdf
路径：file:///files/abc123|document.pdf|1024000
大小：1000.0KB

LLM 工具访问：
read_file_from_langgraph("/files/abc123")
或
read_file_from_langgraph("file:///files/abc123|document.pdf|1024000")

工具自动解析路径，访问 LangGraph Server
```

---

## ✅ 核心实现

### 前端核心代码
```typescript
// 上传
const { filePath, serverUrl } = await uploadFileToLangGraph(file);

// 返回
return {
  content: [{
    type: "text",
    text: `file://${filePath}|${name}|${size}`
  }]
};
```

### 后端核心代码
```python
# 工具
async def read_file_from_langgraph(file_path):
    # 解析路径
    # 访问 LangGraph Server
    # 读取并返回内容

# 使用
llm_response = llm.invoke({
    "message": "分析这个文件...",
    # 文件路径在消息中
})
```

---

## 🎯 无需实现的部分

❌ 自定义文件存储
❌ 自定义去重检查
❌ router_node 中的文件处理
❌ Store 中的文件管理
❌ 文件路由逻辑

---

## ✨ 完成检查

- [ ] 前端工具 `uploadFileToLangGraph()` ✅
- [ ] 前端 `AttachmentAdapter.send()` ✅
- [ ] 后端工具 `read_file_from_langgraph()` ✅
- [ ] 测试上传和读取 ✅

---

## 🎉 最终确认

**方案**：LangGraph SDK Files API 路径传递
**前端**：上传到 Server，获得路径
**后端**：路径在消息中，LLM 需要时读取
**工具**：从 Server 读取文件
**特点**：纯文本路径，无 file block，最简洁

**这就是最优方案！** 🚀


