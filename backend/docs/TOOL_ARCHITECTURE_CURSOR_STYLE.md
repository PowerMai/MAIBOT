# 工具架构设计 - Cursor 风格混合模式

## 📋 概述

本文档描述了基于 LangChain 官方标准的工具架构设计，采用 Cursor 风格的混合模式：**基础工具 + python_run**。

## 🎯 设计原则

1. **遵循 LangChain 官方标准**：所有工具都基于 LangChain 官方工具和示例
2. **混合模式**：简单任务用基础工具，复杂任务用 python_run
3. **工具注入**：python_run 执行环境中自动注入所有基础工具
4. **最小化上下文开销**：保持工具描述简洁，引导 LLM 正确使用

## 🏗️ 架构设计

```
┌─────────────────────────────────────────┐
│          LLM 决策层                      │
│  (根据任务复杂度选择工具)                │
└──────────────┬──────────────────────────┘
               │
       ┌───────┴────────┐
       │                │
   ┌───▼───┐      ┌─────▼─────┐
   │ 简单  │      │   复杂     │
   │ 任务  │      │   任务     │
   └───┬───┘      └─────┬─────┘
       │                │
   ┌───▼──────────┐ ┌───▼──────────────┐
   │ 基础工具      │ │  python_run      │
   │ - read_file   │ │  - 组合工具      │
   │ - write_file  │ │  - 复杂逻辑      │
   │ - search      │ │  - 数据处理      │
   └───────────────┘ └──────────────────┘
```

## 🔧 基础工具（LangChain 官方标准）

### 文件操作工具

所有文件操作工具都直接使用 LangChain Community 的官方工具：

- **read_file**: `EnhancedReadFileTool`（基于 `ReadFileTool`）
  - 支持多种格式：txt, md, pdf, docx, doc, xlsx, csv
  - 自动识别文件类型
  - 接口：`read_file.invoke("path/to/file")`

- **write_file**: `WriteFileTool`（LangChain 官方）
  - 接口：`write_file.invoke({"file_path": "path", "text": "content"})`

- **delete_file, copy_file, move_file, list_directory**: LangChain 官方工具

### 代码执行工具

- **python_run**: `execute_python_code`（增强版 PythonREPLTool）
  - 自动导入库（pandas, numpy, docx, pptx 等）
  - 注入所有基础工具到执行环境
  - 超时控制、错误处理

## 🚀 python_run 增强功能

### 工具注入

在 `python_run` 执行环境中，所有基础工具自动注入：

```python
# 在 CodeExecutor.execute() 中
from backend.tools.base.registry import get_core_tools_registry
tools_registry = get_core_tools_registry()

# 注入所有基础工具
for tool_name, tool in tools_registry.tools.items():
    exec_globals[tool_name] = tool

# 提供统一的工具字典
exec_globals['tools'] = tools_registry.tools
```

### 使用示例

```python
# 示例 1: 在 python_run 中调用基础工具
content = read_file.invoke("data.txt")
processed = process_content(content)
write_file.invoke({"file_path": "output.txt", "text": processed})

# 示例 2: 灵活文件读取
with open("file.txt") as f:
    lines = f.readlines()[100:200]  # 读取特定行
    print(''.join(lines))

# 示例 3: 组合工具和库
content = read_file.invoke("data.csv")
import pandas as pd
from io import StringIO
df = pd.read_csv(StringIO(content))
result = df.groupby('category').sum()
```

## 📝 工具使用策略

### 简单任务 → 基础工具

**适用场景**：
- 读取文件
- 写入文件
- 搜索
- 简单的文件操作

**优势**：
- ✅ 更可靠
- ✅ 更快
- ✅ 错误更少
- ✅ 自动上下文管理

**示例**：
```python
# 直接调用基础工具
content = read_file.invoke("file.txt")
write_file.invoke({"file_path": "output.txt", "text": content})
```

### 复杂任务 → python_run

**适用场景**：
- 数据分析
- 文档处理
- 自定义转换
- 灵活文件读取（特定行、分块等）
- 组合多个工具

**优势**：
- ✅ 灵活组合
- ✅ 处理复杂逻辑
- ✅ 可以使用所有 Python 库
- ✅ 可以调用基础工具

**示例**：
```python
# 使用 python_run 组合工具和库
python_run('''
content = read_file.invoke("data.csv")
import pandas as pd
from io import StringIO
df = pd.read_csv(StringIO(content))
result = df.groupby('category').sum()
print(result)
''')
```

## 🎓 系统提示词引导

### Document Agent 提示词

在 `backend/engine/prompts/subagent_doc_prompts.py` 中：

