# 🧹 前端文件大清理 - 执行清单

## 📋 要删除的文件清单

### 1️⃣ 旧的聊天系统（完全用 LangGraph SDK 替代）
```
❌ components/ChatBubbles/          # 整个文件夹（旧的气泡）
❌ components/ChatInput.tsx          # 旧的聊天输入
❌ components/ChatEventRenderer.tsx  # 旧的事件渲染
❌ components/UnifiedChatInterface.tsx
❌ components/UnifiedChatLayout.tsx  # → 改用 Thread 布局
❌ components/UnifiedMessageRenderer.tsx
❌ components/OptimizedMessageBubble.tsx
❌ components/MessageCard.tsx
❌ components/MessageRenderer.tsx
❌ components/EnhancedChatPage.tsx
❌ components/EditorWithChat.tsx
```

### 2️⃣ 旧的编辑器变体
```
❌ components/FullEditorV2.tsx       # 改用 MainEditorPage（已包含）
❌ components/Editor/                # 整个文件夹（旧的编辑器）
```

### 3️⃣ 旧的 API 适配器（完全用 LangGraph SDK 替代）
```
❌ lib/api/langserveChat.ts          # 旧的 LangServe 直接调用
❌ lib/api/langserveAdapter.ts       # 旧的适配器
❌ lib/api/backendAdapter.ts
❌ lib/api/chatAdapter.ts            # 旧的聊天适配器
❌ lib/api/ui-message-adapter.ts
❌ lib/api/local_agent.ts
❌ lib/api/v1.ts
❌ lib/api/runtime.ts
❌ lib/api/runs.ts
```

### 4️⃣ 旧的工作区管理（保留简化版）
```
❌ components/WorkspaceManager.tsx   # 重复的管理器
❌ components/WorkspaceModeSelector.tsx
❌ components/WorkspaceSelector.tsx  # 用 WorkspaceFileTree 替代
❌ lib/workspace/                    # 旧的工作区库
```

### 5️⃣ 不需要的功能（市场、教卡、模板等）
```
❌ components/TeachcardMarket.tsx
❌ components/KnowledgeBasePanel.tsx
❌ components/DomainManager.tsx
❌ components/ScheduleTaskDialog.tsx
❌ components/TemplatePanel.tsx
❌ components/AIAssistantPanel.tsx
❌ components/TaskBar.tsx
❌ components/TaskLane.tsx
❌ components/RiskPanel.tsx
❌ components/RunnerPanel.tsx
```

### 6️⃣ 旧的对话框和模态
```
❌ components/CommandPalette.tsx     # 已从 App 移除
❌ components/WelcomeGuide.tsx       # 已从 App 移除
❌ components/DebugCenter.tsx        # 已从 App 移除
❌ components/BidWizard.tsx          # 暂保留，但应简化
❌ components/DebugPanel/            # 调试面板
```

### 7️⃣ 无用的工具组件
```
❌ components/WindowManager.tsx
❌ components/VoiceWaveform.tsx
❌ components/HeartbeatIndicator.tsx
❌ components/LoadingStates.tsx
❌ components/MediaViewer.tsx
❌ components/PdfPreview.tsx
❌ components/DiffModal.tsx
❌ components/FileSync/              # 整个文件夹
❌ components/FileUploadZone.tsx
❌ components/FileSystemBrowser.tsx
❌ components/UserProfile/           # 整个文件夹
❌ components/figma/                 # 整个文件夹
```

### 8️⃣ 冗余的 API 文件
```
❌ lib/api/actuator.ts
❌ lib/api/attachments.ts
❌ lib/api/audit.ts
❌ lib/api/brain.ts
❌ lib/api/control.ts
❌ lib/api/discovery.ts
❌ lib/api/docmap.ts
❌ lib/api/domain.ts
❌ lib/api/editor.ts
❌ lib/api/jobs.ts
❌ lib/api/km.ts
❌ lib/api/knowledge.ts
❌ lib/api/memory.ts
❌ lib/api/permissions.ts
❌ lib/api/search.ts
❌ lib/api/teachcards.ts
❌ lib/api/telemetry.ts
❌ lib/api/client.ts
```

### 9️⃣ 冗余的 hooks（用内置替代）
```
❌ hooks/useChatStream.ts            # 改用 LangGraph SDK
❌ hooks/useChatSession.ts
❌ hooks/useAPI.ts
```

### 🔟 旧的上下文管理
```
❌ lib/context/                      # 整个文件夹（用 App 状态替代）
```

---

## ✅ 要保留的核心文件

### 组件层
```
✅ components/App.tsx               - 顶部路由
✅ components/Dashboard.tsx         - 首页
✅ components/MainEditorPage.tsx    - 完整编辑器（三面板）
✅ components/FullEditorV2.tsx      - 编辑区（嵌入到 MainEditorPage）
✅ components/ChatArea.tsx          - 聊天区（使用 LangGraph SDK）
✅ components/WorkspaceFileTree.tsx - 文件树
✅ components/SettingsDialog.tsx    - 设置
✅ components/common/               - 通用组件（简化）
✅ components/ChatComponents/       - LangGraph 官方组件
✅ components/ui/                   - UI 库（保留）
```

