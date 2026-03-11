# 工作区和知识库前后端同步实现方案

## 问题分析

### 当前状态
- ✅ 前端：WorkspaceFileTree 可以通过 Electron 读取本地文件
- ✅ 后端：LangGraph Store 已配置（SQLite）
- ✅ 编辑器：FullEditorV2 可以保存单个文件到后端
- ❌ **缺失**：本地文件夹打开后，没有批量上传到后端
- ❌ **缺失**：前后端没有实时同步
- ❌ **缺失**：知识库文件变化后，没有触发后端索引更新

### 需要实现的流程

```
用户操作流程：
1. 用户点击"打开文件夹" → Electron 读取本地文件夹
2. 前端遍历所有文件 → 批量上传到 LangGraph Store
3. 后端接收文件 → 存储到 Store
4. 用户编辑文件 → 前端自动保存到后端
5. 后端文件变化 → 前端自动刷新（可选）
6. 知识库文件变化 → 触发后端重新索引
```

---

## 实现方案

### Step 1: 工作区初始化同步

**文件**: `frontend/desktop/src/lib/workspaceSync.ts`

```typescript
/**
 * 工作区同步管理器
 * 负责将本地文件夹同步到 LangGraph Store
 */
import { Client } from "@langchain/langgraph-sdk";

export class WorkspaceSync {
  private client: Client;
  
  constructor(apiUrl: string) {
    this.client = new Client({ apiUrl });
  }
  
  /**
   * 初始化工作区：上传本地文件夹到后端
   */
  async initializeWorkspace(params: {
    workspaceId: string;
    localPath: string;
    files: Array<{ path: string; content: string }>;
  }): Promise<{ synced: number; failed: number }> {
    let synced = 0;
    let failed = 0;
    
    for (const file of params.files) {
      try {
        // 存储到 LangGraph Store
        await this.client.store.put(
          ['workspaces', params.workspaceId, 'files', file.path],
          {
            path: file.path,
            content: file.content,
            localPath: `${params.localPath}/${file.path}`,
            updatedAt: Date.now(),
          }
        );
        synced++;
      } catch (error) {
        console.error(`上传失败: ${file.path}`, error);
        failed++;
      }
    }
    
    // 更新工作区元数据
    await this.client.store.put(
      ['workspaces', params.workspaceId, 'metadata'],
      {
        id: params.workspaceId,
        localPath: params.localPath,
        fileCount: synced,
        lastSync: Date.now(),
      }
    );
    
    return { synced, failed };
  }
  
  /**
   * 同步单个文件到后端
   */
  async syncFile(params: {
    workspaceId: string;
    filePath: string;
    content: string;
  }): Promise<void> {
    await this.client.store.put(
      ['workspaces', params.workspaceId, 'files', params.filePath],
      {
        path: params.filePath,
        content: params.content,
        updatedAt: Date.now(),
      }
    );
  }
  
  /**
   * 从后端读取文件
   */
  async readFile(params: {
    workspaceId: string;
    filePath: string;
  }): Promise<string | null> {
    try {
      const data = await this.client.store.get(
        ['workspaces', params.workspaceId, 'files', params.filePath]
      );
      return data?.content || null;
    } catch {
      return null;
    }
  }
}
```

### Step 2: 修改 WorkspaceFileTree 集成同步

**文件**: `frontend/desktop/src/components/WorkspaceFileTree.tsx`

在用户选择文件夹后，添加同步逻辑：

```typescript
// 在 handleSelectFolder 函数中，选择文件夹后：
const handleSelectFolder = async () => {
  // ... 现有的 Electron 选择逻辑 ...
  
  if (result.success && result.path) {
    // 1. 加载本地文件树
    await loadLocalFileTree(result.path);
    
    // 2. 读取所有文件内容
    const files = await readAllFilesFromTree(localFileTree);
    
    // 3. 上传到后端
    const workspaceId = `workspace_${Date.now()}`;
    const sync = new WorkspaceSync(LANGGRAPH_API_URL);
    
    toast.info('正在同步文件到后端...');
    const result = await sync.initializeWorkspace({
      workspaceId,
      localPath: result.path,
      files,
    });
    
    toast.success(`同步完成：${result.synced} 个文件`);
  }
};

// 辅助函数：递归读取所有文件
async function readAllFilesFromTree(tree: FileNode): Promise<Array<{ path: string; content: string }>> {
  const files: Array<{ path: string; content: string }> = [];
  
  async function traverse(node: FileNode, basePath: string = '') {
    const fullPath = basePath ? `${basePath}/${node.name}` : node.name;
    
    if (node.type === 'file') {
      // 使用 Electron 读取文件内容
      const result = await electron.readFile({ filePath: node.path });
      if (result.success) {
        files.push({
          path: fullPath,
          content: result.content,
        });
      }
    } else if (node.children) {
      // 递归处理子节点
      for (const child of node.children) {
        await traverse(child, fullPath);
      }
    }
  }
  
  await traverse(tree);
  return files;
}
```

