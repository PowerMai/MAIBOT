# LangGraph Config 完整实现文档

## 📋 概述

本文档描述了基于 LangGraph 官方 Config 机制的完整实现，按照 Cursor 风格设计，支持运行时动态配置。

## ✅ 已实现功能

### 1. 配置管理模块

**文件**: `backend/engine/utils/config_manager.py`

**功能**:
- ✅ 统一的配置管理器 `ConfigManager`
- ✅ 模型配置（model_id, temperature, max_tokens, timeout）
- ✅ 任务配置（task_type, priority, timeout, max_iterations）
- ✅ 权限配置（user_role, allowed_tools, workspace_access）
- ✅ 调试配置（debug_mode, trace_id, request_id, log_level）
- ✅ 性能配置（max_concurrent_tools, cache_enabled, streaming_enabled）
- ✅ 编辑器上下文（editor_path, selected_text, workspace_path）

**使用示例**:
```python
from backend.engine.utils.config_manager import get_config_manager

def my_node(state: AgentState, config: Optional[RunnableConfig] = None):
    config_mgr = get_config_manager(config)
    
    # 获取模型配置
    if config_mgr.model_id:
        print(f"使用模型: {config_mgr.model_id}")
    
    # 获取权限配置
    if not config_mgr.has_permission("write_file"):
        return "权限不足"
    
    # 获取调试配置
    if config_mgr.debug_mode:
        config_mgr.log_config("[my_node]")
```

### 2. 前端配置传递

**文件**: 
- `frontend/desktop/src/lib/api/langserveChat.ts`
- `frontend/desktop/src/components/ChatComponents/MyRuntimeProvider.tsx`

**功能**:
- ✅ `sendMessage` 支持传递 `config` 参数
- ✅ 自动构建完整的 config（模型、编辑器上下文、用户上下文、调试信息）
- ✅ 通过 LangGraph SDK 的 `config` 参数传递

**使用示例**:
```typescript
// 前端自动构建 config
const config = {
  model_id: selectedModel,
  editor_path: editorPath,
  selected_text: selectedText,
  debug_mode: isDev,
  trace_id: `trace-${Date.now()}`,
};

await sendMessage({
  threadId,
  messages: [message],
  config,
});
```

### 3. 后端配置读取

**文件**: 
- `backend/engine/agent/deep_agent.py`
- `backend/engine/nodes/router_node.py`

**功能**:
- ✅ `create_llm()` 支持从 config 读取模型配置
- ✅ `create_orchestrator_agent()` 支持从 config 读取模型配置
- ✅ `router_node()` 支持读取并记录配置信息

**使用示例**:
```python
def create_llm(model_id: Optional[str] = None, config: Optional[RunnableConfig] = None):
    if config:
        config_mgr = get_config_manager(config)
        if config_mgr.model_id:
            model_id = config_mgr.model_id
            temperature = config_mgr.model_temperature
            max_tokens = config_mgr.model_max_tokens
    # ... 创建 LLM
```

## 🎯 配置项说明

### 模型配置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `model_id` | string | null | 选择的模型 ID |
| `model_temperature` | number | 0.7 | 模型温度参数 |
| `model_max_tokens` | number | 32768 | 最大 token 数 |
| `model_timeout` | number | 300 | 请求超时时间（秒） |

### 任务配置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `task_type` | string | "chat" | 任务类型（analysis, generation, review, chat） |
| `task_priority` | string | "normal" | 任务优先级（low, normal, high, urgent） |
| `task_timeout` | number | 300 | 任务超时时间（秒） |
| `task_max_iterations` | number | 10 | 任务最大迭代次数 |

### 权限配置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `user_role` | string | "user" | 用户角色（admin, user, guest） |
| `allowed_tools` | array | [] | 允许使用的工具列表（空表示全部允许） |
| `workspace_access` | array | [] | 可访问的工作区列表（空表示全部允许） |
| `user_id` | string | null | 用户 ID（从 thread metadata 自动传递） |
| `team_id` | string | null | 团队 ID（从 thread metadata 自动传递） |

### 调试配置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `debug_mode` | boolean | false | 是否启用调试模式 |
| `trace_id` | string | null | 追踪 ID（用于日志关联） |
| `request_id` | string | null | 请求 ID（用于请求追踪） |
| `log_level` | string | "info" | 日志级别（debug, info, warning, error） |

### 性能配置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `max_concurrent_tools` | number | 5 | 最大并发工具数 |
| `cache_enabled` | boolean | true | 是否启用缓存 |
| `streaming_enabled` | boolean | true | 是否启用流式输出 |
| `batch_size` | number | 10 | 批处理大小 |

