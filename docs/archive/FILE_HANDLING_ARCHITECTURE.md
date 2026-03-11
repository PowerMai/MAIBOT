## ✅ 正确的文件处理架构 - LangChain 标准方式

---

## 🎯 核心原则

> **不要修补 LangChain 的内部函数！**  
> **使用 LangChain 提供的标准机制来处理模型差异！**

---

## 📊 架构设计

```
前端 (LangGraph Studio / assistant-ui)
  ↓ 发送 LangChain 标准消息格式
  ↓ HumanMessage(content=[{"type": "text", ...}, {"type": "file", ...}])
  ↓
LangGraph Server
  ↓
DeepAgent Graph
  ↓
消息适配器 (Message Adapter) ✅ 关键层
  ├─ 检测模型能力
  ├─ 转换消息格式
  └─ 保留原始语义
  ↓
LLM (LM Studio / vLLM / Ollama)
  ├─ 只接收纯文本消息
  └─ 文件内容已转换为文本
```

---

## 🔧 实现方式

### 1. 消息适配器 (`message_adapter.py`)

```python
from langchain_core.runnables import RunnableLambda

def create_message_adapter(model_supports_multimodal: bool = False):
    """
    创建消息适配器
    
    功能：
    1. 检测消息中的 multimodal content
    2. 提取 file blocks 的内容
    3. 转换为纯文本格式
    4. 保留文件名和类型信息
    
    返回：
    - RunnableLambda，可以插入到 LangChain 链中
    """
    def adapt_messages(input_data):
        if model_supports_multimodal:
            return input_data  # 不转换
        
        # 转换 multimodal → text
        return convert_multimodal_to_text(input_data)
    
    return RunnableLambda(adapt_messages)
```

### 2. LLM 初始化 (`main_agent.py`)

```python
def create_llm():
    """
    创建 LLM 实例
    
    ✅ 正确方式：
    1. 使用 ChatOpenAI 直接初始化
    2. 配置模型能力标志
    3. 让 LangChain 知道模型的限制
    """
    from langchain_openai import ChatOpenAI
    
    llm = ChatOpenAI(
        model="transformers@4bit",
        base_url="http://localhost:1234/v1",
        api_key="ollama",
        temperature=0.7,
        max_tokens=4096,
    )
    
    # ✅ 设置能力标志
    llm._identifying_params = {
        **llm._identifying_params,
        "supports_strict_tool_calling": False,
        "supports_tool_choice_required": False,
    }
    
    return llm
```

### 3. 包装 LLM (`main_agent.py`)

```python
def create_orchestrator_agent():
    # 创建 LLM
    model = create_llm()
    
    # ✅ 创建消息适配器
    message_adapter = create_message_adapter(
        model_supports_multimodal=False  # LM Studio 不支持
    )
    
    # ✅ 包装 LLM：adapter | llm
    adapted_model = message_adapter | model
    
    # ✅ 使用包装后的 model
    agent = create_deep_agent(
        model=adapted_model,  # 带适配器的 LLM
        tools=tools,
        system_prompt=prompt,
        ...
    )
    
    return agent
```

---

## 🎨 消息转换示例

### 输入（LangGraph Studio 发送）

```json
{
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "请分析这个招标文件"
        },
        {
          "type": "file",
          "name": "招标文件.txt",
          "mime_type": "text/plain",
          "data": "base64encodedcontent..."
        }
      ]
    }
  ]
}
```

### 输出（发送到 LM Studio）

```json
{
  "messages": [
    {
      "role": "user",
      "content": "请分析这个招标文件\n\n<file name=\"招标文件.txt\" mime_type=\"text/plain\">\n[解码后的文件内容...]\n</file>"
    }
  ]
}
```

---

## ✅ 优势

