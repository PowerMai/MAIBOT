# 🔴 CRITICAL FIX: 文件附件处理方案

## 问题根源确认

**400 错误的真正原因**：
```
前端发送的消息包含 'file' content block
→ LLM 不支持 'file' 类型
→ OpenAI API 返回 400 错误
```

### 错误消息
```
openai.BadRequestError: Error code: 400 - Invalid 'content': 
'content' objects must have a 'type' field that is either 'text' or 'image_url'."
```

### 违反的规则
```
LLM 只支持两种 content block 类型：
✅ text
✅ image_url
❌ file (不支持！)
❌ json (不支持！)
❌ code (不支持！)
```

---

## 🔍 问题代码位置

### MyRuntimeProvider.tsx (第 220-237 行)

```typescript
// ❌ 这段代码会生成 'file' content block
const completeAttachment = {
  ...attachment,
  status: { type: "complete" as const },
  content: [
    {
      type: "file" as const,  // ❌ 错误！LLM 不支持
      mimeType: attachment.contentType,
      filename: attachment.name,
      data: dataUrl,  // base64 data URL
    },
  ],
};
```

### 后端路由 (router_node.py)

```python
# 需要检查是否有地方从 'file' block 中提取数据
# 并且不是发送给 LLM 的消息结构
```

---

## ✅ 正确的修复方案

### 方案 A：文件转换为文本（推荐用于文本文件）

```typescript
// ✅ 将文件内容转换为文本
async send(attachment) {
  try {
    const text = await attachment.file.text();
    
    // ✅ 返回 content block 格式（前端可以解析）
    return {
      ...attachment,
      status: { type: "complete" as const },
      content: [
        {
          type: "file" as const,  // 这是给前端的，不是给 LLM 的
          mimeType: attachment.contentType,
          filename: attachment.name,
          data: text,  // 文本内容，而不是 data URL
        },
      ],
    };
  } catch (error) {
    // ...
  }
}
```

### 方案 B：文件转换为消息的 text block（最佳方案）

```typescript
// ✅ 直接将文件转换为消息中的 text content block
// 这样 LLM 可以直接理解

// 在 MyRuntimeProvider 的增强消息逻辑中：
const enhancedMessages = [...messages];
if (enhancedMessages.length > 0) {
  const lastMessage = enhancedMessages[enhancedMessages.length - 1];
  
  // 如果消息中有文件，转换为文本
  if (lastMessage.content && Array.isArray(lastMessage.content)) {
    const textBlocks: any[] = [];
    const fileBlocks: any[] = [];
    
    for (const block of lastMessage.content) {
      if (block.type === 'file') {
        // ✅ 将 file block 转换为 text block
        textBlocks.push({
          type: 'text',
          text: `[文件: ${block.filename}, 类型: ${block.mimeType}]\n${block.data}`
        });
      } else {
        textBlocks.push(block);
      }
    }
    
    // 只保留 text 和 image_url blocks（LLM 支持的类型）
    lastMessage.content = textBlocks.filter(b => 
      b.type === 'text' || b.type === 'image_url'
    );
  }
}
```

### 方案 C：图片特殊处理（用于图片文件）

```typescript
// ✅ 如果是图片，转换为 image_url
async send(attachment) {
  try {
    if (attachment.contentType.startsWith('image/')) {
      // ✅ 图片可以转换为 image_url block（LLM 支持）
      return {
        ...attachment,
        status: { type: "complete" as const },
        content: [
          {
            type: "image_url" as const,  // ✅ LLM 支持
            image_url: {
              url: dataUrl,
            },
          },
        ],
      };
    } else {
      // ❌ 其他文件类型不能直接发送给 LLM
      // 需要转换为文本或其他方式
      throw new Error(`不支持的文件类型: ${attachment.contentType}`);
    }
  } catch (error) {
    // ...
  }
}
```

---

## 🚀 推荐的修复步骤

### Step 1: 理解问题

- [x] 前端生成 `file` content block
- [x] LLM 不支持 `file` 类型
- [x] 导致 400 错误

### Step 2: 修改前端代码

**修改 MyRuntimeProvider.tsx 中的消息增强逻辑**：

```typescript
// 在 stream 函数中，发送消息前进行转换
const enhancedMessages = [...messages];
if (enhancedMessages.length > 0) {
  const lastMessage = enhancedMessages[enhancedMessages.length - 1];
  
  // 转换消息中的 content blocks
  if (lastMessage.content && Array.isArray(lastMessage.content)) {
    lastMessage.content = lastMessage.content.map((block: any) => {
      if (block.type === 'file') {
        // ✅ 方案：将 file 转换为 text（对于 LLM）
        return {
          type: 'text',
          text: `[文件 ${block.filename} (${block.mimeType})]\n${block.data?.substring(0, 1000) || ''}`
        };
      } else if (block.type === 'image_url') {
        // ✅ 图片可以保留
        return block;
      } else if (block.type === 'text') {
        // ✅ 文本保留
        return block;
      }
      // ❌ 其他类型（json、code 等）移除，因为 LLM 不支持
      return null;
    }).filter((block: any) => block !== null);
  }
}

return sendMessage({
  threadId,
  messages: enhancedMessages,
});
```

### Step 3: 后端验证

**确保后端正确处理转换后的消息**：

```python
# router_node.py
def router_node(state: AgentState) -> AgentState:
    last_message = state['messages'][-1]
    
    # ✅ 验证消息格式
    if isinstance(last_message.content, list):
        for block in last_message.content:
            if isinstance(block, dict):
                block_type = block.get('type')
                # ✅ 只应该有 text 和 image_url
                if block_type not in ['text', 'image_url']:
                    logger.warning(f"⚠️ 非法 block 类型在消息中: {block_type}")
    
    # ... rest of the code
```

### Step 4: 测试

```bash
# 1. 重新启动前端
npm run dev

# 2. 发送包含文件的消息
# 应该看到：
# ✅ 消息成功发送
# ✅ 后端返回 200 OK
# ❌ 不再返回 400 错误
```

---

## 📋 快速修复清单

### 前端修改
- [ ] 修改 MyRuntimeProvider.tsx 的消息增强逻辑
- [ ] 将 `file` blocks 转换为 `text` blocks
- [ ] 确保消息只包含 `text` 和 `image_url`

### 后端验证
- [ ] 确保路由节点不会添加非法 blocks
- [ ] 确保工具节点返回的消息格式正确
- [ ] 添加日志验证消息类型

### 测试
- [ ] 发送纯文本消息（无文件）✅
- [ ] 发送包含文件的消息（文本文件）✅
- [ ] 发送包含图片的消息（图片文件）✅
- [ ] 验证 LLM 可以理解所有消息 ✅

---

## 🎯 最终检查

```python
# 验证函数（添加到后端）
def validate_llm_compatible_message(message):
    """验证消息可以安全发送给 LLM"""
    if isinstance(message.content, str):
        return True  # ✅ 纯文本可以
    
    if isinstance(message.content, list):
        for block in message.content:
            if isinstance(block, dict):
                block_type = block.get('type')
                if block_type not in ['text', 'image_url']:
                    return False  # ❌ 非法类型
    
    return True

# 使用方式
for msg in state['messages']:
    if not validate_llm_compatible_message(msg):
        raise ValueError(f"❌ 消息格式不兼容 LLM: {msg}")
```

---

## 💡 总结

**问题**: 前端生成了 LLM 不支持的 `file` content block
**解决**: 在发送给后端前，将其转换为 `text` 或 `image_url`
**结果**: 后端返回 200 OK，流式输出正常工作

这是一个**前端修复**，而不是架构问题！


