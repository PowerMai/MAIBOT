# 上下文窗口管理问题分析

## 🔴 当前问题

### 1. 工具数量问题

**问题**：工具越多，工具描述占用越多上下文
- 每个工具的描述、参数说明都会发送给 LLM
- 工具越多，上下文开销越大
- 为了 `read_file` 就有一堆函数（`read_file_chunk`, `read_file_lines`, `search_file_content` 等）不值得

**影响**：
```
上下文组成：
- 系统提示词：~2000 tokens
- 工具描述：~500 tokens/工具 × N 个工具
- 对话历史：~1000 tokens/轮
- 工具调用结果：文件内容（可能数万 tokens）
─────────────────────────────────────────
总计：可能远超窗口限制
```

### 2. read_file 工作方式

**当前流程**：
```
1. LLM 调用 read_file(file_path)
2. 工具读取整个文件到内存
3. 返回完整文件内容（字符串）
4. 工具结果被添加到对话历史（messages）
5. 整个对话历史（包括文件内容）发送给 LLM
```

**问题**：
- ❌ 没有窗口大小检查
- ❌ 大文件会直接超出窗口限制
- ❌ 文件内容直接添加到上下文，没有智能处理

### 3. 窗口大小在哪里考虑？

**答案**：**当前没有考虑！**

工具结果直接添加到对话历史，然后整个历史一起发送给 LLM。如果文件很大，会直接超出窗口限制。

### 4. 迭代方式

**是的**：直接将读取的信息 + 上次的聊天记录都发给 LLM 进行迭代。

```
每次迭代的上下文：
┌─────────────────────────────────────┐
│ 系统提示词                           │
│ 工具描述（所有工具）                  │
│ 对话历史（所有轮次）                  │
│ 工具调用结果（包括大文件内容）        │
└─────────────────────────────────────┘
→ 发送给 LLM
```

---

## ✅ 解决方案

### 方案 1: 智能截断（简单但有效）⭐

在工具返回时，根据窗口大小智能截断：

```python
class EnhancedReadFileTool(BaseTool):
    def _run(self, file_path: str) -> str:
        # 读取文件
        content = ...
        
        # 估算当前上下文大小
        # 系统提示词 + 工具描述 + 对话历史 ≈ 5000 tokens
        # 剩余窗口 ≈ 30000 tokens（假设 32K 窗口）
        max_content_tokens = 25000  # 留出安全余量
        
        # 估算字符数（粗略：1 token ≈ 4 字符）
        max_content_chars = max_content_tokens * 4
        
        if len(content) > max_content_chars:
            truncated = content[:max_content_chars]
            return (
                f"{truncated}\n\n"
                f"[文件已截断，共 {len(content)} 字符，"
                f"已显示前 {max_content_chars} 字符。"
                f"如需更多内容，请使用 read_file 多次读取不同部分]"
            )
        
        return content
```

**优点**：
- ✅ 简单实现
- ✅ 防止超出窗口
- ✅ LLM 可以继续调用读取其他部分

**缺点**：
- ❌ 粗暴截断，可能丢失关键信息
- ❌ 需要多次调用才能获取完整内容

### 方案 2: 上下文压缩（推荐）⭐⭐

在发送给 LLM 前，检查并压缩上下文：

```python
def compress_context(messages: List[BaseMessage], max_tokens: int) -> List[BaseMessage]:
    """
    压缩上下文，确保不超过窗口限制
    
    策略：
    1. 保留系统提示词和最近的对话
    2. 压缩或摘要旧的工具调用结果
    3. 大文件内容只保留摘要或关键部分
    """
    # 1. 计算当前 tokens
    current_tokens = estimate_tokens(messages)
    
    if current_tokens <= max_tokens:
        return messages
    
    # 2. 压缩策略
    compressed = []
    tokens_used = 0
    
    # 保留系统提示词
    system_msg = messages[0] if messages[0].type == "system" else None
    if system_msg:
        compressed.append(system_msg)
        tokens_used += estimate_tokens([system_msg])
    
    # 保留最近的对话（最后 N 轮）
    recent_messages = messages[-10:]  # 最后 10 条消息
    for msg in recent_messages:
        if msg.type == "tool" and len(msg.content) > 10000:
            # 大文件内容：只保留摘要
            msg.content = summarize_large_content(msg.content)
        
        compressed.append(msg)
        tokens_used += estimate_tokens([msg])
        
        if tokens_used > max_tokens * 0.9:  # 留 10% 余量
            break
    
    return compressed
```

**优点**：
- ✅ 智能压缩，保留关键信息
- ✅ 防止超出窗口
- ✅ 可以摘要旧内容

**缺点**：
- ❌ 实现较复杂
- ❌ 需要 token 估算

