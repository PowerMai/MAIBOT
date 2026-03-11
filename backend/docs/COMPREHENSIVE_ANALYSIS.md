# 全面分析：DeepAgent 中间件、Claude 资源、上下文优化

## 一、DeepAgent 中间件分析

### 1.1 DeepAgent 自动加载的中间件

通过分析 `deepagents/graph.py` 源码，发现 `create_deep_agent()` 会**自动加载**以下中间件：

```python
deepagent_middleware = [
    TodoListMiddleware(),                    # ✅ 自动加载
    FilesystemMiddleware(backend=backend),   # ✅ 自动加载
    SubAgentMiddleware(...,                  # ✅ 自动加载
        default_middleware=[
            TodoListMiddleware(),            # SubAgent 也有
            FilesystemMiddleware(backend),   # SubAgent 也有
            SummarizationMiddleware(...),    # ✅ SubAgent 自动压缩
            AnthropicPromptCachingMiddleware(),
            PatchToolCallsMiddleware(),
        ],
    ),
    SummarizationMiddleware(...),            # ✅ 主 Agent 自动压缩
    AnthropicPromptCachingMiddleware(),      # ✅ 自动加载
    PatchToolCallsMiddleware(),              # ✅ 自动加载
]
```

### 1.2 我们只需要添加的额外中间件

| 中间件 | 来源 | 用途 |
|--------|------|------|
| `create_content_fix_middleware()` | 自定义 | 修复本地模型 Jinja 模板问题 |
| `ModelCallLimitMiddleware` | LangChain | 防止无限 LLM 循环 |
| `ToolCallLimitMiddleware` | LangChain | 防止工具滥用 |
| `ToolRetryMiddleware` | LangChain | 工具失败重试 |
| `ModelRetryMiddleware` | LangChain | 模型失败重试 |
| `ContextEditingMiddleware` | LangChain | 在压缩前清理工具调用 |
| `FilesystemFileSearchMiddleware` | LangChain | ripgrep 快速搜索 |

### 1.3 已移除的重复中间件

- ~~`TodoListMiddleware()`~~ - DeepAgent 自动加载
- ~~`SummarizationMiddleware()`~~ - DeepAgent 自动加载（85% 触发）

## 二、禁用功能修复

### 2.1 SQLite 问题已修复

```
✅ SqliteSaver 可用
✅ SQLiteStore 可用
```

需要确保 `langgraph-checkpoint-sqlite` 包正确安装到 venv。

### 2.2 知识图谱和自学习

在 `.env` 中设置：
```
ENABLE_KNOWLEDGE_RETRIEVER=true
ENABLE_KNOWLEDGE_GRAPH=true
ENABLE_SELF_LEARNING=false  # 可选，开启会增加 token 消耗
```

## 三、Claude 开源资源分析

### 3.1 MCP (Model Context Protocol) 资源

**Claude 官方 MCP Servers**（免费开源）：
- GitHub: `github.com/modelcontextprotocol/servers`
- NPM 包，可直接使用

**langchain-mcp-adapters**（免费开源）：
- GitHub: `github.com/langchain-ai/langchain-mcp-adapters`
- 将 MCP 服务器转换为 LangChain 工具

### 3.2 推荐的 MCP 服务器

| 服务器 | 用途 | 推荐度 |
|--------|------|--------|
| `@modelcontextprotocol/server-filesystem` | 文件系统操作 | ⭐⭐⭐⭐⭐ |
| `@modelcontextprotocol/server-sqlite` | 数据库操作 | ⭐⭐⭐⭐ |
| `@modelcontextprotocol/server-puppeteer` | 浏览器自动化 | ⭐⭐⭐ |
| `@modelcontextprotocol/server-memory` | 持久化记忆 | ⭐⭐⭐⭐ |
| `@modelcontextprotocol/server-github` | GitHub 操作 | ⭐⭐⭐ |

### 3.3 集成方式

```python
from langchain_mcp_adapters import MCPToolkit

# 连接 MCP 服务器
toolkit = MCPToolkit(
    servers=[
        {"name": "filesystem", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]},
        {"name": "sqlite", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-sqlite", "db.sqlite"]},
    ]
)

# 获取工具列表
tools = toolkit.get_tools()
```

