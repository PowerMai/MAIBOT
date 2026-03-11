# 前后端标准化改正计划

## 🎯 目标

完全对标 LangChain 官方标准和 assistant-ui 官方实现，消除所有自定义非标准代码。

---

## 📋 改正任务清单

### 【优先级 P0 - 立即改正】

#### 1. 后端：消息生成标准化

**文件**: `backend/engine/middleware/generative_ui_middleware.py`

**现状**：
```python
# ❌ 自定义 UI 格式
last_msg.additional_kwargs['ui'] = {
    "type": "table",
    "columns": columns,
    "data": data
}
```

**改正**：
```python
# ✅ 官方标准：使用 content block
from langchain_core.messages import AIMessage

message = AIMessage(
    content=[
        {"type": "text", "text": summary_text},
        {"type": "json", "json": {
            "type": "table",
            "columns": columns,
            "rows": data
        }}
    ]
)
state['messages'].append(message)
```

**工作量**: 小（1-2小时）
**影响范围**: 生成式 UI 相关的所有节点

---

#### 2. 后端：路由元数据标准化

**文件**: `backend/engine/state/agent_state.py` + `backend/engine/nodes/router_node.py`

**现状**：
```python
# ❌ 自定义状态字段
class AgentState(TypedDict):
    messages: Annotated[List[BaseMessage], operator.add]
    source: Optional[str]           # ❌ 应该在消息 metadata 中
    request_type: Optional[str]     # ❌ 应该在消息 metadata 中
    operation: Optional[str]        # ❌ 应该在消息 metadata 中
    file_path: Optional[str]        # ❌ 应该在消息 metadata 中
    # ... 更多自定义字段
```

**改正**：
```python
# ✅ 精简的状态
class AgentState(TypedDict):
    messages: Annotated[List[BaseMessage], operator.add]
    # 所有路由信息通过消息 metadata 或 additional_kwargs 传递
    # 如果需要保留某些字段，应该在消息处理后提取

# ✅ 在消息中传递路由信息
def router_node(state: AgentState) -> AgentState:
    last_message = state['messages'][-1]
    
    # 从消息的 additional_kwargs 中提取（保留在消息中，不复制到 state）
    metadata = last_message.additional_kwargs or {}
    source = metadata.get('source', 'chatarea')
    request_type = metadata.get('request_type', 'agent_chat')
    
    # ✅ 直接基于这些信息进行路由决策（无需存储在 state 中）
    # state 中不保存这些字段
    
    return state
```

**工作量**: 小（1-2小时）
**影响范围**: State 定义 + 路由节点 + 路由决策函数

---

#### 3. 后端：文件附件标准化

**文件**: `backend/engine/nodes/router_node.py`

**现状**：
```python
# ❌ 自定义文件格式
attachments.append({
    'name': filename,
    'content': file_content,
    'type': mime_type,
    'base64_data': base64_data,
})
kwargs['attachments'] = attachments  # ❌ 放在 additional_kwargs
```

**改正**：
```python
# ✅ 官方标准：已在 content blocks 中
# 文件已经通过 content block 传递，无需额外处理
# 如果需要从消息中提取文件，直接从 content list 中获取

if isinstance(content, list):
    for block in content:
        if block.get("type") == "file":
            file_info = block["file"]  # ✅ 直接访问标准字段
            filename = file_info["filename"]
            file_data = file_info["file_data"]
            mime_type = file_info["mime_type"]
            
            # 处理文件...
            # 无需重新组织，直接使用官方格式
```

**工作量**: 小（1小时）
**影响范围**: router_node + 所有需要处理文件的节点

---

#### 4. 后端：移除自定义中间件

**文件**: `backend/engine/middleware/generative_ui_middleware.py`

**现状**：
```python
# ❌ 自定义中间件层
class GenerativeUIMiddleware:
    def _detect_and_generate_ui(self):
        # 后处理消息
        # 这会阻塞流式输出
```

**改正**：
```python
# ✅ 直接在节点中生成 UI
# 在相关的处理节点中直接创建包含 UI 的消息
# 无需中间件

def processing_node(state: AgentState) -> AgentState:
    # 处理逻辑...
    result = process_data()
    
    # ✅ 直接生成完整消息（包含 UI）
    message = AIMessage(
        content=[
            {"type": "text", "text": result_text},
            {"type": "json", "json": {"type": "table", ...}}
        ]
    )
    state['messages'].append(message)
    return state
```

