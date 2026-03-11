# 🔥 流式输出解决方案

## 问题分析

当前架构：
```
Main Graph → deepagent_node
                └─ agent.stream() 
                    └─ [内部流式事件被消耗]
```

**问题**：`agent.stream()` 在 `deepagent_node` 函数内部被完全消耗，流式事件无法传递到 Main Graph 外层。

## ✅ 解决方案：使用 Subgraph

LangGraph 支持 **Subgraph 嵌套**，可以让 DeepAgent 的流式事件自动传递：

```python
# main_graph.py

from engine.agent.deep_agent import agent as deepagent_graph

def create_router_graph():
    workflow = StateGraph(AgentState)
    
    # 添加常规节点
    workflow.add_node("router", router_node)
    workflow.add_node("editor_tool", editor_tool_node)
    workflow.add_node("error", error_node)
    
    # ✅ 关键：将 DeepAgent 作为 Subgraph 添加
    # 不要包装在函数中，直接添加 Graph 对象
    workflow.add_node("deepagent", deepagent_graph)
    
    # 设置路由...
    workflow.add_conditional_edges("router", route_decision, {...})
    
    return workflow.compile()
```

**工作原理**：
1. LangGraph 检测到 `deepagent` 是一个 Graph 对象（不是函数）
2. 自动将其视为 Subgraph
3. Subgraph 的所有流式事件会自动传递到父 Graph
4. 前端可以收到 DeepAgent 内部每个节点的输出

## 🎯 具体实现步骤

### Step 1: 修改 `main_graph.py`

```python
# backend/engine/core/main_graph.py

from engine.agent.deep_agent import agent as deepagent_compiled_graph

def create_router_graph():
    workflow = StateGraph(AgentState)
    
    # 常规节点
    workflow.add_node("router", router_node)
    workflow.add_node("editor_tool", editor_tool_node)
    workflow.add_node("error", error_node)
    
    # ✅ 直接添加 DeepAgent Graph（作为 Subgraph）
    workflow.add_node("deepagent", deepagent_compiled_graph)
    
    # 路由设置...
    workflow.set_entry_point("router")
    workflow.add_conditional_edges("router", route_decision, {
        "deepagent": "deepagent",
        "editor_tool": "editor_tool",
        "error": "error",
    })
    
    workflow.add_edge("deepagent", END)
    workflow.add_edge("editor_tool", END)
    workflow.add_edge("error", END)
    
    return workflow.compile()
```

### Step 2: 删除 `deepagent_node.py`（不再需要）

因为 DeepAgent 现在作为 Subgraph 直接集成，不需要包装函数。

### Step 3: 状态适配（如果需要）

如果 `AgentState` 和 DeepAgent 的内部状态不完全兼容，需要添加状态转换：

```python
def state_adapter(state: AgentState) -> DeepAgentState:
    """将 Main Graph 的状态转换为 DeepAgent 的状态"""
    return {
        "messages": state["messages"],
        # 其他字段...
    }

workflow.add_node("deepagent", deepagent_graph, state_adapter=state_adapter)
```

## 🎉 预期效果

实现后，前端会看到：

```
用户: 分析项目结构

[流式输出开始]
├─ [router] 路由到 deepagent
├─ [deepagent.understanding] 🤔 正在理解需求...
├─ [deepagent.planning] 📝 创建 TODO: 分析目录结构
├─ [deepagent.planning] 📝 创建 TODO: 分析代码文件
├─ [deepagent.model] 🤖 调用工具: list_directory
├─ [deepagent.tools] 📁 工具返回: 15 个文件
├─ [deepagent.model] 🤖 调用工具: read_file
├─ [deepagent.tools] 📄 工具返回: main.py 内容
├─ [deepagent.synthesis] ✨ 综合分析结果...
└─ [deepagent] ✅ 完成！

[最终输出]
项目结构分析如下：
1. 主入口: main.py
2. ...
```

## 📊 对比

| 方案 | 流式输出 | DeepAgent 复用 | 实现复杂度 |
|------|----------|----------------|------------|
| **当前 (invoke)** | ❌ 无 | ✅ 完全复用 | 简单 |
| **Subgraph** | ✅ 完整 | ✅ 完全复用 | 中等 |
| **扁平化** | ✅ 完整 | ❌ 需重写 | 高 |

## 🚀 推荐：使用 Subgraph 方案

**理由**：
1. ✅ 完全保留 DeepAgent 的所有功能
2. ✅ 支持完整的流式输出
3. ✅ 符合 LangChain/LangGraph 的设计理念
4. ✅ 修改量小（只需改 `main_graph.py`）
5. ✅ 前端可以显示详细的执行步骤

## 📝 注意事项

1. **状态兼容性**：确保 `AgentState` 包含 DeepAgent 需要的所有字段
2. **streamMode 配置**：前端使用 `streamMode: ["messages", "updates"]` 来接收所有事件
3. **消息过滤**：如果不想暴露所有内部 tool_calls，可以在前端过滤