### 编辑器上下文

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `editor_path` | string | null | 编辑器当前文件路径 |
| `selected_text` | string | null | 编辑器选中的文本 |
| `workspace_path` | string | null | 工作区路径 |

## 🔄 工作流程

```
前端选择模型/配置
  ↓
MyRuntimeProvider 构建 config
  ↓
sendMessage 传递 config 到 LangGraph SDK
  ↓
LangGraph Server 接收 config
  ↓
router_node 读取并记录 config
  ↓
create_llm 从 config 读取模型配置
  ↓
创建使用指定模型的 LLM
  ↓
Agent 使用新 LLM 处理请求
  ↓
流式输出正常
```

## 📝 使用示例

### 前端：传递配置

```typescript
// 在 MyRuntimeProvider 中自动构建
const config = {
  model_id: selectedModel,
  editor_path: editorPath,
  selected_text: selectedText,
  debug_mode: isDev,
};

await sendMessage({
  threadId,
  messages: [message],
  config,
});
```

### 后端：读取配置

```python
# 在节点中读取配置
def my_node(state: AgentState, config: Optional[RunnableConfig] = None):
    config_mgr = get_config_manager(config)
    
    # 使用配置
    if config_mgr.model_id:
        print(f"使用模型: {config_mgr.model_id}")
    
    if config_mgr.debug_mode:
        config_mgr.log_config("[my_node]")
    
    return state
```

### 工具：使用配置

```python
@tool
def my_tool(query: str) -> str:
    from backend.tools.utils.context import get_user_context_from_config
    from langchain_core.runnables import RunnableConfig
    import inspect
    
    # 从调用栈获取 config
    config = _get_config_from_stack()
    user_context = get_user_context_from_config(config)
    
    # 使用用户上下文
    user_id = user_context["user_id"]
    # ...
```

## ✅ 动态模型切换（已实现）

### 实现方案

使用 **方案1：configurable_fields 机制**

**工作原理**：
1. 前端通过 `config.configurable.model_id` 传递模型选择
2. LangGraph 自动将 `config` 传递给所有节点（包括 Subgraph 内部）
3. DeepAgent 内部的 LLM 在每次调用时从 `config` 读取模型配置
4. 使用 Subgraph 保证完整流式输出

**优点**：
- ✅ 支持运行时模型切换
- ✅ 保持完整流式输出
- ✅ 简单实现，无需模型缓存
- ✅ 符合 LangGraph 官方标准

**适用范围**：
- ✅ 同一个 LM Studio 端点下的多个模型切换
- ✅ 同一个 API 端点的不同模型切换
- ❌ 跨端点/跨提供商的模型切换（需要方案2）

## 🚀 未来扩展

### 1. 模型缓存机制

```python
# 为每个模型创建独立的 Agent 实例
_agent_cache: dict[str, Agent] = {}

def get_agent_for_model(model_id: str) -> Agent:
    if model_id not in _agent_cache:
        _agent_cache[model_id] = create_orchestrator_agent(model_id=model_id)
    return _agent_cache[model_id]
```

### 2. 动态模型绑定

```python
# 使用 LangGraph 的 bind() 机制
def create_dynamic_agent(base_agent: Agent, model_id: str) -> Agent:
    new_llm = create_llm(model_id=model_id)
    return base_agent.bind(model=new_llm)
```

### 3. 配置验证

```python
# 添加配置验证
def validate_config(config: Dict[str, Any]) -> bool:
    # 验证模型 ID 是否有效
    # 验证权限配置是否合理
    # ...
    return True
```

## 📚 相关文档

- [LangGraph Config 官方文档](https://langchain-ai.github.io/langgraph/how-tos/configure/)
- [RunnableConfig 类型定义](https://api.python.langchain.com/en/latest/runnables/langchain_core.runnables.config.RunnableConfig.html)
- [MODEL_SELECTION_IMPLEMENTATION.md](./MODEL_SELECTION_IMPLEMENTATION.md) - 模型选择实现说明

## 🔍 相关文件

- `backend/engine/utils/config_manager.py` - 配置管理模块
- `frontend/desktop/src/lib/api/langserveChat.ts` - 前端 API
- `frontend/desktop/src/components/ChatComponents/MyRuntimeProvider.tsx` - Runtime Provider
- `backend/engine/agent/deep_agent.py` - LLM 和 Agent 创建
- `backend/engine/nodes/router_node.py` - 路由节点
- `backend/tools/utils/context.py` - 工具上下文辅助函数

