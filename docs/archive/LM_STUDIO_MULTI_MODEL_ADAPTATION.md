# 🔧 LM Studio 多模型适配方案

## 📋 问题分析

### 当前状况
```python
MODEL_NAME = "transformers@4bit"  # 硬编码，不灵活
```

### 问题
1. **硬编码模型名称** - 每次 LM Studio 切换模型都需要修改代码
2. **模型兼容性** - 不同模型可能有不同的能力（工具调用、多模态等）
3. **API 选择** - 需要自动检测 LM Studio 是否提供了特定模型

---

## ✅ 解决方案

### 方案 A：自动检测当前模型（推荐）

通过 LM Studio 的 `/v1/models` 端点获取当前加载的模型列表：

```bash
curl http://localhost:1234/v1/models
```

**响应示例**：
```json
{
  "object": "list",
  "data": [
    {
      "id": "llama-2-7b-chat",
      "object": "model",
      "owned_by": "lm-studio"
    }
  ]
}
```

### 方案 B：环境变量配置

允许用户通过环境变量指定模型名称：

```bash
MODEL_NAME=qwen-32b LM_STUDIO_URL=http://localhost:1234 langgraph dev
```

### 方案 C：运行时配置

从 `langgraph.json` 或环境变量读取模型配置。

---

## 🚀 实现方案

### 步骤 1：创建模型检测函数

在 `main_agent.py` 中添加：

```python
async def detect_lm_studio_model(base_url: str = "http://localhost:1234/v1") -> str:
    """
    自动检测 LM Studio 中当前加载的模型
    
    Args:
        base_url: LM Studio 的 OpenAI 兼容 API 地址
        
    Returns:
        模型名称，如果检测失败则返回默认值
    """
    import httpx
    
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.get(f"{base_url}/models")
            data = response.json()
            
            if data.get("data") and len(data["data"]) > 0:
                model_id = data["data"][0]["id"]
                print(f"✅ 自动检测到模型: {model_id}")
                return model_id
    except Exception as e:
        print(f"⚠️  模型检测失败: {e}")
    
    # 降级到默认模型
    return "default"
```

### 步骤 2：更新配置

修改 `OrchestratorConfig`：

```python
class OrchestratorConfig:
    """Orchestrator 配置"""
    
    MODEL_PROVIDER = "openai"
    MODEL_URL = "http://localhost:1234/v1"
    
    # ✅ 支持环境变量覆盖
    MODEL_NAME = os.getenv(
        "LM_STUDIO_MODEL",
        "default"  # 将在启动时自动检测
    )
    
    TEMPERATURE = 0.7
    MAX_TOKENS = 4096
    TIMEOUT = 300
```

### 步骤 3：更新 LLM 创建函数

```python
def create_llm():
    """
    创建 LLM 实例 - 支持任意 LM Studio 模型
    """
    from langchain_openai import ChatOpenAI
    import httpx
    
    # 如果是 "default"，尝试自动检测
    model_name = OrchestratorConfig.MODEL_NAME
    if model_name == "default":
        try:
            # 同步获取模型名称
            response = httpx.get(
                f"{OrchestratorConfig.MODEL_URL}/models",
                timeout=5.0
            )
            data = response.json()
            if data.get("data") and len(data["data"]) > 0:
                model_name = data["data"][0]["id"]
                print(f"✅ 使用模型: {model_name}")
        except Exception as e:
            print(f"⚠️  模型检测失败，使用 'gpt-3.5-turbo' 作为占位符: {e}")
            model_name = "gpt-3.5-turbo"  # 占位符
    
    llm = ChatOpenAI(
        model=model_name,
        base_url=OrchestratorConfig.MODEL_URL,
        api_key="sk-no-key",  # LM Studio 不需要真实 key
        temperature=OrchestratorConfig.TEMPERATURE,
        max_tokens=OrchestratorConfig.MAX_TOKENS,
        timeout=OrchestratorConfig.TIMEOUT,
    )
    
    return llm
```

---

## 📝 实现步骤

### 1️⃣ 编辑 `backend/engine/core/main_agent.py`

**修改配置部分**（第 95-115 行）：

