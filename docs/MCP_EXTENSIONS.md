# MCP 扩展建议 - 招标文档分析系统

## 一、MCP 概述

**MCP (Model Context Protocol)** 是 Anthropic 提出的标准协议，用于 AI 模型与外部工具/服务的通信。

### 优势

1. **标准化** - 统一的工具接口协议
2. **生态丰富** - 大量官方和社区 MCP 服务器
3. **安全** - 支持权限控制和认证
4. **灵活** - 支持 stdio 和 HTTP 两种传输方式

### LangChain 支持

```python
# 安装
pip install langchain-mcp-adapters

# 使用
from langchain_mcp_adapters.client import MultiServerMCPClient

async with MultiServerMCPClient(config) as client:
    tools = client.get_tools()
    agent = create_react_agent(llm, tools)
```

## 二、官方 MCP 服务器

| 服务器 | 包名 | 功能 | 适用场景 |
|--------|------|------|----------|
| **Filesystem** | `@modelcontextprotocol/server-filesystem` | 文件读写、目录操作 | 本地文件管理 |
| **Puppeteer** | `@modelcontextprotocol/server-puppeteer` | 浏览器自动化 | 网页抓取、截图 |
| **SQLite** | `@modelcontextprotocol/server-sqlite` | SQLite 操作 | 本地数据存储 |
| **PostgreSQL** | `@modelcontextprotocol/server-postgres` | PostgreSQL 操作 | 企业数据库 |
| **Brave Search** | `@modelcontextprotocol/server-brave-search` | 网页搜索 | 信息检索 |
| **GitHub** | `@modelcontextprotocol/server-github` | GitHub API | 代码管理 |
| **Slack** | `@modelcontextprotocol/server-slack` | Slack 消息 | 团队协作 |
| **Google Drive** | `@modelcontextprotocol/server-gdrive` | 云存储 | 文档共享 |

## 三、针对招标业务的 MCP 扩展建议

### 3.1 免费/开源 MCP

#### 1. Filesystem Server (必选)

```bash
npm install -g @modelcontextprotocol/server-filesystem
```

**用途**：
- 读取招标文件 (PDF, DOCX, Excel)
- 写入分析报告
- 管理工作区文件

**配置**：
```python
{
    "filesystem": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/workspace"],
        "transport": "stdio"
    }
}
```

#### 2. Puppeteer Server (推荐)

```bash
npm install -g @modelcontextprotocol/server-puppeteer
```

**用途**：
- 抓取招标网站信息
- 自动截图保存证据
- 填写在线表单

**配置**：
```python
{
    "puppeteer": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-puppeteer"],
        "transport": "stdio"
    }
}
```

#### 3. SQLite Server (推荐)

```bash
npm install -g @modelcontextprotocol/server-sqlite
```

**用途**：
- 存储分析结果
- 缓存历史记录
- 本地知识库

**配置**：
```python
{
    "sqlite": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-sqlite", "--db-path", "./data/analysis.db"],
        "transport": "stdio"
    }
}
```

### 3.2 付费/需要 API Key

#### 1. Brave Search (推荐)

**费用**：$5/月起

**用途**：
- 搜索招标相关信息
- 市场调研
- 竞品分析

**配置**：
```python
{
    "brave-search": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-brave-search"],
        "env": {"BRAVE_API_KEY": "your-api-key"},
        "transport": "stdio"
    }
}
```

#### 2. GitHub Server (免费，需要 Token)

**用途**：
- 版本控制
- 团队协作
- 代码管理

**配置**：
```python
{
    "github": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-github"],
        "env": {"GITHUB_PERSONAL_ACCESS_TOKEN": "your-token"},
        "transport": "stdio"
    }
}
```

### 3.3 第三方 MCP 服务

#### 1. Notion MCP

**来源**：https://github.com/modelcontextprotocol/servers/tree/main/src/notion

**用途**：
- 知识库管理
- 文档协作
- 项目管理

#### 2. Slack MCP

**来源**：https://github.com/modelcontextprotocol/servers/tree/main/src/slack

**用途**：
- 团队通知
- 审批流程
- 协作沟通

#### 3. Google Drive MCP

**来源**：https://github.com/modelcontextprotocol/servers/tree/main/src/gdrive

