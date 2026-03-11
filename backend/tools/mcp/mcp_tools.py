"""
MCP 工具集成 - 使用 LangChain 官方 langchain-mcp-adapters

使用官方 MCP 适配器连接 MCP 服务器，而非自定义实现。

架构说明：
- 本地 MCP Server 使用官方 @modelcontextprotocol/server-* 包
- 云端 DeepAgent 通过 langchain-mcp-adapters 连接
- 支持 stdio 和 HTTP/SSE 两种传输方式

官方 MCP 服务器（可集成）：
- @modelcontextprotocol/server-filesystem: 文件系统操作
- @modelcontextprotocol/server-puppeteer: 浏览器自动化
- @modelcontextprotocol/server-postgres: PostgreSQL 数据库
- @modelcontextprotocol/server-sqlite: SQLite 数据库
- @modelcontextprotocol/server-brave-search: Brave 搜索
- @modelcontextprotocol/server-github: GitHub 操作
- @modelcontextprotocol/server-slack: Slack 集成
- @modelcontextprotocol/server-google-drive: Google Drive

安装：
  pip install langchain-mcp-adapters
  npm install -g @modelcontextprotocol/server-filesystem

使用方式：
  # 方式 1: stdio transport (本地子进程)
  async with MultiServerMCPClient(config) as client:
      tools = client.get_tools()
      agent = create_react_agent(llm, tools)
  
  # 方式 2: HTTP/SSE transport (远程服务器)
  client = MCPClient(url="http://localhost:3000/sse")
  tools = await client.get_tools()
"""

import asyncio
import logging
import os
import json
import time
import copy
from typing import Any, Dict, List, Optional
from contextlib import asynccontextmanager
from pathlib import Path

from langchain_core.tools import BaseTool

logger = logging.getLogger(__name__)


# ============================================================================
# MCP 服务器配置
# ============================================================================

# 官方 MCP 服务器配置模板（作为兜底）
_DEFAULT_MCP_SERVER_CONFIGS = {
    # 文件系统 - 本地文件操作
    "filesystem": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "{workspace_path}"],
        "transport": "stdio",
        "description": "本地文件系统操作 (read, write, edit, ls, glob, grep)",
    },
    
    # 浏览器自动化 - Puppeteer
    "puppeteer": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-puppeteer"],
        "transport": "stdio",
        "description": "浏览器自动化 (navigate, screenshot, click, type)",
    },
    
    # SQLite 数据库
    "sqlite": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-sqlite", "--db-path", "{db_path}"],
        "transport": "stdio",
        "description": "SQLite 数据库操作 (query, execute)",
    },
    
    # PostgreSQL 数据库
    "postgres": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-postgres", "{connection_string}"],
        "transport": "stdio",
        "description": "PostgreSQL 数据库操作",
    },
    
    # Brave 搜索
    "brave-search": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-brave-search"],
        "env": {"BRAVE_API_KEY": "{api_key}"},
        "transport": "stdio",
        "description": "Brave 网页搜索",
    },
    
    # GitHub 操作
    "github": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-github"],
        "env": {"GITHUB_PERSONAL_ACCESS_TOKEN": "{token}"},
        "transport": "stdio",
        "description": "GitHub 仓库操作 (issues, PRs, files)",
    },
}


def _load_mcp_server_configs() -> Dict[str, Dict[str, Any]]:
    """从 backend/config/mcp_servers.json 加载配置；缺失时回退默认值。"""
    config_path = Path(__file__).resolve().parents[2] / "config" / "mcp_servers.json"
    if not config_path.exists():
        return dict(_DEFAULT_MCP_SERVER_CONFIGS)
    try:
        payload = json.loads(config_path.read_text(encoding="utf-8"))
        servers = payload.get("servers") if isinstance(payload, dict) else None
        if not isinstance(servers, list):
            return dict(_DEFAULT_MCP_SERVER_CONFIGS)
        loaded: Dict[str, Dict[str, Any]] = {}
        for item in servers:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name", "") or "").strip()
            if not name or item.get("enabled", True) is False:
                continue
            cfg: Dict[str, Any] = {
                "transport": str(item.get("transport", "stdio") or "stdio"),
                "description": str(item.get("description", "") or ""),
            }
            if "url" in item:
                cfg["url"] = str(item.get("url", "") or "")
            if "command" in item:
                cfg["command"] = str(item.get("command", "") or "")
            if "args" in item and isinstance(item.get("args"), list):
                cfg["args"] = [str(x) for x in item.get("args", [])]
            if "env" in item and isinstance(item.get("env"), dict):
                cfg["env"] = {str(k): str(v) for k, v in item.get("env", {}).items()}
            loaded[name] = cfg
        return loaded or dict(_DEFAULT_MCP_SERVER_CONFIGS)
    except Exception as e:
        logger.warning("load mcp_servers.json failed, fallback to default: %s", e)
        return dict(_DEFAULT_MCP_SERVER_CONFIGS)


