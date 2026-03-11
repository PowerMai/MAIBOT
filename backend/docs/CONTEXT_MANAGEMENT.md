# DeepAgent 上下文管理分析与优化

## DeepAgent 原生上下文管理机制

### 1. 消息历史结构

```
HumanMessage → AIMessage (+ tool_calls) → ToolMessage → AIMessage → ...
```

每轮对话都会累积消息，特别是工具调用结果可能占用大量 token。

### 2. SubAgent 上下文隔离

```python
# SubAgentMiddleware 内部实现
def _validate_and_prepare_state(subagent_type, description, runtime):
    subagent_state = {k: v for k, v in runtime.state.items() 
                      if k not in _EXCLUDED_STATE_KEYS}  # 排除 messages, todos
    subagent_state["messages"] = [HumanMessage(content=description)]  # 只有一条消息！
    return subagent, subagent_state
```

**关键发现**：
- SubAgent 不会继承父 Agent 的 `messages` 和 `todos`
- SubAgent 只接收 `task()` 的 `description` 作为唯一消息
- 这是设计如此，实现上下文隔离

### 3. SubAgent 结果返回

```python
def _return_command_with_state_update(result, tool_call_id):
    state_update = {k: v for k, v in result.items() 
                    if k not in _EXCLUDED_STATE_KEYS}
    return Command(
        update={
            **state_update,
            "messages": [ToolMessage(result["messages"][-1].text, tool_call_id=tool_call_id)],
        }
    )
```

SubAgent 只返回最后一条消息的 `text`，其他状态会合并到父 Agent。

## 中间件配置优化

### 优化前

```python
ClearToolUsesEdit(
    trigger=int(Config.MAX_TOKENS * 0.7),  # 70% = 22937 tokens
    keep=5,  # 保留 5 次工具调用
)

SummarizationMiddleware(
    model=model,
    trigger_token_count=int(Config.MAX_TOKENS * 0.85),  # 85% = 27852 tokens
)
```

**问题**：
- 触发阈值太高，可能在压缩前就超出窗口
- 保留 5 次工具调用可能仍然太多（大文件 read_file 可能 10000+ tokens）

### 优化后

```python
ClearToolUsesEdit(
    trigger=int(Config.MAX_TOKENS * 0.5),  # 50% = 16384 tokens（提前触发）
    keep=3,  # 保留 3 次工具调用（减少）
    clear_tool_inputs=True,  # 清理工具输入（节省更多 token）
)

SummarizationMiddleware(
    model=model,
    trigger=("fraction", 0.65),  # 65%（使用 fraction 模式）
    keep=("messages", 15),  # 保留 15 条消息（减少）
)
```

**触发顺序**：
1. **50%** → ClearToolUsesEdit 清理工具输出
2. **65%** → SummarizationMiddleware 压缩历史

**效果**：
- 先清理占用最多 token 的工具输出
- 再压缩消息历史
- 保留更多空间给新的对话和工具调用

## 配置对比

| 参数 | 优化前 | 优化后 | 说明 |
|------|--------|--------|------|
| ClearToolUsesEdit trigger | 70% (22937) | 50% (16384) | 提前清理 |
| ClearToolUsesEdit keep | 5 | 3 | 减少保留 |
| clear_tool_inputs | False | True | 清理输入 |
| SummarizationMiddleware trigger | 85% | 65% | 提前压缩 |
| SummarizationMiddleware keep | 20 | 15 | 减少保留 |

## 最佳实践

### 1. task() 调用时传递精简信息

```python
# ✅ 好的做法：传递路径
task("分析文件: uploads/招标文件.pdf", "<available-planning-subagent>")

# ❌ 不好的做法：传递完整内容
task(f"分析以下内容:\n{file_content}", "<available-planning-subagent>")
```

### 2. SubAgent 返回精简结果

```python
# ✅ 好的做法：写文件，返回路径
result = {
    "status": "success",
    "summary": "分析了 15 个技术指标",
    "output_path": "outputs/analysis.md"
}

# ❌ 不好的做法：返回完整内容
result = {
    "status": "success",
    "analysis": long_content  # 可能 5000+ 字符
}
```

### 3. 使用 grep 定位而非全量读取

```python
# ✅ 好的做法：先定位，再读取关键部分
grep("技术要求", "uploads/招标文件.pdf")
read_file("uploads/招标文件.pdf", offset=100, limit=50)

# ❌ 不好的做法：读取整个文件
read_file("uploads/招标文件.pdf")
```

## 总结

DeepAgent 已经提供了完善的上下文管理机制：
1. **SummarizationMiddleware** - 自动压缩历史消息
2. **ContextEditingMiddleware** - 清理旧工具调用
3. **SubAgentMiddleware** - 子代理上下文隔离
4. **LangGraph Store** - 跨会话持久化
5. **LangGraph Checkpointer** - 会话状态恢复

本次优化只调整了中间件的触发参数，使其更早触发、保留更少内容，从而在多轮对话后仍有足够的上下文空间。