### 方案 3: RAG 检索（最佳）⭐⭐⭐

使用 RAG 只检索相关内容，而不是读取整个文件：

```python
@tool
def read_file(file_path: str, query: Optional[str] = None) -> str:
    """
    读取文件内容
    
    如果提供了 query，使用 RAG 检索相关内容
    否则读取文件开头部分（摘要）
    """
    if query:
        # 使用 RAG 检索相关内容
        return search_file_content(file_path, query)
    else:
        # 读取文件开头（摘要）
        content = read_file_head(file_path, max_chars=5000)
        return f"{content}\n\n[这是文件的开头部分，如需更多内容，请提供查询关键词]"
```

**优点**：
- ✅ 只获取相关内容，不浪费窗口
- ✅ 支持大文件
- ✅ 语义理解，精准定位

**缺点**：
- ❌ 需要预处理和索引
- ❌ 实现较复杂

### 方案 4: LLM 自动分块（灵活）⭐⭐

保持工具简洁，让 LLM 自动分块读取：

```python
# 只保留一个 read_file 工具，但返回时提示如何继续
class EnhancedReadFileTool(BaseTool):
    def _run(self, file_path: str) -> str:
        content = read_file_content(file_path)
        
        # 如果文件很大，只返回开头，提示如何继续
        if len(content) > 10000:
            head = content[:10000]
            return (
                f"{head}\n\n"
                f"[文件较大，共 {len(content)} 字符，"
                f"已显示前 10000 字符。"
                f"如需继续，请再次调用 read_file，"
                f"我会自动从上次位置继续读取]"
            )
        
        return content
```

**优点**：
- ✅ 工具简洁，只有一个 read_file
- ✅ LLM 自动决定如何继续
- ✅ 灵活，适应不同场景

**缺点**：
- ❌ 需要多次调用
- ❌ LLM 需要理解如何分块

---

## 🎯 推荐方案：混合策略

### 短期（立即实施）

1. **删除不必要的工具**
   - 删除 `file_ops_advanced.py` 中的组合工具
   - 只保留核心工具：`read_file`, `write_file`, `list_directory` 等

2. **智能截断**
   - 在 `read_file` 中实现智能截断
   - 根据窗口大小自动截断，并提示如何继续

### 中期（优化）

3. **上下文压缩**
   - 在发送给 LLM 前检查上下文大小
   - 自动压缩或摘要旧内容

### 长期（最佳）

4. **RAG 集成**
   - 大文件自动预处理和索引
   - `read_file` 支持查询参数，使用 RAG 检索

---

## 📝 实施建议

### 1. 简化工具集

**删除**：`backend/tools/base/file_ops_advanced.py`

**保留**：核心工具
- `read_file`：智能截断版本
- `write_file`：标准工具
- `list_directory`：标准工具
- 其他标准文件操作工具

### 2. 增强 read_file

```python
class EnhancedReadFileTool(BaseTool):
    def _run(self, file_path: str) -> str:
        # 读取文件
        content = ...
        
        # 智能截断（考虑窗口大小）
        max_chars = self._calculate_max_chars()
        
        if len(content) > max_chars:
            return self._truncate_with_hint(content, max_chars)
        
        return content
    
    def _calculate_max_chars(self) -> int:
        """根据窗口大小计算最大字符数"""
        # 假设 32K 窗口
        # 系统提示词 + 工具描述 + 对话历史 ≈ 8000 tokens
        # 剩余 ≈ 24000 tokens ≈ 96000 字符
        # 留 50% 安全余量 ≈ 48000 字符
        return 48000
    
    def _truncate_with_hint(self, content: str, max_chars: int) -> str:
        """截断并提示如何继续"""
        truncated = content[:max_chars]
        total_chars = len(content)
        return (
            f"{truncated}\n\n"
            f"[文件已截断：共 {total_chars} 字符，"
            f"已显示前 {max_chars} 字符。"
            f"如需更多内容，请继续对话，我会自动读取后续部分]"
        )
```

### 3. 上下文管理（可选）

在 LangGraph 的节点中，在调用 LLM 前压缩上下文：

```python
def agent_node(state: AgentState):
    messages = state["messages"]
    
    # 压缩上下文
    compressed_messages = compress_context_if_needed(messages)
    
    # 调用 LLM
    response = llm.invoke(compressed_messages)
    
    return {"messages": [response]}
```

---

## 🔗 相关文件

- `backend/tools/base/file_ops.py`: 核心文件操作工具
- `backend/tools/base/file_ops_advanced.py`: **应删除**（工具太多）
- `backend/engine/agent/deep_agent.py`: Agent 主逻辑（可添加上下文压缩）