def _resolve_mcp_env(server_name: str, env: Dict[str, Any]) -> Dict[str, str]:
    """解析 MCP 配置中的 env 占位符，从环境变量注入敏感信息（参照 Cursor/大厂凭证管理）。
    - 值为 {env:VAR_NAME} 时，使用 os.environ.get(\"VAR_NAME\") 注入；
    - 值为 {placeholder} 时，尝试 os.environ.get(\"MCP_<SERVER>_<KEY>\") 或 os.environ.get(\"<KEY>\")。
    敏感值请通过环境变量或系统密钥链配置，不要写入配置文件明文。
    """
    if not env:
        return {}
    out: Dict[str, str] = {}
    for k, v in env.items():
        if not isinstance(v, str):
            out[k] = str(v) if v is not None else ""
            continue
        if v.startswith("{env:") and v.endswith("}"):
            var_name = v[5:-1].strip()
            out[k] = os.environ.get(var_name, "")
        elif v.startswith("{") and v.endswith("}"):
            key_upper = k.upper().replace("-", "_")
            server_part = server_name.upper().replace("-", "_")
            out[k] = (
                os.environ.get(f"MCP_{server_part}_{key_upper}", "")
                or os.environ.get(k, "")
                or os.environ.get(key_upper, "")
                or ""
            )
        else:
            out[k] = v
    return out


MCP_SERVER_CONFIGS = _load_mcp_server_configs()


# ============================================================================
# 业务相关 MCP 扩展建议
# ============================================================================

# 针对招标文档分析系统的 MCP 扩展建议
BUSINESS_MCP_EXTENSIONS = {
    # ========== 免费/开源 ==========
    
    "filesystem": {
        "category": "免费",
        "description": "文件系统操作",
        "use_case": "读取招标文件、写入分析报告、管理工作区",
        "official": True,
    },
    
    "puppeteer": {
        "category": "免费",
        "description": "浏览器自动化",
        "use_case": "抓取招标网站、截图、自动填表",
        "official": True,
    },
    
    "sqlite": {
        "category": "免费",
        "description": "SQLite 数据库",
        "use_case": "本地存储分析结果、缓存、历史记录",
        "official": True,
    },
    
    # ========== 付费/需要 API Key ==========
    
    "brave-search": {
        "category": "付费 (需要 API Key)",
        "description": "Brave 网页搜索",
        "use_case": "搜索招标相关信息、市场调研、竞品分析",
        "official": True,
    },
    
    "github": {
        "category": "免费 (需要 Token)",
        "description": "GitHub 操作",
        "use_case": "版本控制、协作、代码管理",
        "official": True,
    },
    
    # ========== 第三方 MCP 服务 ==========
    
    "notion": {
        "category": "第三方",
        "description": "Notion 集成",
        "use_case": "知识库管理、文档协作、项目管理",
        "url": "https://github.com/modelcontextprotocol/servers/tree/main/src/notion",
    },
    
    "slack": {
        "category": "第三方",
        "description": "Slack 集成",
        "use_case": "团队通知、审批流程、协作沟通",
        "url": "https://github.com/modelcontextprotocol/servers/tree/main/src/slack",
    },
    
    "google-drive": {
        "category": "第三方",
        "description": "Google Drive 集成",
        "use_case": "云端文档存储、共享、协作编辑",
        "url": "https://github.com/modelcontextprotocol/servers/tree/main/src/gdrive",
    },
    
    # ========== 推荐扩展 (针对招标业务) ==========
    
    "pdf-tools": {
        "category": "推荐开发",
        "description": "PDF 处理工具",
        "use_case": "PDF 解析、表格提取、OCR、合并拆分",
        "implementation": "使用 PyMuPDF/pdfplumber 封装为 MCP Server",
    },
    
    "excel-tools": {
        "category": "推荐开发",
        "description": "Excel 处理工具",
        "use_case": "Excel 读写、数据分析、图表生成",
        "implementation": "使用 openpyxl/pandas 封装为 MCP Server",
    },
    
    "docx-tools": {
        "category": "推荐开发",
        "description": "Word 文档工具",
        "use_case": "DOCX 生成、模板填充、格式转换",
        "implementation": "使用 python-docx 封装为 MCP Server",
    },
    
    "chart-generator": {
        "category": "推荐开发",
        "description": "图表生成工具",
        "use_case": "数据可视化、分析图表、报告插图",
        "implementation": "使用 matplotlib/plotly 封装为 MCP Server",
    },
}


