# 完整前端文件保留清单（基于用户视角）

## 📋 Dashboard 页面相关

### ✅ 必须保留
```
src/components/
├── Dashboard.tsx               # ✅ 主仪表盘 (需要清理 Run 相关代码)
├── CommandPalette.tsx          # ✅ 命令面板 (Cmd+K)
├── NotificationCenter.tsx      # ✅ 通知中心
└── WelcomeGuide.tsx           # ✅ 欢迎引导
```

### ❌ 删除 (调试/开发工具)
```
src/components/
├── RunnerPanel.tsx            # ❌ 运行面板 (调试用)
├── DebugCenter.tsx            # ❌ 调试中心
└── DebugPanel/                # ❌ 调试面板文件夹
```

---

## 📋 主编辑页面相关

### ✅ 核心组件 (必须保留)
```
src/components/
├── MainEditorPage.tsx          # ✅ 主编辑页面布局
├── FullEditorV2.tsx           # ✅ 编辑器主体 (你会手动精简)
├── WorkspaceFileTree.tsx       # ✅ 左边栏：文件树
├── FileSystemBrowser.tsx       # ✅ 文件浏览器
├── WorkspaceManager.tsx        # ✅ 工作区管理器
└── WorkspaceModeSelector.tsx   # ✅ 工作区模式选择
```

### ✅ 聊天对话组件 (右边栏)
```
src/components/
├── ChatArea.tsx               # ✅ 聊天区域主组件
└── ChatComponents/            # ✅ LangGraph 聊天组件 (完整保留)
    ├── MyRuntimeProvider.tsx
    ├── thread.tsx
    ├── thread-list.tsx
    ├── markdown-text.tsx
    ├── attachment.tsx
    ├── tool-fallback.tsx
    ├── tooltip-icon-button.tsx
    └── index.ts
```

### ✅ 编辑器辅助功能
```
src/components/
├── PdfPreview.tsx             # ✅ PDF 预览
├── MediaViewer.tsx            # ✅ 媒体查看器
├── HeartbeatIndicator.tsx     # ✅ 连接状态指示器
├── DiffModal.tsx              # ✅ 差异对比
└── LoadingStates.tsx          # ✅ 加载状态
```

### ⚠️ 评估保留 (你决定)
```
src/components/
├── TaskBar.tsx                # ⚠️ 任务栏 - 用户需要吗？
├── TaskLane.tsx               # ⚠️ 任务泳道 - 用户需要吗？
├── CitationCard.tsx           # ⚠️ 引用卡片 - 用户需要吗？
└── RiskPanel.tsx              # ⚠️ 风险面板 - 用户需要吗？
```

### ❌ 删除 (冗余/旧版)
```
src/components/
├── EditorWithChat.tsx         # ❌ 旧版编辑器
├── EnhancedChatPage.tsx       # ❌ 旧版聊天页面
├── SidebarChatV2.tsx          # ❌ 旧版侧边栏聊天
├── MicroFaceV2.tsx            # ❌ 浮动小窗
├── UnifiedChatInterface.tsx   # ❌ 已被 ChatComponents 替代
├── ChatMessageDisplay.tsx     # ❌ 旧版消息显示
├── ImprovedMessageDisplay.tsx # ❌ 旧版改进消息显示
├── MessageCard.tsx            # ❌ 旧版消息卡片
├── MessageRenderer.tsx        # ❌ 旧版消息渲染器
├── ChatEventRenderer.tsx      # ❌ 旧版事件渲染器
├── ChatInput.tsx              # ❌ 旧版聊天输入
├── ChatBubbles/               # ❌ 旧版聊天气泡
├── AIAssistantPanel.tsx       # ❌ 旧版 AI 助手面板
└── common/UnifiedMessageRenderer.tsx # ❌ 已被 ChatComponents 替代
```

---

## 📋 配置/设置相关

### ✅ 必须保留
```
src/components/
├── SettingsDialog.tsx         # ✅ 设置对话框
├── PermissionModal.tsx        # ✅ 权限模态框
└── WorkspaceSelector.tsx      # ✅ 工作区选择器
```