**用途**：
- 云端文档存储
- 共享协作
- 备份

### 3.4 推荐自建 MCP 服务器

针对招标业务的特殊需求，建议自建以下 MCP 服务器：

#### 1. PDF Tools Server

**功能**：
- PDF 解析和文本提取
- 表格识别和提取
- OCR 识别
- PDF 合并/拆分

**实现**：
```python
# 使用 FastMCP 框架
from fastmcp import FastMCP

mcp = FastMCP("pdf-tools")

@mcp.tool()
def extract_text(pdf_path: str) -> str:
    """从 PDF 提取文本"""
    import fitz  # PyMuPDF
    doc = fitz.open(pdf_path)
    text = ""
    for page in doc:
        text += page.get_text()
    return text

@mcp.tool()
def extract_tables(pdf_path: str) -> list:
    """从 PDF 提取表格"""
    import pdfplumber
    tables = []
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            tables.extend(page.extract_tables())
    return tables
```

#### 2. Excel Tools Server

**功能**：
- Excel 读写
- 数据分析
- 图表生成
- 格式转换

**实现**：
```python
from fastmcp import FastMCP

mcp = FastMCP("excel-tools")

@mcp.tool()
def read_excel(file_path: str, sheet_name: str = None) -> dict:
    """读取 Excel 文件"""
    import pandas as pd
    df = pd.read_excel(file_path, sheet_name=sheet_name)
    return df.to_dict()

@mcp.tool()
def analyze_data(file_path: str, analysis_type: str) -> dict:
    """分析 Excel 数据"""
    import pandas as pd
    df = pd.read_excel(file_path)
    
    if analysis_type == "summary":
        return df.describe().to_dict()
    elif analysis_type == "correlation":
        return df.corr().to_dict()
    # ...
```

#### 3. DOCX Tools Server

**功能**：
- DOCX 生成
- 模板填充
- 格式转换
- 样式处理

**实现**：
```python
from fastmcp import FastMCP

mcp = FastMCP("docx-tools")

@mcp.tool()
def create_report(template_path: str, data: dict, output_path: str) -> str:
    """使用模板生成报告"""
    from docxtpl import DocxTemplate
    doc = DocxTemplate(template_path)
    doc.render(data)
    doc.save(output_path)
    return f"Report saved to {output_path}"
```

#### 4. Chart Generator Server

**功能**：
- 数据可视化
- 分析图表
- 报告插图

**实现**：
```python
from fastmcp import FastMCP

mcp = FastMCP("chart-generator")

@mcp.tool()
def create_bar_chart(data: dict, title: str, output_path: str) -> str:
    """创建柱状图"""
    import matplotlib.pyplot as plt
    
    plt.figure(figsize=(10, 6))
    plt.bar(data.keys(), data.values())
    plt.title(title)
    plt.savefig(output_path)
    plt.close()
    
    return f"Chart saved to {output_path}"
```

## 四、集成架构

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         MCP 集成架构                                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  用户电脑 (Electron App)                                                     │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │  MCP Servers (本地)                                                    │ │
│  │  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐     │ │
│  │  │ Filesystem  │ │ Puppeteer   │ │ SQLite      │ │ PDF Tools   │     │ │
│  │  │ (官方)      │ │ (官方)      │ │ (官方)      │ │ (自建)      │     │ │
│  │  └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘     │ │
│  │  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐                     │ │
│  │  │ Excel Tools │ │ DOCX Tools  │ │ Chart Gen   │                     │ │
│  │  │ (自建)      │ │ (自建)      │ │ (自建)      │                     │ │
│  │  └─────────────┘ └─────────────┘ └─────────────┘                     │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│                              ↑ stdio / HTTP                                 │
│                              │                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │  云端 - LangGraph Server                                              │ │
│  │  ┌─────────────────────────────────────────────────────────────────┐ │ │
│  │  │   DeepAgent + langchain-mcp-adapters                            │ │ │
│  │  │   - MultiServerMCPClient 连接多个 MCP 服务器                     │ │ │
│  │  │   - 动态发现和加载工具                                           │ │ │
│  │  └─────────────────────────────────────────────────────────────────┘ │ │
│  │                                                                       │ │
│  │  MCP Servers (云端)                                                   │ │
│  │  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐                     │ │
│  │  │ Brave Search│ │ GitHub      │ │ Notion      │                     │ │
│  │  │ (付费)      │ │ (免费)      │ │ (第三方)    │                     │ │
│  │  └─────────────┘ └─────────────┘ └─────────────┘                     │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 五、使用示例