# ============================================================================
# MCP Client 管理
# ============================================================================

# 连接重试：次数与退避秒数（指数退避）
MCP_CONNECT_MAX_RETRIES = int(os.environ.get("MCP_CONNECT_MAX_RETRIES", "3"))
MCP_CONNECT_INITIAL_BACKOFF = float(os.environ.get("MCP_CONNECT_INITIAL_BACKOFF", "1.0"))


class MCPClientManager:
    """MCP 客户端管理器 - 使用 langchain-mcp-adapters"""

    def __init__(self):
        self._clients: Dict[str, Any] = {}
        self._tools: Dict[str, List[BaseTool]] = {}
        self._health: Dict[str, Dict[str, Any]] = {}
        self._lock: Optional[asyncio.Lock] = None
        self._connect_locks: Dict[str, asyncio.Lock] = {}
        self._connect_locks_lock = asyncio.Lock()

    def _get_lock(self) -> asyncio.Lock:
        if self._lock is None:
            self._lock = asyncio.Lock()
        return self._lock

    async def _get_connect_lock(self, name: str) -> asyncio.Lock:
        """按 name 的单 flight 锁，避免同一服务并发创建多连接。"""
        async with self._connect_locks_lock:
            if name not in self._connect_locks:
                self._connect_locks[name] = asyncio.Lock()
            return self._connect_locks[name]

    def _namespace_tools(self, server_name: str, tools: List[BaseTool]) -> List[BaseTool]:
        namespaced: List[BaseTool] = []
        prefix = f"mcp_{server_name}_"
        for tool in tools:
            try:
                tool_copy = copy.copy(tool)
                current = str(getattr(tool_copy, "name", "") or "")
                if current and not current.startswith(prefix):
                    setattr(tool_copy, "name", f"{prefix}{current}")
            except Exception:
                tool_copy = tool
            namespaced.append(tool_copy)
        return namespaced
    
    async def _connect_stdio_impl(
        self,
        name: str,
        command: str,
        args: List[str],
        env: Optional[Dict[str, str]] = None,
    ) -> List[BaseTool]:
        """实际执行 stdio 连接（在 _connect_lock 内调用）。"""
        from langchain_mcp_adapters.client import MultiServerMCPClient

        config = {
            name: {
                "command": command,
                "args": args,
                "env": {**os.environ, **(env or {})},
                "transport": "stdio",
            }
        }
        client = MultiServerMCPClient(config)
        await client.__aenter__()
        tools = self._namespace_tools(name, list(client.get_tools() or []))
        self._clients[name] = client
        self._tools[name] = tools
        self._health[name] = {"ok": True, "last_connected_at": time.time(), "last_error": ""}
        logger.info("Connected to MCP server '%s' with %d tools", name, len(tools))
        return tools

    async def connect_stdio(
        self,
        name: str,
        command: str,
        args: List[str],
        env: Optional[Dict[str, str]] = None,
    ) -> List[BaseTool]:
        """连接 stdio transport 的 MCP 服务器（单 flight：同 name 仅一个连接创建）。"""
        conn_lock = await self._get_connect_lock(name)
        async with conn_lock:
            if name in self._clients and self._tools.get(name):
                return self._tools.get(name, [])
            try:
                return await self._connect_stdio_impl(name, command, args, env)
            except ImportError:
                logger.warning("langchain-mcp-adapters not installed, using fallback")
                return []
            except Exception as e:
                self._health[name] = {"ok": False, "last_connected_at": 0.0, "last_error": str(e)}
                logger.error("Failed to connect to MCP server '%s': %s", name, e)
                return []
    
    async def connect_http(self, name: str, url: str) -> List[BaseTool]:
        """连接 HTTP/SSE transport 的 MCP 服务器（单 flight：同 name 仅一个连接创建）。"""
        conn_lock = await self._get_connect_lock(name)
        async with conn_lock:
            if name in self._clients and self._tools.get(name):
                return self._tools.get(name, [])
            try:
                from langchain_mcp_adapters.client import MCPClient

                client = MCPClient(url=url)
                tools = self._namespace_tools(name, list(await client.get_tools() or []))
                self._clients[name] = client
                self._tools[name] = tools
                self._health[name] = {"ok": True, "last_connected_at": time.time(), "last_error": ""}
                logger.info("Connected to MCP server '%s' at %s with %d tools", name, url, len(tools))
                return tools
            except ImportError:
                logger.warning("langchain-mcp-adapters not installed")
                return []
            except Exception as e:
                self._health[name] = {"ok": False, "last_connected_at": 0.0, "last_error": str(e)}
                logger.error("Failed to connect to MCP server '%s': %s", name, e)
                return []
    
    async def disconnect(self, name: str):
        """断开 MCP 服务器连接"""
        if name in self._clients:
            client = self._clients[name]
            if hasattr(client, '__aexit__'):
                await client.__aexit__(None, None, None)
            del self._clients[name]
            del self._tools[name]
            self._health[name] = {"ok": False, "last_connected_at": 0.0, "last_error": "disconnected"}
            logger.info(f"Disconnected from MCP server '{name}'")
    
    async def disconnect_all(self):
        """断开所有连接"""
        for name in list(self._clients.keys()):
            await self.disconnect(name)
    
    def get_tools(self, name: Optional[str] = None) -> List[BaseTool]:
        """获取工具列表
        
        Args:
            name: 服务器名称，None 表示所有服务器
        
        Returns:
            工具列表
        """
        if name:
            return self._tools.get(name, [])
        
        all_tools = []
        for tools in self._tools.values():
            all_tools.extend(tools)
        return all_tools

    async def ensure_connected(self, name: str, config: Dict[str, Any]) -> List[BaseTool]:
        """按配置确保指定 MCP 服务已连接；失败时有限次退避重试。env 占位符从环境变量解析（见 _resolve_mcp_env）。"""
        if name in self._clients and self._tools.get(name):
            return self._tools.get(name, [])
        transport = str(config.get("transport", "stdio") or "stdio").lower()
        last_error: Optional[Exception] = None
        backoff = MCP_CONNECT_INITIAL_BACKOFF
        for attempt in range(MCP_CONNECT_MAX_RETRIES):
            try:
                if transport in {"http", "https", "sse"} and config.get("url"):
                    out = await self.connect_http(name, str(config.get("url")))
                else:
                    raw_env = dict(config.get("env", {}) or {})
                    env = _resolve_mcp_env(name, raw_env)
                    out = await self.connect_stdio(
                        name=name,
                        command=str(config.get("command", "") or "npx"),
                        args=list(config.get("args", []) or []),
                        env=env,
                    )
                if out:
                    return out
            except Exception as e:
                last_error = e
                logger.debug("ensure_connected %s attempt %s: %s", name, attempt + 1, e)
            if attempt < MCP_CONNECT_MAX_RETRIES - 1:
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30.0)
        if last_error:
            logger.warning("ensure_connected %s failed after %s retries: %s", name, MCP_CONNECT_MAX_RETRIES, last_error)
        return self._tools.get(name, [])

    async def health_check(self) -> Dict[str, Dict[str, Any]]:
        """返回 MCP 连接池健康状态。"""
        snapshot: Dict[str, Dict[str, Any]] = {}
        for name, cfg in MCP_SERVER_CONFIGS.items():
            info = dict(self._health.get(name, {}))
            info.setdefault("ok", bool(name in self._clients and self._tools.get(name)))
            info.setdefault("tool_count", len(self._tools.get(name, [])))
            info.setdefault("transport", cfg.get("transport", "stdio"))
            snapshot[name] = info
        return snapshot
    
    def get_connected_servers(self) -> List[str]:
        """获取已连接的服务器列表"""
        return list(self._clients.keys())


