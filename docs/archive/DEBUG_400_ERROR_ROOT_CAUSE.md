# 🔍 问题调查：400 错误根源分析

## 错误信息分析

```
openai.BadRequestError: Error code: 400 - Invalid 'content': 
'content' objects must have a 'type' field that is either 'text' or 'image_url'."

错误位置：deepagents/middleware/subagents.py:483 → model node
```

## 🎯 问题定位

### 错误栈分析

```
File "deepagents/middleware/subagents.py", line 483, in awrap_model_call
  return await handler(request.override(system_prompt=system_prompt))

File "langchain/agents/factory.py", line 1157, in _execute_model_async
  output = await model_.ainvoke(messages)

File "langchain_openai/chat_models/base.py", line 1539, in _astream
  response = await self.async_client.create(**payload)

openai.BadRequestError: Error code: 400 - ...
```

### 根本原因假设

**DeepAgent 的某个中间件或节点在创建消息时，包含了非法的 content block 类型**。

可能的位置：
1. `deepagents/middleware/subagents.py` - SubAgent 中间件
2. `deepagents/middleware/filesystem.py` - 文件系统中间件
3. `deepagents/middleware/todo.py` - TODO 中间件
4. DeepAgent 的内部节点（Understanding, Planning, Delegation, Synthesis, Output）

## 🚀 调查步骤

### Step 1: 启用详细日志

在后端启动时添加：

```bash
export LANGCHAIN_DEBUG=true
export LANGCHAIN_VERBOSE=true
export DEEPAGENT_DEBUG=true
python backend/run_langgraph_server.py
```

### Step 2: 查找问题代码

关键搜索词：
```
# 搜索所有创建 content block 的地方
grep -r "content.*\[" backend/
grep -r "type.*json" backend/
grep -r "type.*text" backend/

# 特别是在 DeepAgent 相关的代码中
grep -r "AIMessage" backend/engine/
```

### Step 3: 可能的修复

**假设：某个地方在消息中添加了 json content block**

修复方法：
```python
# ❌ 错误：这会在 LLM 调用前被拒绝
message = AIMessage(
    content=[
        {"type": "text", "text": "..."},
        {"type": "json", "json": {...}}  # ❌ LLM 不支持
    ]
)

# ✅ 正确：只在最后的响应中添加 UI
# DeepAgent 内部使用纯文本
message = AIMessage(content="...")

# 只在 Output 节点中创建完整的响应
response = AIMessage(
    content=[
        {"type": "text", "text": "..."},
        {"type": "json", "json": {...}}  # ✅ 只给客户端
    ]
)
```

## 📋 可能的违规代码位置

### 位置 1: 消息增强中间件

```python
# ❌ 可能的问题代码
def wrap_message(message):
    if isinstance(message.content, str):
        # 某处可能添加了 json block
        message.content = [
            {"type": "text", "text": message.content},
            {"type": "json", "json": {...}}  # ❌ 错误！
        ]
    return message
```

### 位置 2: 文件系统中间件

```python
# deepagents/middleware/filesystem.py 可能在处理文件时
# 添加了不该有的 content block
```

### 位置 3: SubAgent 中间件

```python
# deepagents/middleware/subagents.py 可能在调用 SubAgent 时
# 生成了包含非法 block 的消息
```

## 🔧 快速修复指南

### 如果问题在我们的代码中

**检查清单**：
- [ ] `backend/engine/nodes/router_node.py` - 是否修改了消息?
- [ ] `backend/engine/nodes/editor_tool_node.py` - 返回的消息格式是否正确?
- [ ] `backend/engine/middleware/` - 是否有中间件修改了消息?
- [ ] 任何自定义的消息处理代码

**修复方式**：
```python
# 确保所有中间消息只有 text/image_url
def safe_message(content):
    return AIMessage(
        content=[
            {"type": "text", "text": str(content)},
            # ❌ 不要添加其他类型
        ]
    )

# 或者直接使用字符串
return AIMessage(content="text content only")
```

### 如果问题在 DeepAgent 库中

**解决方案**：
```python
# 1. 更新 deepagents 库到最新版本
pip install --upgrade deepagents

# 2. 或者禁用有问题的中间件
from deepagents import Agent
agent = create_deep_agent(
    # ... 其他参数 ...
    disable_middlewares=[
        'subagent_middleware',  # 可能有问题的中间件
        'filesystem_middleware',
    ]
)
```

## 📊 验证修复

运行测试，确认消息格式正确：

```python
# 测试：验证所有消息的 content block 类型
def validate_messages(messages):
    for msg in messages:
        if isinstance(msg.content, list):
            for block in msg.content:
                if isinstance(block, dict):
                    msg_type = block.get("type")
                    # ✅ 只允许这些类型
                    if msg_type not in ["text", "image_url"]:
                        print(f"❌ 非法 block 类型: {msg_type}")
                        return False
    return True

# 在消息发送前调用
assert validate_messages(state['messages']), "消息格式不合法!"
```

## 🎯 最终检查清单

- [ ] 后端日志显示哪个节点产生了问题消息
- [ ] 找到并修复产生非法 content block 的代码
- [ ] 确保所有中间消息只有 `text` 和 `image_url` 类型
- [ ] UI blocks 只在最后的响应中添加
- [ ] 测试流式输出正常工作
- [ ] 验证 200 OK 而不是 400 错误

---

## 🆘 如果无法定位问题

**建议的调试步骤**：

1. **简化测试**：发送简单的文本消息（无附件、无上下文）
2. **逐步添加复杂度**：
   - 只发送文本
   - 添加编辑器上下文
   - 添加文件附件
3. **检查每个步骤的日志**
4. **使用 curl 或 Postman 测试后端 API**（排除前端因素）

```bash
# 直接测试后端
curl -X POST http://localhost:2024/threads \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"type": "human", "content": "Hello"}]}'
```

5. **检查 DeepAgent 的日志输出**