### 5.1 基本使用

```python
from tools.mcp import mcp_session

async with mcp_session({
    "filesystem": {"workspace_path": "/path/to/workspace"},
    "sqlite": {"db_path": "./data/analysis.db"},
}) as tools:
    # tools 包含所有 MCP 服务器提供的工具
    agent = create_react_agent(llm, tools)
    result = await agent.ainvoke({"input": "分析招标文件..."})
```

### 5.2 动态添加服务器

```python
from tools.mcp import get_mcp_manager

manager = get_mcp_manager()

# 连接文件系统服务器
await manager.connect_stdio(
    name="filesystem",
    command="npx",
    args=["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
)

# 连接浏览器服务器
await manager.connect_stdio(
    name="puppeteer",
    command="npx",
    args=["-y", "@modelcontextprotocol/server-puppeteer"],
)

# 获取所有工具
tools = manager.get_tools()
```

## 六、安全考虑

### 6.1 本地 MCP 服务器

- 限定工作区目录，防止越权访问
- 使用沙箱环境执行代码
- 记录所有工具调用日志

### 6.2 云端 MCP 服务器

- 使用 HTTPS 加密通信
- API Key 安全存储
- 权限最小化原则

### 6.3 敏感数据

- 招标文件不上传云端
- 本地处理敏感信息
- 加密存储 API Key

## 七、成本估算

| MCP 服务 | 费用 | 说明 |
|----------|------|------|
| Filesystem | 免费 | 开源 |
| Puppeteer | 免费 | 开源 |
| SQLite | 免费 | 开源 |
| Brave Search | $5/月起 | 按调用量计费 |
| GitHub | 免费 | 需要 Token |
| Notion | 免费 | 需要 API Key |
| 自建服务器 | 免费 | 开发成本 |

## 八、实施路线图

### Phase 1: 基础 MCP (1-2 周)

- [x] 集成 Filesystem Server
- [ ] 集成 SQLite Server
- [ ] 测试本地文件操作

### Phase 2: 扩展 MCP (2-3 周)

- [ ] 集成 Puppeteer Server
- [ ] 开发 PDF Tools Server
- [ ] 开发 Excel Tools Server

### Phase 3: 高级 MCP (3-4 周)

- [ ] 集成 Brave Search
- [ ] 开发 DOCX Tools Server
- [ ] 开发 Chart Generator Server

### Phase 4: 企业 MCP (可选)

- [ ] 集成 Notion/Slack
- [ ] 开发自定义业务 MCP
- [ ] 权限和审计系统

## 九、快速开始

### 9.1 安装依赖

```bash
# 后端 Python 依赖
cd backend
pip install langchain-mcp-adapters

# 前端 Node.js 依赖（官方 MCP 服务器）
npm install -g @modelcontextprotocol/server-filesystem
npm install -g @modelcontextprotocol/server-puppeteer
npm install -g @modelcontextprotocol/server-sqlite
```

### 9.2 在 Electron 中启动 MCP 服务器

```typescript
// 前端代码
const result = await window.electron.mcpStartServer({
  type: 'filesystem',
  name: 'local-fs',
  config: { workspacePath: '/path/to/workspace' }
});

if (result.success) {
  console.log('MCP Server started, PID:', result.pid);
}
```

### 9.3 在后端连接 MCP 服务器

```python
# 后端代码
from tools.mcp import mcp_session

async with mcp_session({
    "filesystem": {"workspace_path": "/path/to/workspace"},
}) as tools:
    # tools 包含 MCP 服务器提供的所有工具
    print(f"Available tools: {[t.name for t in tools]}")
```

### 9.4 获取业务扩展建议

```python
from tools.mcp import get_business_mcp_extensions

extensions = get_business_mcp_extensions()
for name, info in extensions.items():
    print(f"{name}: {info['description']}")
    print(f"  Category: {info['category']}")
    print(f"  Use case: {info['use_case']}")
```
