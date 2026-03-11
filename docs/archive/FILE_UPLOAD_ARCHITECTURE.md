# 文件上传架构文档

## 📋 架构概述

本系统采用**业界标准做法**实现文件上传和管理：

- ✅ **文件存储在服务器文件系统**（不使用 LangGraph Store）
- ✅ **通过 HTTP API 上传文件**（自定义 FastAPI 应用）
- ✅ **LLM 使用标准 `read_file` 工具**读取文件
- ✅ **知识库和工作区通过 REST API 同步**

## 🏗️ 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│                      前端 (Desktop)                          │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  MyRuntimeProvider                                   │    │
│  │  - 文件上传 → POST /files/upload                     │    │
│  │  - 消息发送 → POST /threads/{id}/runs/stream        │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   LangGraph Server (:2024)                   │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  自定义 API (api/app.py) ← langgraph.json http.app  │    │
│  │  - POST /files/upload    → tmp/uploads/             │    │
│  │  - GET  /files/list                                  │    │
│  │  - POST /knowledge/upload → knowledge/               │    │
│  │  - POST /workspace/upload → workspace/              │    │
│  └─────────────────────────────────────────────────────┘    │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  LangGraph Agent (engine/core/main_graph.py)        │    │
│  │  - 使用 read_file(path) 读取上传的文件                │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

## 📁 目录结构

```
backend/
├── tmp/
│   └── uploads/          # 用户上传的临时文件
├── knowledge/             # 知识库文件（持久化）
├── workspace/            # 工作区文件（项目文件）
├── api/
│   └── app.py            # 自定义 FastAPI API
├── tools/
│   └── file_operations.py # read_file 工具
└── langgraph.json        # LangGraph Server 配置
```

## 🔄 文件上传流程

### 1. 前端上传文件

```typescript
// frontend/desktop/src/components/ChatComponents/MyRuntimeProvider.tsx
async send(attachment) {
  const formData = new FormData();
  formData.append('file', attachment.file);
  
  const response = await fetch(`${langGraphApiUrl}/files/upload`, {
    method: 'POST',
    body: formData,
  });
  
  const result = await response.json();
  // result = { filename, path, size }
}
```

### 2. 后端保存文件

```python
# backend/api/app.py
@app.post("/files/upload")
async def upload_file(file: UploadFile = File(...)):
    file_path = UPLOAD_DIR / file.filename
    # 保存文件到 tmp/uploads/
    return {"path": str(file_path.absolute())}
```

### 3. 消息包含文件路径

前端返回给 LLM 的消息格式：
```
📎 已上传文件: document.docx
路径: /absolute/path/to/tmp/uploads/document.docx
大小: 120.17 KB
类型: application/vnd.openxmlformats-officedocument.wordprocessingml.document
```

### 4. LLM 读取文件

```python
# backend/tools/file_operations.py
async def read_file(file_path: str) -> str:
    path = Path(file_path)
    # 使用 DocumentParser 解析 Word、Excel、PDF 等
    return DocumentParser.parse(path.read_bytes(), path.name, "")
```

## 🔧 配置

### langgraph.json

```json
{
  "http": {
    "app": "./api/app.py:app"
  }
}
```

这会将自定义 FastAPI 应用挂载到 LangGraph Server。

### API 端点

| 端点 | 方法 | 说明 |
|-----|------|------|
| `/files/upload` | POST | 上传文件到 `tmp/uploads/` |
| `/files/list` | GET | 列出已上传的文件 |
| `/knowledge/upload` | POST | 上传文件到知识库 |
| `/knowledge/list` | GET | 列出知识库文件 |
| `/workspace/upload` | POST | 上传文件到工作区 |
| `/workspace/list` | GET | 列出工作区文件 |
| `/health` | GET | 健康检查 |

## 🧪 测试

运行测试脚本：

```bash
cd backend
uv run python test_file_upload.py
```

## 📝 关键设计决策

### ✅ 为什么不用 LangGraph Store？

- **Store 的用途**：存储状态、记忆、元数据（key-value）
- **文件的特性**：二进制数据、大文件、需要文件系统操作
- **业界标准**：文件应该存储在文件系统中

### ✅ 为什么用自定义 FastAPI 应用？

- **LangGraph Server 没有内置文件上传**
- **通过 `http.app` 配置可以无缝集成**
- **符合 FastAPI 标准，易于扩展**

### ✅ 为什么返回绝对路径？

- **LLM 的 `read_file` 工具需要明确路径**
- **避免相对路径的歧义**
- **跨平台兼容性更好**

## 🚀 使用示例

### 前端上传文件

```typescript
const file = new File([content], "document.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });

const formData = new FormData();
formData.append('file', file);

const response = await fetch('http://localhost:2024/files/upload', {
  method: 'POST',
  body: formData,
});

const { path } = await response.json();
// path = "/absolute/path/to/tmp/uploads/document.docx"
```

### LLM 读取文件

```python
# LLM 收到消息：
# "📎 已上传文件: document.docx
#  路径: /absolute/path/to/tmp/uploads/document.docx"

# LLM 调用工具：
read_file("/absolute/path/to/tmp/uploads/document.docx")

# 返回文件内容（已解析为文本）
```

## 🔐 安全考虑

1. **文件类型验证**：可以在 API 中添加文件类型白名单
2. **文件大小限制**：限制上传文件的最大大小
3. **路径安全**：确保文件路径不会逃逸到系统目录
4. **权限控制**：添加用户认证和授权

## 📚 相关文档

- [LangGraph Server 文档](https://langchain-ai.github.io/langgraph/)
- [FastAPI 文档](https://fastapi.tiangolo.com/)
- [LangChain ReadFileTool](https://python.langchain.com/docs/integrations/tools/filesystem)

