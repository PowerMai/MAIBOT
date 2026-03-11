# 文件附件处理实现说明

## ✅ 已按官方标准实现

### 1. 前端文件上传 (`MyRuntimeProvider.tsx`)

**实现方式**:
- ✅ 使用 assistant-ui 的 `adapters.attachments.upload`
- ✅ 返回文件信息（id, name, type, size, data, mimeType, filename）
- ✅ assistant-ui 会自动将返回的对象转换为 content blocks
- ✅ 格式: `{"type": "file", "file": {filename, file_data (base64), mime_type}}`

**关键点**:
- `data`: base64 编码的文件内容
- `mimeType`: 文件的 MIME 类型
- `filename`: 文件名
- assistant-ui 会自动处理这些字段并转换为标准的 file content block

### 2. 后端文件提取 (`router_node.py`)

**实现方式**:
- ✅ 从 `HumanMessage.content` 中提取 file blocks
- ✅ 支持 LangChain 官方标准格式: `{"type": "file", "file": {...}}`
- ✅ 解码 base64 文件内容
- ✅ 转换为 DeepAgent 期望的 `context.attachments` 格式

**处理流程**:
1. 检查 `message.content` 是否为列表（multimodal content）
2. 遍历 content blocks，查找 `type === 'file'` 的块
3. 从 `file.file_data` 中提取 base64 数据
4. 解码为文本内容
5. 添加到 `additional_kwargs.attachments`，供 DeepAgent 使用

### 3. DeepAgent 处理

**实现方式**:
- ✅ 文件以字符串形式在 `context.attachments` 中传递
- ✅ 符合 DeepAgent 官方设计
- ✅ 避免 vLLM 的 "Unknown part type: file" 错误

## 📋 数据流

```
前端上传文件
  ↓
assistant-ui adapters.attachments.upload()
  ↓
返回 {id, name, type, data (base64), mimeType, filename}
  ↓
assistant-ui 自动转换为 content blocks
  ↓
{"type": "file", "file": {filename, file_data, mime_type}}
  ↓
发送到 LangGraph Server
  ↓
router_node 提取 file blocks
  ↓
解码 base64 → 文本内容
  ↓
添加到 additional_kwargs.attachments
  ↓
DeepAgent 从 context.attachments 读取
```

## ✅ 符合官方标准

- ✅ 使用 assistant-ui 官方 `adapters.attachments.upload`
- ✅ 返回格式符合 assistant-ui 期望
- ✅ assistant-ui 自动转换为 LangChain 标准 content blocks
- ✅ 后端处理符合 LangChain `HumanMessage` 标准
- ✅ DeepAgent 处理符合官方设计

---

*更新时间: 2024-12-19*