**工作量**: 中（2-3小时）
**影响范围**: 移除 middleware 模块 + 更新所有生成 UI 的节点

---

### 【优先级 P1 - 次要改正】

#### 5. 前端：消息处理标准化

**文件**: `frontend/desktop/src/components/ChatComponents/MyRuntimeProvider.tsx`

**现状**：✅ 已经符合官方标准

**检查项目**：
- [ ] 没有自定义的消息转换逻辑
- [ ] 没有修改消息的 `additional_kwargs`
- [ ] 直接 `yield* generator`（无任何处理）

**如需添加功能**：
```typescript
// ✅ 如果需要添加上下文，直接在消息中
const enhancedMessages = messages.map((msg, idx) => {
  if (idx === messages.length - 1 && msg.type === 'human') {
    return {
      ...msg,
      additional_kwargs: {
        ...msg.additional_kwargs,
        // ✅ 在 additional_kwargs 中添加元数据（前端只读）
        editor_context: {
          file_path: editorContext.editorPath,
          // ...
        }
      }
    };
  }
  return msg;
});
```

**工作量**: 无（已符合标准）
**影响范围**: 无

---

#### 6. 后端：简化 DeepAgent 输入/输出

**文件**: `backend/engine/agent/deep_agent.py`

**现状**：
```python
# 检查 DeepAgent 是否有自定义的 schema
AgentInput, AgentOutput, ContextInfo, AttachmentInfo
```

**改正**：
```python
# ✅ 如果这些 schema 不是官方标准，应该简化
# 应该直接使用 BaseMessage
# 不定义自己的 input/output schema

# 官方标准：
# Input: {"messages": [BaseMessage, ...]}
# Output: {"messages": [BaseMessage, ...]}
```

**工作量**: 中-大（取决于 DeepAgent 的定义）
**影响范围**: DeepAgent 的所有输入/输出处理

---

### 【优先级 P2 - 可选改进】

#### 7. 测试与验证

**文件**: `backend/test_streaming.py`, `backend/test_streaming_debug.py`

**目标**：
- [ ] 验证流式输出正确
- [ ] 验证消息格式标准
- [ ] 验证生成式 UI 显示
- [ ] 验证文件处理

**改正方向**：
```python
# ✅ 添加标准验证
def test_message_format():
    """验证所有消息都符合官方格式"""
    for msg in messages:
        assert isinstance(msg, BaseMessage)  # ✅ 使用官方类型
        assert msg.type in ["system", "human", "ai", "tool"]
        assert isinstance(msg.content, (str, list))
        if isinstance(msg.content, list):
            for block in msg.content:
                assert block["type"] in ["text", "file", "image_url", "json", ...]

def test_streaming_events():
    """验证流式事件符合官方标准"""
    for event in stream_events:
        assert event["event"] in LangGraphKnownEventTypes
```

**工作量**: 小（1-2小时）
**影响范围**: 测试文件

---

## 🔄 改正步骤

### 第一阶段：后端消息标准化（2-3小时）

1. **修改 AgentState** - 移除自定义字段
2. **修改 router_node** - 不保存状态字段，直接在消息中处理
3. **修改消息生成** - 所有消息使用官方格式
4. **更新 DeepAgent** - 确保输出格式标准

**验证方式**：
```python
def verify_backend():
    # 运行一次完整流程
    result = agent.invoke({"messages": [HumanMessage("测试")]})
    
    # 检查所有消息
    for msg in result['messages']:
        assert isinstance(msg, BaseMessage)
        assert msg.type in ["system", "human", "ai", "tool"]
        # 检查没有自定义字段
        assert "ui" not in (msg.additional_kwargs or {})
        assert "attachments" not in (msg.additional_kwargs or {})
```

### 第二阶段：前端流式处理验证（1小时）

1. **验证消息接收** - 确认消息格式正确
2. **验证流式输出** - 确认消息逐个到达
3. **验证 UI 显示** - 确认生成式 UI 正确显示

