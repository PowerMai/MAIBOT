"""
MCP 使用示例

展示如何在实际代码中使用 MCP 工具。
"""

import asyncio
from typing import List

from langchain_core.tools import BaseTool


async def example_basic_usage():
    """
    基本使用示例 - 连接文件系统 MCP 服务器
    """
    from . import mcp_session
    
    async with mcp_session({
        "filesystem": {"workspace_path": "/path/to/workspace"},
    }) as tools:
        print(f"Available tools: {[t.name for t in tools]}")
        
        # 使用工具
        for tool in tools:
            if tool.name == "read_file":
                result = await tool.ainvoke({"path": "README.md"})
                print(f"File content: {result[:100]}...")


async def example_multiple_servers():
    """
    多服务器示例 - 同时连接多个 MCP 服务器
    """
    from . import mcp_session
    
    async with mcp_session({
        "filesystem": {"workspace_path": "/path/to/workspace"},
        "sqlite": {"db_path": "./data/analysis.db"},
    }) as tools:
        print(f"Total tools: {len(tools)}")
        
        # 按服务器分类工具
        fs_tools = [t for t in tools if "file" in t.name.lower() or "directory" in t.name.lower()]
        db_tools = [t for t in tools if "query" in t.name.lower() or "execute" in t.name.lower()]
        
        print(f"Filesystem tools: {[t.name for t in fs_tools]}")
        print(f"Database tools: {[t.name for t in db_tools]}")


async def example_with_agent():
    """
    与 Agent 集成示例
    """
    from langchain_openai import ChatOpenAI
    from langgraph.prebuilt import create_react_agent
    from . import mcp_session
    from backend.engine.agent.model_manager import get_model_manager
    
    manager = get_model_manager()
    chosen_model = manager.get_current_model() or manager.default_model

    # 创建 LLM
    llm = ChatOpenAI(
        base_url="http://localhost:1234/v1",
        api_key="sk-no-key",
        model=chosen_model,
    )
    
    async with mcp_session({
        "filesystem": {"workspace_path": "/path/to/workspace"},
    }) as tools:
        # 创建 Agent
        agent = create_react_agent(llm, tools)
        
        # 执行任务
        result = await agent.ainvoke({
            "messages": [{"role": "user", "content": "列出当前目录的文件"}]
        })
        
        print(result)


async def example_custom_server():
    """
    自定义 MCP 服务器示例
    """
    from . import get_mcp_manager
    
    manager = get_mcp_manager()
    
    # 连接自定义 MCP 服务器
    tools = await manager.connect_stdio(
        name="custom-tools",
        command="python",
        args=["-m", "my_mcp_server"],
        env={"MY_API_KEY": "xxx"},
    )
    
    print(f"Custom tools: {[t.name for t in tools]}")
    
    # 使用完毕后断开
    await manager.disconnect("custom-tools")


def example_get_extensions():
    """
    获取可用扩展信息
    """
    from . import get_business_mcp_extensions
    
    extensions = get_business_mcp_extensions()
    
    print("=" * 60)
    print("可用的 MCP 扩展")
    print("=" * 60)
    
    for name, info in extensions.items():
        print(f"\n{name}:")
        print(f"  类别: {info.get('category', 'N/A')}")
        print(f"  描述: {info.get('description', 'N/A')}")
        print(f"  用途: {info.get('use_case', 'N/A')}")
        if 'url' in info:
            print(f"  URL: {info['url']}")
        if 'implementation' in info:
            print(f"  实现: {info['implementation']}")


if __name__ == "__main__":
    # 运行示例
    print("=== 获取扩展信息 ===")
    example_get_extensions()
    
    print("\n=== 基本使用示例 ===")
    # asyncio.run(example_basic_usage())
    print("(需要启动 MCP 服务器)")