---

## 📋 搜索/文件相关

### ✅ 必须保留
```
src/components/
├── FileUploadZone.tsx         # ✅ 文件上传区域
└── FileSync/                  # ✅ 文件同步相关 (评估内容后决定)
```

---

## 📋 招投标业务相关

### ⚠️ 评估保留
```
src/components/
├── BidWizard.tsx              # ⚠️ 招投标向导 - 核心业务功能
├── DomainManager.tsx          # ⚠️ 领域管理器
├── KnowledgeBasePanel.tsx     # ⚠️ 知识库面板
├── TemplatePanel.tsx          # ⚠️ 模板面板
└── TeachcardMarket.tsx        # ⚠️ Teachcard 市场
```

**建议**: 这些业务组件保留，但需要确认是否都集成到 Dashboard 或主编辑页面

---

## 📋 其他组件

### ✅ 保留
```
src/components/
├── AppContext.tsx             # ✅ 全局上下文
├── AnimatedSparkles.tsx       # ✅ 动画效果
├── VoiceWaveform.tsx          # ✅ 语音波形
└── WindowManager.tsx          # ✅ 窗口管理器
```

### ✅ 通用组件
```
src/components/common/
├── ConnectionStatus.tsx       # ✅ 连接状态
├── ErrorBoundary.tsx         # ✅ 错误边界
├── UnifiedChatInput.tsx      # ✅ 统一聊天输入 (如果 ChatComponents 没有则保留)
├── UnifiedChatLayout.tsx     # ✅ 统一聊天布局 (如果 ChatComponents 没有则保留)
└── index.ts
```

### ❌ 删除
```
src/components/
├── Editor/                   # ❌ 旧版编辑器文件夹
├── figma/                    # ❌ Figma 相关
├── UserProfile/              # ❌ 用户资料 (如果没用到)
└── WPSConnector.tsx         # ❌ WPS 连接器 (如果没用到)
```

---

## 📋 UI 组件库 (Shadcn UI)

### ✅ 完全保留
```
src/components/ui/             # ✅ 完整保留所有 Shadcn UI 组件
├── accordion.tsx
├── alert-dialog.tsx
├── alert.tsx
├── avatar.tsx
├── badge.tsx
├── button.tsx
├── calendar.tsx              # ✅ Dashboard 日历显示需要
├── card.tsx
├── dialog.tsx
├── dropdown-menu.tsx
├── input.tsx
├── textarea.tsx
├── scroll-area.tsx
├── separator.tsx
├── tabs.tsx
├── ... (所有其他 UI 组件)
└── utils.ts
```

---

## 📋 API 文件

### ✅ 核心 API (必须保留)
```
src/lib/api/
├── langserveAdapter.ts        # ✅ LangServe 适配器 (或使用 langserveChat.ts)
├── chat.ts                    # ✅ 聊天 API
├── chatAdapter.ts             # ✅ 聊天适配器
├── workspace.ts               # ✅ 工作区 API
├── client.ts                  # ✅ API 客户端
├── errors.ts                  # ✅ 错误处理
├── editor.ts                  # ✅ 编辑器 API
└── index.ts                   # ✅ 导出文件
```

### ✅ 业务 API
```
src/lib/api/
├── knowledge.ts               # ✅ 知识库 API
├── domain.ts                  # ✅ 领域 API
├── teachcards.ts              # ✅ Teachcard API
├── docmap.ts                  # ✅ 文档映射 API
└── km.ts                      # ✅ 知识管理 API
```

### ✅ 文件/搜索 API
```
src/lib/api/
├── attachments.ts             # ✅ 附件 API
└── search.ts                  # ✅ 搜索 API
```

### ⚠️ 评估保留
```
src/lib/api/
├── ui-message-adapter.ts      # ⚠️ UI 消息适配器 - 评估是否与 ChatComponents 冲突
├── backendAdapter.ts          # ⚠️ 后端适配器 - 评估是否需要
└── v1.ts                      # ⚠️ V1 API - 评估是否还在用
```

