# MyRuntimeProvider 最终实现 - 完全符合官方标准

## 核心改进

### 1. 移除手动创建 thread 的逻辑 ✅

**之前（错误）**：
```typescript
// ❌ 手动检查并创建 thread
const { externalId } = await initialize();
if (!externalId) {
  const createResult = await createThreadFunc();
  externalId = createResult.externalId;
}
```

**现在（正确）**：
```typescript
// ✅ 完全依赖 initialize()
const { externalId } = await initialize();
if (!externalId) throw new Error("Thread not found");
```

**原因**：
- `ThreadList` 组件已经负责管理 thread 生命周期
- `initialize()` 会自动调用 `create()`（当需要时）
- 不需要手动干预

### 2. 简化代码结构 ✅

**代码行数**：245 行 → 196 行（减少 20%）

**移除的冗余代码**：
- ❌ `createThreadFunc` 函数定义
- ❌ 手动创建 thread 的逻辑
- ❌ 过多的 console.log
- ❌ 复杂的条件判断

**保留的核心功能**：
- ✅ 编辑器上下文传递
- ✅ 用户上下文传递
- ✅ 文件上传处理
- ✅ 流式输出

### 3. 完全符合官方标准 ✅

#### 官方示例
```typescript
const runtime = useLangGraphRuntime({
  stream: async function* (messages, { initialize }) {
    const { externalId } = await initialize();
    if (!externalId) throw new Error("Thread not found");
    
    const generator = sendMessage({ threadId: externalId, messages });
    yield* generator;
  },
  create: async () => {
    const { thread_id } = await createThread();
    return { externalId: thread_id };
  },
  load: async (externalId) => {
    const state = await getThreadState(externalId);
    return { messages: state.values.messages ?? [], interrupts: ... };
  },
});
```

#### 我们的实现
```typescript
const runtime = useLangGraphRuntime({
  stream: async function* (messages, { initialize }) {
    const { externalId } = await initialize();
    if (!externalId) throw new Error("Thread not found");
    
    // ✅ 增强：添加 UI 上下文
    const enhancedMessages = [...messages];
    // 添加 editorContext 和 userContext
    
    const generator = sendMessage({ threadId: externalId, messages: enhancedMessages });
    yield* generator;
  },
  create: async () => {
    // ✅ 增强：添加用户元数据
    const thread = await createThread({ metadata: { user_id, team_id, ... } });
    return { externalId: thread.thread_id };
  },
  load: async (externalId) => {
    const state = await getThreadState(externalId);
    return { messages: state.values.messages ?? [], interrupts: ... };
  },
  // ✅ 增强：附件处理
  adapters: { attachments: { add, send, remove } },
});
```

**对比结论**：
- ✅ 核心结构 100% 一致
- ✅ 在官方标准基础上增强（UI 上下文、附件）
- ✅ 没有破坏官方机制

## 完整代码

### MyRuntimeProvider.tsx（196 行）

