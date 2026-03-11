# LangChain 工具扩展参数和组合使用指南

## 📋 目录

1. [LangChain 工具的扩展参数](#langchain-工具的扩展参数)
2. [WriteFileTool 路径参数说明](#writefiletool-路径参数说明)
3. [通过工具组合实现高级功能](#通过工具组合实现高级功能)
4. [实际应用示例](#实际应用示例)

---

## LangChain 工具的扩展参数

### 1. `root_dir` 参数（安全沙箱）

所有文件操作工具（继承自 `BaseFileToolMixin`）都支持 `root_dir` 参数，用于限制文件操作的范围。

```python
from langchain_community.tools import ReadFileTool, WriteFileTool

# 创建带安全沙箱的工具
read_tool = ReadFileTool(root_dir="/safe/directory")
write_tool = WriteFileTool(root_dir="/safe/directory")

# 所有文件操作都会被限制在 /safe/directory 目录下
# 尝试访问该目录外的文件会返回错误
```

**用途**：
- ✅ 安全沙箱：防止访问系统敏感文件
- ✅ 权限控制：限制 Agent 的文件操作范围
- ✅ 多租户隔离：不同用户使用不同的 root_dir

**示例**：
```python
# ✅ 可以访问沙箱内的文件
read_tool.invoke("data.txt")  # 实际路径: /safe/directory/data.txt

# ❌ 无法访问沙箱外的文件
read_tool.invoke("/etc/passwd")  # 返回错误: Access denied
```

---

## WriteFileTool 路径参数说明

### 参数详情

`WriteFileTool` 有 **3 个参数**：

1. **`file_path`**（必需）：文件路径
   - 可以是相对路径：`"output.txt"`、`"./results/data.txt"`
   - 可以是绝对路径：`"/tmp/output.txt"`、`"/Users/workspace/file.txt"`
   - 如果设置了 `root_dir`，路径会被限制在沙箱内

2. **`text`**（必需）：要写入的内容
   - 字符串类型
   - 会按照 UTF-8 编码写入

3. **`append`**（可选，默认 `False`）：是否追加
   - `False`：覆盖模式（默认）
   - `True`：追加模式

### 使用示例

```python
from langchain_community.tools import WriteFileTool

write_tool = WriteFileTool()

# 示例 1: 覆盖模式（默认）
write_tool.invoke({
    "file_path": "output.txt",
    "text": "Hello World"
})

# 示例 2: 追加模式
write_tool.invoke({
    "file_path": "log.txt",
    "text": "New log entry\n",
    "append": True
})

# 示例 3: 使用相对路径
write_tool.invoke({
    "file_path": "./results/data.txt",
    "text": "Data content"
})

# 示例 4: 使用绝对路径
write_tool.invoke({
    "file_path": "/tmp/output.txt",
    "text": "Data content"
})
```

---

## 通过工具组合实现高级功能

LangChain 的设计哲学是：**保持工具接口简洁，高级功能通过工具组合实现**。

### 方式 1: 创建新的组合工具（推荐）⭐

使用 `@tool` 装饰器创建新工具，内部调用标准工具。

**优点**：
- ✅ 接口清晰，LLM 容易理解
- ✅ 可以添加复杂的处理逻辑
- ✅ 可以组合多个标准工具

**示例**：分块读取工具

```python
from langchain_core.tools import tool
from langchain_community.tools import ReadFileTool

_read_file_tool = ReadFileTool()

@tool
def read_file_chunk(
    file_path: str,
    chunk_index: int = 0,
    chunk_size: int = 4000,
) -> str:
    """
    分块读取文件内容
    
    Args:
        file_path: 文件路径
        chunk_index: 分块索引（从0开始）
        chunk_size: 每块的大小（字符数）
    """
    # 1. 使用标准 read_file 工具读取完整文件
    full_content = _read_file_tool.invoke(file_path)
    
    # 2. 计算分块范围
    start = chunk_index * chunk_size
    end = start + chunk_size
    
    # 3. 提取分块内容
    chunk_content = full_content[start:end]
    
    return chunk_content
```

**已实现的组合工具**（见 `backend/tools/base/file_ops_advanced.py`）：
- `read_file_chunk`: 分块读取
- `read_file_lines`: 按行范围读取
- `search_file_content`: 关键词搜索
- `get_file_stats`: 文件统计信息

### 方式 2: 在 Agent 中让 LLM 自动组合调用

LLM 可以自动组合多个工具调用来实现复杂功能。

**示例场景**：

1. **复制文件**：
   ```
   LLM 调用流程：
   1. read_file("source.txt") → 获取内容
   2. write_file("destination.txt", text=内容) → 写入新文件
   ```

2. **分析大文件**：
   ```
   LLM 调用流程：
   1. read_file("large_file.txt") → 读取第一部分
   2. （如果需要更多内容）read_file_chunk("large_file.txt", chunk_index=1)
   3. （分析内容）analyze_document(...)
   ```

3. **搜索并提取**：
   ```
   LLM 调用流程：
   1. search_file_content("file.txt", keyword="error") → 找到相关行
   2. read_file_lines("file.txt", start_line=10, end_line=20) → 读取上下文
   3. write_file("extracted.txt", text=提取的内容) → 保存结果
   ```

### 方式 3: 使用 LangChain Chains/Runnable 组合

使用 LangChain 的 `RunnableSequence` 和 `RunnableParallel` 来组合工具。

**示例**：

```python
from langchain_core.runnables import RunnableSequence, RunnableParallel
from langchain_community.tools import ReadFileTool, WriteFileTool

read_tool = ReadFileTool()
write_tool = WriteFileTool()

# 顺序执行：读取 → 处理 → 写入
pipeline = RunnableSequence(
    read_tool,
    lambda content: content.upper(),  # 处理逻辑
    lambda content: write_tool.invoke({"file_path": "output.txt", "text": content})
)

# 并行执行：同时读取多个文件
parallel_read = RunnableParallel(
    file1=lambda x: read_tool.invoke("file1.txt"),
    file2=lambda x: read_tool.invoke("file2.txt"),
)
```

---

## 实际应用示例

### 示例 1: 处理大文件

**场景**：需要分析一个 100KB 的文档，但 LLM 窗口有限。

**解决方案**：

```python
# 方式 A: 使用分块读取工具
read_file_chunk("large_doc.txt", chunk_index=0)  # 读取第1块
read_file_chunk("large_doc.txt", chunk_index=1)  # 读取第2块
# ... LLM 可以根据需要继续读取

# 方式 B: 使用 RAG 检索（推荐）
# 1. 预处理文件，建立索引
process_file_for_rag("large_doc.txt", file_id="doc1")

# 2. 通过语义搜索获取相关内容
search_knowledge_base(query="关键信息", file_id="doc1")
```

### 示例 2: 按行精确定位

**场景**：需要读取文件的第 100-200 行。

**解决方案**：

```python
# 使用按行读取工具
read_file_lines("file.txt", start_line=100, end_line=200)
```

### 示例 3: 关键词搜索

**场景**：在文件中查找所有包含 "error" 的行。

**解决方案**：

```python
# 使用关键词搜索工具
search_file_content("log.txt", keyword="error", max_results=10)
```

### 示例 4: 文件复制

**场景**：复制文件到新位置。

**解决方案**：

```python
# LLM 自动组合调用
# 1. read_file("source.txt") → 获取内容
# 2. write_file("destination.txt", text=内容) → 写入新文件
```

---

## 📝 总结

### LangChain 工具设计原则

1. **接口简洁**：每个工具只包含必要的参数
2. **单一职责**：每个工具专注于一个任务
3. **功能组合**：高级功能通过工具组合实现

### 扩展参数

- ✅ **`root_dir`**：所有文件工具都支持，用于安全沙箱
- ✅ **`append`**：`WriteFileTool` 支持，用于追加模式

### 工具组合方式

1. ⭐ **创建组合工具**：使用 `@tool` 装饰器
2. **LLM 自动组合**：让 Agent 自动调用多个工具
3. **Chains/Runnable**：使用 LangChain 的链式组合

### 最佳实践

- ✅ 保持工具接口简洁（遵循 LangChain 标准）
- ✅ 高级功能通过组合工具实现
- ✅ 使用 `root_dir` 参数确保安全性
- ✅ 充分利用 LangChain 的标准工具和加载器

---

## 🔗 相关文件

- `backend/tools/base/file_ops.py`: 基础文件操作工具（标准接口）
- `backend/tools/base/file_ops_advanced.py`: 高级文件操作工具（组合实现）
- `backend/tools/base/registry.py`: 工具注册中心