## 四、上下文优化策略

### 4.1 问题分析

本地模型窗口较小（32K/64K），文档类业务需要读大量内容，导致：
1. 上下文快速填满
2. 多轮对话后信息不足
3. 重复传递相同内容

### 4.2 优化方案一：Python 代码处理

**核心思路**：让 LLM 制定方案，用 Python 代码执行，减少 LLM 处理次数

```python
# LLM 生成的 Python 代码示例
import os
import re

# 1. 扫描目录找到目标文件
files = [f for f in os.listdir("uploads") if f.endswith(".pdf")]

# 2. 用 Python 提取关键信息
from PyPDF2 import PdfReader
reader = PdfReader("uploads/招标文件.pdf")
toc = reader.outline  # 目录结构

# 3. 只返回摘要给 LLM
summary = {
    "total_pages": len(reader.pages),
    "sections": [item.title for item in toc],
    "key_terms": extract_key_terms(text),  # 自定义函数
}
```

**优势**：
- Python 处理速度快，不消耗 token
- 可以精确定位内容，只读取需要的部分
- 支持复杂的数据处理和计算

### 4.3 优化方案二：分类压缩卸载

**核心思路**：不同内容类型采用不同压缩策略

| 内容类型 | 压缩策略 | 存储位置 |
|----------|----------|----------|
| 任务描述 | 保留原文 | 上下文 |
| 关键决策 | 保留原文 | 上下文 |
| 文件内容 | 摘要 + 路径 | 文件系统 |
| 工具调用结果 | 摘要 + 路径 | 文件系统 |
| 历史对话 | 自动压缩 | SummarizationMiddleware |
| 中间数据 | 路径引用 | outputs/.cache/ |

**实现方式**：

```python
# 在 Orchestrator 提示词中指导
"""
## 上下文管理规则

1. **文件内容**：
   - 不要在上下文中保留完整文件内容
   - 使用 read_file() 读取后，提取关键信息
   - 将提取的信息写入 outputs/.cache/xxx_summary.md
   - 后续只传递路径和摘要

2. **工具调用结果**：
   - 大于 500 字符的结果写入文件
   - 只在上下文中保留路径和摘要

3. **按需查看**：
   - 如果需要详细信息，使用 read_file() 重新读取
   - 不要依赖上下文中的历史内容
"""
```

### 4.4 Python 工具调用 vs SubAgent 调用

**问题**：通过 Python 代码访问 LLM 是否合理？

**回答**：**不推荐**。原因：
1. SubAgent 有完整的上下文隔离和状态管理
2. Python 直接调用 LLM 会绕过中间件（重试、限流、压缩）
3. 无法利用 LangGraph 的流式输出和检查点

**推荐做法**：
- 用 Python 做**数据处理**（提取、计算、格式化）
- 用 SubAgent 做**决策和生成**

## 五、Cursor 的内部/外部 Python 实现

### 5.1 Cursor 的架构

Cursor 有两种执行模式：

1. **内部 Python**（快速，无显示）：
   - 在 Agent 内部执行的 Python 代码
   - 用于数据处理、文件操作、计算
   - 不需要用户交互，速度快
   - 例如：文件搜索、代码分析、格式转换

2. **外部 Python**（显示在聊天区）：
   - 需要用户看到执行过程的 Python 代码
   - 用于数据可视化、报告生成
   - 有明确的输出结果
   - 例如：生成图表、运行测试、执行脚本

### 5.2 为什么 Cursor 速度快

1. **不是所有操作都需要 LLM**：
   - 文件列表：直接 `ls` 命令
   - 代码搜索：直接 `ripgrep`
   - 文件读取：直接 `read_file`

2. **工具调用优先于 LLM 推理**：
   - 能用工具解决的不用 LLM
   - 只在需要理解/生成时调用 LLM

3. **并行执行**：
   - 多个工具调用可以并行
   - 不需要等待 LLM 逐个处理

### 5.3 本系统的优化方向