### Step 3: 编辑器自动同步

**文件**: `frontend/desktop/src/components/FullEditorV2Enhanced.tsx`

在保存文件时，同时更新 Store：

```typescript
const handleSaveFile = async (fileId?: string) => {
  // ... 现有保存逻辑 ...
  
  // 同步到 LangGraph Store
  if (currentWorkspace) {
    const sync = new WorkspaceSync(LANGGRAPH_API_URL);
    await sync.syncFile({
      workspaceId: currentWorkspace.id,
      filePath: targetFile.path,
      content: targetFile.content,
    });
  }
};
```

### Step 4: 知识库文件同步

**文件**: `frontend/desktop/src/components/KnowledgeBasePanel.tsx`

在上传文件到知识库后，触发后端索引：

```typescript
const handleFileUpload = async (files: File[]) => {
  // 1. 上传文件到 Store
  for (const file of files) {
    const content = await file.text();
    await client.store.put(
      ['knowledge_base', selectedBase, 'files', file.name],
      {
        name: file.name,
        content,
        uploadedAt: Date.now(),
      }
    );
  }
  
  // 2. 触发后端重新索引（通过工具调用）
  await langgraphApi.chat({
    message: `请重新索引知识库 ${selectedBase}`,
    context: {
      operation: 'reindex_knowledge_base',
      kb_id: selectedBase,
    },
  });
  
  toast.success(`已上传 ${files.length} 个文件并触发索引`);
};
```

---

## 实施步骤

### Phase 1: 基础同步（2-3小时）
1. ✅ 创建 `workspaceSync.ts`
2. ✅ 修改 `WorkspaceFileTree.tsx` 添加初始化同步
3. ✅ 测试：打开文件夹 → 文件上传到 Store

### Phase 2: 编辑器集成（1-2小时）
1. ✅ 修改 `FullEditorV2Enhanced.tsx` 集成同步
2. ✅ 测试：编辑文件 → 自动保存到 Store

### Phase 3: 知识库同步（1-2小时）
1. ✅ 修改 `KnowledgeBasePanel.tsx` 添加文件上传同步
2. ✅ 创建后端索引触发工具
3. ✅ 测试：上传文件 → 后端索引更新

### Phase 4: 双向同步（可选，3-4小时）
1. 实现后端文件变化监听
2. 前端自动刷新文件树
3. 冲突检测和解决

---

## 测试计划

### 测试用例 1: 工作区初始化
1. 打开本地文件夹（包含 10+ 个文件）
2. 验证所有文件上传到 LangGraph Store
3. 验证工作区元数据正确

### 测试用例 2: 文件编辑同步
1. 在编辑器中打开文件
2. 修改内容并保存
3. 验证 Store 中文件内容已更新

### 测试用例 3: 知识库文件同步
1. 上传文件到知识库
2. 验证文件存储到 Store
3. 验证后端索引已更新（可以搜索到新文件）

### 测试用例 4: 后端 AI 访问
1. 在聊天中询问工作区文件内容
2. 验证 AI 可以读取 Store 中的文件
3. 验证 AI 可以搜索知识库

---

## 注意事项

1. **不要重复实现**
   - 使用 LangGraph SDK 的 `client.store` API
   - 不要创建自定义的 Store 包装

2. **利用现有代码**
   - `WorkspaceFileTree` 的 Electron 读取逻辑已完整
   - `FullEditorV2` 的保存逻辑已完整
   - 只需添加 Store 同步调用

3. **性能优化**
   - 大文件夹（1000+ 文件）需要显示进度条
   - 批量上传使用并发控制（限制 10 个并发）
   - 二进制文件需要 base64 编码

4. **错误处理**
   - 上传失败的文件需要重试
   - 网络错误需要友好提示
   - 冲突需要用户确认

---

## 预期效果

完成后，用户体验：

1. **打开文件夹**
   - 用户：点击"打开文件夹"
   - 系统：显示"正在同步 123 个文件..."
   - 结果：文件夹内容完全同步到后端

2. **编辑文件**
   - 用户：在编辑器中修改文件
   - 系统：自动保存到后端（2秒延迟）
   - 结果：前后端文件内容一致

3. **AI 访问文件**
   - 用户：在聊天中询问"项目中有哪些 API？"
   - AI：读取 Store 中的文件，分析并回答
   - 结果：AI 可以访问所有工作区文件

4. **知识库搜索**
   - 用户：上传招标文档到知识库
   - 系统：自动索引文档内容
   - 结果：可以通过 AI 搜索文档内容

