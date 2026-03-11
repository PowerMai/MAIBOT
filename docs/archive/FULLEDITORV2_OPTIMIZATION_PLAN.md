# ✅ FullEditorV2.tsx 优化方案

## 📋 当前问题

FullEditorV2.tsx 依赖的文件被误删：
- ❌ `PdfPreview.tsx` - PDF 预览组件
- ❌ `UnifiedChatInterface.tsx` - 旧的聊天界面
- ❌ `HeartbeatIndicator.tsx` - 心跳指示器
- ✅ `WorkspaceFileTree.tsx` - 文件树（保留）

## 🎯 优化策略

### 1️⃣ 核心功能保留（必须保留）
```
FullEditorV2.tsx 三面板结构：
├── 左侧：WorkspaceFileTree（工作区管理）✅
├── 中间：编辑器区域（多标签、编辑/预览/分割视图）✅
└── 右侧：AI 对话（需要改进）
```

### 2️⃣ AI 对话集成改进

**当前方案（有问题）：**
```typescript
// ❌ 使用被删除的 UnifiedChatInterface
<UnifiedChatInterface
  messages={activeChat?.messages}
  onSendMessage={handleSendMessage}
/>
```

**新方案（LangGraph SDK）：**
```typescript
// ✅ 使用 LangGraph SDK
<ChatArea
  workspaceId={currentWorkspace?.id}
  editorContent={activeFile?.content}
  editorPath={activeFile?.path}
/>
```

### 3️⃣ 必须恢复的辅助功能

| 功能 | 组件 | 状态 | 优化方案 |
|------|------|------|--------|
| PDF 预览 | `PdfPreview` | 删除 | 恢复或简化 |
| 心跳指示器 | `HeartbeatIndicator` | 删除 | 用简单指示器替代 |
| 聊天界面 | `UnifiedChatInterface` | 删除 | 改用 `ChatArea` + LangGraph |

### 4️⃣ 保留的业务功能

✅ **编辑功能：**
- 多标签编辑
- 编辑/预览/分割视图
- 教卡 JSON 编辑
- AI 写作工具（润色、扩写、翻译等）
- 招投标检查和生成

✅ **文件操作：**
- 工作区文件树
- 文件打开/关闭/重命名
- 保存/导出
- 文件类型检测

✅ **分析功能：**
- 文档分析（字数、段落等）
- 大纲生成
- 上下文检测

## 🚀 实施计划

### Phase 1: 恢复关键组件（10 分钟）
- [ ] 恢复 `PdfPreview.tsx`（简化版）
- [ ] 恢复 `HeartbeatIndicator.tsx`（简单指示器）
- [ ] 更新导入

### Phase 2: 改进聊天集成（15 分钟）
- [ ] 用 `ChatArea` 替代 `UnifiedChatInterface`
- [ ] 保留所有聊天逻辑
- [ ] 集成 LangGraph SDK

### Phase 3: 清理和优化（10 分钟）
- [ ] 移除已删除组件的调用
- [ ] 优化导入
- [ ] 测试编译

## 📊 预期结果

```
FullEditorV2.tsx
├── ✅ 左侧文件树 - WorkspaceFileTree
├── ✅ 中间编辑区 - 多标签编辑器
│   ├── ✅ 编辑/预览/分割视图
│   ├── ✅ AI 写作工具
│   ├── ✅ 招投标功能
│   └── ✅ 教卡管理
├── ✅ 右侧对话 - ChatArea（LangGraph SDK）
│   ├── ✅ 流式聊天
│   ├── ✅ 工具调用
│   └── ✅ 上下文感知
└── ✅ 底部状态栏 - 编辑状态指示
```

## 💾 优化原则

1. **保留核心业务逻辑** - 不改变现有功能
2. **使用 LangChain 标准** - 聊天集成改用 LangGraph SDK
3. **最小化导入** - 只恢复必要的组件
4. **简化辅助功能** - 复杂功能改为简化版本
5. **兼容现有流程** - 不破坏工作流程

