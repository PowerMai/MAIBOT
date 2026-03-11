# 模型选择实现说明

## 📋 当前实现状态

### ✅ 已完成

1. **前端模型选择器**
   - 从 LM Studio 获取模型列表
   - 支持模型切换
   - 将选择的模型通过 `additional_kwargs.model_selection.model_id` 传递

2. **后端模型支持**
   - `create_llm()` 支持 `model_id` 参数
   - `create_orchestrator_agent()` 支持 `model_id` 参数
   - 后端 API `/models/list` 获取 LM Studio 模型列表

### ⚠️ 当前限制

**问题**：DeepAgent 的 LLM 是在创建 Agent 时就绑定的，不能在运行时动态改变。

**原因**：
- DeepAgent 是第三方库，Agent 的 LLM 在创建时绑定
- 直接使用 Graph 作为节点（保证流式输出），无法在运行时修改 LLM
- 如果使用包装节点（`deepagent_node`），会阻塞流式输出

### 🎯 解决方案

#### 方案 1：使用默认模型（当前实现）

**优点**：
- ✅ 流式输出正常工作
- ✅ 代码简单，无性能损失
- ✅ 符合 LangGraph 最佳实践

**缺点**：
- ❌ 前端选择的模型不会立即生效
- ❌ 需要重启后端才能切换模型

**适用场景**：
- 开发环境
- 单模型部署
- 模型切换不频繁的场景

#### 方案 2：使用 LangGraph Config 机制（✅ 已实现）

**实现方式**：
1. ✅ 前端通过 LangGraph SDK 的 `config` 参数传递模型信息
2. ✅ 在 `create_llm()` 中从 `RunnableConfig` 读取模型信息
3. ✅ 使用 `ConfigManager` 统一管理所有配置
4. ✅ 使用 Subgraph 保证完整流式输出

**优点**：
- ✅ 支持运行时模型切换
- ✅ 保持完整流式输出
- ✅ 符合 LangGraph 官方标准
- ✅ 统一的配置管理

**实现原理**：
- LangGraph 自动将 `config` 传递给所有节点和子节点
- DeepAgent 内部的 LLM 在每次调用时从 `config.configurable.model_id` 读取模型
- 同一个 LM Studio 端点下的不同模型可以动态切换
- 无需重新创建 Agent 实例

**已实现代码**：
```python
# 1. ✅ create_llm() 支持从 config 读取
def create_llm(model_id: Optional[str] = None, config: Optional[RunnableConfig] = None):
    if config:
        config_mgr = get_config_manager(config)
        if config_mgr.model_id:
            model_id = config_mgr.model_id
            temperature = config_mgr.model_temperature
            max_tokens = config_mgr.model_max_tokens
    # ... 创建 LLM

# 2. ✅ 前端通过 config 传递模型信息
const config = {
  model_id: selectedModel,
  editor_path: editorPath,
  debug_mode: isDev,
};
await sendMessage({ threadId, messages, config });

# 3. ✅ main_graph 使用 Subgraph 保证流式输出
workflow.add_node("deepagent", deepagent_graph)  # 直接使用 Graph 作为节点
```

**适用场景**：
- 同一个 LM Studio 中加载的多个模型切换
- 同一个 API 端点的不同模型切换（如 gpt-4 / gpt-3.5）
- 只需调整 model_id、temperature、max_tokens 等参数

#### 方案 3：模型缓存 + 动态 Agent 创建（复杂，不推荐）

**实现方式**：
1. 在 router_node 中读取模型选择信息
2. 根据模型 ID 缓存 Agent 实例
3. 在调用时选择对应的 Agent

**缺点**：
- ❌ 需要管理多个 Agent 实例
- ❌ 内存占用增加
- ❌ 代码复杂度高

## 🔄 当前工作流程

```
前端选择模型
  ↓
通过 additional_kwargs.model_selection.model_id 传递
  ↓
后端接收消息（但模型信息暂未使用）
  ↓
使用默认模型处理请求
  ↓
流式输出正常
```

## 📝 下一步计划

1. **短期**（当前）：
   - ✅ 保持流式输出正常工作
   - ✅ 前端模型选择器正常显示
   - ✅ 模型信息正确传递到后端

2. **中期**（推荐实现）：
   - 实现方案 2：使用 LangGraph Config 机制
   - 支持运行时模型切换
   - 保持流式输出

3. **长期**（可选）：
   - 模型性能监控
   - 模型自动切换（根据任务类型）
   - 多模型并行处理

## 💡 使用建议

**当前阶段**：
- 如果需要切换模型，修改环境变量 `LM_STUDIO_MODEL` 并重启后端
- 前端模型选择器可以正常显示，但选择不会立即生效

**未来实现方案 2 后**：
- 前端选择模型后，立即生效
- 无需重启后端
- 流式输出正常工作

## 🔍 相关文件

- `frontend/desktop/src/components/ChatComponents/model-selector.tsx` - 前端模型选择器
- `frontend/desktop/src/components/ChatComponents/MyRuntimeProvider.tsx` - 模型信息传递
- `backend/api/app.py` - 模型列表 API
- `backend/engine/agent/deep_agent.py` - LLM 和 Agent 创建
- `backend/engine/core/main_graph.py` - 主路由 Graph