### ❌ 删除 (调试/开发工具)
```
src/lib/api/
├── runs.ts                    # ❌ 运行 API (调试用)
├── jobs.ts                    # ❌ 任务 API (调试用)
├── runtime.ts                 # ❌ 运行时 API (调试用)
├── actuator.ts                # ❌ 执行器 API (调试用)
├── audit.ts                   # ❌ 审计 API (调试用)
├── telemetry.ts               # ❌ 遥测 API (调试用)
├── local_agent.ts             # ❌ 本地代理 API (调试用)
├── discovery.ts               # ❌ 发现 API (调试用)
├── control.ts                 # ❌ 控制 API (调试用)
├── memory.ts                  # ❌ 内存 API (调试用)
├── permissions.ts             # ❌ 权限 API (如果没用到)
├── env.ts                     # ❌ 环境 API (如果没用到)
└── brain.ts                   # ❌ Brain API (如果没用到)
```

---

## 📋 工具/服务文件

### ✅ 必须保留
```
src/lib/
├── constants.ts               # ✅ 常量定义
├── fileUtils.ts              # ✅ 文件工具
├── taskConfig.ts             # ✅ 任务配置
├── taskUtils.ts              # ✅ 任务工具
└── hooks/
    └── useAPI.ts             # ✅ API Hook
```

### ✅ 服务
```
src/lib/services/
└── unifiedFileService.ts     # ✅ 统一文件服务
```

### ✅ 上下文系统
```
src/lib/context/              # ✅ 完整保留
├── api-enhancer.ts
├── detector.ts
├── manager.ts
├── types.ts
└── index.ts
```

### ✅ 插件系统
```
src/lib/plugins/              # ✅ 完整保留
├── index.ts
├── manager.ts
├── types.ts
└── builtin/
    ├── core-analysis.ts
    ├── core-writing.ts
    ├── domain-tender.ts
    └── index.ts
```

### ✅ 工作区系统
```
src/lib/workspace/            # ✅ 完整保留
├── detector.ts
└── index.ts
```

### ✅ 事件系统
```
src/lib/events/
└── fileEvents.ts             # ✅ 文件事件
```

### ✅ 工具函数
```
src/lib/utils/
├── api-helpers.ts            # ✅ API 辅助函数
├── formatters.ts             # ✅ 格式化工具
└── index.ts
```

### ✅ 类型定义
```
src/lib/types/
└── message-types.ts          # ✅ 消息类型
```

### ⚠️ 评估保留
```
src/lib/
├── audio/                    # ⚠️ 音频相关 - 如果有语音功能则保留
│   ├── recorder.ts
│   └── tts.ts
├── file-sync/                # ⚠️ 文件同步 - 评估是否与 unifiedFileService 重复
└── debug/                    # ❌ 调试相关 - 删除
```

---

## 📋 样式文件

### ✅ 必须保留
```
src/styles/
└── globals.css               # ✅ 全局样式
```

---

## 📊 最终文件统计

### 组件文件
- ✅ **必须保留**: ~25-30 个
- ⚠️ **评估保留**: ~10-15 个 (你决定)
- ❌ **删除**: ~30-40 个

### API 文件
- ✅ **必须保留**: ~10-12 个
- ⚠️ **评估保留**: ~3-5 个
- ❌ **删除**: ~15-20 个

### 工具/服务文件
- ✅ **必须保留**: ~20-25 个
- ⚠️ **评估保留**: ~5-8 个
- ❌ **删除**: ~3-5 个

### 总计
- **保留**: ~60-75 个文件 (从 150+ 精简)
- **删除**: ~80-100 个文件

---

## 🔧 需要你手动修改的文件

### 1. FullEditorV2.tsx (优先级 1)
**你需要删除**:
- [ ] 所有调试相关代码
- [ ] 旧版聊天逻辑 (保留与 ChatComponents 集成的部分)
- [ ] 冗余的状态管理
- [ ] 未使用的导入
- [ ] 注释掉的代码块

**保留**:
- [ ] 文件标签管理
- [ ] 编辑器核心功能
- [ ] 工具栏
- [ ] 状态栏
- [ ] 与 ChatArea 的集成接口

