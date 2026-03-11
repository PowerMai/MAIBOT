# 前端架构分析：FullEditorV2 三栏布局集成方案

## 一、核心架构分析

### 1. 三栏布局需求
```
┌─────────────────────────────────────────┐
│          TopBar (工具栏)                 │
├───────────┬──────────────┬──────────────┤
│           │              │              │
│  Left     │   Middle     │    Right     │
│  Panel    │   Editor     │   ChatArea   │
│  (文件树) │ (编辑器)     │ (AI聊天)     │
│           │              │              │
└───────────┴──────────────┴──────────────┘
```

### 2. 集成需求分析
- **左侧面板**：工作区文件树 + LangGraph 工具选择
- **中间编辑器**：多格式文档编辑 + 生成式UI支持
- **右侧ChatArea**：LangServe集成 + 流式消息处理
- **集成点**：编辑器内容 → ChatArea上下文 → LangGraph工具调用 → 文件更新

---

## 二、推荐库和工具栈

### A. 编辑器组件

#### 1. **Monaco Editor** (推荐用于代码编辑)
```bash
npm install monaco-editor @monaco-editor/react
```
**优势**：
- VS Code核心编辑器，功能强大
- 支持100+语言高亮和智能补全
- 内置TypeScript/JavaScript支持
- 性能优异

**集成示例**：
```tsx
import Editor from "@monaco-editor/react";

<Editor
  height="100%"
  defaultLanguage="python"
  value={fileContent}
  onChange={(value) => setFileContent(value)}
  theme="vs-dark"
  options={{ wordWrap: 'on', minimap: { enabled: false } }}
/>
```

#### 2. **MDEditor** (推荐用于Markdown)
```bash
npm install @uiw/react-md-editor
```
**优势**：
- 轻量级Markdown编辑
- 实时预览
- 支持KaTeX公式、Mermaid图表

#### 3. **TipTap** (推荐用于富文本)
```bash
npm install @tiptap/react @tiptap/starter-kit
```
**优势**：
- 完全可定制
- 支持实时协作
- 轻量级、模块化

---

### B. 文件树/导航组件

#### 1. **rc-tree**
```bash
npm install rc-tree
```
**特点**：React Tree组件，高性能

#### 2. **React Virtual Tree**
```bash
npm install @af-design/react-virtual-tree
```
**特点**：虚拟化大型文件树

---

### C. LangChain/LangGraph 集成

#### 1. **@langchain/langgraph**
```bash
npm install @langchain/langgraph
```
**用于**：
- 定义工作流图
- 文件系统工具集成
- 状态管理

#### 2. **@langchain/core**
```bash
npm install @langchain/core
```
**关键类**：
- `Tool`: 定义可调用工具
- `RunnableSequence`: 链式调用

#### 3. **@assistant-ui/react-langgraph**
```bash
npm install @assistant-ui/react-langgraph
```
**用于**：与ChatArea无缝集成

---

### D. 生成式UI相关

#### 1. **React JSON Schema Form** (@rjsf)
```bash
npm install @rjsf/core @rjsf/mui
```
**用于**：根据JSON Schema动态生成表单

#### 2. **react-markdown** + JSX支持
```bash
npm install react-markdown remark-gfm
```
**用于**：在AI响应中渲染Markdown和JSX

---

## 三、开源项目参考

### 1. **Vercel AI Chatbot**
- GitHub: `vercel-labs/ai-chatbot`
- **参考内容**：ChatArea与编辑器状态管理的集成
- **亮点**：流式消息处理、工具调用集成

### 2. **LangChain Cookbook**
- GitHub: `langchain-ai/langchain`
- **参考路径**：`templates/chat-langchain/`
- **亮点**：LangServe集成示例

### 3. **Assistant UI Examples**
- GitHub: `MakiSugimoto/assistant-ui`
- **参考内容**：@ChatComponents集成方案
- **亮点**：生成式UI实现

### 4. **Code Sandbox / VS Code Online**
- GitHub: `codesandbox/codesandbox-client`
- **参考内容**：多格式编辑器 + 文件管理
- **亮点**：工作空间状态管理

---

## 四、推荐架构设计

### 1. 文件树集成方案

```tsx
// WorkspaceFileTree.tsx - 与LangGraph集成
interface FileNode {
  id: string;
  name: string;
  type: 'file' | 'folder';
  children?: FileNode[];
  langchainToolId?: string; // 与LangGraph工具映射
}

// 关键特性：
- 虚拟化渲染（大文件树性能）
- 拖拽支持
- 右键菜单（创建、删除、重命名）
- 与编辑器同步
```

### 2. 编辑器中间层设计

```tsx
// EditorMiddlePane.tsx
interface EditorState {
  activeFile: {
    id: string;
    content: string;
    format: 'markdown' | 'code' | 'text' | 'json';
    language?: string;
  };
  unsavedChanges: boolean;
  generativeUIComponents: React.ComponentType[];
}

// 集成点：
- 变更检测 → 通知ChatArea
- 选中文本 → 发送给LLM上下文
- AI建议 → 调用编辑器方法
```

### 3. ChatArea与编辑器协作

```tsx
// ChatArea与编辑器的交互
interface ChatEditorContext {
  currentFile: EditorState['activeFile'];
  selectedText: string;
  fileList: FileNode[];
  
  // 回调
  onEditFile: (fileId: string, newContent: string) => void;
  onCreateFile: (path: string, content: string) => void;
  onExecuteCode: (code: string, language: string) => Promise<string>;
}
```

### 4. LangGraph工具定义

```python
# backend/tools/file_operations.py
from langchain_core.tools import tool

@tool
def read_file(file_path: str) -> str:
    """Read file content"""
    pass

@tool  
def write_file(file_path: str, content: str) -> str:
    """Write file content"""
    pass

@tool
def list_files(directory: str) -> list:
    """List files in directory"""
    pass

@tool
def create_file(file_path: str, content: str) -> str:
    """Create new file"""
    pass
```

---

## 五、实现步骤

### Phase 1: 基础编辑器
1. 集成 Monaco Editor
2. 实现文件标签系统
3. 基本保存/加载功能

### Phase 2: 文件管理集成
1. 虚拟化文件树
2. 编辑器 ↔ 文件树同步
3. LangGraph工具映射

### Phase 3: ChatArea集成
1. 编辑器上下文传递
2. 流式消息处理
3. 工具调用反馈

### Phase 4: 生成式UI
1. JSON Schema表单
2. Markdown中的React组件
3. AI代码生成支持

---

## 六、关键库版本推荐

```json
{
  "@monaco-editor/react": "^4.5.0",
  "@uiw/react-md-editor": "^3.0.0",
  "@langchain/langgraph": "^0.0.50",
  "@langchain/core": "^0.1.0",
  "@assistant-ui/react-langgraph": "^0.5.0",
  "@rjsf/core": "^5.0.0",
  "re-resizable": "^6.9.0",
  "react-markdown": "^9.0.0"
}
```

---

## 七、性能优化建议

1. **虚拟化**：使用 `@tanstack/react-virtual` 处理大文件树
2. **代码分割**：编辑器组件按需加载
3. **防抖**：编辑器onChange防抖处理
4. **缓存**：文件内容缓存管理
5. **WebWorker**：大文件解析移至Worker线程

---

## 八、下一步行动

1. 分析 FullEditorV2.tsx 现有结构
2. 提取可复用的部分（布局、状态管理）
3. 替换过时组件为推荐库
4. 实现三栏联动逻辑
5. 集成LangGraph工具系统