# ============================================================================
# 全局实例
# ============================================================================

_mcp_manager: Optional[MCPClientManager] = None

def get_mcp_manager() -> MCPClientManager:
    """获取 MCP 管理器单例"""
    global _mcp_manager
    if _mcp_manager is None:
        _mcp_manager = MCPClientManager()
    return _mcp_manager


# ============================================================================
# 便捷函数
# ============================================================================

async def connect_filesystem_server(workspace_path: str) -> List[BaseTool]:
    """连接文件系统 MCP 服务器
    
    Args:
        workspace_path: 工作区路径
    
    Returns:
        文件系统工具列表
    """
    manager = get_mcp_manager()
    return await manager.connect_stdio(
        name="filesystem",
        command="npx",
        args=["-y", "@modelcontextprotocol/server-filesystem", workspace_path],
    )


async def connect_puppeteer_server() -> List[BaseTool]:
    """连接 Puppeteer MCP 服务器
    
    Returns:
        浏览器自动化工具列表
    """
    manager = get_mcp_manager()
    return await manager.connect_stdio(
        name="puppeteer",
        command="npx",
        args=["-y", "@modelcontextprotocol/server-puppeteer"],
    )


async def connect_sqlite_server(db_path: str) -> List[BaseTool]:
    """连接 SQLite MCP 服务器
    
    Args:
        db_path: 数据库文件路径
    
    Returns:
        数据库工具列表
    """
    manager = get_mcp_manager()
    return await manager.connect_stdio(
        name="sqlite",
        command="npx",
        args=["-y", "@modelcontextprotocol/server-sqlite", "--db-path", db_path],
    )


