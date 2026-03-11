# 🎨 生成式 UI 官方标准改正指南

## 核心改正

**改正方向**: 从 `additional_kwargs.ui` 改为 `json` content block（官方标准）

---

## 官方标准的三种生成式 UI 实现方式

### 方式 1️⃣ : 直接在 AIMessage 的 content 中使用 json block（推荐）

```python
# ✅ 官方标准：最清晰的方式
from langchain_core.messages import AIMessage

message = AIMessage(
    content=[
        {"type": "text", "text": "这是表格数据："},
        {
            "type": "json",  # ✅ 官方 content block
            "json": {
                "type": "table",
                "columns": ["Name", "Age", "City"],
                "rows": [
                    {"Name": "Alice", "Age": 30, "City": "NYC"},
                    {"Name": "Bob", "Age": 25, "City": "LA"}
                ]
            }
        }
    ]
)

state["messages"].append(message)
```

### 方式 2️⃣ : 使用 ToolMessage with artifact（推荐用于工具结果）

```python
# ✅ 官方标准：用于工具执行结果
from langchain_core.messages import ToolMessage

message = ToolMessage(
    content="表格已生成",
    tool_call_id="table_gen_123",
    artifact={  # ✅ assistant-ui 官方支持的字段
        "type": "table",
        "columns": [...],
        "rows": [...]
    }
)

state["messages"].append(message)
```

### 方式 3️⃣ : 在 additional_kwargs 中使用官方字段

```python
# ✅ 官方标准：use reasoning for thinking process
from langchain_core.messages import AIMessage

message = AIMessage(
    content="最终答案",
    additional_kwargs={
        "reasoning": {  # ✅ 官方支持的字段
            "summary": [
                {"text": "第一步：分析..."},
                {"text": "第二步：处理..."}
            ]
        }
    }
)
```

---

## 改正步骤

### 第 1 步：改正中间件检测逻辑

**文件**: `backend/engine/middleware/generative_ui_middleware.py`

**改正后的逻辑**:

```python
@staticmethod
def _detect_and_generate_ui_content_blocks(message: Any) -> Optional[List[Dict[str, Any]]]:
    """
    ✅ 官方标准：返回 content block 列表而不是 additional_kwargs.ui
    """
    content = getattr(message, 'content', '')
    
    if not content:
        return None
    
    content_blocks = []
    
    # 检测JSON数据 - 可能是表格
    if (content.startswith('{') or content.startswith('[')) and not '```' in content:
        try:
            import json
            data = json.loads(content)
            
            if isinstance(data, list) and len(data) > 0:
                if isinstance(data[0], dict):
                    # ✅ 返回 json content block（官方标准）
                    content_blocks.append({
                        "type": "json",
                        "json": {
                            "type": "table",
                            "columns": list(data[0].keys()),
                            "rows": data
                        }
                    })
                    return content_blocks
        except:
            pass
    
    # 检测代码块
    if '```' in content:
        import re
        code_match = re.search(r'```(\w+)?\n([\s\S]*?)```', content)
        if code_match:
            language = code_match.group(1) or 'text'
            code = code_match.group(2)
            # ✅ 返回 json content block 包含代码（官方标准）
            content_blocks.append({
                "type": "json",
                "json": {
                    "type": "code",
                    "language": language,
                    "code": code
                }
            })
            return content_blocks
    
    return None
```

### 第 2 步：改正节点使用方式

**文件**: `backend/engine/nodes/generative_ui_node.py` 或直接在消息生成处

**改正方式**:

```python
# ❌ 改正前
def generative_ui_node(state: AgentState) -> AgentState:
    # ... 检测 UI ...
    message.additional_kwargs['ui'] = ui_config  # ❌ 自定义格式
    return state

# ✅ 改正后（在消息生成处直接使用）
def process_node(state: AgentState) -> AgentState:
    # 处理逻辑...
    result = generate_table_data()
    
    # ✅ 直接在消息中包含 UI 数据
    return {
        "messages": [
            AIMessage(
                content=[
                    {"type": "text", "text": "处理完成，结果如下："},
                    {
                        "type": "json",
                        "json": {
                            "type": "table",
                            "columns": result["columns"],
                            "rows": result["rows"]
                        }
                    }
                ]
            )
        ]
    }
```

### 第 3 步：前端自动处理（无需改动）

```typescript
// ✅ 前端已有官方处理
// convertLangChainMessages 会自动识别 json content block
// 并通过对应的 UI 组件渲染

