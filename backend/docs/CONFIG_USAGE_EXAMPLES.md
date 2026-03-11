# LangGraph Config 使用示例

## 📋 快速开始

### 前端：传递配置

```typescript
import { sendMessage, LangGraphConfig } from '@/lib/api/langserveChat';

// 构建配置
const config: LangGraphConfig = {
  // 模型配置
  model_id: "llama-3-8b",
  model_temperature: 0.7,
  model_max_tokens: 32768,
  
  // 任务配置
  task_type: "analysis",
  task_priority: "high",
  
  // 编辑器上下文
  editor_path: "/path/to/file.py",
  selected_text: "def hello():",
  workspace_path: "/workspace",
  
  // 调试配置
  debug_mode: true,
  trace_id: `trace-${Date.now()}`,
};

// 发送消息
await sendMessage({
  threadId: "thread-123",
  messages: [message],
  config,
});
```

### 后端：读取配置

```python
from backend.engine.utils.config_manager import get_config_manager
from langchain_core.runnables import RunnableConfig

def my_node(state: AgentState, config: Optional[RunnableConfig] = None):
    # 获取配置管理器
    config_mgr = get_config_manager(config)
    
    # 读取模型配置
    if config_mgr.model_id:
        print(f"使用模型: {config_mgr.model_id}")
        print(f"温度: {config_mgr.model_temperature}")
        print(f"最大 tokens: {config_mgr.model_max_tokens}")
    
    # 读取任务配置
    print(f"任务类型: {config_mgr.task_type}")
    print(f"优先级: {config_mgr.task_priority}")
    
    # 读取权限配置
    if not config_mgr.has_permission("write_file"):
        return "权限不足"
    
    # 读取编辑器上下文
    if config_mgr.editor_path:
        print(f"编辑器文件: {config_mgr.editor_path}")
        print(f"选中文本: {config_mgr.selected_text}")
    
    # 调试模式
    if config_mgr.debug_mode:
        config_mgr.log_config("[my_node]")
    
    return state
```

## 🎯 常见场景

### 场景 1：模型选择

```typescript
// 前端
const config = {
  model_id: selectedModel,
};

await sendMessage({ threadId, messages, config });
```

```python
# 后端
def create_llm(config: Optional[RunnableConfig] = None):
    config_mgr = get_config_manager(config)
    model_id = config_mgr.model_id or "default"
    # ... 创建 LLM
```

### 场景 2：权限控制

```typescript
// 前端
const config = {
  user_role: "admin",
  allowed_tools: ["read_file", "write_file"],
};

await sendMessage({ threadId, messages, config });
```

```python
# 后端工具
@tool
def write_file(file_path: str, text: str) -> str:
    from backend.engine.utils.config_manager import get_config_manager
    from langchain_core.runnables import RunnableConfig
    import inspect
    
    # 获取 config
    config = _get_config_from_stack()
    config_mgr = get_config_manager(config)
    
    # 检查权限
    if not config_mgr.has_permission("write_file"):
        return "❌ 权限不足：无法写入文件"
    
    # 检查用户角色
    if config_mgr.user_role == "guest":
        return "❌ 访客用户无法写入文件"
    
    # 执行写入...
```

### 场景 3：任务类型配置

```typescript
// 前端
const config = {
  task_type: "analysis",
  task_priority: "high",
  task_timeout: 600,
};

await sendMessage({ threadId, messages, config });
```

```python
# 后端
def process_task(state: AgentState, config: Optional[RunnableConfig] = None):
    config_mgr = get_config_manager(config)
    
    # 根据任务类型选择处理方式
    if config_mgr.task_type == "analysis":
        return analyze_task(state)
    elif config_mgr.task_type == "generation":
        return generate_task(state)
    # ...
```

### 场景 4：编辑器上下文

```typescript
// 前端（自动传递）
const config = {
  editor_path: editorPath,
  selected_text: selectedText,
  workspace_path: workspacePath,
};

await sendMessage({ threadId, messages, config });
```

```python
# 后端
def code_analysis_node(state: AgentState, config: Optional[RunnableConfig] = None):
    config_mgr = get_config_manager(config)
    
    # 使用编辑器上下文
    if config_mgr.editor_path:
        file_path = config_mgr.editor_path
        selected_text = config_mgr.selected_text
        
        # 分析选中的代码
        if selected_text:
            return analyze_code(selected_text, file_path)
        else:
            return analyze_file(file_path)
```