def get_all_mcp_tools() -> List[BaseTool]:
    """获取所有已连接的 MCP 工具（连接池复用）。"""
    return get_mcp_manager().get_tools()


async def get_all_mcp_tools_async() -> List[BaseTool]:
    """获取并确保已启用 MCP 服务已连接。"""
    manager = get_mcp_manager()
    for name, cfg in MCP_SERVER_CONFIGS.items():
        try:
            await manager.ensure_connected(name, cfg)
        except Exception as e:
            logger.debug("ensure mcp connected failed: %s (%s)", name, e)
    return manager.get_tools()


async def get_mcp_health() -> Dict[str, Dict[str, Any]]:
    """返回 MCP 连接池健康状态。"""
    return await get_mcp_manager().health_check()


def get_business_mcp_extensions() -> Dict[str, Any]:
    """获取业务相关 MCP 扩展建议"""
    return BUSINESS_MCP_EXTENSIONS


# ============================================================================
# 上下文管理器
# ============================================================================

@asynccontextmanager
async def mcp_session(servers: Dict[str, Dict[str, Any]]):
    """MCP 会话上下文管理器
    
    使用示例：
        async with mcp_session({
            "filesystem": {"workspace_path": "/path/to/workspace"},
            "sqlite": {"db_path": "/path/to/db.sqlite"},
        }) as tools:
            agent = create_react_agent(llm, tools)
            result = await agent.ainvoke({"input": "..."})
    
    Args:
        servers: 服务器配置字典
    
    Yields:
        工具列表
    """
    manager = get_mcp_manager()
    
    try:
        all_tools = []
        
        for name, config in servers.items():
            if name == "filesystem":
                tools = await connect_filesystem_server(config.get("workspace_path", "."))
            elif name == "puppeteer":
                tools = await connect_puppeteer_server()
            elif name == "sqlite":
                tools = await connect_sqlite_server(config.get("db_path", ":memory:"))
            else:
                # 自定义服务器
                if "url" in config:
                    tools = await manager.connect_http(name, config["url"])
                elif "command" in config:
                    tools = await manager.connect_stdio(
                        name,
                        config["command"],
                        config.get("args", []),
                        config.get("env"),
                    )
                else:
                    continue
            
            all_tools.extend(tools)
        
        yield all_tools
        
    finally:
        await manager.disconnect_all()