```
工具使用策略（Cursor 风格）：
- 简单任务：优先使用基础工具（read_file, write_file 等）
  * 更可靠、更快、错误更少
  * 例如：读取文件、写入文件、搜索
- 复杂任务：使用 python_run 组合工具和库
  * 灵活组合、处理复杂逻辑
  * 例如：数据分析、文档处理、自定义转换、灵活文件读取（特定行、分块等）
- python_run 中已注入所有基础工具，可直接调用
  * 用法: content = read_file.invoke("path/to/file.txt")
  * 用法: write_file.invoke({"file_path": "path", "text": "content"})
```

### Orchestrator 提示词

在 `backend/engine/prompts/deepagent_prompts.py` 中：

```
## Tool Usage Strategy (Cursor Style)
- Simple tasks: Use base tools (read_file, write_file, etc.)
- Complex tasks: Use python_run to combine tools and libraries
- python_run has all base tools injected, can call directly
```

## ✅ LangChain 标准符合性

### 工具接口标准

所有工具都遵循 LangChain 的 `BaseTool` 接口：

```python
from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field

class ToolInput(BaseModel):
    """工具输入参数"""
    param: str = Field(description="参数描述")

class MyTool(BaseTool):
    name: str = "tool_name"
    description: str = "工具描述"
    args_schema: type[BaseModel] = ToolInput
    
    def _run(self, param: str) -> str:
        """同步执行"""
        return result
    
    async def _arun(self, param: str) -> str:
        """异步执行"""
        return self._run(param)
```

### 工具注册标准

使用 `CoreToolsRegistry` 统一管理：

```python
from backend.tools.base.registry import get_core_tools_registry

registry = get_core_tools_registry()
tool = registry.get_tool("read_file")
```

## 📊 工具列表

### 基础工具（直接提供给 LLM）

| 工具名称 | LangChain 来源 | 用途 |
|---------|---------------|------|
| read_file | EnhancedReadFileTool | 读取文件（多格式支持） |
| write_file | WriteFileTool | 写入文件 |
| delete_file | DeleteFileTool | 删除文件 |
| copy_file | CopyFileTool | 复制文件 |
| move_file | MoveFileTool | 移动文件 |
| list_directory | ListDirectoryTool | 列出目录 |
| python_run | execute_python_code | 执行 Python 代码 |
| shell_run | ShellTool | 执行 Shell 命令 |
| web_search | TavilySearchResults | 网络搜索 |
| duckduckgo_search | DuckDuckGoSearchRun | DuckDuckGo 搜索 |
| file_search | FileSearchTool | 文件搜索 |

### python_run 中可用的工具

所有基础工具都注入到 `python_run` 执行环境中，可以通过以下方式调用：

```python
# 方式 1: 直接调用工具对象
content = read_file.invoke("path/to/file.txt")

# 方式 2: 通过工具字典
content = tools['read_file'].invoke("path/to/file.txt")
```

## 🔍 实现细节

### 1. EnhancedReadFileTool

位置：`backend/tools/base/file_ops.py`

- 基于 LangChain `ReadFileTool`
- 内部使用 `UnifiedDocumentLoader` 自动识别文件类型
- 支持：txt, md, pdf, docx, doc, xlsx, csv 等

### 2. execute_python_code

位置：`backend/tools/base/code_execution.py`

- 基于 LangChain `PythonREPLTool`
- 增强功能：
  - 自动导入库
  - 注入基础工具
  - 超时控制
  - 错误处理

### 3. 工具注入机制

在 `CodeExecutor.execute()` 中：

```python
# 注入基础工具
from backend.tools.base.registry import get_core_tools_registry
tools_registry = get_core_tools_registry()

for tool_name, tool in tools_registry.tools.items():
    exec_globals[tool_name] = tool

exec_globals['tools'] = tools_registry.tools
```

## 🎯 最佳实践

1. **优先使用基础工具**：简单任务直接调用基础工具
2. **复杂任务用 python_run**：需要组合或复杂逻辑时使用
3. **工具组合**：在 python_run 中调用基础工具，而不是重新实现
4. **错误处理**：python_run 中的代码应该包含错误处理
5. **资源管理**：注意文件句柄、内存等资源管理

## 📚 相关文档

- [LangChain Tools 官方文档](https://python.langchain.com/docs/modules/tools/)
- [LangChain Community Tools](https://python.langchain.com/docs/integrations/tools/)
- [PythonREPLTool 文档](https://python.langchain.com/docs/integrations/tools/python/)

## 🔄 更新历史

- 2024-01-XX: 初始实现，采用 Cursor 风格混合模式
- 2024-01-XX: 增强 python_run，注入基础工具
- 2024-01-XX: 更新系统提示词，引导工具使用策略

