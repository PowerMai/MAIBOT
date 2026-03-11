# 前端文件保留清单

## ✅ 必须保留的核心文件

### 1. 主页面组件 (必须)
```
src/components/
├── App.tsx                      # 主应用入口 (需要重写，简化逻辑)
├── Dashboard.tsx                # 仪表盘页面 (保留，清理无效API调用)
├── MainEditorPage.tsx           # 主编辑页面 (保留)
├── FullEditorV2.tsx            # ❌ 删除 - 问题太多，需要重写
└── AppContext.tsx               # 全局上下文 (保留)
```

### 2. LangChain 集成组件 (必须保留)
```
src/components/ChatComponents/   # ✅ 从 assistant-ui 移植，完全保留
├── MyRuntimeProvider.tsx        # LangGraph SDK Runtime Provider
├── thread.tsx                   # 聊天线程组件
├── thread-list.tsx              # 线程列表
├── markdown-text.tsx            # Markdown 渲染
├── attachment.tsx               # 文件附件
├── tool-fallback.tsx           # 工具回退
├── tooltip-icon-button.tsx     # 工具提示按钮
└── index.ts                     # 导出文件
```

### 3. 工作区/文件管理组件 (必须)
```
src/components/
├── WorkspaceFileTree.tsx        # ✅ 工作区文件树
├── FileSystemBrowser.tsx        # ✅ 文件系统浏览器
└── FileUploadZone.tsx           # ✅ 文件上传区域
```

### 4. 聊天相关组件
```
src/components/
├── ChatArea.tsx                 # ✅ 聊天区域 (使用 ChatComponents)
├── UnifiedChatInterface.tsx     # ❌ 删除 - 已被 ChatComponents 替代
└── common/
    ├── UnifiedChatInput.tsx     # ⚠️ 评估是否被 ChatComponents 替代
    ├── UnifiedChatLayout.tsx    # ⚠️ 评估是否被 ChatComponents 替代
    └── UnifiedMessageRenderer.tsx # ❌ 删除 - ChatComponents 已有
```

### 5. UI 基础组件 (Shadcn UI - 全部保留)
```
src/components/ui/              # ✅ 完全保留，这是 Shadcn UI 组件库
├── button.tsx
├── input.tsx
├── textarea.tsx
├── dialog.tsx
├── dropdown-menu.tsx
├── card.tsx
├── badge.tsx
├── avatar.tsx
├── scroll-area.tsx
├── separator.tsx
├── tabs.tsx
├── ... (所有其他 UI 组件)
└── utils.ts                    # UI 工具函数
```

### 6. 通用组件
```
src/components/common/
├── ConnectionStatus.tsx         # ✅ 连接状态指示器
├── ErrorBoundary.tsx           # ✅ 错误边界
└── index.ts                    # 导出文件
```

### 7. 辅助组件
```
src/components/
├── SettingsDialog.tsx           # ✅ 设置对话框
├── HeartbeatIndicator.tsx       # ✅ 心跳指示器
├── PdfPreview.tsx              # ✅ PDF 预览
├── NotificationCenter.tsx       # ✅ 通知中心
└── AnimatedSparkles.tsx        # ✅ 动画效果
```

---

## ✅ 必须保留的 API/工具文件

### 1. LangChain/LangGraph 集成
```
src/lib/api/
├── langserveChat.ts            # ✅ LangGraph SDK 聊天 API (必须)
├── chat.ts                     # ⚠️ 评估是否与 langserveChat 重复
└── index.ts                    # 导出文件
```

### 2. 工作区管理
```
src/lib/api/
└── workspace.ts                # ✅ 工作区 API (必须)
```

### 3. 基础工具
```
src/lib/
├── constants.ts                # ✅ 常量定义
├── fileUtils.ts                # ✅ 文件工具
└── utils/
    ├── api-helpers.ts          # ✅ API 辅助函数
    ├── formatters.ts           # ✅ 格式化工具
    └── index.ts
```

### 4. 文件同步服务
```
src/lib/services/
└── unifiedFileService.ts       # ✅ 统一文件服务
```

### 5. 事件系统
```
src/lib/events/
└── fileEvents.ts               # ✅ 文件事件
```

### 6. 插件系统
```
src/lib/plugins/                # ✅ 完全保留
├── index.ts
├── manager.ts
├── types.ts
└── builtin/
    ├── core-analysis.ts
    ├── core-writing.ts
    ├── domain-tender.ts
    └── index.ts
```

---

## ❌ 可以删除的文件

### 1. 冗余的聊天组件
```
src/components/
├── UnifiedChatInterface.tsx     # ❌ 已被 ChatComponents 替代
└── common/
    └── UnifiedMessageRenderer.tsx # ❌ ChatComponents 已有 markdown-text.tsx
```

### 2. 问题组件
```
src/components/
└── FullEditorV2.tsx            # ❌ 删除 - 重新实现为 SimpleEditor.tsx
```

### 3. 可能冗余的 API 文件 (需评估)
```
src/lib/api/
├── chat.ts                     # ⚠️ 如果与 langserveChat.ts 功能重复则删除
├── runs.ts                     # ⚠️ 评估是否需要
└── env.ts                      # ⚠️ 评估是否需要
```