### 场景 5：调试和监控

```typescript
// 前端（开发环境自动启用）
const config = {
  debug_mode: import.meta.env.DEV,
  trace_id: `trace-${Date.now()}`,
  request_id: `req-${Date.now()}`,
  log_level: "debug",
};

await sendMessage({ threadId, messages, config });
```

```python
# 后端
def my_node(state: AgentState, config: Optional[RunnableConfig] = None):
    config_mgr = get_config_manager(config)
    
    # 调试模式
    if config_mgr.debug_mode:
        logger.setLevel(logging.DEBUG)
        config_mgr.log_config("[my_node]")
    
    # 追踪 ID
    if config_mgr.trace_id:
        logger.info(f"追踪 ID: {config_mgr.trace_id}")
    
    # 请求 ID
    if config_mgr.request_id:
        logger.info(f"请求 ID: {config_mgr.request_id}")
```

## 🔧 工具中使用配置

### 方法 1：从调用栈获取 config

```python
@tool
def my_tool(query: str) -> str:
    from backend.engine.utils.config_manager import get_config_manager
    from langchain_core.runnables import RunnableConfig
    import inspect
    
    # 从调用栈获取 config
    config = None
    frame = inspect.currentframe()
    try:
        while frame:
            local_vars = frame.f_locals
            if 'config' in local_vars and isinstance(local_vars['config'], dict):
                if 'configurable' in local_vars['config']:
                    config = local_vars['config']
                    break
            frame = frame.f_back
    finally:
        del frame
    
    # 使用配置
    if config:
        config_mgr = get_config_manager(config)
        user_id = config_mgr.user_id
        # ...
```

### 方法 2：通过参数传递（推荐）

```python
# 在节点中调用工具时传递 config
def my_node(state: AgentState, config: Optional[RunnableConfig] = None):
    # 调用工具时传递 config
    result = my_tool.invoke(
        {"query": "..."},
        config=config  # ✅ 传递 config
    )
    return state
```

## 📊 配置项完整列表

### 模型配置

```typescript
{
  model_id: string,              // 模型 ID
  model_temperature: number,      // 温度 (0.0-2.0)
  model_max_tokens: number,       // 最大 tokens
  model_timeout: number,          // 超时时间（秒）
}
```

### 任务配置

```typescript
{
  task_type: "chat" | "analysis" | "generation" | "review",
  task_priority: "low" | "normal" | "high" | "urgent",
  task_timeout: number,
  task_max_iterations: number,
}
```

### 权限配置

```typescript
{
  user_role: "admin" | "user" | "guest",
  allowed_tools: string[],        // 空数组表示全部允许
  workspace_access: string[],     // 空数组表示全部允许
  user_id: string,                // 自动从 thread metadata 传递
  team_id: string,                // 自动从 thread metadata 传递
}
```

### 调试配置

```typescript
{
  debug_mode: boolean,
  trace_id: string,
  request_id: string,
  log_level: "debug" | "info" | "warning" | "error",
}
```

### 性能配置

```typescript
{
  max_concurrent_tools: number,
  cache_enabled: boolean,
  streaming_enabled: boolean,
  batch_size: number,
}
```

### 编辑器上下文

```typescript
{
  editor_path: string,
  selected_text: string,
  workspace_path: string,
}
```

## 🎨 Cursor 风格最佳实践

### 1. 配置命名

- 使用下划线命名：`model_id` 而不是 `modelId`
- 分组清晰：`model_*`, `task_*`, `user_*`
- 语义明确：`debug_mode` 而不是 `debug`

### 2. 默认值

- 所有配置项都有合理的默认值
- 前端不传递时使用默认值
- 后端降级处理优雅

### 3. 类型安全

- TypeScript 接口定义完整
- Python 类型注解完整
- 运行时类型检查

### 4. 错误处理

- 配置缺失时使用默认值
- 配置无效时记录警告
- 不阻塞正常流程

## 📚 相关文档

- [LANGGRAPH_CONFIG_IMPLEMENTATION.md](./LANGGRAPH_CONFIG_IMPLEMENTATION.md) - 完整实现文档
- [MODEL_SELECTION_IMPLEMENTATION.md](./MODEL_SELECTION_IMPLEMENTATION.md) - 模型选择实现
- [LangGraph 官方文档](https://langchain-ai.github.io/langgraph/)