**验证方式**：
```typescript
// 浏览器控制台
runtime.on("message", (msg) => {
  console.log("消息格式:", msg);
  console.log("内容类型:", typeof msg.content);
  console.log("是否包含自定义字段:", msg.additional_kwargs?.ui);
});
```

### 第三阶段：端到端集成测试（1-2小时）

1. **文本消息** - 简单的文本对话
2. **文件上传** - 验证文件处理
3. **生成式 UI** - 验证表格/代码等
4. **流式输出** - 验证实时输出

---

## 📊 改正优先级矩阵

| 任务 | 重要度 | 紧急度 | 工作量 | 优先级 |
|------|-------|-------|------|------|
| 消息生成标准化 | 🔴 高 | 🔴 高 | 小 | **P0** |
| 路由元数据标准化 | 🟡 中 | 🔴 高 | 小 | **P0** |
| 文件附件标准化 | 🔴 高 | 🟡 中 | 小 | **P0** |
| 移除自定义中间件 | 🔴 高 | 🟡 中 | 中 | **P0** |
| 前端消息处理 | 🟢 低 | 🟢 低 | 无 | P1 |
| DeepAgent 简化 | 🟡 中 | 🟡 中 | 大 | P1 |
| 测试与验证 | 🟡 中 | 🟡 中 | 小 | P2 |

---

## ✅ 改正完成检查清单

### 后端检查

- [ ] State 定义只包含 `messages` 和最少必要字段
- [ ] 所有消息使用 `HumanMessage`, `AIMessage` 等官方类型
- [ ] 所有 content block 都是官方标准类型
- [ ] UI 数据在 `content` 中，不在 `additional_kwargs`
- [ ] 文件使用官方的 `file` content block
- [ ] 没有自定义的中间件或后处理节点
- [ ] 没有自定义的消息转换逻辑
- [ ] 所有节点直接返回更新后的 state

### 前端检查

- [ ] 使用 `useLangGraphRuntime` hook
- [ ] `stream` 函数直接 `yield* generator`
- [ ] `sendMessage` 返回官方类型 `AsyncGenerator<LangGraphMessagesEvent>`
- [ ] 没有自定义的消息转换
- [ ] 事件处理在 `eventHandlers` 中
- [ ] 支持所有官方 content block 类型

### 消息流检查

- [ ] 前端消息 → 后端直接接收（无转换）
- [ ] 后端返回完整的 `AIMessage`
- [ ] 流式输出逐个 token/事件返回
- [ ] 前端自动合并并显示

### 功能检查

- [ ] 文本对话正常
- [ ] 文件上传正常
- [ ] 生成式 UI 显示正常
- [ ] 流式输出实时显示

---

## 📚 参考

### 官方示例对比

| 组件 | 官方示例位置 | 项目位置 | 是否符合 |
|------|------------|--------|---------|
| API 层 | `examples/with-langgraph/lib/chatApi.ts` | `frontend/.../langserveChat.ts` | ✅ |
| Runtime | `examples/with-langgraph/app/MyRuntimeProvider.tsx` | `frontend/.../MyRuntimeProvider.tsx` | ✅ |
| 消息转换 | `packages/react-langgraph/src/convertLangChainMessages.ts` | 自动处理 | ✅ |
| 事件处理 | `packages/react-langgraph/src/useLangGraphMessages.ts` | 自动处理 | ✅ |
| 消息累积 | `packages/react-langgraph/src/LangGraphMessageAccumulator.ts` | 自动处理 | ✅ |

### 需要对标的地方

1. **后端 State** - 对标 `langgraph` 官方示例
2. **后端消息** - 对标 `langchain_core.messages`
3. **后端节点** - 对标 `langgraph` 官方示例
4. **前端 API** - 已对标，无需改进

---

## 🎯 成功标准

✅ **改正完成时**：

1. **代码符合官方标准** - 所有消息、状态、节点都符合 LangChain 官方标准
2. **无自定义概念** - 没有 `ui`, `attachments`, 自定义状态字段等
3. **流式输出正常** - 前端能实时收到消息内容
4. **生成式 UI 正常** - 表格、代码等 UI 能正确显示
5. **端到端集成测试通过** - 所有功能端到端测试通过


