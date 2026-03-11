# 生成式 UI 前后端不匹配问题分析

## 🚨 核心问题

**后端设置了 `additional_kwargs.ui`，但前端没有处理！**

## 📋 问题详情

### 后端实现

**文件**: `backend/engine/middleware/generative_ui_middleware.py`

后端在 `additional_kwargs.ui` 中设置了生成式 UI 配置：

```python
last_msg.additional_kwargs['ui'] = {
    "type": "table",
    "columns": columns,
    "data": data
}
```

### 前端实现

**文件**: `assistant-ui/packages/react-langgraph/src/convertLangChainMessages.ts`

前端只处理了：
- `additional_kwargs.reasoning` ✅
- `additional_kwargs.tool_outputs` ✅
- `additional_kwargs.ui` ❌ **未处理！**

```typescript
const allContent = [
  message.additional_kwargs?.reasoning,  // ✅ 处理了
  ...normalizedContent,
  ...(message.additional_kwargs?.tool_outputs ?? []),  // ✅ 处理了
  // ❌ 没有处理 message.additional_kwargs?.ui
].filter((c) => c !== undefined);
```

## 🔍 根本原因

1. **assistant-ui 不支持 `additional_kwargs.ui`**
   - `convertLangChainMessages` 函数没有处理 `ui` 字段
   - 消息转换时 `ui` 配置被丢弃

2. **前后端标准不一致**
   - 后端使用 `additional_kwargs.ui`（可能是自定义标准）
   - assistant-ui 使用 `additional_kwargs.reasoning` 和 `tool_outputs`（LangChain 标准）

3. **缺少自定义转换逻辑**
   - 没有在 `MyRuntimeProvider` 或 `convertLangChainMessages` 中添加 `ui` 处理

## ✅ 解决方案

### 方案 1：扩展 `convertLangChainMessages`（推荐）

在 `MyRuntimeProvider` 中自定义消息转换，处理 `additional_kwargs.ui`：

```typescript
import { convertLangChainMessages } from "@assistant-ui/react-langgraph";

const customConvertLangChainMessages = (message: LangChainMessage) => {
  const converted = convertLangChainMessages(message);
  
  // 处理 additional_kwargs.ui
  if (message.type === 'ai' && message.additional_kwargs?.ui) {
    const ui = message.additional_kwargs.ui;
    
    // 根据 UI 类型添加对应的内容部分
    switch (ui.type) {
      case 'table':
        // 转换为表格内容
        converted.content.push({
          type: 'data',
          data: {
            type: 'table',
            columns: ui.columns,
            rows: ui.data,
          },
        });
        break;
      case 'code':
        // 代码块已经通过 markdown 处理
        break;
      // ... 其他类型
    }
  }
  
  return converted;
};
```

### 方案 2：使用消息内容解析（简单但不优雅）

后端将 UI 配置嵌入到消息内容中（如 JSON），前端解析：

```python
# 后端
message.content = json.dumps({
    "text": "这是表格数据",
    "ui": {"type": "table", "data": [...]}
})
```

```typescript
// 前端
const content = JSON.parse(message.content);
if (content.ui) {
  // 渲染 UI
}
```

### 方案 3：使用 LangChain 标准字段

检查 LangChain 是否有标准的生成式 UI 字段，如果有，使用标准字段而不是自定义 `ui`。

## 🎯 推荐实现

**方案 1** 是最合理的，因为：
1. 保持后端实现不变
2. 在前端扩展标准转换逻辑
3. 符合 assistant-ui 的扩展模式

## 📝 实施步骤

1. 在 `MyRuntimeProvider` 中创建自定义转换函数
2. 处理 `additional_kwargs.ui` 的各个类型（table, code, markdown, steps）
3. 将 UI 配置转换为 assistant-ui 支持的内容类型
4. 测试各种 UI 类型的渲染