```python
class OrchestratorConfig:
    """Orchestrator 配置"""
    
    MODEL_PROVIDER = "openai"
    MODEL_URL = "http://localhost:1234/v1"
    # ✅ 新增：支持环境变量，默认自动检测
    MODEL_NAME = os.getenv("LM_STUDIO_MODEL", "default")
    
    TEMPERATURE = 0.7
    MAX_TOKENS = 4096
    TIMEOUT = 300
```

**修改 LLM 创建函数**（第 130-148 行）：

```python
def create_llm():
    """
    创建 LLM 实例 - 自动适配任意 LM Studio 模型
    """
    from langchain_openai import ChatOpenAI
    import httpx
    
    model_name = OrchestratorConfig.MODEL_NAME
    
    # 如果是 "default" 或未设置，自动检测
    if model_name == "default":
        try:
            response = httpx.get(
                f"{OrchestratorConfig.MODEL_URL}/models",
                timeout=5.0
            )
            data = response.json()
            if data.get("data") and len(data["data"]) > 0:
                model_name = data["data"][0]["id"]
                print(f"✅ 自动检测到模型: {model_name}")
        except Exception as e:
            print(f"⚠️  自动检测失败: {e}，使用占位符")
            model_name = "gpt-3.5-turbo"
    
    llm = ChatOpenAI(
        model=model_name,
        base_url=OrchestratorConfig.MODEL_URL,
        api_key="sk-no-key",  # LM Studio 不需要真实密钥
        temperature=OrchestratorConfig.TEMPERATURE,
        max_tokens=OrchestratorConfig.MAX_TOKENS,
        timeout=OrchestratorConfig.TIMEOUT,
    )
    
    print(f"✅ LLM 已配置: {model_name} @ {OrchestratorConfig.MODEL_URL}")
    return llm
```

### 2️⃣ 使用方式

**自动检测（推荐）**：
```bash
cd /Users/workspace/DevelopProjects/ccb-v0.378
source .venv/bin/activate
langgraph dev
# 系统会自动从 LM Studio 检测当前模型
```

**指定模型**：
```bash
export LM_STUDIO_MODEL="qwen-32b"
langgraph dev
```

**多个模型切换**：
1. 在 LM Studio 中加载新模型
2. 重启后端
3. 后端会自动检测新模型

---

## 🔍 验证

### 检查模型是否正确加载

```bash
# 1. 查看 LM Studio 当前模型
curl http://localhost:1234/v1/models | jq '.data[0].id'

# 2. 查看后端日志
# 应该看到类似输出：
# ✅ 自动检测到模型: llama-2-7b-chat
# ✅ LLM 已配置: llama-2-7b-chat @ http://localhost:1234/v1
```

### 测试不同模型

1. **在 LM Studio 中加载模型 A**
2. **启动后端**：`langgraph dev`
3. **发送消息进行测试**
4. **切换到 LM Studio 中的模型 B**
5. **重启后端**
6. **再次测试**

---

## 📊 模型兼容性

### 支持的模型类型

| 模型特性 | 支持状况 | 说明 |
|--------|--------|------|
| **工具调用** | ✅ 支持 | 大多数模型支持 JSON 格式的工具调用 |
| **多轮对话** | ✅ 支持 | 所有模型都支持 |
| **文本生成** | ✅ 支持 | 所有模型都支持 |
| **多模态（图像）** | ⚠️ 部分支持 | 取决于具体模型 |
| **文件块** | ❌ 不支持 | LM Studio 的 OpenAI API 不支持 |
| **函数调用** | ✅ 支持 | 所有模型都支持标准格式 |

---

## 🎯 最终效果

```
LM Studio 任意模型切换
         ↓
自动检测模型名称
         ↓
LangChain ChatOpenAI 自动适配
         ↓
后端无缝切换，无需代码修改 ✨
```

---

## ✨ 总结

✅ **是的，可以使用 LM Studio 的任意模型！**

通过以上修改：
1. 支持 LM Studio 中的任何模型
2. 无需修改代码即可切换模型
3. 自动检测当前加载的模型
4. 支持环境变量覆盖
5. 完全向后兼容

现在你可以在 LM Studio 中随意切换模型，后端会自动适配！🚀