```python
# 在 Executor 提示词中强调
"""
## 执行策略

1. **优先使用工具**：
   - 文件操作：read_file, write_file, ls, grep
   - 代码执行：python_run, bash
   - 数据处理：用 Python 代码而非 LLM

2. **减少 LLM 调用**：
   - 不要让 LLM 做简单的字符串处理
   - 不要让 LLM 做文件格式转换
   - 不要让 LLM 做数学计算

3. **批量处理**：
   - 多个文件用 batch_read_files
   - 多个搜索用 grep + 正则
"""
```

## 六、Skill 层级实现

### 6.1 Claude 的 Skill 实现

Claude Code 的 Skill 系统：
1. **Progressive Disclosure**：只加载元数据，按需读取完整内容
2. **YAML Frontmatter**：定义触发词、依赖、工具权限
3. **层级结构**：Foundation → General → Domain → Complex

### 6.2 本系统的实现

```
knowledge_base/skills/
├── foundation/          # 基础能力（文件操作、代码执行）
├── general/             # 通用能力（文本分析、数据分析）
│   ├── text_analysis/
│   ├── data_analysis/
│   └── document_generation/
├── education/           # 教育领域
├── manufacturing/       # 制造领域
├── marketing/           # 市场营销
│   └── bidding/         # 招投标
│       ├── proposal_writing/
│       ├── bid_evaluation/
│       └── compliance_check/
└── complex/             # 复合能力
```

### 6.3 Skill 加载机制

```python
# skill_loader.py
class SkillLoader:
    def initialize(self, skills_paths):
        """加载 SKILL.md 的 YAML 元数据"""
        for path in skills_paths:
            metadata = self._parse_skill_frontmatter(skill_file)
            self.skills_metadata[skill_name] = metadata
    
    def get_skill_content(self, skill_name):
        """按需读取完整 SKILL.md 内容"""
        return skill_file.read_text()
```

## 七、生成式 UI 优化

### 7.1 Claude 的 UI 实现

Claude 的 Artifacts 系统：
1. **类型识别**：根据内容自动选择渲染器
2. **实时预览**：代码、图表、文档即时渲染
3. **交互式组件**：可编辑、可执行

### 7.2 本系统的优化方向

```typescript
// 根据工具调用类型选择 UI 组件
const toolUIMap = {
  'python_run': PythonExecutionUI,      // 代码 + 输出
  'create_chart': ChartPreviewUI,       // 图表预览
  'write_file': FileCreatedUI,          // 文件创建提示
  'read_file': FileContentUI,           // 文件内容展示
  'search_knowledge': KnowledgeResultUI, // 知识检索结果
};

// 动态渲染
function renderToolResult(toolCall) {
  const UIComponent = toolUIMap[toolCall.name] || DefaultUI;
  return <UIComponent result={toolCall.result} />;
}
```

## 八、已完成的优化

### 8.1 中间件优化 ✅

1. **移除重复配置**：
   - DeepAgent 自动加载：TodoListMiddleware, FilesystemMiddleware, SubAgentMiddleware, SummarizationMiddleware
   - 我们只添加：限流、重试、上下文清理、文件搜索

2. **修复 SQLite 存储** ✅：
   - SqliteSaver 现已可用
   - 支持会话状态持久化

### 8.2 提示词优化 ✅

1. **Orchestrator**：
   - 添加上下文管理规则（路径优先、摘要优先、按需加载）
   - 添加 Python 优先策略指导

2. **Executor**：
   - 添加 Python 优先策略详细说明
   - 明确 Python 适合 vs LLM 适合的任务

3. **Knowledge**：
   - 输出限制（摘要 100 字、要点 5 条、步骤 7 步）
   - 分类检索策略

### 8.3 Skill 系统 ✅

1. **Progressive Disclosure 模式**：
   - 启动时只加载元数据
   - 按需通过 read_file 获取完整内容
   - 支持依赖关系

2. **层级结构**：
   - general（通用）→ domain（领域）→ complex（复合）

## 九、后续优化方向

### 9.1 短期（1-2 周）

1. 添加更多 Skill 文件（教育、制造、管理领域）
2. 集成 MCP 服务器（filesystem, sqlite, memory）
3. 优化前端生成式 UI

### 9.2 中期（1 个月）

1. 性能监控和调优
2. 多模态支持（图片、音频）
3. 知识图谱增强
