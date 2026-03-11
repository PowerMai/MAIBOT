# Router 优化与 MCP 扩展方案

## 一、Router Node 分流分析

### 1.1 当前路由逻辑

```python
route_decision(state) -> "deepagent" | "editor_tool" | "error"

路由规则：
├── chatarea → deepagent（智能对话）
├── editor + complex_operation → deepagent（智能编辑）
├── editor + tool_command → editor_tool（快速工具，无 LLM）
├── system + file_sync → editor_tool（文件同步）
└── 其他 → deepagent（默认）
```

### 1.2 Claude 的路由模式对比

Claude 没有显式的 router_node，而是：
1. **单一 Agent 入口**：所有请求进入同一 Agent
2. **内部决策**：Agent 内部通过 LLM 决定处理方式
3. **Strict Tool Use**：强制工具调用，跳过 LLM 推理

### 1.3 评估结论

**当前架构更优**，因为：
- 减少不必要的 LLM 调用（快速工具直接执行）
- 路由逻辑清晰可控
- 降低 token 消耗

### 1.4 建议的路由增强

```python
# 可选的额外路由（根据业务需要）
route_decision(state) -> Literal[
    "deepagent",      # 智能对话和复杂任务
    "editor_tool",    # 快速工具（无 LLM）
    "data_query",     # 数据查询（可选，直接查数据库）
    "error"
]

# 新增路由条件（可选）
elif source == 'system' and request_type == 'data_query':
    return "data_query"  # 直接查询数据库，无需 LLM
```

**建议**：暂不增加，当前两条路由足够。

---

## 二、Strict Tool Use 优化

### 2.1 什么是 Strict Tool Use

Claude 的 Strict Tool Use 是指：
- **强制工具调用**：LLM 必须调用指定工具，不能自由回答
- **减少推理**：跳过复杂推理，直接执行工具
- **确定性输出**：输出格式固定，便于解析

### 2.2 在 DeepAgent 中实现

**方法 1：通过提示词控制**

```python
# 在 agent_prompts.py 中添加
STRICT_TOOL_USE_INSTRUCTION = """
当任务明确时，直接调用工具，不要解释或推理：
- 读取文件 → 直接调用 read_file
- 执行代码 → 直接调用 python_run
- 搜索知识 → 直接调用 search_knowledge
"""
```

**方法 2：通过 tool_choice 参数**

```python
# LangChain 支持 tool_choice 参数
llm.bind_tools(tools, tool_choice="required")  # 强制使用工具
llm.bind_tools(tools, tool_choice={"type": "function", "function": {"name": "python_run"}})  # 指定工具
```

### 2.3 建议

在 `deep_agent.py` 的 `create_llm_for_agent` 中添加 `tool_choice` 支持：

```python
def create_llm_for_agent(agent_type: str, config=None, strict_tool: bool = False):
    llm = create_llm_for_subagent(config=config, task_type=task_type)
    
    if strict_tool:
        # 强制工具调用模式
        return llm.bind_tools(tools, tool_choice="required")
    return llm
```

---

## 三、MCP Server 扩展能力

### 3.1 Claude 官方 MCP Servers

| MCP Server | 功能 | 扩展能力 |
|------------|------|---------|
| **filesystem** | 文件操作 | 操作任意目录，不限于工作区 |
| **memory** | 持久化记忆 | 跨 Agent 共享记忆 |
| **sqlite** | 数据库操作 | 共享数据存储 |
| **puppeteer** | 网页自动化 | 爬取招标网站 |
| **brave-search** | 网络搜索 | 更强的搜索能力 |
| **github** | 代码仓库 | 代码管理 |

### 3.2 您的需求对应方案

#### 需求 1：操作更大范围的文件

**当前限制**：DeepAgent FilesystemMiddleware 限于工作区

**MCP 方案**：
```python
# 使用 filesystem MCP
from langchain_mcp_adapters import MCPToolkit

mcp_toolkit = MCPToolkit(
    servers={
        "filesystem": {
            "command": "npx",
            "args": ["-y", "@anthropic-ai/mcp-server-filesystem", "/"],
            "env": {}
        }
    }
)

# 获取工具
filesystem_tools = mcp_toolkit.get_tools()
```

