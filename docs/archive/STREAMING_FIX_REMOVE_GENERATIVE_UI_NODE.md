# 流式输出修复：移除 generative_ui 节点

## ✅ 已完成的修复

### 1. 移除 `generative_ui_node` 从主 Graph

**文件**: `backend/engine/core/main_graph.py`

**修改**:
- ❌ 移除 `workflow.add_node("generative_ui", generative_ui_node)`
- ❌ 移除所有到 `generative_ui` 的边
- ✅ 改为直接结束：`workflow.add_edge("deepagent", END)`

**原因**:
- `generative_ui_node` 是后处理节点，会阻塞流式输出
- 它处理的是完整消息列表，而不是流式消息块
- 导致前端只能看到最终结果，无法看到流式更新

### 2. 新的架构

**修复前**:
```
router → deepagent → generative_ui → END
                        ↑
                  阻塞流式输出
```

**修复后**:
```
router → deepagent → END
            ↓
    流式输出过程中
    动态添加生成式 UI
```

## 📋 下一步：在 DeepAgent 内部处理生成式 UI

由于 DeepAgent 是第三方库（`deepagents`），无法直接修改其内部节点。

### 方案 A：使用 LangGraph 的流式中间件（推荐）

在 LangGraph Server 层面处理，不阻塞流式输出：

```python
# 在 langserve_app.py 或类似位置
async def stream_with_generative_ui(stream):
    async for event in stream:
        # 处理流式事件，动态添加 UI
        if isinstance(event, dict) and 'messages' in event:
            for msg in event['messages']:
                if isinstance(msg, AIMessage):
                    ui = GenerativeUIMiddleware._detect_and_generate_ui(msg)
                    if ui:
                        if not msg.additional_kwargs:
                            msg.additional_kwargs = {}
                        msg.additional_kwargs['ui'] = ui
        yield event
```

### 方案 B：在消息生成时处理（需要修改 DeepAgent）

如果 DeepAgent 支持自定义输出处理，可以在那里添加。

### 方案 C：前端处理（临时方案）

在前端接收到消息后，动态检测并添加生成式 UI。

## 🎯 预期效果

### 修复前
- ❌ 流式输出被阻塞
- ❌ 前端只能看到最终结果
- ❌ 无法看到中间过程

### 修复后
- ✅ 流式输出正常工作
- ✅ 前端可以看到流式更新
- ✅ 生成式 UI 在流式过程中动态添加

## ⚠️ 注意事项

1. **生成式 UI 处理位置**：
   - 需要在流式输出过程中处理
   - 不能阻塞流式输出
   - 应该在消息生成时动态添加

2. **工具调用结果**（write_file）：
   - 需要在工具调用节点中处理
   - 添加 `editor_action` UI 事件

3. **测试**：
   - 测试流式输出是否正常
   - 测试生成式 UI 是否正确显示
   - 测试文件同步是否正常

---

*更新时间: 2026-01-04*