| 方面 | 之前的方式（补丁） | 现在的方式（适配器） |
|------|------------------|---------------------|
| **可维护性** | ❌ 修改 LangChain 内部 | ✅ 标准 LangChain 接口 |
| **可扩展性** | ❌ 硬编码转换逻辑 | ✅ 易于添加新模型支持 |
| **稳定性** | ❌ LangChain 更新可能破坏 | ✅ 不依赖内部实现 |
| **调试性** | ❌ 难以追踪问题 | ✅ 清晰的转换流程 |
| **测试性** | ❌ 难以单元测试 | ✅ 可独立测试适配器 |

---

## 🚀 扩展性

### 添加新模型支持

```python
# 1. 定义模型配置
OPENAI_GPT4_CONFIG = {
    "supports_multimodal": True,  # GPT-4 支持
    "supports_vision": True,
    "supports_file_search": True,
}

LM_STUDIO_CONFIG = {
    "supports_multimodal": False,  # 不支持
    "supports_vision": False,
    "supports_file_search": False,
}

# 2. 创建适配器
adapter = create_message_adapter(
    model_supports_multimodal=LM_STUDIO_CONFIG["supports_multimodal"]
)

# 3. 包装 LLM
adapted_llm = adapter | llm
```

### 支持多种文件类型

```python
def extract_file_content_from_message(message):
    """
    可以扩展支持：
    - PDF: 使用 PyPDF2 解析
    - DOCX: 使用 python-docx 解析
    - 图片: 使用 OCR 提取文本
    - 音频: 使用 Whisper 转文字
    """
    for item in message.content:
        if item["type"] == "file":
            ext = item.get("name", "").split(".")[-1]
            
            if ext == "pdf":
                return extract_pdf_content(item["data"])
            elif ext == "docx":
                return extract_docx_content(item["data"])
            elif ext in ["png", "jpg"]:
                return ocr_image(item["data"])
            # ...更多类型
```

---

## 📝 关键要点

### ✅ DO（推荐做法）

```
1. 使用 LangChain 的标准接口
2. 创建消息适配器 Runnable
3. 使用 RunnableLambda 包装转换逻辑
4. 让 LLM 配置告知模型能力
5. 在 chain 中插入适配器
```

### ❌ DON'T（避免做法）

```
1. 不要修补 LangChain 内部函数
2. 不要硬编码模型差异处理
3. 不要绕过 LangChain 的消息系统
4. 不要在工具中做格式转换
5. 不要假设所有模型都一样
```

---

## 🧪 测试验证

### 1. 单元测试适配器

```python
def test_message_adapter():
    # 准备测试数据
    messages = [
        HumanMessage(content=[
            {"type": "text", "text": "Hello"},
            {"type": "file", "name": "test.txt", "data": "base64..."}
        ])
    ]
    
    # 创建适配器
    adapter = create_message_adapter(model_supports_multimodal=False)
    
    # 转换
    adapted = adapter.invoke(messages)
    
    # 验证
    assert isinstance(adapted[0].content, str)
    assert "<file name=\"test.txt\">" in adapted[0].content
```

### 2. 集成测试

```python
def test_llm_with_file():
    # 创建带适配器的 LLM
    llm = create_llm()
    adapter = create_message_adapter(model_supports_multimodal=False)
    adapted_llm = adapter | llm
    
    # 发送包含文件的消息
    result = adapted_llm.invoke([
        HumanMessage(content=[
            {"type": "text", "text": "Summarize this file"},
            {"type": "file", "name": "doc.txt", "data": "..."}
        ])
    ])
    
    # 验证结果
    assert result.content  # 应该有响应
```

---

## 🎯 总结

**这是 LangChain 官方推荐的标准方式！**

1. ✅ 不修改 LangChain 内部代码
2. ✅ 使用 Runnable 接口构建适配器
3. ✅ 通过配置告知模型能力
4. ✅ 在 chain 中插入适配器
5. ✅ 保持架构清晰可维护

**现在的实现完全符合 LangChain 的最佳实践！** 🎉