#### 需求 2：跨 Agent 公共记忆

**当前实现**：LangGraph Store（会话级）

**MCP 方案**：
```python
# 使用 memory MCP 实现全局记忆
memory_mcp = {
    "memory": {
        "command": "npx",
        "args": ["-y", "@anthropic-ai/mcp-server-memory"],
        "env": {}
    }
}

# 或使用 SQLite 实现共享记忆
sqlite_mcp = {
    "sqlite": {
        "command": "npx",
        "args": ["-y", "@anthropic-ai/mcp-server-sqlite", "--db-path", "data/shared_memory.db"],
        "env": {}
    }
}
```

#### 需求 3：公共数据库

**方案**：SQLite MCP

```python
# 配置 SQLite MCP
sqlite_config = {
    "sqlite": {
        "command": "npx",
        "args": [
            "-y", 
            "@anthropic-ai/mcp-server-sqlite",
            "--db-path", "data/business.db"
        ]
    }
}

# 可用工具
# - query: 执行 SQL 查询
# - execute: 执行 SQL 命令
# - list_tables: 列出所有表
# - describe_table: 描述表结构
```

#### 需求 4：图表增强

**方案 1：使用 python_run + matplotlib**（当前）

```python
# 已支持，通过 python_run 工具
import matplotlib.pyplot as plt
plt.plot(data)
plt.savefig('outputs/chart.png')
```

**方案 2：专用图表 MCP**

```python
# 可以创建自定义 MCP Server
chart_mcp = {
    "chart": {
        "command": "python",
        "args": ["-m", "chart_mcp_server"],
        "tools": [
            "create_line_chart",
            "create_bar_chart",
            "create_pie_chart",
            "create_heatmap",
            "create_dashboard"
        ]
    }
}
```

### 3.3 MCP 集成到 DeepAgent

```python
# backend/tools/mcp/mcp_integration.py

from langchain_mcp_adapters import MCPToolkit
from typing import List, Dict

class MCPManager:
    """MCP Server 管理器"""
    
    def __init__(self):
        self.servers = {}
        self.toolkit = None
    
    def register_server(self, name: str, config: Dict):
        """注册 MCP Server"""
        self.servers[name] = config
    
    def get_tools(self) -> List:
        """获取所有 MCP 工具"""
        if not self.toolkit:
            self.toolkit = MCPToolkit(servers=self.servers)
        return self.toolkit.get_tools()
    
    def get_server_tools(self, server_name: str) -> List:
        """获取指定 Server 的工具"""
        return [t for t in self.get_tools() if t.name.startswith(server_name)]


# 默认配置
DEFAULT_MCP_SERVERS = {
    "filesystem": {
        "command": "npx",
        "args": ["-y", "@anthropic-ai/mcp-server-filesystem", "/Users"],
        "description": "扩展文件系统访问"
    },
    "sqlite": {
        "command": "npx",
        "args": ["-y", "@anthropic-ai/mcp-server-sqlite", "--db-path", "data/shared.db"],
        "description": "共享数据库"
    }
}
```

---

## 四、实施建议

### 4.1 优先级排序

| 优先级 | 任务 | 工作量 | 价值 |
|-------|------|-------|------|
| 🔴 高 | 修复学习回调函数签名 | 0.5h | 闭环 |
| 🔴 高 | 完善招投标 Skill 体系 | 2h | 业务 |
| 🟡 中 | 添加 SQLite MCP | 2h | 数据 |
| 🟡 中 | 添加图表增强 | 2h | 可视化 |
| 🟢 低 | 添加 Strict Tool Use | 1h | 优化 |
| 🟢 低 | 扩展 filesystem MCP | 1h | 扩展 |

### 4.2 立即执行

1. ✅ 修复 `learn_from_success/failure` 函数调用
2. 完善招投标 Skill 体系
3. 清理旧的重复目录

### 4.3 后续迭代

1. 集成 SQLite MCP
2. 创建图表增强工具
3. 添加 Strict Tool Use 支持
