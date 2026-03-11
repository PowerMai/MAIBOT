"""
MCP 工具集成模块 - 使用 LangChain 官方 langchain-mcp-adapters

提供：
1. MCP Server 配置
2. MCP Client 管理
3. 工具获取便捷函数
4. 业务扩展建议

使用方式：
    from tools.mcp import get_mcp_manager, get_all_mcp_tools, mcp_session

    # 获取所有 MCP 工具
    tools = get_all_mcp_tools()

    # 使用上下文管理器
    async with mcp_session({"filesystem": {"workspace_path": "/path"}}) as tools:
        agent = create_react_agent(llm, tools)
"""

from .mcp_tools import (
    # 配置
    MCP_SERVER_CONFIGS,
    BUSINESS_MCP_EXTENSIONS,
    
    # 管理器
    MCPClientManager,
    get_mcp_manager,
    
    # 便捷函数
    connect_filesystem_server,
    connect_puppeteer_server,
    connect_sqlite_server,
    get_all_mcp_tools,
    get_business_mcp_extensions,
    
    # 上下文管理器
    mcp_session,
)

__all__ = [
    # 配置
    "MCP_SERVER_CONFIGS",
    "BUSINESS_MCP_EXTENSIONS",
    
    # 管理器
    "MCPClientManager",
    "get_mcp_manager",
    
    # 便捷函数
    "connect_filesystem_server",
    "connect_puppeteer_server",
    "connect_sqlite_server",
    "get_all_mcp_tools",
    "get_business_mcp_extensions",
    
    # 上下文管理器
    "mcp_session",
]