### 4. 未使用的工具文件夹
```
src/lib/
├── editor/                     # ⚠️ 评估内容
├── hooks/                      # ⚠️ 评估内容
└── file-sync/                  # ⚠️ 评估是否与 services/unifiedFileService 重复
```

---

## 📝 需要新建的简化组件

### 1. 简化的编辑器组件
```
src/components/
└── SimpleEditor.tsx            # 新建 - 替代 FullEditorV2
    - 基础 Textarea 编辑器
    - 文件标签管理
    - 基础工具栏
    - 状态栏
```

---

## 🔧 需要修改的文件

### 1. App.tsx
- ✅ 保留 Dashboard 和 Editor 切换
- ✅ 简化状态管理
- ✅ 使用 SimpleEditor 替代 FullEditorV2

### 2. MainEditorPage.tsx
- ✅ 保留三栏布局
- ✅ 左：WorkspaceFileTree
- ✅ 中：SimpleEditor (新组件)
- ✅ 右：ChatArea (使用 ChatComponents)

### 3. Dashboard.tsx
- ✅ 注释掉所有无效的 API 调用
- ✅ 保留基础 UI 结构
- ✅ Run 相关功能暂时禁用

### 4. ChatArea.tsx
- ✅ 确保使用 ChatComponents/MyRuntimeProvider
- ✅ 确保使用 ChatComponents/thread.tsx
- ✅ 清理旧的聊天逻辑

---

## 📋 执行步骤

### 第一步：清理文件
```bash
# 删除冗余组件
rm src/components/UnifiedChatInterface.tsx
rm src/components/common/UnifiedMessageRenderer.tsx

# 备份 FullEditorV2 (可选)
mv src/components/FullEditorV2.tsx src/components/FullEditorV2.backup.tsx
```

### 第二步：评估可选文件
1. 检查 `src/lib/api/chat.ts` 是否与 `langserveChat.ts` 重复
2. 检查 `src/lib/hooks/`, `src/lib/editor/`, `src/lib/file-sync/` 是否有用
3. 决定保留或删除

### 第三步：创建新组件
1. 创建 `SimpleEditor.tsx` (简化的编辑器)
2. 修改 `MainEditorPage.tsx` 使用新编辑器
3. 修改 `App.tsx` 简化状态管理

### 第四步：测试验证
1. Dashboard 页面渲染
2. MainEditorPage 三栏布局
3. 左边栏文件管理
4. 中间编辑器
5. 右边栏聊天

---

## ✨ 最终文件结构 (简化版)

```
src/
├── components/
│   ├── App.tsx                      # 主入口 (简化)
│   ├── Dashboard.tsx                # 仪表盘 (清理)
│   ├── MainEditorPage.tsx           # 主编辑页 (保留)
│   ├── SimpleEditor.tsx             # 新建简化编辑器
│   ├── ChatArea.tsx                 # 聊天区域
│   ├── WorkspaceFileTree.tsx        # 文件树
│   ├── FileSystemBrowser.tsx
│   ├── FileUploadZone.tsx
│   ├── SettingsDialog.tsx
│   ├── HeartbeatIndicator.tsx
│   ├── PdfPreview.tsx
│   ├── NotificationCenter.tsx
│   ├── AnimatedSparkles.tsx
│   ├── AppContext.tsx
│   ├── ChatComponents/              # LangChain 组件 (完整)
│   │   ├── MyRuntimeProvider.tsx
│   │   ├── thread.tsx
│   │   ├── thread-list.tsx
│   │   ├── markdown-text.tsx
│   │   ├── attachment.tsx
│   │   ├── tool-fallback.tsx
│   │   ├── tooltip-icon-button.tsx
│   │   └── index.ts
│   ├── common/
│   │   ├── ConnectionStatus.tsx
│   │   ├── ErrorBoundary.tsx
│   │   ├── UnifiedChatInput.tsx     # 评估保留
│   │   └── index.ts
│   └── ui/                          # Shadcn UI (完整)
│       └── ... (所有 UI 组件)
├── lib/
│   ├── api/
│   │   ├── langserveChat.ts         # LangGraph SDK
│   │   ├── workspace.ts
│   │   └── index.ts
│   ├── services/
│   │   └── unifiedFileService.ts
│   ├── events/
│   │   └── fileEvents.ts
│   ├── plugins/                     # 完整
│   │   ├── index.ts
│   │   ├── manager.ts
│   │   ├── types.ts
│   │   └── builtin/
│   ├── utils/
│   │   ├── api-helpers.ts
│   │   ├── formatters.ts
│   │   └── index.ts
│   ├── constants.ts
│   └── fileUtils.ts
├── styles/
│   └── globals.css
└── App.tsx

保留文件总数: ~30-40 个核心文件 (从 100+ 减少到精简版)
```

---

## 🎯 关键原则

1. **ChatComponents 是核心** - 从 assistant-ui 移植，完全符合 LangGraph 架构，不要动
2. **Shadcn UI 完全保留** - 这是成熟的 UI 组件库
3. **删除所有冗余** - UnifiedChatInterface, FullEditorV2 等有问题的组件
4. **保持简单** - 新的 SimpleEditor 只需基础功能
5. **LangChain 优先** - 所有实现优先使用 LangChain/LangGraph 官方方法

这个方案可行吗？

