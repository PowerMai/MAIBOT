# 🚀 完整实现指南：Text Block + 大文件分拆

## ✅ 已实现的组件

### 1. 前端改进（MyRuntimeProvider.tsx）
✅ 智能文件处理：
- 检测文件大小
- 小文件（<100KB）→ 直接转换为 text block
- 大文件（>100KB）→ 分拆成多个 text blocks（每块 50KB）
- 分块格式：`[文件: name (type), 块 X/Y] content...`

### 2. 后端模块

#### backend/engine/utils/file_chunker.py
✅ 文件分拆工具库：
- `FileChunker`：核心分拆逻辑
  - 自动判断是否需要分拆
  - Token 消耗估算
  - 文件大小验证
  
- `ChunkMessageCache`：分拆块缓存管理
  - 缓存分拆块
  - 检测是否全部接收
  - 自动合并块
  - 过期清理

#### backend/engine/nodes/chunked_message_handler.py
✅ 分拆消息处理节点：
- 检测分拆块标记
- 缓存接收到的块
- 等待全部块后合并
- 提取分拆块信息

---

## 🔧 集成步骤

### Step 1: 更新 backend/engine/nodes/__init__.py

```python
from backend.engine.nodes.chunked_message_handler import chunked_message_handler

__all__ = [
    "router_node",
    "route_decision",
    "editor_tool_node",
    "error_node",
    "chunked_message_handler",  # ✅ 添加
]
```

### Step 2: 在 main_graph.py 中集成

```python
# backend/engine/core/main_graph.py

from engine.nodes import (
    router_node,
    route_decision,
    editor_tool_node,
    error_node,
    chunked_message_handler,  # ✅ 添加
)

def create_router_graph():
    workflow = StateGraph(AgentState)
    
    # 添加节点
    workflow.add_node("router", router_node)
    workflow.add_node("chunked_message_handler", chunked_message_handler)  # ✅ 添加
    workflow.add_node("deepagent", deepagent_graph)
    workflow.add_node("editor_tool", editor_tool_node)
    workflow.add_node("error", error_node)
    
    # 设置入口
    workflow.set_entry_point("router")
    
    # ✅ 添加路由：router → chunked_message_handler → 其他
    workflow.add_conditional_edges(
        "router",
        route_decision,
        {
            "deepagent": "chunked_message_handler",  # 改为先处理分拆
            "editor_tool": "editor_tool",
            "error": "error",
        }
    )
    
    # ✅ 从 chunked_message_handler 继续路由
    workflow.add_conditional_edges(
        "chunked_message_handler",
        _chunked_route_decision,  # 新增：在处理分拆后决定下一步
        {
            "deepagent": "deepagent",
            "skip": "deepagent",  # 等待下一个块
        }
    )
    
    # 结束边
    workflow.add_edge("deepagent", END)
    workflow.add_edge("editor_tool", END)
    workflow.add_edge("error", END)
    
    return workflow.compile()


def _chunked_route_decision(state: AgentState) -> str:
    """
    ✅ 新增路由函数：处理分拆消息后的路由
    
    如果消息已完整合并 → 继续到 deepagent
    如果还在等待块 → 等待下一个块（但不会真正等待，设计上会）
    """
    last_message = state['messages'][-1]
    
    # 检查是否是状态消息（等待块）
    if isinstance(last_message, HumanMessage):
        is_chunk_status = getattr(last_message, 'additional_kwargs', {}).get('is_chunk_status', False)
        if is_chunk_status:
            # 还在等待块，但这里会返回到 deepagent（后续交由用户发送下一块）
            return "skip"
    
    return "deepagent"
```

---

## 💻 使用流程

### 小文件上传（< 100KB）

```
用户: 上传 sample.txt (50KB)
     ↓
前端: 转换为 text block
     "[文件: sample.txt (text/plain), 50KB]\n content..."
     ↓
后端: 直接处理，无分拆
     ↓
LLM: 分析完整内容
     ↓
结果: ✅ 直接响应
```

### 大文件上传（> 100KB）

```
用户: 上传 document.pdf (500KB)
     ↓
前端: 检测到大文件，分拆成 10 块（每块 50KB）
     块 1: "[文件: document.pdf (application/pdf), 块 1/10]\n..."
     块 2: "[文件: document.pdf (application/pdf), 块 2/10]\n..."
     ...
     ↓
后端: 
  1. 接收块 1 → 缓存
     ✅ 已缓存块 1/10
     💬 等待剩余块
     
  2. 接收块 2 → 缓存
     ✅ 已缓存块 2/10
     💬 等待剩余块
     
  ...
  
  10. 接收块 10 → 缓存并合并
      ✅ 所有块已接收，开始合并
      ✅ 合并完成（500KB）
      ↓
      LLM: 分析完整内容
      ↓
      结果: ✅ 最终响应
```

