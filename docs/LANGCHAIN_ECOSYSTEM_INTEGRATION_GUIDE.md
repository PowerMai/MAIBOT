"""
LangChain Ecosystem Integration Guide

本指南展示如何严格按照 LangChain 生态标准集成提示词、工具和 Agent。

核心原则：
1. 使用 @tool 装饰器定义工具
2. 使用 PromptTemplate 管理提示词
3. 使用 Chain 组合工具和 LLM
4. 使用 LangServe 部署 API
5. 使用 LangSmith 进行监控和调试
"""

# ============================================================================
# Part 1: 提示词使用 - LangChain PromptTemplate Pattern
# ============================================================================

"""
提示词开发遵循 LangChain 官方模式：
https://python.langchain.com/docs/how_to/prompt_templates

✅ 正确的做法：

from langchain.prompts import PromptTemplate
from backend.engine.prompts.orchestrator import get_orchestrator_prompt

# 1. 使用预定义的提示词
prompt_text = get_orchestrator_prompt()

# 2. 或使用 PromptTemplate 进行动态提示词
template = PromptTemplate(
    template="You are a helpful assistant. Answer this: {question}",
    input_variables=["question"]
)

prompt = template.format(question="What is LangChain?")

# 3. 用于 LLM
from langchain_openai import ChatOpenAI
llm = ChatOpenAI()
result = llm.invoke(prompt)
"""


# ============================================================================
# Part 2: 工具使用 - LangChain @tool Decorator Pattern
# ============================================================================

"""
工具开发遵循 LangChain @tool 装饰器模式：
https://python.langchain.com/docs/how_to/custom_tools

✅ 正确的做法：

from backend.tools.thinking_tools import reflect_on_question, decompose_problem
from backend.tools.file_tools import read_file, create_file
from backend.tools.registry import get_all_tools

# 1. 获取工具列表
all_tools = get_all_tools()

# 2. 按类别获取工具
from backend.tools.registry import get_tools_by_category
thinking_tools = get_tools_by_category("thinking")
file_tools = get_tools_by_category("file")

# 3. 用于 Agent
from deepagents import create_deep_agent
agent = create_deep_agent(
    model=llm,
    tools=all_tools,
    system_prompt=system_prompt,
    subagents=[...]
)
"""


# ============================================================================
# Part 3: Agent 集成 - deepagents Pattern
# ============================================================================

"""
Agent 开发遵循 deepagents 库的模式：

✅ 正确的做法 - Orchestrator Agent:

from datetime import datetime
from langchain_openai import ChatOpenAI
from deepagents import create_deep_agent

from backend.engine.prompts.orchestrator import get_orchestrator_prompt
from backend.engine.prompts.chat import get_chat_prompt
from backend.engine.prompts.qa import get_qa_prompt
from backend.tools.registry import get_all_tools

# 定义 Sub-Agents
sub_agents = [
    {
        "name": "chat-agent",
        "description": "Handles general conversation",
        "system_prompt": get_chat_prompt(),
        "tools": get_tools_by_category("communication"),
    },
    {
        "name": "qa-agent",
        "description": "Answers questions from knowledge base",
        "system_prompt": get_qa_prompt(),
        "tools": get_tools_by_category("knowledge"),
    },
]

# 创建 Orchestrator
model = ChatOpenAI(
    base_url="http://localhost:8000/v1",
    model="/Users/workspace/LLM/Qwen3-8B",
    temperature=0.0,
)

orchestrator = create_deep_agent(
    model=model,
    tools=get_all_tools(),
    system_prompt=get_orchestrator_prompt(),
    subagents=sub_agents,
)
"""


# ============================================================================
# Part 4: Chain 模式 - 工具组合
# ============================================================================

"""
使用 LangChain Chain 进行工具和 LLM 组合：
https://python.langchain.com/docs/how_to/chains

✅ 文档处理 Chain 示例：

from langchain_community.document_loaders import PyPDFLoader
from langchain.text_splitter import RecursiveCharacterTextSplitter
from langchain.chains.combine_documents import create_stuff_documents_chain
from langchain_core.prompts import ChatPromptTemplate
from langchain_openai import ChatOpenAI

# Step 1: 加载文档
loader = PyPDFLoader("document.pdf")
docs = loader.load()

# Step 2: 分割文档
splitter = RecursiveCharacterTextSplitter(
    chunk_size=1000,
    chunk_overlap=200
)
split_docs = splitter.split_documents(docs)

# Step 3: 创建 Chain
prompt = ChatPromptTemplate.from_template("""
Summarize this document:
{context}
""")

llm = ChatOpenAI()
chain = create_stuff_documents_chain(llm, prompt)

# Step 4: 执行
result = chain.invoke({"context": split_docs})

✅ RAG (检索增强生成) Chain 示例：

from langchain_community.vectorstores import FAISS
from langchain_openai import OpenAIEmbeddings
from langchain.chains.retrieval import create_retrieval_chain

# Step 1: 创建向量存储
embeddings = OpenAIEmbeddings()
vectorstore = FAISS.from_documents(split_docs, embeddings)
retriever = vectorstore.as_retriever()

# Step 2: 创建 RAG Chain
rag_chain = create_retrieval_chain(
    retriever,
    create_stuff_documents_chain(llm, prompt)
)

# Step 3: 执行
result = rag_chain.invoke({"input": "What is the main topic?"})
"""


# ============================================================================
# Part 5: API 部署 - LangServe Pattern
# ============================================================================