### 2. Dashboard.tsx (优先级 2)
**你需要删除**:
- [ ] RunnerPanel 相关代码
- [ ] DebugCenter 相关代码
- [ ] 所有调试/运行 API 调用
- [ ] runs, jobs, telemetry 相关逻辑

**保留**:
- [ ] 工作区显示
- [ ] 日历显示
- [ ] 统计卡片
- [ ] 快速操作按钮
- [ ] 通知中心集成

### 3. MainEditorPage.tsx (优先级 3)
**你需要修改**:
- [ ] 确保使用 FullEditorV2 (精简后)
- [ ] 确保使用 ChatArea + ChatComponents
- [ ] 确保使用 WorkspaceFileTree
- [ ] 删除旧版聊天组件引用

### 4. ChatArea.tsx (优先级 4)
**你需要确保**:
- [ ] 使用 ChatComponents/MyRuntimeProvider
- [ ] 使用 ChatComponents/thread.tsx
- [ ] 删除旧版聊天逻辑
- [ ] 集成 langserveChat.ts 或 langserveAdapter.ts

### 5. App.tsx (优先级 5)
**你需要修改**:
- [ ] 删除所有旧版页面引用
- [ ] 只保留 Dashboard 和 MainEditorPage
- [ ] 简化路由逻辑
- [ ] 删除调试相关导入

---

## ⚠️ 需要特别评估的业务组件

请你决定这些是否需要保留:

1. **BidWizard.tsx** - 招投标向导
   - 如果是核心业务流程 → 保留
   - 如果很少用 → 删除或延后

2. **DomainManager.tsx** - 领域管理器
   - 如果用户需要管理领域 → 保留
   - 如果是后台管理功能 → 删除

3. **KnowledgeBasePanel.tsx** - 知识库面板
   - 如果用户需要查看知识库 → 保留
   - 如果只是后台功能 → 删除

4. **TemplatePanel.tsx** - 模板面板
   - 如果用户需要使用模板 → 保留
   - 如果很少用 → 删除

5. **TeachcardMarket.tsx** - Teachcard 市场
   - 如果是核心功能 → 保留
   - 如果是次要功能 → 删除

6. **TaskBar/TaskLane** - 任务管理
   - 如果用户需要任务看板 → 保留
   - 如果只是内部工具 → 删除

---

## 🎯 执行步骤建议

### 你先做：
1. **精简 FullEditorV2.tsx** (删除 30-50% 代码)
2. **清理 Dashboard.tsx** (删除 Run/Debug 相关)
3. **决定业务组件** (上面 6 个组件的去留)
4. **清理 App.tsx** (简化到最简)
5. **检查 ChatArea.tsx** (确保用 ChatComponents)

### 我再做：
1. 删除所有标记为 ❌ 的文件
2. 检查并修复所有导入错误
3. 确保三栏布局正常工作
4. 集成 ChatComponents
5. 测试整体功能

---

## 📝 文件清单检查表

复制这个清单，标记你的决定：

```
### 业务组件决定
- [ ] BidWizard.tsx - 保留/删除
- [ ] DomainManager.tsx - 保留/删除
- [ ] KnowledgeBasePanel.tsx - 保留/删除
- [ ] TemplatePanel.tsx - 保留/删除
- [ ] TeachcardMarket.tsx - 保留/删除
- [ ] TaskBar.tsx + TaskLane.tsx - 保留/删除

### 可选功能决定
- [ ] CitationCard.tsx - 保留/删除
- [ ] RiskPanel.tsx - 保留/删除
- [ ] audio/ (语音功能) - 保留/删除
- [ ] VoiceWaveform.tsx - 保留/删除

### 你已完成的精简工作
- [ ] FullEditorV2.tsx 精简完成
- [ ] Dashboard.tsx 清理完成
- [ ] App.tsx 简化完成
- [ ] ChatArea.tsx 检查完成
- [ ] MainEditorPage.tsx 修改完成
```

准备好后告诉我，我开始执行文件删除和集成工作！

