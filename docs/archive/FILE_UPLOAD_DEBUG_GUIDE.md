# 文件上传调试指南

## 🔍 问题现象

用户上传了文件，但 LLM 没有收到文件内容。

## 📋 调试步骤

### 1. 前端调试

打开浏览器控制台，检查以下日志：

#### 1.1 文件添加
```
[MyRuntimeProvider] 添加附件: <文件名> <类型> <大小>
```

#### 1.2 文件发送
```
[MyRuntimeProvider] 📤 发送附件: { name, type, size, id }
[MyRuntimeProvider] ✅ 文件已转换为 base64，长度: <长度>
[MyRuntimeProvider] ✅ 返回 CompleteAttachment: { ... }
```

#### 1.3 消息发送
检查消息中是否包含文件内容块：
- 打开 Network 标签
- 找到发送到 LangGraph Server 的请求
- 检查请求体中的 `messages` 字段
- 应该包含 `{"type": "file", "file": {...}}` 格式的内容块

### 2. 后端调试

检查后端日志，应该看到：

#### 2.1 消息接收
```
🔍 router_node 收到消息内容类型: <类型>
🔍 content 是列表，长度: <长度>
🔍 content[0]: type=..., keys=...
```

#### 2.2 文件检测
```
📎 检测到文件块: {...}
🔍 file_info: {...}
🔍 file_info keys: [...]
📎 文件信息: filename=..., mime_type=..., file_data_length=...
```

#### 2.3 文件提取
```
📎 提取文件附件: <文件名> (<类型>, <长度> 字符)
📍 路由信息: ... attachments=<数量> 个文件
```

### 3. 常见问题

#### 问题1: 前端没有发送文件

**症状**: 控制台没有 `[MyRuntimeProvider] 📤 发送附件` 日志

**可能原因**:
- 文件没有正确添加到附件列表
- `send` 方法没有被调用

**解决方法**:
- 检查文件是否成功添加到附件列表
- 检查 `send` 方法是否被调用

#### 问题2: 文件格式不正确

**症状**: 后端没有检测到文件块

**可能原因**:
- `content` 格式不符合期望
- `file` 字段缺失或格式错误

**解决方法**:
- 检查 `getMessageContent` 是否正确转换文件格式
- 检查后端日志中的 `content` 格式

#### 问题3: 文件数据为空

**症状**: `file_data_length=0`

**可能原因**:
- base64 编码失败
- Data URL 格式错误

**解决方法**:
- 检查前端 base64 编码是否正确
- 检查 Data URL 格式是否正确

## 🔧 修复建议

如果文件仍然没有传递，请检查：

1. **前端文件格式**:
   - `content[0].type` 应该是 `"file"`
   - `content[0].data` 应该是 Data URL 或 base64 字符串
   - `content[0].mimeType` 和 `content[0].filename` 应该存在

2. **后端文件提取**:
   - `block.get('type')` 应该是 `'file'`
   - `block.get('file')` 应该存在
   - `file_info.get('file_data')` 或 `file_info.get('url')` 应该有值

3. **DeepAgent 接收**:
   - 检查 `context.attachments` 是否有文件
   - 检查文件内容是否正确解码

---

*更新时间: 2026-01-04*