"""
使用 LangServe 部署 API：
https://python.langchain.com/docs/langserve

✅ 正确的做法 - app.py:

from fastapi import FastAPI
from langserve import add_routes
from backend.core.orchestrator_agent import orchestrator

app = FastAPI(
    title="LangChain Server",
    version="1.0",
    description="A server for our Agent API"
)

# 添加 orchestrator agent 路由
add_routes(app, orchestrator, path="/orchestrator")

# 添加特定 sub-agent 路由
add_routes(app, chat_agent, path="/chat")
add_routes(app, qa_agent, path="/qa")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)

使用：
curl -X POST "http://localhost:8001/orchestrator/invoke" \\
  -H "Content-Type: application/json" \\
  -d '{"input": {"messages": [{"role": "user", "content": "Hello"}]}}'
"""


# ============================================================================
# Part 6: 监控和调试 - LangSmith Integration
# ============================================================================

"""
使用 LangSmith 进行监控：
https://docs.smith.langchain.com/

✅ 正确的做法：

import os
from langsmith import Client

# 设置 LangSmith API Key
os.environ["LANGCHAIN_API_KEY"] = "your-api-key"
os.environ["LANGCHAIN_TRACING_V2"] = "true"
os.environ["LANGCHAIN_PROJECT"] = "ccb-v0.378"

# 现在所有 LangChain 操作都会自动被追踪
from deepagents import create_deep_agent

agent = create_deep_agent(
    model=llm,
    tools=tools,
    system_prompt=system_prompt,
)

# 执行会被自动记录到 LangSmith
result = agent.invoke({"input": "user message"})

# 在 smith.langchain.com 查看执行追踪
"""


# ============================================================================
# Part 7: 完整集成示例 - main_orchestrator.py
# ============================================================================

"""
完整的生产级集成示例：

from datetime import datetime
from typing import List, Dict, Optional
import logging

from langchain_openai import ChatOpenAI
from langchain_core.prompts import PromptTemplate
from langchain_core.language_model import BaseLanguageModel
from deepagents import create_deep_agent

from backend.engine.prompts import (
    get_orchestrator_prompt,
    get_chat_prompt,
    get_qa_prompt,
    get_document_processor_prompt,
    get_editor_prompt,
    get_thinking_prompt,
)
from backend.tools.registry import (
    get_all_tools,
    get_tools_by_category,
)

logger = logging.getLogger(__name__)


class OrchestratorAgentFactory:
    '''Factory for creating production-ready Orchestrator Agent'''
    
    @staticmethod
    def create_model(
        base_url: str = "http://localhost:8000/v1",
        model_path: str = "/Users/workspace/LLM/Qwen3-8B",
        temperature: float = 0.0,
    ) -> BaseLanguageModel:
        '''Create LLM model'''
        return ChatOpenAI(
            base_url=base_url,
            model=model_path,
            temperature=temperature,
            api_key="not-needed",
            max_tokens=1024,
            top_p=0.95,
            timeout=60,
        )
    
    @staticmethod
    def create_sub_agents() -> List[Dict]:
        '''Define all sub-agents'''
        return [
            {
                "name": "chat-agent",
                "description": "Handle general conversations",
                "system_prompt": get_chat_prompt(),
                "tools": get_tools_by_category("communication"),
            },
            {
                "name": "qa-agent",
                "description": "Answer questions from knowledge base",
                "system_prompt": get_qa_prompt(),
                "tools": get_tools_by_category("knowledge"),
            },
            {
                "name": "document-agent",
                "description": "Process and analyze documents",
                "system_prompt": get_document_processor_prompt(),
                "tools": get_tools_by_category("document"),
            },
            {
                "name": "editor-agent",
                "description": "Manage files and edits",
                "system_prompt": get_editor_prompt(),
                "tools": get_tools_by_category("file"),
            },
            {
                "name": "thinking-agent",
                "description": "Deep analysis and reasoning",
                "system_prompt": get_thinking_prompt(),
                "tools": get_tools_by_category("thinking"),
            },
        ]
    
    @staticmethod
    def create_orchestrator() -> any:
        '''Create the orchestrator agent'''
        model = OrchestratorAgentFactory.create_model()
        sub_agents = OrchestratorAgentFactory.create_sub_agents()
        
        orchestrator = create_deep_agent(
            model=model,
            tools=get_all_tools(),
            system_prompt=get_orchestrator_prompt(),
            subagents=sub_agents,
        )
        
        logger.info("Orchestrator agent created successfully")
        return orchestrator


# 使用示例
if __name__ == "__main__":
    orchestrator = OrchestratorAgentFactory.create_orchestrator()
    
    # 执行
    result = orchestrator.invoke({
        "input": "Please analyze this document and summarize key findings"
    })
    
    print(result)
"""


# ============================================================================
# Part 8: 测试模式
# ============================================================================

"""
测试 Agent 和 Tools：

import pytest
from unittest.mock import Mock, patch
from backend.tools.thinking_tools import reflect_on_question
from backend.tools.file_tools import read_file


def test_reflect_on_question():
    '''Test thinking tool'''
    result = reflect_on_question(
        question="What are key factors?",
        context="In business context",
        depth="balanced"
    )
    
    assert isinstance(result, str)
    assert "business context" in result


def test_read_file():
    '''Test file tool'''
    # 创建测试文件
    test_path = "/tmp/test.txt"
    with open(test_path, 'w') as f:
        f.write("Test content")
    
    result = read_file(test_path)
    assert "Test content" in result


@pytest.mark.asyncio
async def test_agent_integration():
    '''Test full agent integration'''
    from backend.core.orchestrator_agent import orchestrator
    
    result = await orchestrator.ainvoke({
        "input": "Hello, how are you?"
    })
    
    assert result is not None
    assert "content" in result
"""


print(__doc__)