### API 层
```
✅ lib/api/chat.ts                  - LangGraph API 调用（简化）
✅ lib/api/workspace.ts             - 工作区 API
✅ lib/api/index.ts                 - API 入口（更新）
```

### 其他
```
✅ lib/plugins/                     - 插件系统（保留）
✅ lib/audio/                       - 音频工具（可选）
✅ lib/editor/                      - 编辑器工具
✅ lib/fileUtils.ts                 - 文件工具
```

---

## 📊 清理后的结构

```
frontend/desktop/src/
├── components/
│   ├── ui/                 # Shadcn UI 组件库
│   ├── ChatComponents/     # LangGraph 官方组件
│   ├── common/             # 通用组件（ConnectionStatus 等）
│   ├── App.tsx             # 主应用
│   ├── Dashboard.tsx       # 首页
│   ├── MainEditorPage.tsx  # 编辑器主容器
│   ├── FullEditorV2.tsx    # 编辑区
│   ├── ChatArea.tsx        # 聊天区
│   ├── WorkspaceFileTree.tsx
│   ├── SettingsDialog.tsx
│   └── ...（最少化）
├── lib/
│   ├── api/
│   │   ├── chat.ts         # LangGraph API（简化）
│   │   ├── workspace.ts    # 工作区 API
│   │   └── index.ts        # 入口
│   ├── plugins/            # 插件系统
│   ├── hooks/              # 自定义 hooks（删除大部分）
│   ├── audio/              # 音频相关
│   └── ...
└── ...
```

---

## 🔗 对接检查清单

### 后端 (LangGraph Server @ localhost:2024)
- ✅ `/api/threads` - 创建线程
- ✅ `/api/threads/{thread_id}` - 获取线程
- ✅ `/api/runs/{thread_id}/{assistant_id}/stream` - 流式执行

### 前端 (MyRuntimeProvider)
- ✅ 配置 API URL：`http://localhost:2024`
- ✅ 配置 Assistant ID：`orchestrator`（对应后端图名）
- ✅ 所有通信通过 LangGraph SDK

---

## 📈 预期变化

| 指标 | 清理前 | 清理后 | 节省 |
|------|--------|--------|------|
| 组件文件 | ~70 | ~20 | 71% |
| API 文件 | ~30 | ~3 | 90% |
| 总代码行数 | ~25,000 | ~5,000 | 80% |
| 依赖复杂度 | 极高 | 低 | - |
| 启动时间 | 慢 | 快 | ~50% |

---

## 🚀 执行策略

### 第 1 阶段：备份和分析（0.5h）
- ✅ 记录所有组件用途
- ✅ 创建 Git 分支备份
- ✅ 生成依赖关系图

### 第 2 阶段：删除冗余（1h）
- ❌ 删除聊天气泡（用 LangGraph 组件）
- ❌ 删除旧 API 适配器
- ❌ 删除市场、教卡等功能

### 第 3 阶段：重构核心（1h）
- ✅ 改进 ChatArea 使用 LangGraph SDK
- ✅ 修复 MainEditorPage
- ✅ 简化 App.tsx

### 第 4 阶段：验证和测试（1h）
- ✅ 编译检查
- ✅ 前后端对接测试
- ✅ 功能验证

---

## 💾 文件删除脚本（参考）

```bash
# 删除旧的聊天系统
rm -rf src/components/ChatBubbles
rm -f src/components/Chat*.tsx
rm -f src/components/Unified*.tsx
rm -f src/components/Optimized*.tsx
rm -f src/components/Message*.tsx
rm -f src/components/Enhanced*.tsx

# 删除旧的编辑器
rm -rf src/components/Editor
rm -f src/components/EditorWithChat.tsx

# 删除旧的 API
rm -f src/lib/api/langserve*.ts
rm -f src/lib/api/*Adapter.ts
rm -f src/lib/api/local_agent.ts
rm -f src/lib/api/v1.ts
rm -f src/lib/api/runtime.ts

# 删除不需要的功能
rm -f src/components/Teachcard*.tsx
rm -f src/components/Knowledge*.tsx
rm -f src/components/Domain*.tsx
rm -f src/components/Schedule*.tsx
rm -f src/components/Template*.tsx
rm -f src/components/Task*.tsx
rm -f src/components/Risk*.tsx
rm -f src/components/Runner*.tsx
rm -f src/components/Command*.tsx
rm -f src/components/Welcome*.tsx
rm -f src/components/Debug*.tsx
rm -f src/components/Bid*.tsx

# 删除工具组件
rm -f src/components/Window*.tsx
rm -f src/components/Voice*.tsx
rm -f src/components/Heartbeat*.tsx
rm -f src/components/Loading*.tsx
rm -f src/components/Media*.tsx
rm -f src/components/Pdf*.tsx
rm -f src/components/Diff*.tsx
rm -rf src/components/FileSync
rm -rf src/components/UserProfile
rm -rf src/components/figma

# 删除旧的 context
rm -rf src/lib/context
```

---

## ✨ 完成后的优点

1. **代码清晰** - 只有必要的功能
2. **维护简单** - 代码量减少 80%
3. **性能提升** - 启动快 50%
4. **易于扩展** - 清晰的架构
5. **标准集成** - 完全使用 LangChain 生态

---

**下一步**：确认是否应该执行清理？

