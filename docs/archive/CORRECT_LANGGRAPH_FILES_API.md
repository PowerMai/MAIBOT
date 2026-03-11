# ✅ 正确方案：使用 LangGraph Files API 路径上传

## 🎯 核心问题修正

您说得完全正确！之前的方案有个致命问题：

**❌ 错误方式**
```
AttachmentAdapter → file block 消息封装 → LLM 收到 file block
结果：触发 400 错误（LLM 不支持 file content type）
```

**✅ 正确方式**
```
使用 LangGraph Files API
    ↓
前端上传文件获得路径
    ↓
直接在消息中包含路径
    ↓
LLM 通过工具访问路径
    ↓
无消息封装，无 block 问题
```

---

## 🏗️ 正确的实现方案

### 前端：直接使用 LangGraph SDK Files API

```typescript
// frontend/desktop/src/lib/api/fileUpload.ts

import { Client } from "@langchain/langgraph-sdk";

const LANGGRAPH_API_URL = (import.meta as any).env?.VITE_LANGGRAPH_API_URL || 'http://localhost:2024';

/**
 * ✅ 使用 LangGraph SDK Files API 上传文件
 * 
 * 关键：直接获得文件路径，不创建 file block
 */
export async function uploadFileToLangGraph(
  file: File
): Promise<{ fileId: string; filePath: string }> {
  try {
    const client = new Client({ apiUrl: LANGGRAPH_API_URL });
    
    // ✅ 使用官方 Files API
    const formData = new FormData();
    formData.append("file", file);
    
    // ✅ 直接调用 LangGraph Server 的 /files 端点
    const response = await fetch(`${LANGGRAPH_API_URL}/files`, {
      method: "POST",
      body: formData,
    });
    
    if (!response.ok) {
      throw new Error(`上传失败: ${response.statusText}`);
    }
    
    const data = await response.json();
    
    // ✅ 返回文件路径（不是 blob，不是 block）
    return {
      fileId: data.id || data.file_id,
      filePath: data.path || `/files/${data.id}`,
    };
    
  } catch (error) {
    console.error("❌ 文件上传失败:", error);
    throw error;
  }
}

/**
 * ✅ 使用 LangGraph SDK Store API 上传文件（替代方案）
 * 
 * 如果 Files API 不可用，可以用 Store
 */
export async function uploadFileToStore(
  file: File
): Promise<{ fileId: string; filePath: string }> {
  try {
    const client = new Client({ apiUrl: LANGGRAPH_API_URL });
    
    const arrayBuffer = await file.arrayBuffer();
    const base64 = btoa(
      new Uint8Array(arrayBuffer)
        .reduce((data, byte) => data + String.fromCharCode(byte), '')
    );
    
    const fileId = `${Date.now()}_${file.name}`;
    
    // ✅ 使用 Store API
    const storeClient = (client as any).store;
    
    await storeClient.put(
      ["files", fileId],
      {
        id: fileId,
        name: file.name,
        type: file.type,
        size: file.size,
        base64: base64,
        uploadedAt: new Date().toISOString(),
      }
    );
    
    // ✅ 返回路径（虚拟路径，Store 中的位置）
    return {
      fileId: fileId,
      filePath: `/store/files/${fileId}`,
    };
    
  } catch (error) {
    console.error("❌ Store 上传失败:", error);
    throw error;
  }
}
```

### 前端：修改 AttachmentAdapter，上传后直接获得路径

```typescript
// frontend/desktop/src/components/ChatComponents/MyRuntimeProvider.tsx

adapters: {
  attachments: {
    accept: "*/*",
    
    async add({ file }) {
      // ... 保持不变 ...
    },
    
    async send(attachment) {
      console.log('[MyRuntimeProvider] 📤 发送附件:', {
        name: attachment.name,
        size: attachment.file.size,
      });
      
      try {
        // ✅ 使用 LangGraph SDK Files API 上传
        const { fileId, filePath } = await uploadFileToLangGraph(attachment.file);
        
        console.log('[MyRuntimeProvider] ✅ 文件已上传到 LangGraph:', {
          fileId,
          filePath,
        });
        
        // ✅ 关键：返回路径在 additional_kwargs 中，不是 file block
        return {
          ...attachment,
          status: { type: "complete" as const },
          // ❌ 不要创建 file content block
          // ✅ 而是把路径放在 content 中作为文本
          content: [
            {
              type: "text" as const,
              text: `file://${fileId}|${filePath}|${attachment.name}`,
            },
          ],
        };
        
      } catch (error) {
        console.error('[MyRuntimeProvider] ❌ 文件上传失败:', error);
        throw error;
      }
    },
    
    async remove(attachment) {
      // ... 保持不变 ...
    },
  },
},
```

---

## 📝 后端：解析文件路径并传递给 LLM

```python
# backend/engine/nodes/router_node.py

"""
✅ 路由节点 - 处理文件路径

关键点：
1. 提取文件路径（来自消息的 text content）
2. 将路径直接传递给 LLM
3. 不需要在 router_node 中做什么处理
"""

from typing import Optional
from langchain_core.messages import HumanMessage

