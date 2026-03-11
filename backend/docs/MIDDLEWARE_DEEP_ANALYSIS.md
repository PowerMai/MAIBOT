# DeepAgent/LangChain 中间件深度分析与优化

**说明**：本文档部分结论已过时。当前代码（`backend/engine/agent/deep_agent.py`）已启用 `TodoListMiddleware`（write_todos）与 `SummarizationMiddleware`（自动上下文压缩），下表 1.2 中二者为「未配置」的描述请以代码为准。

## 一、当前中间件使用状态

### 1.1 DeepAgents 原生中间件

| 中间件 | 状态 | 说明 |
|--------|------|------|
| `FilesystemMiddleware` | ✅ 已配置 | 通过 `backend` 参数自动启用 |
| `SubAgentMiddleware` | ✅ 已配置 | 通过 `subagents` 参数自动启用 |

### 1.2 LangChain 中间件

| 中间件 | 状态 | 说明 |
|--------|------|------|
| `ToolRetryMiddleware` | ✅ 已配置 | 工具调用失败自动重试 |
| `ModelRetryMiddleware` | ✅ 已配置 | 模型调用失败自动重试 |
| `ContextEditingMiddleware` | ✅ 已配置 | 上下文自动裁剪 |
| `ModelCallLimitMiddleware` | ✅ 已配置 | 模型调用次数限制 |
| `ToolCallLimitMiddleware` | ✅ 已配置 | 工具调用次数限制 |
| `SummarizationMiddleware` | ❌ **未配置** | 自动上下文压缩 |
| `TodoListMiddleware` | ❌ **未配置** | TODO 管理（write_todos） |
| `FilesystemFileSearchMiddleware` | ❌ **未配置** | 文件搜索增强 |
| `HumanInTheLoopMiddleware` | ⚠️ 部分配置 | 通过 `interrupt_on` 参数 |

### 1.3 关键发现

**问题 1：`skills_paths` 和 `memory_paths` 未被使用**

```python
# 当前代码定义了这些变量，但没有传递给任何中间件
skills_paths = [...]  # 定义了
memory_paths = [...]  # 定义了
# 但 create_deep_agent 没有这些参数！
```

**问题 2：SkillsMiddleware 和 MemoryMiddleware 不存在于 DeepAgents/LangChain**

这些是早期设计中的概念，实际已通过其他方式实现。

## 二、优化方案

### 2.1 Skill 加载机制（已实现：BUNDLE.md 内联 + 自定义工具）

**方案：通过系统提示词注入 Skill 信息**

```python
# 在 get_orchestrator_prompt() 中动态注入
def get_orchestrator_prompt(config):
    base_prompt = ORCHESTRATOR_PROMPT
    
    # 加载所有 Skill 的元数据
    skills_info = load_skills_metadata(skills_paths)
    
    # 注入到提示词
    skill_section = format_skills_for_prompt(skills_info)
    return base_prompt + "\n\n" + skill_section
```

### 2.2 Memory 机制（模拟 MemoryMiddleware）

**方案：通过 FilesystemFileSearchMiddleware + 系统提示词**

```python
# 配置文件搜索中间件
FilesystemFileSearchMiddleware(
    root_path=".context/",  # 记忆文件目录
    use_ripgrep=True,
    max_file_size_mb=1,
)
```

### 2.3 添加缺失的中间件

```python
additional_middleware = [
    # 现有的...
    
    # ✅ 新增：自动上下文压缩（当上下文过长时自动总结）
    SummarizationMiddleware(
        model=model,
        trigger_token_count=int(Config.MAX_TOKENS * 0.8),
    ),
    
    # ✅ 新增：TODO 管理（提供 write_todos 工具）
    TodoListMiddleware(),
    
    # ✅ 新增：文件搜索增强（快速搜索知识库）
    FilesystemFileSearchMiddleware(
        root_path=str(PROJECT_ROOT / "knowledge_base"),
        use_ripgrep=True,
        max_file_size_mb=5,
    ),
]
```

## 三、Skill 层级关系实现

### 3.1 Claude 的 Skill 规则

Claude 的 Skill 系统：
1. **通用 Skill**：所有任务都可能用到（文本分析、数据分析）
2. **专用 Skill**：特定领域任务（招投标、合同）
3. **组合使用**：专用 Skill 可以调用通用 Skill

### 3.2 实现方案

```python
# 在 SKILL.md 中声明依赖
---
name: proposal_writing
dependencies:
  - text_analysis      # 通用 Skill
  - document_generation  # 通用 Skill
---

# Agent 处理时：
# 1. 识别任务需要 proposal_writing Skill
# 2. 自动加载其依赖的通用 Skill
# 3. 组合使用
```

### 3.3 动态 Skill 加载

```python
def load_skill_with_dependencies(skill_name: str, loaded: set = None) -> str:
    """递归加载 Skill 及其依赖"""
    if loaded is None:
        loaded = set()
    
    if skill_name in loaded:
        return ""
    loaded.add(skill_name)
    
    skill_path = find_skill_path(skill_name)
    skill_content = read_skill_md(skill_path)
    
    # 解析依赖
    dependencies = parse_dependencies(skill_content)
    
    # 先加载依赖
    dep_content = ""
    for dep in dependencies:
        dep_content += load_skill_with_dependencies(dep, loaded)
    
    return dep_content + skill_content
```

## 四、MCP 生态分析

### 4.1 收费情况

| MCP 类型 | 收费 | 说明 |
|----------|------|------|
| Claude 官方 MCP | **免费** | 集成在 Claude API 中，按 token 计费 |
| Anthropic MCP Servers | **免费开源** | NPM 包，本地运行 |
| LangChain MCP Adapters | **免费开源** | `langchain-mcp-adapters` 包 |

### 4.2 LangChain MCP 集成

```python
# 使用 langchain-mcp-adapters（免费）
from langchain_mcp_adapters import MCPToolkit

toolkit = MCPToolkit(
    servers={
        "filesystem": {
            "command": "npx",
            "args": ["-y", "@anthropic-ai/mcp-server-filesystem", "/knowledge_base"],
        },
        "sqlite": {
            "command": "npx", 
            "args": ["-y", "@anthropic-ai/mcp-server-sqlite", "--db-path", "data/shared.db"],
        },
    }
)

# 获取工具
mcp_tools = toolkit.get_tools()
```

### 4.3 推荐的 MCP 扩展

| MCP Server | 功能 | 招投标业务用途 |
|------------|------|---------------|
| `filesystem` | 文件操作 | 管理招标文档、输出报告 |
| `sqlite` | 数据库 | 存储投标历史、评分数据 |
| `puppeteer` | 网页自动化 | 爬取招标公告 |
| `brave-search` | 网络搜索 | 市场调研、竞品分析 |

## 五、实施计划

### Phase 1：中间件完善（1-2小时）

1. 添加 `SummarizationMiddleware`
2. 添加 `TodoListMiddleware`
3. 添加 `FilesystemFileSearchMiddleware`

### Phase 2：Skill 加载机制（2-3小时）

1. 创建 `skill_loader.py` 模块
2. 实现依赖解析和递归加载
3. 集成到提示词生成

### Phase 3：MCP 集成（2-3小时）

1. 安装 `langchain-mcp-adapters`
2. 配置 filesystem 和 sqlite MCP
3. 集成到工具列表

### Phase 4：图表工具（1-2小时）

1. 创建 `chart_tools.py`
2. 封装 matplotlib/plotly
3. 注册为工具