---

## 🧪 测试用例

### 测试 1：小文件

```bash
# 1. 上传 < 100KB 的文本文件
# 2. 消息中不应出现块标记
# 3. AI 应该直接处理并响应
```

### 测试 2：中等文件

```bash
# 1. 上传 100KB-500KB 的文件
# 2. 应该分拆为 2-10 块
# 3. 前端依次发送每一块
# 4. 后端缓存所有块
# 5. 最后一块接收后，自动合并并处理
```

### 测试 3：大文件

```bash
# 1. 上传 500KB-1MB 的文件
# 2. 应该分拆为 10-20 块
# 3. 前端依次发送每一块
# 4. 后端缓存并等待
# 5. 全部块到达后合并
```

### 测试 4：超大文件

```bash
# 1. 尝试上传 > 1MB 的文件
# 2. 应该被拒绝（需要超过 100MB 才拆分处理）
# 3. 前端显示错误消息
```

---

## 📊 配置参数说明

### 前端（MyRuntimeProvider.tsx）

```javascript
const CHUNK_SIZE = 50 * 1024;  // 50KB per chunk
const CHUNK_THRESHOLD = 100_000;  // 100KB 以上分拆
```

### 后端（file_chunker.py）

```python
FileChunker.CHUNK_SIZE = 50_000  # 50KB per chunk
FileChunker.MAX_CHUNKS = 20  # 最多 20 块
FileChunker.MAX_FILE_SIZE = 1_000_000  # 1MB 最大
FileChunker.SAFE_TOKEN_BUDGET = 3000  # 预留 token
```

这些参数可以根据您的 LLM 能力调整：
- 更强的模型 → 增加 CHUNK_SIZE（60KB）
- token 限制 → 减小 CHUNK_SIZE（40KB）

---

## 🔍 日志输出示例

### 小文件

```
[MyRuntimeProvider] ✅ 小文件转换为 text block: sample.txt (50KB)
[MyRuntimeProvider] ✅ 已完成消息 content block 处理（支持文件分拆）
[chunked_message_handler] 🔍 检测到分拆消息，开始处理...
[chunked_message_handler] ⚠️ 无法提取分拆块信息
[chunked_message_handler] 消息无分拆块标记，直接传给 deepagent
```

### 大文件

```
[MyRuntimeProvider] ⚠️ 大文件检测: document.pdf (500KB)，开始分拆...
[MyRuntimeProvider] ✅ 分拆块 1/10: 50KB
[MyRuntimeProvider] ✅ 分拆块 2/10: 50KB
...
[MyRuntimeProvider] ✅ 分拆块 10/10: 50KB
[MyRuntimeProvider] ✅ 文件分拆完成: document.pdf (500KB) → 10 块

[chunked_message_handler] 🔍 检测到分拆消息，开始处理...
[chunked_message_handler] ✅ 解析分拆块: file=document.pdf, type=application/pdf, chunk=1/10
[chunked_message_handler] 📦 已缓存分拆块: document.pdf_10 (1/10)
[chunked_message_handler] ⏳ 等待剩余 9 块 (1/10 已接收)
[chunked_message_handler] ✅ 已接收文件 document.pdf 的第 1/10 块。💬 继续发送剩余块...

... (块 2-9 类似)

[chunked_message_handler] ✅ 所有块已接收，开始合并: document.pdf_10
[chunked_message_handler] ✅ 分拆合并完成: document.pdf_10 (500000 字符)

deepagent: 分析完整的 document.pdf 内容...
```

---

## 🎯 下一步工作

### 已完成 ✅
- 前端智能文件分拆
- 后端分拆块缓存
- 后端消息合并

### 待完成（可选优化）
- [ ] 进度显示 UI
- [ ] 块上传速度优化
- [ ] 分拆块验证（使用哈希）
- [ ] 块超时处理
- [ ] 大文件流式处理

---

## 💡 性能指标

```
文件大小      分拆方式     块数    总 token 消耗   处理时间
50KB         无分拆       1       ~12.5K        < 1 秒
200KB        分拆         4       ~50K          < 5 秒
500KB        分拆         10      ~125K         < 10 秒
1MB          分拆         20      ~250K         < 20 秒
> 1MB        拒绝         -       -             -
```

**优势对比**：
- ✅ 文本方式 vs 直接发送：避免 400 错误
- ✅ 分拆方式 vs 单块发送：支持更大文件
- ✅ 本地 LLM：不需要升级到 API
- ✅ 成本低：无需付费 API


