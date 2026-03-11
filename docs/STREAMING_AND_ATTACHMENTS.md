# 聊天流式输出与上下文附件

本文说明聊天面板流式输出、以及 Composer 上下文附件（工作区文件/文件夹等）的实现与优化。

## 1. 流式输出

### 1.1 前端行为

- **streamMode**（`langserveChat.ts`）：默认 `["messages", "custom", "values"]`。
  - `messages`：期望后端按 token/消息片段推送，用于逐字显示。
  - `custom`：工具进度、agent_thinking、context_stats 等。
  - `values`：每步完整状态；前端将 `values` 转为 `updates`，用于在**无 token 流**时至少按步更新消息。

- **事件处理**（`MyRuntimeProvider.tsx`）：
  - 仅 yield 主图消息（`messages` / `messages/partial` / `messages/complete`），子图命名空间事件不 yield，避免重复。
  - `values`：兼容 `event.data.messages` 与 `event.data.values?.messages`，转成 `updates` 供 `useLangGraphMessages` 更新 UI。
  - `metadata` / `custom`：转发给库或用于 context_stats、进度条等。

### 1.2 后端与 token 级流式

- 主图使用 `agent.astream()`（`main_graph.py`），子图（DeepAgent）内部由 LangGraph 负责流式。
- **若出现「一直思考再一次性出结果」**：多半是后端/LangGraph 只在该步结束时推送整条消息，未按 token 推送。
- 真正逐 token 流式需要：
  - 图内 LLM 调用使用流式（如 `streaming=True`），且
  - LangGraph Server 在 `stream_mode="messages"` 下将子图流正确转换为 `messages/partial`。
- 验收方式：运行 `backend/test_streaming.py`，确认 `stream_mode="messages"` 时能收到 `messages/partial` 事件。

## 2. 上下文附件（Composer 添加上下文）

### 2.1 入口

- 输入框旁 **「+」→ 添加上下文** 下拉：
  - **添加文件**：本地上传，走 `/files/upload`，成功后加入 `context_items`（path 为服务端路径）。
  - **从工作区选择文件**：弹窗列出**当前已打开**的工作区文件（排除 `/untitled-*`），选一个即作为「文件」类型上下文加入。
  - **添加文件夹**：Electron 下弹出系统目录选择；选中的目录路径作为「文件夹」类型上下文加入。
  - **添加代码片段**：由编辑器响应 `get_selected_code`，把当前选中或当前文件内容加入。
  - **添加网页链接 / 从知识库引用 / 添加图片**：各自独立逻辑。

### 2.2 事件与监听

| 事件名 | 发起方 | 监听方 | 说明 |
|--------|--------|--------|------|
| `open_workspace_file_picker` | Composer | FullEditorV2Enhanced | 弹窗列出已打开文件，回调 `(path, name)` 加入上下文 |
| `open_folder_picker` | Composer | FullEditorV2Enhanced | Electron `selectDirectory()`，回调 `(folderPath, folderName)` |
| `get_selected_code` | Composer | FullEditorV2Enhanced | 回调 `(code, filePath, lineRange)` 加入代码片段 |

### 2.3 工作区文件选择为空时

- 弹窗提示：「请先在左侧文件树中打开要附加的文件，或使用下方「添加文件」从本地上传。」

## 3. 相关文件

- 前端：`frontend/desktop/src/components/ChatComponents/cursor-style-composer.tsx`（入口）、`MyRuntimeProvider.tsx`（流式 yield）、`FullEditorV2Enhanced.tsx`（工作区文件/文件夹弹窗与事件监听）、`lib/api/langserveChat.ts`（streamMode）。
- 后端：`backend/engine/core/main_graph.py`（deepagent 节点 astream）、`backend/test_streaming.py`（流式验收）。