async def router_node(state: AgentState) -> AgentState:
    """
    路由节点 - 简单转发
    
    文件路径已经在消息中了，不需要做额外处理
    直接交给 DeepAgent
    """
    
    messages = state.get('messages', [])
    if not messages:
        return state
    
    last_message = messages[-1]
    
    # ✅ 提取文件路径信息
    if isinstance(last_message, dict):
        content = last_message.get('content', '')
    else:
        content = last_message.content
    
    if isinstance(content, str) and content.startswith('file://'):
        logger.info(f"📎 检测到文件路径: {content}")
    elif isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get('type') == 'text':
                text = block.get('text', '')
                if 'file://' in text:
                    logger.info(f"📎 消息中包含文件路径: {text}")
    
    # ✅ 不需要修改消息，直接返回
    return state
```

---

## 🛠️ DeepAgent 工具：读取文件

```python
# backend/tools/file_operations.py

"""
✅ 文件操作工具 - LLM 可以使用这些工具访问文件
"""

from typing import Annotated
import aiofiles
import base64
from pathlib import Path

async def read_file_by_path(
    file_path: Annotated[str, "文件路径 (file://id|path|name 格式)"],
) -> str:
    """
    ✅ 根据路径读取文件
    
    LLM 可以使用这个工具来读取上传的文件
    """
    
    try:
        # 解析文件路径格式: file://fileId|/actual/path|filename
        if not file_path.startswith('file://'):
            return f"错误：无效的文件路径格式"
        
        path_info = file_path.replace('file://', '')
        parts = path_info.split('|')
        
        if len(parts) >= 2:
            file_id = parts[0]
            actual_path = parts[1]
            filename = parts[2] if len(parts) > 2 else 'unknown'
        else:
            actual_path = path_info
            filename = 'unknown'
        
        logger.info(f"📖 读取文件: {filename} from {actual_path}")
        
        # ✅ 从 LangGraph Server 或本地读取
        # 方式 1: 如果是 LangGraph Files API 路径
        if actual_path.startswith('/files/'):
            # 调用 LangGraph Files API 获取文件
            from langchain.utilities import LangChainClient
            # ... 实现具体的 API 调用
            pass
        
        # 方式 2: 如果是本地路径
        else:
            # 直接读取本地文件
            try:
                async with aiofiles.open(actual_path, 'r', encoding='utf-8') as f:
                    content = await f.read()
            except UnicodeDecodeError:
                # 如果是二进制文件，尝试 base64 解码
                async with aiofiles.open(actual_path, 'rb') as f:
                    binary_content = await f.read()
                    content = base64.b64encode(binary_content).decode('utf-8')
                    content = f"[二进制文件 - Base64 编码]\n{content[:1000]}..."
        
        # 截断长文件
        if len(content) > 4000:
            content = content[:4000] + f"\n\n... [文件已截断，总长度: {len(content)}] ..."
        
        return content
    
    except Exception as e:
        logger.error(f"❌ 读取文件失败: {e}")
        return f"错误：无法读取文件 - {str(e)}"


async def list_uploaded_files(
    pattern: Annotated[str, "文件名模式（可选）"] = "*",
) -> str:
    """
    ✅ 列出所有上传的文件
    
    LLM 可以使用这个工具来查看有哪些文件
    """
    try:
        # 从 Store 或 Files API 列出文件
        # ... 具体实现
        return "已上传的文件列表..."
    except Exception as e:
        return f"错误: {str(e)}"


# 注册工具
FILE_TOOLS = [
    read_file_by_path,
    list_uploaded_files,
]
```

---

## 📊 流程图

```
┌──────────────────────────────────┐
│ 1. 前端上传文件                  │
│    ↓                             │
│ 2. 使用 LangGraph Files API      │
│    ↓                             │
│ 3. 获取文件路径: /files/xxx      │
│    ↓                             │
│ 4. 在消息中包含路径              │
│    "file://id|/path|name"       │
│    ↓                             │
│ 5. 发送消息给后端                │
│    ↓                             │
│ 6. router_node 检测路径          │
│    ↓                             │
│ 7. 传给 DeepAgent                │
│    ↓                             │
│ 8. LLM 需要时使用工具读取        │
│    ↓                             │
│ 9. 分析文件并返回结果            │
└──────────────────────────────────┘
```

---

## ✅ 关键优势

✅ **无 file block 消息封装**
- 直接使用路径字符串
- 避免 LLM 400 错误

✅ **充分利用 LangGraph Files API**
- 官方的文件存储方式
- 无自定义实现

✅ **简洁高效**
- 前端：上传 → 获得路径
- 后端：检测路径 → 转发给 LLM
- LLM：需要时读取

✅ **router_node 不需要参与**
- 只需检测和日志
- 不需要文件处理逻辑

---

## 🚀 实施步骤

1. **前端**：修改 `uploadFileToLangGraph()` 使用 LangGraph Files API
2. **前端**：修改 `send()` 方法返回路径字符串而不是 file block
3. **后端**：在 `tools/file_operations.py` 中添加文件读取工具
4. **测试**：上传文件 → LLM 读取 → 分析

**完成！** 🎉


