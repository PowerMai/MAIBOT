# 系统架构设计 - Cursor 风格 + LangChain/DeepAgent 官方标准

## 核心原则

1. **使用官方实现** - 优先使用 LangChain/DeepAgent 官方 MCP 适配器
2. **避免重复造轮子** - 使用官方 `@modelcontextprotocol/server-*` 包
3. **可扩展** - 支持集成业界已有的 MCP 服务器

## 一、架构概览

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         系统整体架构                                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  用户电脑 (Electron App)                                                     │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │                                                                       │ │
│  │  ┌─────────────────┐    ┌───────────────────────────────────────────┐│ │
│  │  │   Electron UI   │    │   MCP Filesystem Server (本地)            ││ │
│  │  │   - 文件树显示   │    │   @modelcontextprotocol/server-filesystem ││ │
│  │  │   - Monaco 编辑器│    │   - 限定在用户工作区目录                   ││ │
│  │  │   - 聊天界面    │    │   - 提供 read/write/ls/edit/glob/grep     ││ │
│  │  └─────────────────┘    └───────────────────────────────────────────┘│ │
│  │           ↑                              ↑                           │ │
│  │           │ 本地文件系统                  │ MCP 协议                  │ │
│  │           ↓                              ↓                           │ │
│  │  ┌────────────────────────────────────────────────────────────────┐  │ │
│  │  │              用户本地工作区                                     │  │ │
│  │  │              /Users/xxx/project/                               │  │ │
│  │  │              ├── input/   (招标文件)                           │  │ │
│  │  │              ├── output/  (分析报告)                           │  │ │
│  │  │              └── .cache/  (本地缓存)                           │  │ │
│  │  └────────────────────────────────────────────────────────────────┘  │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│                              ↑                                              │
│                              │ HTTPS / WebSocket                            │
│                              │ - MCP 工具调用 (云端→本地)                    │
│                              │ - 聊天消息流                                  │
│                              │ - Embeddings 同步 (本地→云端)                 │
│                              ↓                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │  云服务器 - LangGraph Server                                          │ │
│  │                                                                       │ │
│  │  ┌─────────────────────────────────────────────────────────────────┐ │ │
│  │  │   DeepAgent (Orchestrator + SubAgents)                          │ │ │
│  │  │   - 使用 langchain-mcp-adapters 连接本地 MCP 服务器              │ │ │
│  │  │   - 工具调用决策 → 发送到本地执行                                │ │ │
│  │  │   - 不直接操作文件，只发指令                                     │ │ │
│  │  └─────────────────────────────────────────────────────────────────┘ │ │
│  │                                                                       │ │
│  │  ┌─────────────────────────────────────────────────────────────────┐ │ │
│  │  │   持久化存储 (CompositeBackend)                                  │ │ │
│  │  │   - /memories/   → StoreBackend (长期记忆)                       │ │ │
│  │  │   - /embeddings/ → StoreBackend (向量索引)                       │ │ │
│  │  │   - /knowledge/  → FilesystemBackend (全局知识库)                │ │ │
│  │  │   - 默认         → StateBackend (临时状态)                       │ │ │
│  │  └─────────────────────────────────────────────────────────────────┘ │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 二、部署模式

### 模式 A：本地部署（开发/单机）

```
用户电脑
├── Electron UI
├── MCP Filesystem Server (localhost:3000)
└── LangGraph Server (localhost:2024)
    └── DeepAgent → 通过 MCP 调用本地文件工具
```

**特点**：
- 所有组件在同一台机器
- MCP 服务器和 LangGraph Server 都访问本地文件系统
- 延迟最低，体验最好

### 模式 B：云端部署（生产/多用户）

```
用户电脑                          云服务器
├── Electron UI                  ├── LangGraph Server
├── MCP Filesystem Server ←────→ └── DeepAgent (MCP Client)
└── 本地工作区
```

**特点**：
- LangGraph Server 在云端
- MCP Filesystem Server 在用户本地
- 文件操作通过 MCP 协议远程调用
- 用户数据不上传云端（安全）

## 三、组件职责

### 1. Electron UI (前端)

| 功能 | 说明 |
|------|------|
| 文件树显示 | 直接读取本地文件系统 |
| Monaco 编辑器 | 编辑本地文件 |
| 聊天界面 | 与云端 LangGraph Server 通信 |
| MCP Server 管理 | 启动/停止本地 MCP 服务器 |