```typescript
"use client";

import React from "react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useLangGraphRuntime } from "@assistant-ui/react-langgraph";
import { createThread, getThreadState, sendMessage } from "../../lib/api/langserveChat";
import { LangChainMessage } from "@assistant-ui/react-langgraph";
import { getUserContext } from "../../lib/hooks/useUserContext";

const LANGGRAPH_API_URL = (import.meta as any).env?.VITE_LANGGRAPH_API_URL || 'http://localhost:2024';

interface MyRuntimeProviderProps {
  children: React.ReactNode;
  editorContext?: {
    editorContent?: string;
    editorPath?: string;
    selectedText?: string;
    workspaceFiles?: string[];
    workspacePath?: string;
    workspaceId?: string;
  };
  onFileAction?: (action: {
    type: 'open' | 'refresh' | 'close';
    filePath: string;
    content?: string;
  }) => void;
}

export function MyRuntimeProvider({
  children,
  editorContext,
  onFileAction,
}: MyRuntimeProviderProps) {
  const runtime = useLangGraphRuntime({
    // ✅ stream() - 发送消息时被调用
    stream: async function* (messages, { initialize }) {
      console.log('[MyRuntimeProvider] 📨 stream() 开始');
      
      // ✅ initialize() 会自动调用 create()（如果需要）
      const { externalId } = await initialize();
      if (!externalId) throw new Error("Thread not found");
      
      console.log('[MyRuntimeProvider] ✅ Thread ID:', externalId);
      
      // ✅ 增强消息 - 添加 UI 上下文
      const enhancedMessages = [...messages];
      if (enhancedMessages.length > 0) {
        const lastMessage = enhancedMessages[enhancedMessages.length - 1];
        
        if (lastMessage.type === 'human') {
          if (!lastMessage.additional_kwargs) {
            lastMessage.additional_kwargs = {};
          }
          
          // ✅ 添加编辑器上下文
          if (editorContext && (editorContext.selectedText || editorContext.editorPath)) {
            const editorInfo = editorContext.selectedText
              ? {
                  file_path: editorContext.editorPath,
                  selected_text: editorContext.selectedText,
                  context_type: 'selected',
                }
              : {
                  file_path: editorContext.editorPath,
                  context_type: 'file_path_only',
                };
            
            lastMessage.additional_kwargs.editor_context = editorInfo;
            lastMessage.additional_kwargs.workspace_path = editorContext.workspacePath;
            lastMessage.additional_kwargs.workspace_id = editorContext.workspaceId;
          }
          
          // ✅ 添加用户上下文
          const userContext = getUserContext();
          lastMessage.additional_kwargs.user_context = {
            user_id: userContext.userId,
            team_id: userContext.teamId,
            user_name: userContext.userName,
            team_name: userContext.teamName,
          };
        }
      }
      
      // ✅ 发送消息并流式返回
      const generator = sendMessage({
        threadId: externalId,
        messages: enhancedMessages,
      });

      yield* generator;
    },

    // ✅ create() - 创建新 thread（由 initialize() 自动调用）
    create: async () => {
      console.log('[MyRuntimeProvider] 🆕 create() 被调用');
      
      const userContext = getUserContext();
      const thread = await createThread({
        metadata: {
          user_id: userContext.userId,
          team_id: userContext.teamId,
          user_name: userContext.userName,
          team_name: userContext.teamName,
        }
      });
      
      console.log('[MyRuntimeProvider] ✅ Thread 创建:', thread.thread_id);
      return { externalId: thread.thread_id };
    },

    // ✅ load() - 加载已有会话
    load: async (externalId) => {
      console.log('[MyRuntimeProvider] 📂 load():', externalId);
      
      const state = await getThreadState(externalId);
      return {
        messages:
          (state.values as { messages?: LangChainMessage[] }).messages ?? [],
        interrupts: state.tasks[0]?.interrupts ?? [],
      };
    },

    // ✅ 附件处理
    adapters: {
      attachments: {
        accept: "*/*",
        
        async add({ file }) {
          return {
            id: `${Date.now()}_${file.name}`,
            type: file.type.startsWith("image/") ? "image" : "file",
            name: file.name,
            file,
            contentType: file.type,
            content: [],
            status: { type: "requires-action", reason: "composer-send" },
          };
        },
        
        async send(attachment) {
          try {
            const formData = new FormData();
            formData.append("file", attachment.file);
            
            const response = await fetch(`${LANGGRAPH_API_URL}/files`, {
              method: "POST",
              body: formData,
            });
            
            if (!response.ok) {
              throw new Error(`上传失败: ${response.statusText}`);
            }
            
            const data = await response.json();
            const filePath = data.path || `/files/${data.id}`;
            
            return {
              ...attachment,
              status: { type: "complete" as const },
              content: [
                {
                  type: "text" as const,
                  text: `📎 ${attachment.name}\n路径: ${filePath}`,
                },
              ],
            };
          } catch (error) {
            console.error('[MyRuntimeProvider] 文件上传失败:', error);
            throw error;
          }
        },
        
        async remove(attachment) {
          // 移除附件
        },
      },
    },
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children}
    </AssistantRuntimeProvider>
  );
}
```

## 工作流程

### 第一次发送消息

```
用户点击"新建"或直接输入消息
  ↓
ThreadList 触发 switchToNewThread()
  ↓
创建本地 thread（status: "new"）
  ↓
用户发送消息
  ↓
stream() 被调用
  ↓
initialize() 检测到 status === "new"
  ↓
initialize() 调用 create()
  ↓
create() 创建远程 thread
  ↓
返回 { externalId: 'abc123' }
  ↓
stream() 使用 externalId 发送消息
  ↓
流式返回结果
```

### 后续消息

```
用户发送消息
  ↓
stream() 被调用
  ↓
initialize() 返回已有 externalId
  ↓
stream() 使用 externalId 发送消息
  ↓
流式返回结果
```

## 预期日志

### 第一次发送消息
```
[MyRuntimeProvider] 📨 stream() 开始
[MyRuntimeProvider] 🆕 create() 被调用
[MyRuntimeProvider] ✅ Thread 创建: abc123-def456-ghi789
[MyRuntimeProvider] ✅ Thread ID: abc123-def456-ghi789
```

### 第二次发送消息
```
[MyRuntimeProvider] 📨 stream() 开始
[MyRuntimeProvider] ✅ Thread ID: abc123-def456-ghi789
```

**注意**：第二次不会调用 `create()`！

## 关键改进总结

| 项目 | 之前 | 现在 | 改进 |
|------|------|------|------|
| 代码行数 | 245 行 | 196 行 | -20% |
| 手动创建 thread | ❌ 是 | ✅ 否 | 完全依赖官方机制 |
| 符合官方标准 | ⚠️ 部分 | ✅ 完全 | 100% 一致 |
| 日志冗余 | ❌ 多 | ✅ 少 | 只保留关键日志 |
| 代码复杂度 | ❌ 高 | ✅ 低 | 简洁清晰 |
| UI 上下文 | ✅ 支持 | ✅ 支持 | 保持不变 |
| 文件上传 | ✅ 支持 | ✅ 支持 | 保持不变 |

## 结论

✅ **MyRuntimeProvider 现在完全符合 `assistant-ui` 官方标准**

1. ✅ 不再手动创建 thread
2. ✅ 完全依赖 `initialize()` 机制
3. ✅ 代码简洁清晰（减少 20%）
4. ✅ 保留所有增强功能
5. ✅ 与 `ThreadList` 完美配合

**可以测试了！** 🎉