// 例如：
// - json block with type: "table" → 渲染表格
// - json block with type: "code" → 渲染代码块
// - 等等...
```

---

## 具体改正方案

### 方案 A：保留现有逻辑，改变输出格式（推荐短期）

**文件**: `backend/engine/nodes/generative_ui_node.py`

```python
def generative_ui_node(state: AgentState) -> AgentState:
    """✅ 改正后：输出 content block 而不是 additional_kwargs.ui"""
    messages = state.get('messages', [])
    
    if not messages:
        return state
    
    # 处理最后一条消息
    last_msg = messages[-1]
    if isinstance(last_msg, AIMessage):
        # 检测 UI 内容
        ui_content = GenerativeUIMiddleware._detect_and_generate_ui_content_blocks(last_msg)
        
        if ui_content:
            # ✅ 改为在 content 中添加，而不是 additional_kwargs
            if isinstance(last_msg.content, str):
                last_msg.content = [
                    {"type": "text", "text": last_msg.content},
                    *ui_content  # 添加 UI content blocks
                ]
            elif isinstance(last_msg.content, list):
                last_msg.content.extend(ui_content)
    
    # ✅ 改为返回标准格式
    return {"messages": messages}
```

### 方案 B：完全重构（推荐长期）

直接在各个处理节点中生成完整的消息，无需后处理。

```python
# 在 DeepAgent 的 Output 节点中
def output_node(state):
    # 生成结果
    result = process_result()
    
    # ✅ 直接生成完整消息（包含 UI）
    message = AIMessage(
        content=[
            {"type": "text", "text": result["text"]},
            {"type": "json", "json": result["ui_data"]}  # 如果需要
        ]
    )
    
    return {"messages": [message]}
```

---

## 前端兼容性

### 好消息 ✅

前端的 `convertLangChainMessages` 已经支持处理所有官方 content block：

```typescript
// 来自官方库：packages/react-langgraph/src/convertLangChainMessages.ts

const contentToParts = (content: LangChainMessage["content"]) => {
  if (typeof content === "string")
    return [{ type: "text" as const, text: content }];
  return content
    .map((part) => {
      const type = part.type;
      switch (type) {
        case "text":
          return { type: "text", text: part.text };
        case "json":  // ✅ 已支持！
          return { type: "data", data: part.json };
        case "image_url":
          return { type: "image", image: part.image_url };
        case "file":
          return { type: "file", ... };
        // ... 其他类型
      }
    });
};
```

### 前端无需改动！

只需后端改为使用官方格式，前端会自动识别和渲染。

---

## 优势总结

| 方面 | 改正前 | 改正后 | 优势 |
|------|------|------|-----|
| **格式** | additional_kwargs.ui | json content block | 标准 |
| **前端处理** | 需要自定义 | 自动渲染 | 无需改动 |
| **UI 类型支持** | 受限 | 灵活扩展 | 易于扩展 |
| **与官方兼容** | 否 | 是 | 完全兼容 |
| **流式输出** | 可能阻塞 | 无延迟 | 性能提升 |

---

## 改正优先级

| 优先级 | 任务 | 时间 | 重要性 |
|-------|------|------|--------|
| P1 | 改正中间件逻辑 | 1h | 🔴 高 |
| P1 | 改正节点使用方式 | 1-2h | 🔴 高 |
| P2 | 删除 generative_ui_node | 30min | 🟡 中 |
| P2 | 清理代码 | 30min | 🟢 低 |

---

## 实施建议

### 短期（立即）

1. 改正 `_detect_and_generate_ui` 返回 content block 列表
2. 改正 `generative_ui_node` 使用新的返回值
3. 测试验证

### 中期（可选）

1. 逐步在各个节点中直接生成完整消息
2. 减少对后处理节点的依赖

### 长期（可选）

1. 删除 `generative_ui_node` 和中间件
2. 所有 UI 直接在节点中生成
3. 完全符合官方标准

---

## 验证改正

### 后端验证

```python
from langchain_core.messages import AIMessage

# 验证 content block 格式
msg = AIMessage(
    content=[
        {"type": "text", "text": "数据"},
        {"type": "json", "json": {"type": "table", ...}}  # ✅
    ]
)

# 检查是否包含 json content block
assert any(block.get("type") == "json" for block in msg.content if isinstance(block, dict))
```

### 前端验证

```typescript
// 前端会自动识别并渲染
// 查看浏览器中的数据是否正确显示
```

---

**下一步：按照这个指南改正生成式 UI 实现。**