### 2. MCP Filesystem Server (本地)

使用官方 `@modelcontextprotocol/server-filesystem`：

| 工具 | 说明 |
|------|------|
| `read_file` | 读取文件内容 |
| `write_file` | 写入文件 |
| `edit_file` | 编辑文件（查找替换） |
| `list_directory` | 列出目录 |
| `search_files` | 搜索文件 |
| `get_file_info` | 获取文件信息 |

### 3. LangGraph Server (云端)

| 组件 | 职责 |
|------|------|
| DeepAgent Orchestrator | 任务协调、工具调用决策 |
| Planning Agent | 分析请求、创建计划 |
| Executor Agent | 执行计划（通过 MCP 调用本地工具） |
| Knowledge Agent | 知识检索、语义搜索 |

### 4. 持久化存储 (云端)

| 路径 | Backend | 用途 |
|------|---------|------|
| `/memories/` | StoreBackend | 长期记忆（跨会话） |
| `/embeddings/` | StoreBackend | 向量索引 |
| `/knowledge/` | FilesystemBackend | 全局知识库（SKILL.md） |
| 默认 | StateBackend | 临时状态 |

## 四、数据流

### 1. 用户发送消息

```
用户输入 → Electron UI → LangGraph Server → DeepAgent
                                              ↓
                                         Orchestrator 分析
                                              ↓
                                         决定调用工具
                                              ↓
                                         MCP Client 发送请求
                                              ↓
                              ←────────── MCP Server (本地)
                                              ↓
                                         执行文件操作
                                              ↓
                                         返回结果
                                              ↓
                                         Agent 继续处理
                                              ↓
                                         生成回复
                                              ↓
                              ←────────── 流式返回给用户
```

### 2. 向量同步（独立于文件操作）

```
本地文件变更 → Electron 检测 → 计算 Embedding → 上传云端
                                                    ↓
                                              更新向量索引
                                                    ↓
                                              用于语义搜索
```

## 五、与 Cursor 的对比

| 方面 | Cursor | 本系统 |
|------|--------|--------|
| 工具执行位置 | 本地 | 本地 (MCP Server) |
| AI 推理位置 | 云端 | 云端 (LangGraph) |
| 文件存储 | 本地 | 本地 |
| 向量索引 | 云端 | 云端 |
| 通信协议 | 私有 | MCP (标准) |
| 框架 | 私有 | LangChain/DeepAgent |

## 六、安全考虑

### 1. MCP Server 安全

- 限定根目录为用户工作区
- 路径验证防止遍历攻击
- 认证 Token 验证请求来源

### 2. 云端通信安全

- HTTPS 加密传输
- JWT Token 认证
- 敏感文件不上传（.gitignore/.cursorignore）

### 3. 本地执行安全

- Shell 命令白名单
- Python 代码沙箱
- 资源限制（超时、内存）

## 七、实现步骤

### Phase 1: 本地 MCP Server

1. 安装 `@modelcontextprotocol/server-filesystem`
2. 在 Electron 主进程中启动
3. 配置根目录为用户工作区

### Phase 2: 云端 MCP Client

1. 安装 `langchain-mcp-adapters`
2. 配置 DeepAgent 使用 MCP 工具
3. 修改 Backend 为 CompositeBackend

### Phase 3: 向量同步

1. 本地文件变更检测
2. Embedding 计算（可本地或云端）
3. 向量索引更新

### Phase 4: 部署模式切换

1. 环境变量控制部署模式
2. 本地模式：直接使用 FilesystemBackend
3. 云端模式：使用 MCP Client

## 八、配置示例

### 本地模式 (.env.local)

```env
DEPLOYMENT_MODE=local
MCP_SERVER_URL=http://localhost:3000
LANGGRAPH_URL=http://localhost:2024
```

### 云端模式 (.env.production)

```env
DEPLOYMENT_MODE=cloud
MCP_SERVER_URL=dynamic  # 从客户端连接获取
LANGGRAPH_URL=https://api.example.com
```

## 九、优势总结

1. **符合 LangChain/DeepAgent 官方标准** - 使用 MCP 协议
2. **安全** - 用户文件不上传云端
3. **灵活** - 支持本地和云端部署
4. **标准化** - 使用官方 MCP 服务器实现
5. **可扩展** - 可添加更多 MCP 工具服务器
