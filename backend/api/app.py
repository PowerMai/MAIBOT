"""
自定义 HTTP API - 挂载到 LangGraph Server

提供：
1. 文件上传 API - 将文件保存到服务器文件系统
2. 知识库管理 API - 与前端同步
3. 工作区管理 API - 管理项目文件
4. 内存管理 API - 监控和清理内存

通过 langgraph.json 的 http.app 配置挂载到 LangGraph Server

错误响应约定：部分接口在异常时仍返回 HTTP 200 + body { "ok": false, "error": "..." }，
客户端应以 body.ok 判断成功与否；后续将逐步迁移为 4xx/5xx + 统一 body 结构。

返回值与 Logger 约定：新接口统一使用 body 字段 "ok"/"error"；logger 优先使用
logger.error("msg %s", e) 等参数化形式，避免 f-string 无条件求值。
"""

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Body, Query, Request, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from contextlib import asynccontextmanager
from pathlib import Path
import io
import os
import re
import socket
import ipaddress
import json
import logging
import shutil
import asyncio
import subprocess
import threading
import time
from datetime import datetime, timezone, timedelta
from typing import Any, List, Optional, Tuple, Union, Dict
from urllib.parse import urlparse
from uuid import uuid4
from pydantic import BaseModel, field_validator
import httpx
from backend.tools.base.paths import get_workspace_root, set_workspace_root, UPLOADS_PATH
from backend.engine.license.tier_service import (
    TierPermissionError,
    normalize_tier as resolve_normalize_tier,
    current_tier as resolve_current_tier,
    tier_limits as resolve_tier_limits,
    tier_rank as resolve_tier_rank,
    ensure_skill_install_allowed as ensure_tier_install_allowed,
)
from backend.engine.plugins import PluginLoader, PluginRegistry
from backend.engine.plugins.runtime_events import append_plugin_runtime_event, load_plugin_runtime_events
from backend.config.store_namespaces import (
    NS_BILLING_USAGE,
    NS_BOARD_PERSONAL,
    NS_BOARD_ORG,
    NS_BOARD_PUBLIC,
    NS_BOARD_INVITES,
)
from backend.api.deps import verify_internal_token
from backend.api.common import resolve_read_path as _resolve_read_path  # 供 multimodal/vision/analyze 与测试校验

logger = logging.getLogger(__name__)


def _safe_error_detail(e: Exception) -> str:
    """生产环境不暴露内部异常详情，仅开发环境返回 str(e)。"""
    if os.getenv("APP_ENV", "production") == "development":
        return str(e)
    return "内部服务器错误"


_UI_STREAM_METRICS_LOCK = threading.Lock()
_UI_STREAM_METRICS_SAMPLES_PATH = Path(__file__).resolve().parents[1] / "data" / "ui_stream_metrics_samples.jsonl"
_warmup_task: Optional[asyncio.Task] = None
_cleanup_task: Optional[asyncio.Task] = None

try:
    _slowapi = __import__("slowapi", fromlist=["Limiter", "_rate_limit_exceeded_handler"])
    _slowapi_errors = __import__("slowapi.errors", fromlist=["RateLimitExceeded"])
    _slowapi_middleware = __import__("slowapi.middleware", fromlist=["SlowAPIMiddleware"])
    Limiter = getattr(_slowapi, "Limiter")
    _rate_limit_exceeded_handler = getattr(_slowapi, "_rate_limit_exceeded_handler")
    RateLimitExceeded = getattr(_slowapi_errors, "RateLimitExceeded")
    SlowAPIMiddleware = getattr(_slowapi_middleware, "SlowAPIMiddleware")
except Exception as e:
    logger.debug("slowapi optional import skipped: %s", e)
    Limiter = None
    _rate_limit_exceeded_handler = None
    RateLimitExceeded = None
    SlowAPIMiddleware = None

_SENSITIVE_FILENAME_RULES = [
    re.compile(r"^\.env(\..+)?$", re.IGNORECASE),
    re.compile(r".*(secret|credential|passwd|password|token|apikey|api[-_]?key).*", re.IGNORECASE),
    re.compile(r".*\.(pem|key|p12|pfx|jks)$", re.IGNORECASE),
    re.compile(r"^(id_rsa|id_dsa|id_ed25519)$", re.IGNORECASE),
]
_SENSITIVE_CONTENT_RULES = [
    (re.compile(r"-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----"), "private_key_block"),
    (re.compile(r"AKIA[0-9A-Z]{16}"), "aws_access_key_like"),
    (re.compile(r"sk-[A-Za-z0-9]{20,}"), "openai_key_like"),
    (re.compile(r"(api[_-]?key|access[_-]?token|secret)\s*[:=]\s*['\"]?[A-Za-z0-9_\-]{8,}", re.IGNORECASE), "api_secret_assignment"),
]

# ============================================================
# 后台任务：定期清理
# ============================================================
_cleanup_task = None
_idle_loop_engine = None

async def _periodic_cleanup():
    """定期清理任务（使用可配置的间隔）
    
    ✅ 修复：使用 run_in_executor 避免阻塞调用警告
    清理操作涉及文件系统扫描（glob/stat），是同步阻塞操作
    必须在线程池中执行，避免阻塞异步事件循环
    """
    # 获取可配置的清理间隔
    try:
        from backend.engine.agent.deep_agent import Config
        cleanup_interval = Config.CLEANUP_INTERVAL_SECONDS
    except ImportError:
        cleanup_interval = 3600  # 默认 1 小时
    
    logger.info(f"🔄 定期清理任务已启动，间隔: {cleanup_interval}秒")
    
    # 获取事件循环（协程内使用 get_running_loop，避免 3.12+ 废弃警告）
    loop = asyncio.get_running_loop()
    
    while True:
        try:
            await asyncio.sleep(cleanup_interval)
            
            # 执行清理（在线程池中执行，避免阻塞）
            try:
                from backend.engine.agent.deep_agent import cleanup_all_storage, get_memory_stats
                
                # 检查健康状态（在线程池中执行）
                stats = await loop.run_in_executor(None, get_memory_stats)
                health = stats.get("health", {})
                
                if health.get("status") in ("warning", "critical"):
                    logger.warning(f"⚠️ 内存健康状态: {health.get('status')}")
                    # 自动执行清理（在线程池中执行）
                    aggressive = health.get("status") == "critical"
                    result = await loop.run_in_executor(
                        None, lambda: cleanup_all_storage(aggressive=aggressive)
                    )
                    logger.info(f"🧹 自动清理完成: {result}")
                else:
                    # 常规清理（非激进，在线程池中执行）
                    result = await loop.run_in_executor(
                        None, lambda: cleanup_all_storage(aggressive=False)
                    )
                    if result.get("pickle_files_cleaned", 0) > 0:
                        logger.info(f"🧹 定期清理完成: {result}")
                        
            except Exception as e:
                logger.error(f"❌ 定期清理失败: {e}")
                
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error(f"❌ 定期清理任务异常: {e}")
            await asyncio.sleep(60)  # 出错后等待 1 分钟再重试


def _cleanup_legacy_context_dir() -> None:
    """
    清理旧版 `.context` 空目录（已迁移到 `.maibot`）。
    仅在目录及其子目录都为空时删除，避免误删用户数据。
    """
    candidates = [
        Path(__file__).resolve().parents[2] / ".context",
    ]
    try:
        from backend.tools.base.paths import get_workspace_root
        candidates.append(get_workspace_root() / ".context")
    except Exception as e:
        logger.debug("get_workspace_root for .context cleanup: %s", e)

    for root in candidates:
        try:
            if not root.exists() or not root.is_dir():
                continue
            # 如果有任何文件存在，则跳过删除（保守策略）
            has_files = any(p.is_file() for p in root.rglob("*"))
            if has_files:
                continue
            # 先删子目录，再删根目录
            for d in sorted([p for p in root.rglob("*") if p.is_dir()], key=lambda x: len(x.parts), reverse=True):
                try:
                    d.rmdir()
                except OSError:
                    pass
            try:
                root.rmdir()
                logger.info("✅ 已清理遗留目录: %s", root)
            except OSError:
                pass
        except Exception as e:
            logger.debug("_cleanup_legacy_context_dir entry: %s", e)
            continue


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期管理（生产级）
    
    ✅ 启动时：
    - 预热连接池
    - 启动定期清理任务
    - 验证存储配置
    
    ✅ 关闭时：
    - 优雅停止后台任务
    - 关闭数据库连接
    - 清理资源
    """
    global _cleanup_task, _idle_loop_engine
    
    app.state.health_httpx_client = httpx.AsyncClient(timeout=3.0)
    
    async def _run_startup_guarded(step_name: str, coro, timeout_seconds: float = 12.0) -> bool:
        """统一 startup 重任务超时与降级护栏：超时/异常都不阻塞整体启动。"""
        try:
            await asyncio.wait_for(coro, timeout=timeout_seconds)
            return True
        except asyncio.TimeoutError:
            logger.warning("⏱️ startup step timeout: %s (timeout=%.1fs)，已降级跳过", step_name, timeout_seconds)
            return False
        except Exception as e:
            logger.debug("startup step failed (non-blocking): %s: %s", step_name, e)
            return False
    
    # ============================================================
    # 启动阶段
    # ============================================================
    logger.info("🚀 MAIBOT Backend API 启动")

    minimal_lifespan = str(os.getenv("FASTAPI_LIFESPAN_MINIMAL", "false")).strip().lower() in {"1", "true", "yes", "on"}

    # 0. 清理历史遗留的空 .context 目录（仅空目录）
    await asyncio.to_thread(_cleanup_legacy_context_dir)
    # 0b. 确保运行时 data 目录存在（评估日志/执行日志/升级日志等）
    (PROJECT_ROOT / "data").mkdir(parents=True, exist_ok=True)
    
    # 1. 预热存储连接
    try:
        from backend.engine.core.main_graph import get_sqlite_checkpointer, get_sqlite_store
        get_sqlite_checkpointer()
        get_sqlite_store()
        logger.info("✅ SQLite 存储已初始化")
    except Exception as e:
        logger.warning("⚠️ 存储初始化失败: %s", _safe_error_detail(e))

    # 1b. 启动时清理历史执行日志，避免 SQLite 无上限膨胀
    try:
        from backend.engine.logging.execution_logger import get_execution_logger
        deleted = get_execution_logger().cleanup_old_logs(days=30)
        if deleted > 0:
            logger.info("✅ 已清理历史执行日志: %s", deleted)
    except Exception as e:
        logger.debug("执行日志清理失败（非关键）: %s", e)

    # 1c. 在生命周期中显式执行一次 deep_agent 启动初始化（幂等）
    # 测试/回归脚本可通过 FASTAPI_LIFESPAN_MINIMAL=true 跳过重初始化，避免无关耗时与外部依赖干扰。
    if not minimal_lifespan:
        try:
            from backend.engine.agent.deep_agent import ensure_startup_initialized
            await _run_startup_guarded(
                "deep_agent.ensure_startup_initialized",
                asyncio.to_thread(ensure_startup_initialized),
                timeout_seconds=float(os.getenv("STARTUP_DEEPAGENT_INIT_TIMEOUT_SEC", "20")),
            )
        except Exception as e:
            logger.debug("deep_agent ensure_startup_initialized non-blocking: %s", e)

    # 1d. 提前初始化 SQLite Store，确保协作统计等接口首请求不因懒加载失败而返回错误
    if not minimal_lifespan:
        try:
            from backend.engine.core.main_graph import get_sqlite_store
            await _run_startup_guarded(
                "get_sqlite_store",
                asyncio.to_thread(get_sqlite_store),
                timeout_seconds=float(os.getenv("STARTUP_STORE_INIT_TIMEOUT_SEC", "10")),
            )
        except Exception as e:
            logger.debug("get_sqlite_store non-blocking: %s", e)

    # 2. 预热 Embedding 模型（异步，避免阻塞 API 启动）
    async def _warmup_embeddings_non_blocking() -> None:
        try:
            from backend.tools.base.embedding_tools import get_embeddings
            await asyncio.to_thread(get_embeddings)
            logger.info("✅ Embedding 模型已预热")
        except Exception as e:
            logger.warning(f"⚠️ Embedding 预热失败: {e}")

    global _warmup_task, _cleanup_task
    if not minimal_lifespan:
        _warmup_task = asyncio.create_task(_warmup_embeddings_non_blocking())
        _warmup_task.add_done_callback(lambda t: globals().__setitem__("_warmup_task", None))
    
    # 3. 启动定期清理任务
    _cleanup_task = asyncio.create_task(_periodic_cleanup())
    _cleanup_task.add_done_callback(lambda t: globals().__setitem__("_cleanup_task", None))
    logger.info("✅ 定期清理任务已启动（每小时执行）")
    
    # 4. 初始化 MCP 连接（可选，根据配置）
    if not minimal_lifespan:
        try:
            mcp_enabled = os.getenv("ENABLE_MCP", "false").lower() == "true"
            if mcp_enabled:
                from tools.mcp import connect_filesystem_server, connect_sqlite_server
                workspace_path = os.getenv("MCP_WORKSPACE_PATH", str(PROJECT_ROOT / "tmp"))
                db_path = os.getenv("MCP_DB_PATH", str(PROJECT_ROOT / "data" / "mcp.db"))

                # 连接文件系统 MCP（如果本地 MCP Server 运行中）
                # await connect_filesystem_server(workspace_path)
                # await connect_sqlite_server(db_path)
                logger.info("ℹ️ MCP 集成已启用（需要本地 MCP Server）")
            else:
                logger.info("ℹ️ MCP 集成未启用（设置 ENABLE_MCP=true 启用）")
        except ImportError:
            logger.warning("⚠️ MCP 模块未安装: pip install langchain-mcp-adapters")

    # 4. 输出存储状态
    try:
        from backend.engine.agent.deep_agent import get_memory_stats
        stats = await asyncio.to_thread(get_memory_stats)
        health = stats.get("health", {})
        logger.info(f"📊 存储健康状态: {health.get('status', 'unknown')}")
        if health.get("warnings"):
            for warning in health["warnings"]:
                logger.warning(f"   ⚠️ {warning}")
    except Exception as e:
        logger.debug("startup get_memory_stats (non-critical): %s", e)

    # 4b. 检查 .langgraph_api 目录大小（langgraph dev 模式 pickle 可能膨胀）
    try:
        _langgraph_api_dir = PROJECT_ROOT / ".langgraph_api"
        if _langgraph_api_dir.is_dir():
            def _dir_size(p):
                total = 0
                try:
                    for e in p.rglob("*"):
                        if e.is_file():
                            total += e.stat().st_size
                except OSError:
                    pass
                return total
            _size_bytes = await asyncio.get_running_loop().run_in_executor(None, _dir_size, _langgraph_api_dir)
            _size_mb = _size_bytes / (1024 * 1024)
            if _size_mb > 200:
                logger.warning(
                    "⚠️ .langgraph_api 目录过大 (%.1f MB)，可能导致内存占用升高。建议：清理该目录或使用 langgraph up（SQLite）替代 dev 模式。",
                    _size_mb,
                )
    except Exception as e:
        logger.debug("检查 .langgraph_api 大小失败（非关键）: %s", e)

    # 5. 可选 Agent 预热（减少首次请求延迟，AGENT_WARMUP_ON_STARTUP=true 启用）
    if os.getenv("AGENT_WARMUP_ON_STARTUP", "false").lower() == "true":
        try:
            from backend.engine.agent.deep_agent import warmup_agent
            ok = await _run_startup_guarded(
                "deep_agent.warmup_agent",
                asyncio.to_thread(lambda: warmup_agent(mode="agent")),
                timeout_seconds=float(os.getenv("STARTUP_AGENT_WARMUP_TIMEOUT_SEC", "25")),
            )
            if ok:
                logger.info("✅ Agent 预热完成")
        except Exception as e:
            logger.debug("Agent 预热失败（非关键）: %s", e)

    # 6. A2A 种子节点注册 + 心跳后台任务
    if not minimal_lifespan:
        try:
            from backend.engine.network.registry import register_seed_nodes, start_heartbeat_background
            await _run_startup_guarded(
                "network.register_seed_nodes",
                register_seed_nodes(),
                timeout_seconds=float(os.getenv("STARTUP_SEED_NODES_TIMEOUT_SEC", "12")),
            )
            start_heartbeat_background()
            logger.info("✅ A2A 网络心跳已启动")
        except Exception as e:
            logger.debug("A2A 心跳启动失败（非关键）: %s", e)

    # 7. 任务看板巡检（可选）：使本地角色自动对 available 任务竞标
    if not minimal_lifespan:
        watcher_enabled, watcher_role_from_cfg = _load_watcher_runtime_config()
        if watcher_enabled:
            try:
                from backend.engine.tasks.task_watcher import start_watcher_background, register_builtin_autonomous_tasks
                await _run_startup_guarded(
                    "task_watcher.register_builtin_autonomous_tasks",
                    register_builtin_autonomous_tasks(),
                    timeout_seconds=float(os.getenv("STARTUP_WATCHER_TASKS_TIMEOUT_SEC", "8")),
                )
                role_id = watcher_role_from_cfg
                if not role_id:
                    role_id = _resolve_default_watcher_role("assistant")
                if role_id:
                    start_watcher_background(role_id, scope="personal")
                    logger.info("✅ 任务看板巡检已启动: role_id=%s", role_id)
                else:
                    logger.debug("task_watcher 启用但未配置 role_id 且无可用角色，跳过")
            except Exception as e:
                logger.debug("任务看板巡检启动失败（非关键）: %s", e)

    # 8. 空闲自主循环：始终启动，scan_and_learn 纯读操作不受自治等级限制；co-pilot 建议仅在 L2/L3 时执行
    if not minimal_lifespan:
        try:
            from backend.engine.idle.idle_loop import IdleLoopEngine

            _idle_loop_engine = IdleLoopEngine(interval_seconds=int(os.getenv("IDLE_LOOP_INTERVAL_SECONDS", "300")))
            _idle_loop_engine.start()
            logger.info("✅ 空闲自主循环已启动（scan_and_learn 定期执行；co-pilot 建议按自治等级）")
        except Exception as e:
            logger.debug("空闲自主循环启动失败（非关键）: %s", e)
    else:
        logger.info("ℹ️ FASTAPI_LIFESPAN_MINIMAL=true，已跳过重型启动项（预热/MCP/A2A/watcher/idle_loop）")

    yield
    
    # ============================================================
    # 关闭阶段
    # ============================================================
    logger.info("🛑 MAIBOT Backend API 正在关闭...")
    
    try:
        await app.state.health_httpx_client.aclose()
    except Exception as e:
        logger.debug("health_httpx_client.aclose on shutdown: %s", e)
    
    # 1. 停止后台任务
    if _warmup_task and not _warmup_task.done():
        _warmup_task.cancel()
        try:
            await _warmup_task
        except asyncio.CancelledError:
            pass
    if _cleanup_task and not _cleanup_task.done():
        _cleanup_task.cancel()
        try:
            await _cleanup_task
        except asyncio.CancelledError:
            pass
    
    # 1b. 停止 A2A 心跳
    try:
        from backend.engine.network.registry import stop_heartbeat_background
        stop_heartbeat_background()
    except Exception as e:
        logger.debug("stop_heartbeat_background: %s", e)

    # 1c. 停止空闲自主循环
    try:
        if _idle_loop_engine is not None:
            await _idle_loop_engine.stop()
            _idle_loop_engine = None
    except Exception as e:
        logger.debug("idle_loop_engine.stop: %s", e)

    # 1c. 停止任务看板巡检
    try:
        from backend.engine.tasks.task_watcher import stop_watcher_background
        stop_watcher_background()
    except Exception as e:
        logger.debug("stop_watcher_background: %s", e)
    
    # 2. 关闭存储连接
    try:
        from backend.engine.core.main_graph import cleanup_storage
        cleanup_storage()
        logger.info("✅ 存储连接已关闭")
    except Exception as e:
        logger.warning(f"⚠️ 关闭存储连接失败: {e}")
    
    # 3. 清理 Embedding 资源
    try:
        from backend.tools.base.embedding_tools import cleanup_embedding_resources
        cleanup_embedding_resources()
        logger.info("✅ Embedding 资源已清理")
    except Exception as e:
        logger.warning("清理 Embedding 资源失败: %s", e)
    
    # 4. 关闭 MCP 连接
    try:
        from backend.tools.mcp import get_mcp_manager
        manager = get_mcp_manager()
        await manager.disconnect_all()
        logger.info("✅ MCP 连接已关闭")
    except Exception as e:
        logger.debug(f"ℹ️ MCP 关闭: {e}")
    
    # 5. 关闭 HTTP 客户端
    try:
        from backend.engine.core.http_client import close_all_clients
        await close_all_clients()
        logger.info("✅ HTTP 客户端已关闭")
    except Exception as e:
        logger.warning(f"⚠️ 关闭 HTTP 客户端失败: {e}")
    
    try:
        from backend.engine.agent.deep_agent import cleanup_httpx_client
        cleanup_httpx_client()
        logger.info("✅ DeepAgent httpx 客户端已关闭")
    except Exception as e:
        logger.warning(f"⚠️ 关闭 DeepAgent httpx 客户端失败: {e}")
    
    try:
        from backend.engine.agent.model_manager import cleanup_llm_http_clients
        await cleanup_llm_http_clients()
        logger.info("✅ ModelManager LLM HTTP 客户端已关闭")
    except Exception as e:
        logger.warning(f"⚠️ 关闭 ModelManager LLM HTTP 客户端失败: {e}")
    
    # 6. 强制垃圾回收
    import gc
    gc.collect()
    
    logger.info("👋 MAIBOT Backend API 已关闭")

# ============================================================
# 目录配置（使用统一路径模块）
# ============================================================
try:
    from backend.tools.base.paths import (
        get_project_root, get_workspace_root, UPLOADS_PATH, KB_PATH, WORKSPACE_PATH
    )
    PROJECT_ROOT = get_project_root()
    UPLOAD_DIR = UPLOADS_PATH
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    KNOWLEDGE_DIR = KB_PATH
    WORKSPACE_DIR = WORKSPACE_PATH  # 初始值；列表/解析等需用 get_workspace_root() 以支持 switch 后当前工作区
except ImportError:
    # 回退：与 paths.py 一致，使用项目根（app.py -> api -> backend -> 上一级 = 项目根）
    _app_file = Path(__file__).resolve()
    PROJECT_ROOT = _app_file.parent.parent.parent.parent
    UPLOAD_DIR = PROJECT_ROOT / "tmp" / "uploads"
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    KNOWLEDGE_DIR = PROJECT_ROOT / "knowledge_base"
    WORKSPACE_DIR = PROJECT_ROOT / "tmp"
    WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)


# ============================================================
# FastAPI 应用
# ============================================================

app = FastAPI(
    title="MAIBOT Backend API",
    description="文件上传、知识库和工作区管理 API",
    version="1.0.0",
    lifespan=lifespan,
)

def _trusted_proxy_ips() -> set:
    """受信代理 IP 集合，仅在此情况下才信任 X-Forwarded-For。"""
    raw = os.getenv("TRUSTED_PROXY_IPS", "").strip()
    if not raw:
        return set()
    out = set()
    for part in raw.split(","):
        part = part.strip()
        if part:
            out.add(part)
    return out


def _rate_limit_key(request: Request) -> str:
    """基于客户端 IP 的速率限制键。仅当直连 IP 在 TRUSTED_PROXY_IPS 内时才使用 X-Forwarded-For，否则易被伪造绕过限速。"""
    client_host = (request.client.host if request.client else None) or ""
    trusted = _trusted_proxy_ips()
    if trusted and client_host in trusted:
        xff = request.headers.get("x-forwarded-for", "")
        if xff:
            ip = xff.split(",")[0].strip()
            if ip:
                return ip
    if client_host:
        return client_host
    return "unknown"

# 限流先注册（内层），CORS 后注册（外层），使 429 等响应也携带 CORS 头
_default_rate_limit = os.getenv("API_RATE_LIMIT", "60/minute").strip() or "60/minute"
if Limiter is not None and SlowAPIMiddleware is not None and RateLimitExceeded is not None and _rate_limit_exceeded_handler is not None:
    limiter = Limiter(key_func=_rate_limit_key, default_limits=[_default_rate_limit])
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
    app.add_middleware(SlowAPIMiddleware)
else:
    app.state.limiter = None
    logger.warning("slowapi 未安装，已跳过 API 速率限制中间件")

_CORS_ORIGINS = os.getenv("CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173,http://127.0.0.1:5173").strip().split(",")
_CORS_ORIGINS = [o.strip() for o in _CORS_ORIGINS if o.strip()]
if not _CORS_ORIGINS:
    _CORS_ORIGINS = ["http://localhost:5173"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "Accept", "X-Internal-Token", "X-Agent-Id", "X-Requested-With"],
)


class RequestIDMiddleware(BaseHTTPMiddleware):
    """为每个请求生成 request_id，写入 request.state 与响应头，便于排查与日志关联。后续需要 request_id 的中间件（如访问日志、审计）应加在本中间件之后，通过 request.state.request_id 获取；响应头已带 X-Request-Id。"""

    async def dispatch(self, request: Request, call_next):
        rid = request.headers.get("X-Request-Id") or str(uuid4())
        request.state.request_id = rid
        response = await call_next(request)
        response.headers["X-Request-Id"] = rid
        return response


app.add_middleware(RequestIDMiddleware)


def _request_id_from_request(request: Request) -> Optional[str]:
    return getattr(request.state, "request_id", None)


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException) -> JSONResponse:
    """HTTPException 响应体带上 request_id，便于排查。"""
    rid = _request_id_from_request(request)
    content: Dict[str, Any] = {"detail": exc.detail}
    if rid is not None:
        content["request_id"] = rid
    return JSONResponse(status_code=exc.status_code, content=content)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """未捕获异常返回 500 并带 request_id，同时打日志。"""
    rid = _request_id_from_request(request)
    logger.exception("Unhandled exception (request_id=%s): %s", rid, exc)
    content: Dict[str, Any] = {"detail": _safe_error_detail(exc)}
    if rid is not None:
        content["request_id"] = rid
    return JSONResponse(status_code=500, content=content)


# ============================================================
# 注册子路由
# ============================================================

# 注意：上下文和模式通过消息的 additional_kwargs 传递，不需要独立 API
# Skills：见 /skills/list、/skills/profiles、/skills/reload、/skills/validate

def _workspace_auto_index_status_payload() -> Dict[str, Any]:
    """工作区自动索引状态快照（供独立 router 复用）。"""
    with _workspace_auto_index_lock:
        return {
            "ok": True,
            "enabled": WORKSPACE_UPLOAD_AUTO_INDEX_ENABLED,
            "config": {
                "cooldown_sec": WORKSPACE_UPLOAD_AUTO_INDEX_COOLDOWN_SEC,
                "batch_window_sec": WORKSPACE_UPLOAD_AUTO_INDEX_BATCH_WINDOW_SEC,
                "domains": WORKSPACE_UPLOAD_AUTO_INDEX_DOMAINS,
            },
            "runtime": {
                "worker_active": _workspace_auto_index_worker_active,
                "timer_active": _workspace_auto_index_timer is not None,
                "pending_count": len(_workspace_auto_index_pending),
                "enqueued_total": _workspace_auto_index_enqueued_total,
                "batches_total": _workspace_auto_index_batches_total,
                "batches_failed": _workspace_auto_index_batches_failed,
                "last_batch_size": _workspace_auto_index_last_batch_size,
                "last_run_at": _workspace_auto_index_last_run_at,
                "last_duration_ms": _workspace_auto_index_last_duration_ms,
                "last_error": _workspace_auto_index_last_error,
            },
        }


def _knowledge_pipeline_status_payload() -> Dict[str, Any]:
    """知识链路四象限观测快照：ingest / index / search / ontology。"""
    # ingest: 上传清单统计
    ingest_total = 0
    ingest_recent = 0
    ingest_last_ts = None
    now_epoch = datetime.now(timezone.utc).timestamp()
    manifest_path = _WORKSPACE_UPLOAD_MANIFEST_PATH
    if manifest_path.exists():
        try:
            for raw in manifest_path.read_text(encoding="utf-8", errors="ignore").splitlines():
                line = raw.strip()
                if not line:
                    continue
                ingest_total += 1
                rec = json.loads(line)
                ts = str(rec.get("ts") or "").strip()
                if ts:
                    ingest_last_ts = ts
                    try:
                        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                        if (now_epoch - dt.timestamp()) <= 24 * 3600:
                            ingest_recent += 1
                    except Exception as e:
                        logger.debug("status ingest ts parse: %s", e)
        except Exception as e:
            logger.debug("status ingest scan: %s", e)

    # index/search: 向量与缓存统计
    index_stats: Dict[str, Any] = {}
    search_stats: Dict[str, Any] = {}
    try:
        from backend.tools.base.storage_manager import get_index_manager

        stats = get_index_manager().get_stats()
        meta = stats.get("metadata", {}) if isinstance(stats, dict) else {}
        index_stats = {
            "exists": bool(stats.get("exists")) if isinstance(stats, dict) else False,
            "index_size_mb": stats.get("index_size_mb", 0) if isinstance(stats, dict) else 0,
            "indexed_documents": meta.get("indexed_documents", 0),
            "total_chunks": meta.get("total_chunks", 0),
        }
        search_stats = {
            "cached_queries": meta.get("cached_queries", 0),
            "db_size_kb": meta.get("db_size_kb", 0),
        }
    except Exception as e:
        err_msg = _safe_error_detail(e)
        index_stats = {"ok": False, "error": err_msg, "exists": False, "index_size_mb": 0, "indexed_documents": 0, "total_chunks": 0}
        search_stats = {"ok": False, "error": err_msg, "cached_queries": 0, "db_size_kb": 0}

    # ontology: 实体关系统计
    ontology_entities = 0
    ontology_relations = 0
    ontology_dir = KNOWLEDGE_DIR / "learned" / "ontology"
    entities_file = ontology_dir / "entities.json"
    relations_file = ontology_dir / "relations.json"
    try:
        if entities_file.exists():
            entities_data = json.loads(entities_file.read_text(encoding="utf-8", errors="ignore"))
            ontology_entities = len(entities_data.get("entities") or []) if isinstance(entities_data, dict) else 0
        if relations_file.exists():
            relations_data = json.loads(relations_file.read_text(encoding="utf-8", errors="ignore"))
            ontology_relations = len(relations_data.get("relations") or []) if isinstance(relations_data, dict) else 0
    except Exception as e:
        logger.debug("status ontology stats: %s", e)

    return {
        "ok": True,
        "ingest": {
            "manifest_path": str(manifest_path),
            "total_uploaded": ingest_total,
            "uploaded_last_24h": ingest_recent,
            "last_uploaded_at": ingest_last_ts,
        },
        "index": {
            **_workspace_auto_index_status_payload().get("runtime", {}),
            **index_stats,
        },
        "search": search_stats,
        "ontology": {
            "entities": ontology_entities,
            "relations": ontology_relations,
            "ontology_dir": str(ontology_dir),
        },
    }


# ✅ 知识库管理 API（完整功能）
try:
    from backend.api.knowledge_api import router as knowledge_router
    app.include_router(knowledge_router)
    logger.info("✅ 知识库 API 已注册")
    from backend.api.workspace_auto_index_api import create_workspace_auto_index_router
    app.include_router(create_workspace_auto_index_router(_workspace_auto_index_status_payload))
    logger.info("✅ 工作区自动索引 Ops API 已注册")
    from backend.api.knowledge_ops_api import create_knowledge_ops_router
    app.include_router(create_knowledge_ops_router(_knowledge_pipeline_status_payload))
    logger.info("✅ 知识链路 Ops API 已注册")
except ImportError:
    try:
        from api.knowledge_api import router as knowledge_router
        app.include_router(knowledge_router)
        logger.info("✅ 知识库 API 已注册（相对导入）")
        from api.workspace_auto_index_api import create_workspace_auto_index_router
        app.include_router(create_workspace_auto_index_router(_workspace_auto_index_status_payload))
        logger.info("✅ 工作区自动索引 Ops API 已注册（相对导入）")
        from api.knowledge_ops_api import create_knowledge_ops_router
        app.include_router(create_knowledge_ops_router(_knowledge_pipeline_status_payload))
        logger.info("✅ 知识链路 Ops API 已注册（相对导入）")
    except ImportError as e:
        logger.warning(f"⚠️ 知识库 API 注册失败: {e}")

try:
    from backend.api.routers.board_api import router as board_router
    app.include_router(board_router)
    logger.info("✅ Board/Task API 已注册")
except ImportError as e:
    logger.warning(f"⚠️ Board/Task API 注册失败: {e}")

try:
    from backend.api.routers.files_api import router as files_router
    app.include_router(files_router)
    logger.info("✅ Files API 已注册")
except ImportError as e:
    logger.warning("⚠️ Files API 注册失败: %s", e)

# ============================================================
# 文件上传 API（upload/workspace 仍在此处，依赖工作区索引等状态）
# ============================================================

def _safe_upload_filename(original: str) -> str:
    """生成可安全写入磁盘的文件名，保留原名但去除危险字符。"""
    import re
    import uuid
    raw = (original or "upload").strip()
    # 只取文件名部分，去掉路径
    name = os.path.basename(raw)
    if not name:
        name = "upload"
    # 去除空字节和路径分隔符
    name = re.sub(r'[\x00/\\]', '', name)
    # 如果文件名为空或只有空白，用 UUID
    if not name.strip():
        ext = Path(original).suffix if original else ""
        return f"{uuid.uuid4().hex}{ext or ''}"
    return name


MAX_UPLOAD_BYTES = 50 * 1024 * 1024  # 50MB
UPLOAD_STREAM_CHUNK_BYTES = 1024 * 1024  # 1MB
# 仅允许以下扩展名（白名单），并校验 magic bytes 防伪造
UPLOAD_ALLOWED_EXTENSIONS = frozenset({
    ".pdf", ".docx", ".xlsx", ".csv", ".txt", ".md",
    ".png", ".jpg", ".jpeg", ".gif", ".webp",
    ".json", ".yaml", ".yml", ".toml",
})

# 扩展名 -> (预期文件头, 可选偏移：如 webp 在 8:12 需为 WEBP)
_UPLOAD_MAGIC: Dict[str, Tuple[bytes, Optional[int]]] = {
    ".pdf": (b"%PDF", None),
    ".png": (b"\x89PNG\r\n\x1a\n", None),
    ".jpg": (b"\xff\xd8\xff", None),
    ".jpeg": (b"\xff\xd8\xff", None),
    ".gif": (b"GIF8", None),  # GIF87a / GIF89a
    ".webp": (b"RIFF", 8),  # bytes 8:12 == WEBP
    ".docx": (b"PK\x03\x04", None),
    ".xlsx": (b"PK\x03\x04", None),
}


def _validate_upload_magic(file_path: Path, suffix: str) -> bool:
    """校验文件头与扩展名是否一致，不一致返回 False。无 magic 约定的扩展名直接通过。"""
    suffix = suffix.lower()
    if suffix not in _UPLOAD_MAGIC:
        return True
    magic_spec = _UPLOAD_MAGIC.get(suffix)
    if not magic_spec:
        return True
    prefix, offset = magic_spec
    try:
        with open(file_path, "rb") as f:
            head = f.read(max(12, len(prefix)) if offset else len(prefix))
    except Exception as e:
        logger.debug("_file_matches_magic read: %s", e)
        return False
    if len(head) < len(prefix):
        return False
    if head[: len(prefix)] != prefix:
        return False
    if offset is not None and suffix == ".webp" and len(head) >= 12:
        if head[8:12] != b"WEBP":
            return False
    return True
WORKSPACE_UPLOAD_AUTO_INDEX_ENABLED = os.getenv("WORKSPACE_UPLOAD_AUTO_INDEX_ENABLED", "true").lower() in {"1", "true", "yes", "on"}
def _parse_auto_index_int_env(name: str, default: str) -> int:
    try:
        return int(os.getenv(name, default))
    except (TypeError, ValueError):
        return int(default)
WORKSPACE_UPLOAD_AUTO_INDEX_COOLDOWN_SEC = max(0, _parse_auto_index_int_env("WORKSPACE_UPLOAD_AUTO_INDEX_COOLDOWN_SEC", "20"))
WORKSPACE_UPLOAD_AUTO_INDEX_BATCH_WINDOW_SEC = max(1, _parse_auto_index_int_env("WORKSPACE_UPLOAD_AUTO_INDEX_BATCH_WINDOW_SEC", "3"))
WORKSPACE_UPLOAD_AUTO_INDEX_DOMAINS = [
    item.strip() for item in os.getenv("WORKSPACE_UPLOAD_AUTO_INDEX_DOMAINS", "").split(",") if item.strip()
]
WORKSPACE_UPLOAD_AUTO_INGEST_ENABLED = os.getenv("WORKSPACE_UPLOAD_AUTO_INGEST_ENABLED", "true").lower() in {"1", "true", "yes", "on"}
WORKSPACE_UPLOAD_AUTO_INGEST_SCOPE = (os.getenv("WORKSPACE_UPLOAD_AUTO_INGEST_SCOPE", "global/domain/sales/user_uploads") or "global/domain/sales/user_uploads").strip("/")
_WORKSPACE_AUTO_INDEX_EXT = frozenset({
    ".md", ".txt", ".pdf", ".docx", ".xlsx", ".csv", ".json", ".yaml", ".yml"
})
_workspace_auto_index_lock = threading.Lock()
_workspace_auto_index_last_ts: float = 0.0
_workspace_auto_index_pending: set[str] = set()
_workspace_auto_index_timer: Optional[threading.Timer] = None
_workspace_auto_index_worker_active: bool = False
_workspace_auto_index_enqueued_total: int = 0
_workspace_auto_index_batches_total: int = 0
_workspace_auto_index_batches_failed: int = 0
_workspace_auto_index_last_batch_size: int = 0
_workspace_auto_index_last_run_at: Optional[str] = None
_workspace_auto_index_last_duration_ms: Optional[int] = None
_workspace_auto_index_last_error: Optional[str] = None
_WORKSPACE_UPLOAD_MANIFEST_PATH = KNOWLEDGE_DIR / "learned" / "ingestion" / "workspace_upload_manifest.jsonl"
_workspace_upload_manifest_lock = threading.Lock()


def _sync_copy_upload_stream(upload_fp, file_path: Path, max_bytes: int) -> int:
    """
    将 UploadFile 的底层文件流同步写入磁盘（在线程池中执行）。
    - 避免 await file.read() 一次性读入内存
    - 超过 max_bytes 时抛出 ValueError
    """
    file_path.parent.mkdir(parents=True, exist_ok=True)
    total = 0
    with open(file_path, "wb") as dst:
        while True:
            chunk = upload_fp.read(UPLOAD_STREAM_CHUNK_BYTES)
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                raise ValueError("upload_too_large")
            dst.write(chunk)
    return total


def _is_workspace_indexable_file(file_path: Path) -> bool:
    return file_path.suffix.lower() in _WORKSPACE_AUTO_INDEX_EXT


def _normalize_scope_token(value: Optional[str], fallback: str) -> str:
    token = str(value or "").strip().lower()
    token = re.sub(r"[^a-z0-9_-]+", "-", token).strip("-")
    if not token:
        token = fallback
    return token[:64]


def _build_workspace_ingest_scope(workspace_id: Optional[str], thread_id: Optional[str]) -> str:
    workspace_token = _normalize_scope_token(workspace_id, "default")
    scope = f"{WORKSPACE_UPLOAD_AUTO_INGEST_SCOPE}/workspace_{workspace_token}"
    thread_token = _normalize_scope_token(thread_id, "")
    if thread_token:
        scope = f"{scope}/thread_{thread_token}"
    return scope


def _sync_append_workspace_upload_manifest(entry: Dict[str, Any]) -> None:
    _WORKSPACE_UPLOAD_MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _workspace_upload_manifest_lock:
        with _WORKSPACE_UPLOAD_MANIFEST_PATH.open("a", encoding="utf-8") as fp:
            fp.write(json.dumps(entry, ensure_ascii=False) + "\n")


def _sync_mirror_workspace_upload_to_kb(
    source_path: Path,
    safe_name: str,
    workspace_id: Optional[str],
    thread_id: Optional[str],
) -> Optional[Path]:
    """将工作区可索引文件镜像到知识库域目录，供统一检索链路索引。"""
    if not WORKSPACE_UPLOAD_AUTO_INGEST_ENABLED:
        return None
    if not _is_workspace_indexable_file(source_path):
        return None

    kb_root = Path(KNOWLEDGE_DIR).resolve()
    scope = _build_workspace_ingest_scope(workspace_id, thread_id)
    target_dir = (kb_root / scope).resolve()
    try:
        target_dir.relative_to(kb_root)
    except ValueError:
        logger.warning("工作区上传镜像路径越界，已跳过: %s", target_dir)
        return None

    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / safe_name
    if target.exists():
        target = target_dir / f"{target.stem}-{uuid4().hex[:8]}{target.suffix}"
    shutil.copy2(source_path, target)
    return target


def _workspace_auto_index_timer_callback() -> None:
    global _workspace_auto_index_timer, _workspace_auto_index_worker_active
    with _workspace_auto_index_lock:
        _workspace_auto_index_timer = None
        if _workspace_auto_index_worker_active:
            return
        _workspace_auto_index_worker_active = True
    threading.Thread(
        target=_run_workspace_auto_index_worker,
        name="workspace-auto-index-worker",
        daemon=True,
    ).start()


def _run_workspace_auto_index_worker() -> None:
    global _workspace_auto_index_last_ts, _workspace_auto_index_worker_active
    global _workspace_auto_index_batches_total, _workspace_auto_index_batches_failed
    global _workspace_auto_index_last_batch_size, _workspace_auto_index_last_run_at
    global _workspace_auto_index_last_duration_ms, _workspace_auto_index_last_error
    try:
        while True:
            with _workspace_auto_index_lock:
                pending = list(_workspace_auto_index_pending)
                _workspace_auto_index_pending.clear()
            if not pending:
                break

            gap = time.monotonic() - _workspace_auto_index_last_ts
            if gap < WORKSPACE_UPLOAD_AUTO_INDEX_COOLDOWN_SEC:
                time.sleep(WORKSPACE_UPLOAD_AUTO_INDEX_COOLDOWN_SEC - gap)

            start_ts = time.monotonic()
            from backend.tools.base.embedding_tools import rebuild_index
            # force=False：storage_manager 仅对 needs_reindex(path, file_hash) 的文档增量向量化并合并，对标 Cursor hash diff 增量更新
            ok = rebuild_index(
                WORKSPACE_UPLOAD_AUTO_INDEX_DOMAINS or None,
                None,
                True,
                False,
            )
            elapsed_ms = int((time.monotonic() - start_ts) * 1000)
            with _workspace_auto_index_lock:
                _workspace_auto_index_last_ts = time.monotonic()
                _workspace_auto_index_batches_total += 1
                _workspace_auto_index_last_batch_size = len(pending)
                _workspace_auto_index_last_run_at = datetime.now(timezone.utc).isoformat()
                _workspace_auto_index_last_duration_ms = elapsed_ms
                if ok:
                    _workspace_auto_index_last_error = None
                else:
                    _workspace_auto_index_batches_failed += 1
                    _workspace_auto_index_last_error = "rebuild_index_returned_false"
            if ok:
                logger.info(
                    "✅ 工作区上传批量增量索引完成: batch_size=%s sample=%s elapsed_ms=%s",
                    len(pending),
                    pending[0],
                    elapsed_ms,
                )
            else:
                logger.warning(
                    "⚠️ 工作区上传批量增量索引失败: batch_size=%s sample=%s elapsed_ms=%s",
                    len(pending),
                    pending[0],
                    elapsed_ms,
                )
    except Exception:
        with _workspace_auto_index_lock:
            _workspace_auto_index_batches_failed += 1
            _workspace_auto_index_last_error = "worker_exception"
        logger.exception("❌ 工作区上传后索引任务异常")
    finally:
        with _workspace_auto_index_lock:
            _workspace_auto_index_worker_active = False
            should_restart = bool(_workspace_auto_index_pending) and _workspace_auto_index_timer is None
            if should_restart:
                timer = threading.Timer(
                    WORKSPACE_UPLOAD_AUTO_INDEX_BATCH_WINDOW_SEC,
                    _workspace_auto_index_timer_callback,
                )
                timer.daemon = True
                _workspace_auto_index_timer = timer
                timer.start()


def _schedule_workspace_incremental_index(trigger_path: Path) -> None:
    """上传后触发增量索引（后台线程批处理 + 冷却），不阻塞 API 响应。"""
    global _workspace_auto_index_timer, _workspace_auto_index_enqueued_total
    if not WORKSPACE_UPLOAD_AUTO_INDEX_ENABLED:
        return
    if not _is_workspace_indexable_file(trigger_path):
        return
    with _workspace_auto_index_lock:
        _workspace_auto_index_pending.add(str(trigger_path))
        _workspace_auto_index_enqueued_total += 1
        if _workspace_auto_index_worker_active or _workspace_auto_index_timer is not None:
            return
        timer = threading.Timer(
            WORKSPACE_UPLOAD_AUTO_INDEX_BATCH_WINDOW_SEC,
            _workspace_auto_index_timer_callback,
        )
        timer.daemon = True
        _workspace_auto_index_timer = timer
        timer.start()


@app.post("/files/upload")
async def upload_file(
    file: UploadFile = File(...),
    workspace_path: Optional[str] = Form(default=None),
    _: None = Depends(verify_internal_token),
):
    """
    上传文件到服务器。

    若传 workspace_path 且为有效目录，则保存到该工作区的 uploads/ 下，便于本轮对话 read_file 解析；
    否则保存到当前全局工作区的 uploads/。返回绝对路径供前端放入 context_items，LLM 可用 read_file 读取。
    """
    import asyncio

    try:
        upload_dir = get_workspace_root() / "uploads"
        if workspace_path and (wp := (workspace_path or "").strip()):
            try:
                resolved_wp = Path(wp).resolve()
                if resolved_wp.is_dir():
                    set_workspace_root(resolved_wp)
                    upload_dir = UPLOADS_PATH
            except Exception as e:
                logger.debug("upload workspace_path 无效，使用当前工作区: %s", e)
        upload_dir.mkdir(parents=True, exist_ok=True)
        safe_name = _safe_upload_filename(file.filename or "upload")
        suffix = Path(safe_name).suffix.lower()
        if suffix not in UPLOAD_ALLOWED_EXTENSIONS:
            raise HTTPException(
                status_code=400,
                detail="不允许上传该类型文件，仅支持白名单扩展名",
            )
        file_path = (upload_dir / safe_name).resolve()
        try:
            file_path.relative_to(upload_dir)
        except ValueError:
            raise HTTPException(status_code=400, detail="path not allowed")

        await file.seek(0)
        try:
            # 阻塞 IO 放到线程池，避免 dev 环境 blockbuster 报错
            file_size = await asyncio.to_thread(
                _sync_copy_upload_stream,
                file.file,
                file_path,
                MAX_UPLOAD_BYTES,
            )
        except ValueError as exc:
            if str(exc) == "upload_too_large":
                try:
                    if file_path.exists():
                        file_path.unlink()
                except Exception as e:
                    logger.debug("upload rollback unlink: %s", e)
                raise HTTPException(
                    status_code=413,
                    detail=f"文件大小超过 {MAX_UPLOAD_BYTES // (1024*1024)}MB 限制",
                ) from exc
            raise

        if not _validate_upload_magic(file_path, suffix):
            try:
                if file_path.exists():
                    file_path.unlink()
            except Exception as e:
                logger.debug("upload invalid magic unlink: %s", e)
            raise HTTPException(status_code=400, detail="文件内容与扩展名不符")

        absolute_path = str(file_path.absolute())
        logger.info("✅ 文件上传成功: %s (%s bytes)", absolute_path, file_size)
        return {
            "ok": True,
            "filename": file.filename or safe_name,
            "path": absolute_path,
            "size": file_size,
        }
    except Exception as e:
        logger.exception("❌ 文件上传失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


# 路径解析与 files 只读/读写已迁至 backend.api.routers.files_api；workspace/file-versions 使用 common 的 resolve_write_path/sync_write_text
from backend.api.common import (
    resolve_read_path as _resolve_read_path,
    resolve_write_path as _resolve_write_path,
    sync_write_text as _sync_write_text,
)

# ============================================================
# 知识库 API
# ============================================================

class KnowledgeItem(BaseModel):
    name: str
    content: Optional[str] = None
    path: Optional[str] = None


# 知识库 API 已移至 knowledge_api.py（完整功能）
# 包括：/knowledge/structure, /knowledge/upload, /knowledge/document, 
#       /knowledge/refresh, /knowledge/search, /knowledge/directory


# ============================================================
# 工作区 API
# ============================================================

def _scan_workspace_files(workspace_dir: Path, limit: int) -> list:
    result = []
    for item in workspace_dir.rglob("*"):
        if len(result) >= limit:
            break
        if item.is_file():
            result.append({
                "name": item.name,
                "path": str(item.absolute()),
                "relative_path": str(item.relative_to(workspace_dir)),
                "size": item.stat().st_size,
            })
    return result


@app.get("/workspace/list")
async def list_workspace(limit: int = 500):
    """列出工作区文件（limit 默认 500，最大 2000）。使用当前工作区根（支持 workspace/switch 后一致）。"""
    cap = min(max(1, limit), 2000)
    try:
        try:
            ws_root = get_workspace_root()
        except NameError:
            ws_root = WORKSPACE_DIR
        if ws_root.exists():
            items = await asyncio.to_thread(_scan_workspace_files, ws_root, cap)
        else:
            items = []
        return {"items": items}
    except Exception as e:
        logger.exception("列出工作区文件失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


@app.post("/workspace/upload")
async def upload_to_workspace(
    file: UploadFile = File(...),
    workspace_path: Optional[str] = Form(default=None),
    workspace_id: Optional[str] = Form(default=None),
    thread_id: Optional[str] = Form(default=None),
    _: None = Depends(verify_internal_token),
):
    """上传文件到工作区 uploads/（与 /files/list 一致，可被列出）。若传 workspace_path 则写入该目录下 uploads/，否则用当前全局工作区。"""
    try:
        if workspace_path and (wp := (workspace_path or "").strip()):
            try:
                resolved_wp = Path(wp).resolve()
                if resolved_wp.is_dir():
                    set_workspace_root(resolved_wp)
            except Exception as e:
                logger.debug("workspace/upload workspace_path 无效，使用当前工作区: %s", e)
        upload_dir = get_workspace_root() / "uploads"
        upload_dir.mkdir(parents=True, exist_ok=True)
        safe_name = _safe_upload_filename(file.filename or "upload")
        suffix = Path(safe_name).suffix.lower()
        if suffix not in UPLOAD_ALLOWED_EXTENSIONS:
            raise HTTPException(
                status_code=400,
                detail="不允许上传该类型文件，仅支持白名单扩展名",
            )
        file_path = (upload_dir / safe_name).resolve()
        try:
            file_path.relative_to(upload_dir)
        except ValueError:
            raise HTTPException(status_code=400, detail="path not allowed")
        await file.seek(0)
        try:
            size = await asyncio.to_thread(
                _sync_copy_upload_stream,
                file.file,
                file_path,
                MAX_UPLOAD_BYTES,
            )
        except ValueError as exc:
            if str(exc) == "upload_too_large":
                try:
                    if file_path.exists():
                        file_path.unlink()
                except Exception as e:
                    logger.debug("workspace upload rollback unlink: %s", e)
            raise HTTPException(
                status_code=413,
                detail=f"文件大小超过 {MAX_UPLOAD_BYTES // (1024*1024)}MB 限制",
            ) from exc
            raise
        if not _validate_upload_magic(file_path, suffix):
            try:
                if file_path.exists():
                    file_path.unlink()
            except Exception as e:
                logger.debug("workspace upload invalid magic unlink: %s", e)
            raise HTTPException(status_code=400, detail="文件内容与扩展名不符")
        kb_ingested_path = await asyncio.to_thread(
            _sync_mirror_workspace_upload_to_kb,
            file_path,
            safe_name,
            workspace_id,
            thread_id,
        )
        now_iso = datetime.now(timezone.utc).isoformat()
        await asyncio.to_thread(
            _sync_append_workspace_upload_manifest,
            {
                "ts": now_iso,
                "workspace_id": str(workspace_id or "").strip() or None,
                "thread_id": str(thread_id or "").strip() or None,
                "workspace_path": str(file_path.absolute()),
                "kb_path": str(kb_ingested_path) if kb_ingested_path else None,
                "size": size,
                "auto_ingested": kb_ingested_path is not None,
                "auto_index_scheduled": kb_ingested_path is not None,
            },
        )
        if kb_ingested_path is not None:
            _schedule_workspace_incremental_index(kb_ingested_path)
        return {
            "filename": file.filename or safe_name,
            "path": str(file_path.absolute()),
            "size": size,
            "kb_path": str(kb_ingested_path) if kb_ingested_path else None,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error("❌ 工作区上传失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


# ============================================================
# 模型管理 API（Claude/Cursor 风格）
# ============================================================
# 
# 业务逻辑：
# - 模型列表包含配置、云端端点动态发现、本地端点自动发现；available 由探测或发现结果决定
# - 后端维护当前使用的模型状态；前端按 available 灰显/禁用不可用项
# - 支持 "auto" 选项，自动使用默认模型
# ============================================================

_models_list_cache: dict = {}
_models_list_cache_ts: float = 0
_MODELS_LIST_CACHE_TTL: float = 5.0

@app.get("/models/list")
async def list_models():
    """
    获取可用模型列表（Claude/Cursor 风格）
    
    列表包含：配置模型 + 云端端点动态发现 + 本地端点自动发现。
    返回字段包括：id, name, description, enabled, available, is_default, is_current 等。
    available 由后端探测或发现结果决定，前端应按 available 灰显/禁用不可用项。
    包含 "auto" 选项，自动使用默认模型。
    """
    import time as _time
    global _models_list_cache, _models_list_cache_ts
    now = _time.monotonic()
    if _models_list_cache and (now - _models_list_cache_ts) < _MODELS_LIST_CACHE_TTL:
        try:
            from backend.engine.agent.model_manager import get_model_manager
            manager = get_model_manager()
            cached_models = (_models_list_cache.get("models") or []) if isinstance(_models_list_cache, dict) else []
            has_cloud_in_cache = any(
                str(m.get("tier") or "").strip().lower().startswith("cloud")
                for m in cached_models if isinstance(m, dict)
            )
            if not has_cloud_in_cache and manager.has_discovered_cloud_models():
                _models_list_cache = {}
                _models_list_cache_ts = 0
            elif _models_list_cache:
                return _models_list_cache
        except Exception as e:
            logger.debug("models list cache check: %s", e)
        if _models_list_cache and (now - _models_list_cache_ts) < _MODELS_LIST_CACHE_TTL:
            return _models_list_cache
    try:
        from backend.engine.agent.model_manager import get_model_manager

        manager = get_model_manager()

        # 未命中缓存时先拉取云端发现列表（保证返回真实清单），再刷新本地/配置可用性
        if getattr(manager._config, "cloud_endpoints", None):
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(None, manager.refresh_cloud_models)
        await manager.refresh_availability_async(force=True)

        models = manager.get_models_list(include_auto=True)
        current_model = manager.get_current_model()
        
        result = {
            "ok": True,
            "models": models,
            "current_model": current_model,
            "default_model": manager._config.default_model,
            "capability_models": manager.get_capability_models_status(),
            "subagent_model": getattr(manager._config, "subagent_model", "same_as_main"),
            "subagent_model_mapping": getattr(manager._config, "subagent_model_mapping", {}) or {},
        }
        _models_list_cache = result
        _models_list_cache_ts = now
        # 若所有非 auto 模型均不可用，不缓存以便下次请求重新探测
        non_auto = [x for x in models if isinstance(x, dict) and x.get("id") != "auto"]
        if non_auto and all(not x.get("available", False) for x in non_auto):
            _models_list_cache = {}
            _models_list_cache_ts = 0
        return result
        
    except Exception as e:
        logger.error(f"❌ 获取模型列表失败: {e}")
        return {
            "ok": False,
            "error": _safe_error_detail(e),
            "models": [],
        }


@app.get("/models/status")
async def get_models_status():
    """
    获取模型状态（用于前端轮询或 WebSocket 推送）
    
    返回当前模型状态，前端可以定期调用此接口同步状态。
    """
    try:
        from backend.engine.agent.model_manager import get_model_manager
        
        manager = get_model_manager()
        
        return {
            "ok": True,
            "current_model": manager.get_current_model(),
            "status": manager.get_status(),
        }
        
    except Exception as e:
        logger.error(f"❌ 获取模型状态失败: {e}")
        return {
            "ok": False,
            "error": _safe_error_detail(e),
        }


@app.get("/models/diagnostics")
async def get_models_diagnostics():
    """
    模型连接诊断：列出所有聊天模型及其探测结果，便于排查「无可用模型」。
    对每个模型的第一个候选 URL 请求 GET {url}/models，返回 status_code 或异常信息。
    """
    try:
        from backend.engine.agent.model_manager import get_model_manager, _probe_headers_for_model
        manager = get_model_manager()
        items = []
        for m in manager._config.models:
            if not manager._is_chat_model(m):
                continue
            urls = manager._iter_model_candidate_urls(m)
            probe_url = (urls[0] + "/models") if urls else None
            probe_status_code = None
            probe_error = None
            if probe_url:
                try:
                    headers = _probe_headers_for_model(m)
                    async with httpx.AsyncClient(timeout=5.0) as client:
                        resp = await client.get(probe_url, headers=headers)
                        probe_status_code = resp.status_code
                except Exception as e:
                    probe_error = str(e)
            last_check = getattr(m, "last_check", None)
            api_key_env = (getattr(m, "api_key_env", None) or "").strip()
            has_api_key = bool(api_key_env and (os.getenv(api_key_env) or "").strip())
            items.append({
                "id": m.id,
                "name": getattr(m, "display_name", None) or m.name,
                "tier": str(getattr(m, "tier", "local") or "local"),
                "enabled": bool(m.enabled),
                "configured_url": str(m.url or "").strip() or None,
                "available": bool(getattr(m, "available", False)),
                "last_check": last_check.isoformat() if last_check else None,
                "probe_url": probe_url,
                "probe_status_code": probe_status_code,
                "probe_error": probe_error,
                "has_api_key": has_api_key,
                "api_key_env": api_key_env or None,
            })
        available_count = sum(1 for x in items if x["available"])
        return {
            "ok": True,
            "models": items,
            "summary": {"total": len(items), "available_count": available_count},
        }
    except Exception as e:
        logger.exception("模型诊断失败: %s", e)
        return {
            "ok": False,
            "error": _safe_error_detail(e),
            "models": [],
            "summary": {"total": 0, "available_count": 0},
        }


@app.post("/models/refresh")
async def refresh_models_availability():
    """
    强制刷新模型可用状态
    
    前端可以调用此接口主动刷新模型状态。
    与 GET /models/list 一致：先拉取云端发现列表再刷新可用性，保证「发现优先于探测」生效。
    """
    global _models_list_cache, _models_list_cache_ts
    _models_list_cache = {}
    _models_list_cache_ts = 0
    try:
        from backend.engine.agent.model_manager import get_model_manager

        manager = get_model_manager()
        _ce = getattr(manager._config, "cloud_endpoints", None) or []
        _has_ce = bool(_ce)
        # 与 list 一致：先拉取云端发现，再刷新可用性，避免 refresh 时 discovered_ids 为空导致全部显示不可用
        if _has_ce:
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(None, manager.refresh_cloud_models)
        await manager.refresh_availability_async(force=True)

        models = manager.get_models_list(include_auto=True)
        
        return {
            "ok": True,
            "models": models,
            "message": "模型状态已刷新",
            "capability_models": manager.get_capability_models_status(),
        }
        
    except Exception as e:
        logger.error(f"❌ 刷新模型状态失败: {e}")
        return {
            "ok": False,
            "error": _safe_error_detail(e),
        }


@app.post("/models/refresh-cloud")
async def refresh_cloud_models(_: None = Depends(verify_internal_token)):
    """从配置的 cloud_endpoints 重新拉取 GET /v1/models，动态发现云端模型并加入可用列表。"""
    global _models_list_cache, _models_list_cache_ts
    _models_list_cache = {}
    _models_list_cache_ts = 0
    try:
        from backend.engine.agent.model_manager import get_model_manager
        manager = get_model_manager()
        discovered = manager.refresh_cloud_models()
        return {"ok": True, "discovered": discovered}
    except Exception as e:
        logger.exception("刷新云端模型失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


@app.get("/models/cloud-endpoints")
async def get_cloud_endpoints(_: None = Depends(verify_internal_token)):
    """获取当前配置的云端端点列表及每个端点下的发现模型 id，供配置页按端点展示。"""
    try:
        from backend.engine.agent.model_manager import get_model_manager
        manager = get_model_manager()
        endpoints = getattr(manager._config, "cloud_endpoints", None) or []
        endpoints_with_models = manager.get_cloud_endpoints_with_models()
        return {"ok": True, "cloud_endpoints": endpoints, "endpoints_with_models": endpoints_with_models}
    except Exception as e:
        logger.exception("获取 cloud_endpoints 失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


@app.put("/models/cloud-endpoints")
async def update_cloud_endpoints(body: dict, _: None = Depends(verify_internal_token)):
    """更新云端端点列表并刷新发现。body: {"cloud_endpoints": [{"base_url": "...", "api_key_env": "..."}]}"""
    endpoints = body.get("cloud_endpoints")
    if not isinstance(endpoints, list):
        raise HTTPException(status_code=400, detail="cloud_endpoints 必须为数组")
    try:
        from backend.engine.agent.model_manager import get_model_manager
        manager = get_model_manager()
        discovered = manager.update_cloud_endpoints(endpoints)
        global _models_list_cache, _models_list_cache_ts
        _models_list_cache = {}
        _models_list_cache_ts = 0
        return {"ok": True, "discovered": discovered}
    except Exception as e:
        logger.exception("更新 cloud_endpoints 失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


@app.post("/models/switch")
async def switch_model(request: dict, _: None = Depends(verify_internal_token)):
    """
    切换当前使用的模型
    
    Args:
        request: {"model_id": "bytedance/seed-oss-36b"} 或 {"model_id": "auto"}
    
    支持：
    - "auto": 使用默认模型
    - 具体模型 ID: 切换到指定模型
    
    注意：
    - 切换模型不会影响记忆文件（AGENTS.md, lessons.md）
    - 前端应在切换后更新 localStorage 中的模型选择
    """
    global _models_list_cache, _models_list_cache_ts
    _models_list_cache = {}
    _models_list_cache_ts = 0
    try:
        model_id = request.get("model_id")
        if not model_id:
            raise HTTPException(status_code=400, detail="model_id is required")
        
        from backend.engine.agent.model_manager import get_model_manager
        
        manager = get_model_manager()
        success = manager.set_current_model(model_id, skip_license_for_switch=True)
        
        if not success:
            raise HTTPException(status_code=400, detail=f"无法切换到模型: {model_id}")
        
        # 获取模型信息
        model_info = manager.get_model_info(model_id) if model_id != "auto" else None
        
        logger.info(f"✅ 模型已切换到: {model_id}")
        
        return {
            "ok": True,
            "model_id": model_id,
            "current_model": manager.get_current_model(),
            "message": f"已切换到模型: {model_id}",
            "config": model_info.config if model_info else None,
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"❌ 模型切换失败: {e}")
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


@app.put("/models/default")
async def set_default_model(request: dict, _: None = Depends(verify_internal_token)):
    """
    设置默认模型并持久化到 models.json。
    请求体: {"default_model": "model_id"}
    用于设置页「默认大模型」与后端配置同步，重启后仍生效。
    """
    global _models_list_cache, _models_list_cache_ts
    _models_list_cache = {}
    _models_list_cache_ts = 0
    try:
        raw = request.get("default_model")
        if raw is None or raw == "":
            raise HTTPException(status_code=400, detail="default_model is required")
        model_id = str(raw).strip()
        if not model_id or model_id == "auto":
            raise HTTPException(status_code=400, detail="default_model cannot be 'auto', use a concrete model id")
        from backend.engine.agent.model_manager import get_model_manager
        manager = get_model_manager()
        if not manager.set_default_model(model_id):
            raise HTTPException(status_code=400, detail=f"无法设置默认模型: {model_id}（模型不存在或不可用）")
        return {"ok": True, "default_model": model_id}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("设置默认模型失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


@app.get("/models/configs")
async def get_model_configs():
    """
    获取所有模型的优化配置
    
    返回每个模型的性能优化参数，包括：
    - temperature: 温度参数
    - top_p/top_k: 采样参数
    - max_tokens: 不同任务类型的窗口大小
    """
    try:
        from backend.engine.agent.deep_agent import Config
        from backend.engine.agent.model_manager import get_model_manager
        
        manager = get_model_manager()
        models = manager.get_models_list(include_auto=False)
        
        # 构建配置信息
        configs = {}
        for model in models:
            model_info = manager.get_model_info(model["id"])
            if model_info:
                configs[model["id"]] = model_info.config
        
        return {
            "ok": True,
            "configs": configs,
            "efficiency_tips": Config.EFFICIENCY_TIPS,
            "performance_modes": ["FAST", "BALANCED", "QUALITY", "DOC"],
            "current_mode": Config.PERFORMANCE_MODE,
        }
    except Exception as e:
        logger.error(f"❌ 获取模型配置失败: {e}")
        return {
            "ok": False,
            "error": _safe_error_detail(e),
        }


class CloudProxyChatBody(BaseModel):
    model: str
    messages: List[Dict[str, Any]]
    temperature: Optional[float] = 0.3
    max_tokens: Optional[int] = 4096
    stream: Optional[bool] = False
    provider: Optional[str] = "openai"
    base_url: Optional[str] = None


@app.post("/cloud/proxy/chat")
async def cloud_proxy_chat(body: CloudProxyChatBody):
    """
    云端代理路由（商业化扩展入口）：
    - 默认转发到 CLOUD_PROXY_BASE_URL
    - 兼容 OpenAI Chat Completions 协议
    """
    proxy_base = (body.base_url or os.getenv("CLOUD_PROXY_BASE_URL", "")).strip()
    if not proxy_base:
        raise HTTPException(status_code=400, detail="未配置 CLOUD_PROXY_BASE_URL")
    to_parse = proxy_base if proxy_base.startswith(("http://", "https://")) else "https://" + proxy_base
    parsed = urlparse(to_parse)
    if parsed.scheme != "https":
        raise HTTPException(status_code=400, detail="base_url 仅允许 https")
    if _is_private_or_local_host(parsed.hostname or ""):
        raise HTTPException(status_code=400, detail="不允许访问内网/本地地址")
    allowed_hosts = [h.strip().lower() for h in os.getenv("CLOUD_PROXY_ALLOWED_HOSTS", "").strip().split(",") if h.strip()]
    if body.base_url and body.base_url.strip():
        if not allowed_hosts:
            raise HTTPException(status_code=403, detail="请求体指定 base_url 时需配置 CLOUD_PROXY_ALLOWED_HOSTS 白名单")
        if (parsed.hostname or "").strip().lower() not in allowed_hosts:
            raise HTTPException(status_code=403, detail="base_url 不在允许的代理域名列表内")
    api_key = (
        os.getenv("CLOUD_PROXY_API_KEY", "").strip()
        or os.getenv("OPENROUTER_API_KEY", "").strip()
        or os.getenv("OPENAI_API_KEY", "").strip()
    )
    if not api_key:
        raise HTTPException(status_code=400, detail="未配置云端代理 API Key（CLOUD_PROXY_API_KEY）")
    endpoint = proxy_base.rstrip("/") + "/chat/completions"
    payload = {
        "model": body.model,
        "messages": body.messages,
        "temperature": body.temperature,
        "max_tokens": body.max_tokens,
        "stream": bool(body.stream),
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(endpoint, headers=headers, json=payload)
        if resp.status_code >= 400:
            detail = resp.text[:2000]
            raise HTTPException(status_code=resp.status_code, detail=detail or "云端代理请求失败")
        data = resp.json()
        return {"ok": True, "provider": body.provider, "data": data}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("cloud/proxy/chat 失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


# ============================================================
# 模式说明 API（供前端展示「何时选用 / 获得什么」）
# ============================================================

@app.get("/modes/descriptions")
async def get_modes_descriptions():
    """返回模式的面向用户说明（何时选用、获得什么价值），供前端模式选择器展示。"""
    try:
        from backend.engine.modes import get_mode_user_description
        modes = ["agent", "ask", "plan", "debug", "review"]
        result = {}
        for m in modes:
            result[m] = get_mode_user_description(m)
        return {"ok": True, "modes": result}
    except Exception as e:
        logger.exception("获取模式说明失败: %s", e)
        return {"ok": False, "error": _safe_error_detail(e), "modes": {}}


# ============================================================
# Skills 管理 API（Claude Agent Skills 风格）
# ============================================================
# 
# 提供：已加载 Skills 列表、Skill Profile、热重载、校验
# 前端可通过 config.configurable.skill_profile 指定场景（office/report/research/analyst/bidding/contract/full）
# ============================================================

def _skill_to_item(s):
    """SkillInfo -> dict，含 path 供前端打开/编辑，kb_relative_path 供知识库删除。"""
    d = s.to_dict()
    full_path = getattr(s, "path", "") or (str(Path(s.skill_dir) / "SKILL.md") if getattr(s, "skill_dir", None) else "")
    d["path"] = full_path
    rel = getattr(s, "relative_path", "") or ""
    d["kb_relative_path"] = rel.replace("knowledge_base/", "", 1) if rel.startswith("knowledge_base/") else rel
    return d


def _annotate_skill_sources(items: list[dict]) -> list[dict]:
    """根据已安装版本记录为 Skill 标注来源（local/remote）。"""
    try:
        installed = _load_installed_versions()
        if not isinstance(installed, dict):
            installed = {}
    except Exception as e:
        logger.debug("_load_installed_versions: %s", e)
        installed = {}
    enriched: list[dict] = []
    for raw in items:
        item = dict(raw) if isinstance(raw, dict) else {}
        domain = str(item.get("domain", "general") or "general").strip() or "general"
        name = str(item.get("name", "") or "").strip()
        key = f"{domain}/{name}" if name else ""
        record = installed.get(key) if key else None
        if isinstance(record, dict):
            market_id = str(record.get("market_id", "") or "").strip()
            installed_version = str(record.get("version", "") or "").strip()
            item["market_id"] = market_id or None
            item["installed_version"] = installed_version or None
            item["source_type"] = "remote" if (market_id or installed_version) else "local"
        else:
            item["market_id"] = None
            item["installed_version"] = None
            item["source_type"] = "local"
        enriched.append(item)
    return enriched


def _detect_skill_tier(item: dict, default_tier: str = "core") -> str:
    """根据路径/元数据推断技能层级。"""
    rel = str(item.get("kb_relative_path") or item.get("relative_path") or "").lower()
    full = str(item.get("path") or "").lower()
    level = str(item.get("level") or "").strip().lower()
    for tier in ("core", "pro", "enterprise", "community"):
        token = f"/skills/{tier}/"
        if token in rel or token in full:
            return tier
    if level in {"core", "pro", "enterprise", "community"}:
        return level
    return default_tier


def _quality_gate_specs_for_tier(tier: str) -> list[dict]:
    """返回分层质量门规则（提示级，不阻塞业务）。"""
    mapping: dict[str, list[dict]] = {
        "core": [
            {"id": "actionable_conclusion", "label": "可执行结论", "keywords": ["结论", "建议", "动作"]},
            {"id": "evidence_reference", "label": "证据引用", "keywords": ["依据", "来源", "引用", "文件"]},
            {"id": "uncertainty_marking", "label": "待确认项", "keywords": ["待确认", "不确定", "假设"]},
        ],
        "pro": [
            {"id": "risk_rollback", "label": "风险与回滚", "keywords": ["风险", "回滚"]},
            {"id": "acceptance_criteria", "label": "验收标准", "keywords": ["验收", "标准"]},
            {"id": "next_actions", "label": "下一步动作", "keywords": ["下一步", "行动", "分派"]},
        ],
        "enterprise": [
            {"id": "compliance_boundary", "label": "合规边界", "keywords": ["合规", "脱敏", "审计", "分级"]},
            {"id": "sla_targets", "label": "SLA 指标", "keywords": ["sla", "时延", "可用性"]},
            {"id": "rollout_plan", "label": "灰度回滚", "keywords": ["灰度", "回滚", "上线"]},
        ],
        "community": [
            {"id": "usage_prerequisites", "label": "使用前提", "keywords": ["前提", "依赖", "权限"]},
            {"id": "reproducible_example", "label": "可复现实例", "keywords": ["示例", "输入", "输出", "步骤"]},
            {"id": "maintenance_meta", "label": "维护信息", "keywords": ["作者", "版本", "更新"]},
        ],
    }
    return mapping.get(tier, mapping["core"])


def _annotate_skill_quality(items: list[dict], default_tier: str = "core") -> list[dict]:
    """为技能项附加质量门检查信息（提示级）。"""
    enriched: list[dict] = []
    for raw in items:
        item = dict(raw) if isinstance(raw, dict) else {}
        tier = _detect_skill_tier(item, default_tier=default_tier)
        specs = _quality_gate_specs_for_tier(tier)
        text = " ".join(
            [
                str(item.get("description") or ""),
                str(item.get("capabilities_summary") or ""),
            ]
        ).lower()
        missing: list[str] = []
        for spec in specs:
            kws = [str(k).lower() for k in (spec.get("keywords") or [])]
            if kws and not any(kw in text for kw in kws):
                missing.append(str(spec.get("label") or spec.get("id") or ""))
        item["quality_gate_tier"] = tier
        item["quality_gate_required"] = [str(s.get("label") or s.get("id") or "") for s in specs]
        item["quality_gate_missing"] = [m for m in missing if m]
        item["quality_gate_passed"] = len(item["quality_gate_missing"]) == 0
        item["quality_gate_hint"] = (
            "建议补齐质量门字段后再发布/上架。"
            if not item["quality_gate_passed"]
            else "质量门检查通过（提示级）。"
        )
        enriched.append(item)
    return enriched


@app.get("/skills/list")
async def skills_list(
    domain: Optional[str] = None,
    source: Optional[str] = None,
    limit: Optional[int] = 100,
    offset: Optional[int] = 0,
):
    """
    返回所有已加载 Skills 的列表（与 Claude API List 对齐：支持 source 过滤、limit/offset 分页）。
    
    与 SkillRegistry 一致，扫描 knowledge_base/skills/ 下所有 SKILL.md。
    """
    try:
        from backend.engine.skills.skill_registry import get_skill_registry

        registry = get_skill_registry()
        registry.discover_skills()
        runtime_index = registry.build_runtime_index(profile=None, mode="agent")
        items = runtime_index.get("skills", []) if isinstance(runtime_index, dict) else []
        if domain:
            items = [row for row in items if str((row or {}).get("domain") or "") == str(domain)]
        if source:
            src = str(source).strip().lower()
            if src in ("custom", "anthropic", "learned"):
                items = [row for row in items if str((row or {}).get("source") or "").strip().lower() == src]
        items = _annotate_skill_sources([dict(row) for row in items if isinstance(row, dict)])
        items = _annotate_skill_quality(items, default_tier="core")
        total = len(items)
        limit_val = min(max(1, int(limit) if limit is not None else 100), 100)
        offset_val = max(0, int(offset) if offset is not None else 0)
        items = items[offset_val : offset_val + limit_val]
        return {"ok": True, "skills": items, "total": total, "limit": limit_val, "offset": offset_val}
    except Exception as e:
        logger.error(f"❌ 获取 Skills 列表失败: {e}")
        return {"ok": False, "error": _safe_error_detail(e), "skills": []}


@app.get("/skills/by-profile")
async def skills_by_profile(profile_id: str):
    """
    返回指定 profile 下的 Skills 列表（该 profile 的 paths 所覆盖的 SKILL.md）。
    
    供前端「技能管理」按当前领域展示、编辑。
    """
    try:
        from backend.engine.skills.skill_registry import get_skill_registry

        registry = get_skill_registry()
        registry.discover_skills()
        tier_profile = _load_license_profile()
        runtime_index = registry.build_runtime_index(profile=profile_id, mode="agent", tier_profile=tier_profile)
        raw_items = runtime_index.get("skills", []) if isinstance(runtime_index, dict) else []
        items = _annotate_skill_sources(
            [dict(row) for row in raw_items if isinstance(row, dict) and bool(row.get("runtime_enabled"))]
        )
        items = _annotate_skill_quality(items, default_tier="core")
        return {"ok": True, "skills": items, "total": len(items), "profile_id": profile_id}
    except Exception as e:
        logger.error(f"❌ 按 Profile 获取 Skills 失败: {e}")
        return {"ok": False, "error": _safe_error_detail(e), "skills": [], "total": 0}


@app.get("/skills/runtime-index")
async def skills_runtime_index(profile_id: Optional[str] = None, mode: str = "agent"):
    """统一返回技能管理面与运行面索引。"""
    try:
        from backend.engine.skills.skill_registry import get_skill_registry

        registry = get_skill_registry()
        registry.discover_skills()
        data = registry.build_runtime_index(profile=profile_id, mode=mode)
        items = _annotate_skill_sources(
            [dict(row) for row in (data.get("skills", []) if isinstance(data, dict) else []) if isinstance(row, dict)]
        )
        items = _annotate_skill_quality(items, default_tier="core")
        return {
            "ok": True,
            "profile_id": profile_id or "",
            "mode": mode,
            "runtime_paths": data.get("runtime_paths", []) if isinstance(data, dict) else [],
            "management_total": int(data.get("management_total", len(items)) if isinstance(data, dict) else len(items)),
            "runtime_total": int(
                data.get("runtime_total", len([x for x in items if bool(x.get("runtime_enabled"))]))
                if isinstance(data, dict)
                else len([x for x in items if bool(x.get("runtime_enabled"))])
            ),
            "skills": items,
        }
    except Exception as e:
        logger.error(f"❌ 获取 Skills 运行索引失败: {e}")
        return {"ok": False, "error": _safe_error_detail(e), "skills": [], "management_total": 0, "runtime_total": 0}


@app.get("/skills/profiles")
async def skills_profiles():
    """返回所有可用业务场景（Profile）及能力组合说明（id, label, description, capabilities_summary）。"""
    try:
        from backend.engine.skills.skill_profiles import get_profile_list

        profiles = get_profile_list()
        return {"ok": True, "profiles": profiles}
    except Exception as e:
        logger.error(f"❌ 获取 Skill Profiles 失败: {e}")
        return {"ok": False, "error": _safe_error_detail(e), "profiles": []}


@app.get("/skills/market")
async def skills_market(domain: Optional[str] = None):
    """
    浏览云端 Skills 市场（按领域）。当前为 stub：返回空或配置的静态列表；
    后续接入真实云端仓库后返回 market_id、version、name、description 等。
    注：此路由必须注册在 /skills/{skill_id} 之前，否则 "market" 会被当作 skill_id 匹配导致 404。
    """
    try:
        data, default_source_type = await _load_skills_market_payload()
        raw_items = data.get("skills", []) if isinstance(data, dict) else []
        items = []
        for item in raw_items:
            if not isinstance(item, dict):
                continue
            merged = dict(item)
            merged["source_type"] = str(merged.get("source_type", default_source_type) or default_source_type)
            requires_tier = str(merged.get("requires_tier", "") or "").strip().lower()
            merged["quality_gate_tier"] = "community" if not requires_tier else (
                "enterprise" if requires_tier in {"business", "enterprise"} else "pro"
            )
            items.append(merged)
        items = _annotate_skill_quality(items, default_tier="community")
        if domain:
            items = [s for s in items if (s.get("domain") or "").strip() == domain.strip()]
        return {"ok": True, "skills": items, "total": len(items), "source_type": default_source_type}
    except Exception as e:
        logger.warning("skills/market: %s", e)
        return {"ok": True, "skills": [], "total": 0}


@app.get("/skills/{skill_id}")
async def skills_get_by_id(skill_id: str):
    """
    按 id 返回单条 Skill（与 Claude API Retrieve 对齐）。
    skill_id 支持 name（如 bidding）或 domain/name（如 domain/bidding），与 to_dict 的 id 一致。
    """
    try:
        from backend.engine.skills.skill_registry import get_skill_registry

        registry = get_skill_registry()
        registry.discover_skills()
        runtime_index = registry.build_runtime_index(profile=None, mode="agent")
        all_items = runtime_index.get("skills", []) if isinstance(runtime_index, dict) else []
        all_items = _annotate_skill_sources([dict(row) for row in all_items if isinstance(row, dict)])
        all_items = _annotate_skill_quality(all_items, default_tier="core")
        sid = (skill_id or "").strip()
        if not sid:
            raise HTTPException(status_code=404, detail="skill_id required")
        found = None
        for item in all_items:
            if (item.get("id") or "").strip() == sid or (item.get("name") or "").strip() == sid:
                found = item
                break
        if not found:
            raise HTTPException(status_code=404, detail=f"Skill not found: {skill_id}")
        return {"ok": True, "skill": found}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"❌ 获取 Skill 详情失败: {e}")
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


@app.post("/skills/reload")
async def skills_reload(_: None = Depends(verify_internal_token)):
    """
    触发 SkillRegistry 重新扫描 Skills 目录，并清除 Agent 缓存，实现 Skills 热重载。
    """
    try:
        from backend.engine.skills.skill_registry import get_skill_registry
        from backend.engine.skills.skill_profiles import load_profiles
        from backend.engine.agent.deep_agent import clear_agent_cache
        
        registry = get_skill_registry()
        registry.discover_skills(force_reload=True)
        load_profiles(force_reload=True)
        clear_agent_cache()
        
        count = len(registry.get_all_skills())
        logger.info(f"✅ Skills 已重载，共 {count} 个")
        return {"ok": True, "message": "Skills 已重载", "skills_count": count}
    except Exception as e:
        logger.error(f"❌ Skills 重载失败: {e}")
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))

# Agent 能力档案与任务评估
# ============================================================


@app.get("/agent/profile")
async def agent_get_profile(_: None = Depends(verify_internal_token)):
    """获取 Agent 能力档案（agent_profile.json）。"""
    try:
        from backend.engine.skills.skill_profiles import load_agent_profile
        profile = load_agent_profile()
        return {"ok": True, "profile": profile}
    except Exception as e:
        logger.exception("获取 Agent 档案失败: %s", e)
        return {"ok": False, "error": _safe_error_detail(e), "profile": None}


class AgentProfileUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    capabilities: Optional[dict] = None
    resources: Optional[dict] = None
    pricing: Optional[dict] = None
    network: Optional[dict] = None


@app.patch("/agent/profile")
async def agent_update_profile(body: AgentProfileUpdate, _: None = Depends(verify_internal_token)):
    """更新 Agent 能力档案（人设定能力）。"""
    try:
        from backend.engine.skills.skill_profiles import load_agent_profile, save_agent_profile
        profile = load_agent_profile()
        if body.name is not None:
            profile["name"] = body.name
        if body.description is not None:
            profile["description"] = body.description
        if body.capabilities is not None:
            profile["capabilities"] = {**profile.get("capabilities", {}), **body.capabilities}
        if body.resources is not None:
            profile["resources"] = {**profile.get("resources", {}), **body.resources}
        if body.pricing is not None:
            profile["pricing"] = {**profile.get("pricing", {}), **body.pricing}
        if body.network is not None:
            profile["network"] = {**profile.get("network", {}), **body.network}
        save_agent_profile(profile)
        return {"ok": True, "profile": profile}
    except Exception as e:
        logger.exception("更新 Agent 档案失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


@app.get("/agent/user-model")
async def get_agent_user_model(workspace_id: Optional[str] = None, _: None = Depends(verify_internal_token)):
    """获取用户画像（专长领域、沟通风格、决策模式等）。"""
    try:
        from backend.engine.core.main_graph import get_sqlite_store
        from backend.memory.user_model import get_user_profile
        store = get_sqlite_store()
        profile = get_user_profile(store, workspace_id or "default")
        return {"ok": True, "profile": profile.to_dict()}
    except Exception as e:
        logger.exception("获取用户画像失败: %s", e)
        return {"ok": False, "profile": None, "error": _safe_error_detail(e)}


@app.put("/agent/user-model")
async def update_agent_user_model(body: dict = Body(...), workspace_id: Optional[str] = None, _: None = Depends(verify_internal_token)):
    """部分更新用户画像。"""
    try:
        from backend.engine.core.main_graph import get_sqlite_store
        from backend.memory.user_model import update_user_profile
        store = get_sqlite_store()
        updated = update_user_profile(store, workspace_id or "default", body)
        if updated is None:
            return {"ok": False, "profile": None, "error": "保存失败"}
        return {"ok": True, "profile": updated.to_dict()}
    except Exception as e:
        logger.exception("更新用户画像失败: %s", e)
        return {"ok": False, "profile": None, "error": _safe_error_detail(e)}


@app.get("/agent/crystallization-suggestion")
async def get_agent_crystallization_suggestion(
    thread_id: Optional[str] = None,
    workspace_id: Optional[str] = None,
    _: None = Depends(verify_internal_token),
):
    """获取并消费结晶建议（thread）与工作区建议（idle 检测到变更时写入）。统一由前端 CrystallizationToast 展示。"""
    try:
        from backend.engine.idle.idle_loop import get_and_clear_copilot_suggestion
        from backend.engine.middleware.distillation_middleware import get_crystallization_suggestion
        suggestion = None
        if (thread_id or "").strip():
            suggestion = get_crystallization_suggestion((thread_id or "").strip())
        workspace_suggestion = None
        ws = (workspace_id or "").strip() or "default"
        workspace_suggestion = get_and_clear_copilot_suggestion(ws)
        return {"ok": True, "suggestion": suggestion, "workspace_suggestion": workspace_suggestion}
    except Exception as e:
        logger.exception("get_crystallization_suggestion: %s", e)
        raise HTTPException(status_code=500, detail="Internal error")


class PersonaUpdateBody(BaseModel):
    name: Optional[str] = None
    tone: Optional[str] = None
    relationship: Optional[str] = None
    language: Optional[str] = None
    communication_style: Optional[str] = None
    empathy: Optional[str] = None
    preference_focus: Optional[str] = None


class ConfigReadBody(BaseModel):
    key: str


class ConfigWriteBody(BaseModel):
    key: str
    content: str


_config_loader_instance = None


def _get_config_loader():
    global _config_loader_instance
    if _config_loader_instance is not None:
        return _config_loader_instance
    from backend.tools.base.paths import get_project_root, get_workspace_root
    from backend.tools.base.config_loader import ConfigLoader

    app_root = get_project_root()
    workspace_root = get_workspace_root()
    _config_loader_instance = ConfigLoader(app_root=app_root, project_root=app_root, workspace_root=workspace_root)
    return _config_loader_instance


_json_file_cache: Dict[str, tuple] = {}


def _load_json_file_cached(path: Path, fallback: Dict[str, Any]) -> Dict[str, Any]:
    key = str(path)
    try:
        if not path.exists():
            return fallback
        mtime = path.stat().st_mtime
    except OSError:
        return fallback
    cached = _json_file_cache.get(key)
    if cached and cached[1] == mtime:
        return cached[0]
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        result = raw if isinstance(raw, dict) else fallback
    except Exception as e:
        logger.debug("_load_json_file_cached failed for %s: %s", path, e)
        return fallback
    _json_file_cache[key] = (result, mtime)
    return result


def _invalidate_json_cache(path: Path) -> None:
    _json_file_cache.pop(str(path), None)


def _load_workspace_settings_dict() -> Dict[str, Any]:
    return _load_json_file_cached(get_workspace_root() / ".maibot" / "settings.json", {})


def _save_workspace_settings_dict(payload: Dict[str, Any]) -> None:
    settings_path = get_workspace_root() / ".maibot" / "settings.json"
    settings_path.parent.mkdir(parents=True, exist_ok=True)
    safe_payload = payload if isinstance(payload, dict) else {}
    settings_path.write_text(json.dumps(safe_payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    _invalidate_json_cache(settings_path)


def _load_watcher_runtime_config() -> Tuple[bool, str]:
    """
    读取任务巡检开关与角色：
    - 环境变量优先（兼容已有部署）
    - .maibot/settings.json.autonomous 次级
    """
    env_enabled = os.getenv("TASK_WATCHER_ENABLED")
    if env_enabled is not None:
        enabled = str(env_enabled).lower() == "true"
    else:
        settings = _load_workspace_settings_dict()
        autonomous = settings.get("autonomous", {}) if isinstance(settings, dict) else {}
        enabled = bool(autonomous.get("task_watcher_enabled", True)) if isinstance(autonomous, dict) else True

    role_id = os.getenv("TASK_WATCHER_ROLE_ID", "").strip()
    if not role_id:
        settings = _load_workspace_settings_dict()
        autonomous = settings.get("autonomous", {}) if isinstance(settings, dict) else {}
        if isinstance(autonomous, dict):
            role_id = str(autonomous.get("task_watcher_role_id", "") or "").strip()
    return enabled, role_id


def _resolve_default_watcher_role(preferred_role_id: str = "assistant") -> str:
    """为自治巡检选择默认角色，优先 assistant。"""
    try:
        from backend.engine.roles import list_roles
        roles = list_roles()
    except Exception as e:
        logger.debug("list_roles for watcher: %s", e)
        return ""
    if not roles:
        return ""
    preferred = str(preferred_role_id or "").strip()
    if preferred:
        for role in roles:
            rid = str(role.get("id", "") or "").strip()
            if rid == preferred:
                return rid
    return str(roles[0].get("id", "") or "").strip()


def _editable_config_map() -> Dict[str, Path]:
    loader = _get_config_loader()
    project = {
        "MAIBOT.md": loader.get_project_path("MAIBOT.md"),
        "SOUL.md": loader.get_project_path("SOUL.md"),
        "TOOLS.md": loader.get_project_path("TOOLS.md"),
        "AGENTS.md": loader.get_project_path("AGENTS.md"),
        "SESSION-STATE.md": loader.get_project_path("SESSION-STATE.md"),
        "WORKING-BUFFER.md": loader.get_project_path("WORKING-BUFFER.md"),
        "EVOLUTION-SCORES.md": loader.get_project_path("EVOLUTION-SCORES.md"),
        "persona.json": loader.get_project_path("persona.json"),
        "prompt_assembly.json": loader.get_project_path("prompt_assembly.json"),
        "prompt_calibration.json": loader.get_project_path("prompt_calibration.json"),
        "settings.json": loader.get_project_path("settings.json"),
    }
    return {k: v.resolve() for k, v in project.items()}


@app.get("/config/list")
async def list_configs():
    """列出可编辑配置文件（工作区 .maibot）。"""
    try:
        loader = _get_config_loader()
        config_map = _editable_config_map()
        files = []
        for key, path in sorted(config_map.items(), key=lambda x: x[0].lower()):
            exists = path.exists()
            files.append(
                {
                    "key": key,
                    "path": str(path),
                    "exists": exists,
                    "size": path.stat().st_size if exists and path.is_file() else 0,
                    "updated_at": datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).isoformat()
                    if exists and path.is_file()
                    else None,
                }
            )

        return {
            "ok": True,
            "workspace_root": str(loader.workspace_root),
            "maibot_dir": str(loader.get_project_path().resolve()),
            "files": files,
        }
    except Exception as e:
        logger.exception("读取配置列表失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


@app.post("/config/read")
async def read_config(body: ConfigReadBody, _: None = Depends(verify_internal_token)):
    """读取单个可编辑配置文件内容。"""
    try:
        config_map = _editable_config_map()
        key = (body.key or "").strip()
        path = config_map.get(key)
        if path is None:
            raise HTTPException(status_code=400, detail="无效配置 key")
        if not path.exists():
            return {"ok": True, "key": key, "path": str(path), "exists": False, "content": ""}
        content = await asyncio.to_thread(path.read_text, encoding="utf-8")
        return {"ok": True, "key": key, "path": str(path), "exists": True, "content": content}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("读取配置文件失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


@app.post("/config/write")
async def write_config(body: ConfigWriteBody, _: None = Depends(verify_internal_token)):
    """写入单个可编辑配置文件内容。"""
    try:
        config_map = _editable_config_map()
        key = (body.key or "").strip()
        path = config_map.get(key)
        if path is None:
            raise HTTPException(status_code=400, detail="无效配置 key")
        await asyncio.to_thread(path.parent.mkdir, parents=True, exist_ok=True)
        await asyncio.to_thread(path.write_text, body.content, encoding="utf-8")
        return {
            "ok": True,
            "key": key,
            "path": str(path),
            "size": path.stat().st_size,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("写入配置文件失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


@app.get("/persona")
async def get_persona(_: None = Depends(verify_internal_token)):
    """读取 .maibot/persona.json（若不存在则返回默认配置）。"""
    try:
        from backend.tools.base.paths import get_workspace_root
        ws = get_workspace_root()
        persona_path = ws / ".maibot" / "persona.json"
        default_persona = {
            "name": "MAIBOT",
            "tone": "professional",
            "relationship": "assistant",
            "language": "zh-CN",
            "communication_style": "concise",
            "empathy": "balanced",
            "preference_focus": "task_first",
        }
        if not persona_path.exists():
            return {"ok": True, "persona": default_persona}
        raw = await asyncio.to_thread(persona_path.read_text, encoding="utf-8")
        data = json.loads(raw)
        if not isinstance(data, dict):
            return {"ok": True, "persona": default_persona}
        return {"ok": True, "persona": {**default_persona, **data}}
    except Exception as e:
        logger.exception("读取 persona 失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


@app.patch("/persona")
async def update_persona(body: PersonaUpdateBody, _: None = Depends(verify_internal_token)):
    """更新 .maibot/persona.json，支持对话中动态切换助手身份。"""
    try:
        from backend.tools.base.paths import get_workspace_root
        ws = get_workspace_root()
        persona_path = ws / ".maibot" / "persona.json"
        await asyncio.to_thread(persona_path.parent.mkdir, parents=True, exist_ok=True)
        base = {
            "name": "MAIBOT",
            "tone": "professional",
            "relationship": "assistant",
            "language": "zh-CN",
            "communication_style": "concise",
            "empathy": "balanced",
            "preference_focus": "task_first",
        }
        if persona_path.exists():
            try:
                raw_existing = await asyncio.to_thread(persona_path.read_text, encoding="utf-8")
                existing = json.loads(raw_existing)
                if isinstance(existing, dict):
                    base.update(existing)
            except Exception as e:
                logger.debug("persona read existing for merge: %s", e)
        updates = {k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None}
        if not updates:
            raise HTTPException(status_code=400, detail="至少提供一个要更新的字段")
        base.update(updates)
        await asyncio.to_thread(
            persona_path.write_text,
            json.dumps(base, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        return {"ok": True, "persona": base}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("更新 persona 失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


class AssessTaskBody(BaseModel):
    task: dict


@app.post("/agent/assess-task")
async def agent_assess_task(body: AssessTaskBody):
    """评估任务与当前 Agent 能力的匹配度。"""
    try:
        from backend.engine.skills.skill_profiles import load_agent_profile
        from backend.engine.agent.self_assessment import SelfAssessment
        profile = load_agent_profile()
        assessor = SelfAssessment()
        result = assessor.assess(body.task, profile)
        return {
            "ok": True,
            "assessment": {
                "can_do": result.can_do,
                "skill_match": result.skill_match,
                "matched_skills": result.matched_skills,
                "estimated_cost": result.estimated_cost,
                "estimated_time_minutes": result.estimated_time_minutes,
                "capacity": result.capacity,
            },
        }
    except Exception as e:
        logger.exception("任务评估失败: %s", e)
        return {"ok": False, "error": _safe_error_detail(e), "assessment": None}


# ============================================================
# A2A 数字员工网络 - 节点注册与发现
# ============================================================

class NetworkNodeRegisterBody(BaseModel):
    node_id: str
    base_url: str
    agent_card_url: Optional[str] = None
    name: Optional[str] = None
    metadata: Optional[dict] = None


@app.get("/network/nodes")
async def network_list_nodes():
    """列出已注册的 A2A 节点。"""
    try:
        from backend.engine.network.registry import list_nodes
        nodes = list_nodes()
        return {"ok": True, "nodes": nodes}
    except Exception as e:
        logger.exception("列出网络节点失败: %s", e)
        return {"ok": False, "error": _safe_error_detail(e), "nodes": []}


@app.post("/network/nodes")
async def network_register_node(body: NetworkNodeRegisterBody):
    """注册一个 A2A 节点。"""
    try:
        from backend.engine.network.registry import register_node
        entry = register_node(
            node_id=body.node_id,
            base_url=body.base_url,
            agent_card_url=body.agent_card_url,
            name=body.name,
            metadata=body.metadata,
        )
        return {"ok": True, "node": {"node_id": entry.node_id, "base_url": entry.base_url}}
    except Exception as e:
        logger.exception("注册节点失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


@app.delete("/network/nodes/{node_id}")
async def network_unregister_node(node_id: str):
    """移除已注册节点。"""
    try:
        from backend.engine.network.registry import unregister_node
        ok = unregister_node(node_id)
        if not ok:
            raise HTTPException(status_code=404, detail="节点不存在")
        return {"ok": True}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("移除节点失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


@app.get("/network/agent-card-url")
async def network_agent_card_url(assistant_id: Optional[str] = None):
    """返回本机 Agent Card URL 模板（标准优先，兼容 LangGraph 旧路径）。"""
    import os
    base = os.environ.get("LANGGRAPH_API_URL", "http://127.0.0.1:2024").rstrip("/")
    standard_url = f"{base}/.well-known/agent.json"
    legacy_url = f"{base}/.well-known/agent-card.json"
    if assistant_id:
        standard_url += f"?assistant_id={assistant_id}"
        legacy_url += f"?assistant_id={assistant_id}"
    return {
        "ok": True,
        "url": standard_url,
        "standard_url": standard_url,
        "legacy_url": legacy_url,
        "base_url": base,
    }


class NetworkNodeIdentityBody(BaseModel):
    agent_id: str
    name: str
    role: Optional[str] = "general"
    capabilities: Optional[List[str]] = None
    autonomy_level: Optional[str] = "L1"
    status: Optional[str] = "idle"
    knowledge_domains: Optional[List[str]] = None
    cost_budget_usd_daily: Optional[float] = 0.0


class SpawnConsumeBody(BaseModel):
    limit: Optional[int] = 10
    consume: Optional[bool] = True


class OrganizationQuotaBody(BaseModel):
    agent_id: str
    cpu_slots: Optional[int] = 1
    model_calls_per_hour: Optional[int] = 100
    usd_budget_daily: Optional[float] = 0.0


@app.get("/network/nodes/{node_id}/identity")
async def network_get_node_identity(node_id: str):
    """读取节点 Agent Protocol 身份信息。"""
    try:
        from backend.engine.network.registry import get_node_identity

        identity = get_node_identity(node_id)
        return {"ok": True, "identity": identity}
    except Exception as e:
        logger.exception("读取节点身份失败: %s", e)
        return {"ok": False, "error": _safe_error_detail(e), "identity": None}


@app.post("/network/nodes/{node_id}/identity")
async def network_set_node_identity(node_id: str, body: NetworkNodeIdentityBody):
    """更新节点 Agent Protocol 身份信息。"""
    try:
        from backend.engine.network.registry import AgentIdentity, update_node_identity

        identity = AgentIdentity(
            agent_id=str(body.agent_id or "").strip(),
            name=str(body.name or "").strip() or node_id,
            role=str(body.role or "general"),
            capabilities=list(body.capabilities or []),
            autonomy_level=str(body.autonomy_level or "L1"),
            status=str(body.status or "idle"),
            knowledge_domains=list(body.knowledge_domains or []),
            cost_budget_usd_daily=float(body.cost_budget_usd_daily or 0.0),
        )
        ok = update_node_identity(node_id=node_id, identity=identity)
        if not ok:
            return {"ok": False, "error": "节点不存在"}
        return {"ok": True, "identity": identity.model_dump() if hasattr(identity, "model_dump") else identity.__dict__}
    except Exception as e:
        logger.exception("更新节点身份失败: %s", e)
        return {"ok": False, "error": _safe_error_detail(e)}


@app.get("/organization/spawn/records")
async def organization_spawn_records(limit: int = 20, pending_only: bool = True):
    """读取组织孵化记录。"""
    try:
        from backend.engine.organization.agent_spawner import get_agent_spawner

        spawner = get_agent_spawner()
        if pending_only:
            rows = spawner.list_pending(limit=limit)
        else:
            rows = spawner.list_records()[-max(1, int(limit)) :]
        return {"ok": True, "rows": rows, "pending_only": pending_only}
    except Exception as e:
        logger.exception("读取孵化记录失败: %s", e)
        return {"ok": False, "error": _safe_error_detail(e), "rows": []}


@app.post("/organization/spawn/consume")
async def organization_spawn_consume(body: SpawnConsumeBody, _: None = Depends(verify_internal_token)):
    """消费孵化请求队列（供前端/桌面层创建 worker 窗口）。"""
    try:
        from backend.engine.organization.agent_spawner import get_agent_spawner

        spawner = get_agent_spawner()
        limit = int(body.limit or 10)
        if bool(body.consume):
            rows = spawner.consume_pending(limit=limit)
        else:
            rows = spawner.list_pending(limit=limit)
        return {"ok": True, "rows": rows, "consumed": bool(body.consume)}
    except Exception as e:
        logger.exception("消费孵化记录失败: %s", e)
        return {"ok": False, "error": _safe_error_detail(e), "rows": []}


@app.get("/organization/resources/quota")
async def organization_get_resource_quota(agent_id: str):
    """读取组织资源配额（按 agent/role 维度）。"""
    try:
        from backend.engine.organization import get_resource_pool

        aid = str(agent_id or "").strip()
        if not aid:
            raise HTTPException(status_code=400, detail="agent_id 必填")
        quota = get_resource_pool().get_quota(aid)
        return {
            "ok": True,
            "agent_id": aid,
            "quota": {
                "cpu_slots": int(getattr(quota, "cpu_slots", 1) or 1),
                "model_calls_per_hour": int(getattr(quota, "model_calls_per_hour", 100) or 100),
                "usd_budget_daily": float(getattr(quota, "usd_budget_daily", 0.0) or 0.0),
            },
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("读取资源配额失败: %s", e)
        return {"ok": False, "error": _safe_error_detail(e), "quota": None}


@app.post("/organization/resources/quota")
async def organization_set_resource_quota(body: OrganizationQuotaBody, _: None = Depends(verify_internal_token)):
    """设置组织资源配额。"""
    try:
        from backend.engine.organization import get_resource_pool, ResourceQuota

        aid = str(body.agent_id or "").strip()
        if not aid:
            raise HTTPException(status_code=400, detail="agent_id 必填")
        quota = ResourceQuota(
            cpu_slots=max(1, int(body.cpu_slots or 1)),
            model_calls_per_hour=max(1, int(body.model_calls_per_hour or 100)),
            usd_budget_daily=max(0.0, float(body.usd_budget_daily or 0.0)),
        )
        get_resource_pool().set_quota(aid, quota)
        return {"ok": True, "agent_id": aid, "quota": quota.__dict__.copy()}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("设置资源配额失败: %s", e)
        return {"ok": False, "error": _safe_error_detail(e), "quota": None}


@app.get("/organization/learning/recent")
async def organization_learning_recent(
    limit: int = 20,
    agent_id: Optional[str] = None,
    task_type: Optional[str] = None,
):
    """读取组织集体学习最近样本，并可按 agent 获取学习评分。"""
    try:
        from backend.engine.organization import get_collective_learning

        learning = get_collective_learning()
        rows = learning.recent(limit=max(1, int(limit)))
        score = None
        aid = str(agent_id or "").strip()
        if aid:
            score = learning.agent_recent_score(
                aid,
                task_type=str(task_type or "").strip(),
                limit=max(5, int(limit)),
            )
        return {"ok": True, "rows": rows, "agent_score": score}
    except Exception as e:
        logger.exception("读取组织学习样本失败: %s", e)
        return {"ok": False, "error": _safe_error_detail(e), "rows": {"success_patterns": [], "failure_lessons": []}, "agent_score": None}


@app.get("/organization/collaboration/metrics")
async def organization_collaboration_metrics(
    task_id: Optional[str] = None,
    scope: str = "personal",
    limit: int = 80,
):
    """
    协作统计：按 child_agent/thread 聚合真实执行数据。
    返回每个子代理的运行中数、完成数、失败率、平均时长、贡献分。
    """
    try:
        from backend.api.routers.board_api import (
            _board_ns_for_scope,
            _store_list_keys,
            _store_get,
        )
    except Exception as e:
        logger.warning("协作统计 board_api 导入失败: %s", e)
        return {"ok": False, "error": "协作统计依赖不可用", "rows": []}

    try:
        from backend.engine.organization.agent_spawner import get_agent_spawner
        from backend.engine.core.main_graph import get_sqlite_store

        spawner = get_agent_spawner()
        rows = spawner.list_records()[-max(1, int(limit)) :]
        if task_id:
            target_task = str(task_id).strip()
            rows = [r for r in rows if str((r or {}).get("task_id") or "").strip() == target_task]

        store = get_sqlite_store()
        # 降级/无 Store 时不视为错误，返回空数据，避免前端展示「加载失败」
        if store is None:
            return {"ok": True, "scope": scope, "task_id": task_id, "rows": [], "generated_at": datetime.now(timezone.utc).isoformat()}

        ns = _board_ns_for_scope(scope)
        keys = await _store_list_keys(store, ns)
        all_tasks: List[Dict[str, Any]] = []
        for k in keys:
            out = await _store_get(store, ns, k)
            if not out:
                continue
            v = getattr(out, "value", out) if not isinstance(out, dict) else out
            if not isinstance(v, dict):
                continue
            all_tasks.append({"id": str(k), **dict(v)})

        def _parse_iso(raw: Any) -> Optional[datetime]:
            s = str(raw or "").strip()
            if not s:
                return None
            try:
                if s.endswith("Z"):
                    s = s[:-1] + "+00:00"
                return datetime.fromisoformat(s)
            except Exception as e:
                logger.debug("datetime fromisoformat: %s", e)
                return None

        metric_rows: List[Dict[str, Any]] = []
        active_status = {"claimed", "running", "pending", "waiting_human", "awaiting_plan_confirm", "blocked"}
        done_status = {"completed", "failed", "cancelled"}
        for row in rows:
            child_thread = str((row or {}).get("child_agent_id") or "").strip()
            role = str((row or {}).get("role") or "").strip()
            parent_agent_id = str((row or {}).get("parent_agent_id") or "").strip()
            spawn_task_id = str((row or {}).get("task_id") or "").strip()

            related = []
            for t in all_tasks:
                t_thread = str(t.get("thread_id") or "").strip()
                t_role = str(t.get("claimed_by") or "").strip()
                t_id = str(t.get("id") or t.get("task_id") or "").strip()
                if child_thread and t_thread and t_thread == child_thread:
                    related.append(t)
                    continue
                if role and t_role and t_role == role:
                    related.append(t)
                    continue
                if spawn_task_id and t_id and t_id == spawn_task_id:
                    related.append(t)
                    continue

            completed = 0
            failed = 0
            active = 0
            duration_samples: List[float] = []
            for t in related:
                status = str(t.get("status") or "").strip().lower()
                if status in active_status:
                    active += 1
                if status == "completed":
                    completed += 1
                if status == "failed":
                    failed += 1
                if status in done_status:
                    start_dt = _parse_iso(t.get("created_at"))
                    end_dt = _parse_iso(t.get("updated_at"))
                    if start_dt and end_dt:
                        mins = (end_dt - start_dt).total_seconds() / 60.0
                        if mins >= 0:
                            duration_samples.append(mins)

            total = len(related)
            failure_rate = (failed / total) if total > 0 else 0.0
            avg_duration = (sum(duration_samples) / len(duration_samples)) if duration_samples else None
            contribution = max(0, min(100, int(completed * 22 + active * 8 - failed * 10)))

            metric_rows.append(
                {
                    "ts": row.get("ts"),
                    "task_id": row.get("task_id"),
                    "parent_agent_id": parent_agent_id or None,
                    "child_agent_id": child_thread or None,
                    "role": role or None,
                    "reason": row.get("reason"),
                    "metrics": {
                        "active_count": active,
                        "completed_count": completed,
                        "failed_count": failed,
                        "total_count": total,
                        "failure_rate": round(float(failure_rate), 4),
                        "avg_duration_minutes": round(float(avg_duration), 2) if avg_duration is not None else None,
                        "contribution_score": contribution,
                    },
                }
            )

        metric_rows.sort(key=lambda x: str(x.get("ts") or ""), reverse=True)
        return {
            "ok": True,
            "scope": scope,
            "task_id": task_id,
            "rows": metric_rows,
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }
    except Exception as e:
        logger.exception("读取协作统计失败: %s", e)
        return {"ok": False, "error": _safe_error_detail(e), "rows": []}


@app.get("/.well-known/agent.json")
async def well_known_agent_json(assistant_id: Optional[str] = Query(default=None)):
    """
    Google A2A 常见发现路径兼容层。
    LangGraph 当前原生端点是 /.well-known/agent-card.json，这里做透明代理。
    """
    base = os.environ.get("LANGGRAPH_API_URL", "http://127.0.0.1:2024").rstrip("/")
    upstream = f"{base}/.well-known/agent-card.json"
    if assistant_id:
        upstream += f"?assistant_id={assistant_id}"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(upstream)
            if resp.status_code != 200:
                raise HTTPException(status_code=resp.status_code, detail=resp.text[:200])
            data = resp.json()
            # 补充一个显式兼容标记，便于调试链路时识别来源。
            if isinstance(data, dict):
                data.setdefault("metadata", {})
                if isinstance(data["metadata"], dict):
                    data["metadata"].setdefault("compat_source", "langgraph_agent_card_proxy")
            return JSONResponse(content=data)
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("代理 /.well-known/agent.json 失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


# ============================================================
# 角色管理 API（能力配置 Claude/Cursor 风格）
# ============================================================

@app.get("/roles/list")
async def roles_list():
    """列出所有可用角色（含按 skill_profile 解析的能力映射）。"""
    try:
        from backend.engine.roles import list_roles
        from backend.engine.skills.skill_profiles import load_profiles
        from backend.engine.skills.skill_registry import get_skill_registry

        roles = list_roles()
        profiles = load_profiles().get("profiles", {})

        # 统一预加载 SkillRegistry，避免每个角色重复扫描
        registry = get_skill_registry()
        registry.discover_skills()
        all_skills = registry.get_all_skills()

        def _skills_for_profile(profile_id: str) -> list[dict]:
            profile = profiles.get(profile_id, {}) if profile_id else {}
            profile_paths = profile.get("paths") or []
            if not profile_paths:
                return [_skill_to_item(s) for s in all_skills]

            def path_covered(rel_path: str) -> bool:
                if not rel_path:
                    return False
                for p in profile_paths:
                    norm = (p.rstrip("/") + "/") if not p.endswith("/") else p
                    if rel_path == p or rel_path == p.rstrip("/"):
                        return True
                    if norm.endswith("/") and rel_path.startswith(norm):
                        return True
                return False

            return [_skill_to_item(s) for s in all_skills if path_covered(getattr(s, "relative_path", "") or "")]

        enriched_roles = []
        for role in roles:
            rid = role.get("id", "")
            role_modes = [str(m).strip().lower() for m in (role.get("modes") or []) if str(m).strip()]
            profile_id = role.get("skill_profile", "")
            profile = profiles.get(profile_id, {}) if profile_id else {}

            resolved_skills = _skills_for_profile(profile_id)
            resolved_capabilities = [
                {
                    "id": f"skill_{item.get('name')}",
                    "label": item.get("display_name") or item.get("name", ""),
                    "skill": item.get("name"),
                    "domain": item.get("domain", ""),
                    "description": item.get("description", ""),
                }
                for item in resolved_skills
                if item.get("name")
            ]

            # 显式配置（roles.json）优先，自动补齐未声明能力，保证“能力全映射”
            explicit_caps = role.get("capabilities") or []
            cap_key = lambda c: (c.get("skill") or c.get("id") or "").strip()  # noqa: E731
            existing = {cap_key(c) for c in explicit_caps if cap_key(c)}
            merged_caps = list(explicit_caps)
            for c in resolved_capabilities:
                k = cap_key(c)
                if k and k not in existing:
                    merged_caps.append(c)
                    existing.add(k)

            # Debug/Review 互斥：每个角色 modes 已至多含其一，第四模式即其中在列者
            preferred_fourth_mode = "debug" if "debug" in role_modes else ("review" if "review" in role_modes else None)

            enriched_roles.append(
                {
                    **role,
                    "id": rid,
                    "skill_profile_label": profile.get("label", profile_id),
                    "skill_profile_description": profile.get("description", ""),
                    "capabilities_summary": profile.get("capabilities_summary", ""),
                    "responsibility_scope": role.get("responsibility_scope") or profile.get("description", ""),
                    "not_responsible_for": role.get("not_responsible_for") or [],
                    "preferred_fourth_mode": preferred_fourth_mode or None,
                    "capabilities": merged_caps,
                    "resolved_capabilities": resolved_capabilities,
                    "resolved_capabilities_count": len(resolved_capabilities),
                }
            )
        return {"ok": True, "roles": enriched_roles}
    except Exception as e:
        logger.exception("列出角色失败: %s", e)
        return {"ok": False, "error": _safe_error_detail(e), "roles": []}


@app.get("/roles/{role_id}")
async def roles_get(role_id: str):
    """获取单个角色详情"""
    try:
        from backend.engine.roles import get_role
        role = get_role(role_id)
        if role is None:
            raise HTTPException(status_code=404, detail="角色不存在")
        return {"ok": True, "role": role}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("获取角色失败: %s", e)
        return {"ok": False, "error": _safe_error_detail(e), "role": None}


@app.post("/roles/{role_id}/activate")
async def roles_activate(role_id: str, body: Optional[dict] = Body(default=None)):
    """激活角色：支持全局激活与线程级激活（thread metadata）。"""
    try:
        from backend.api.common import is_valid_thread_id_uuid
        from backend.engine.roles import apply_role, apply_role_to_thread
        payload = body if isinstance(body, dict) else {}
        thread_id = str(payload.get("thread_id") or "").strip()
        if thread_id:
            if not is_valid_thread_id_uuid(thread_id):
                raise HTTPException(status_code=422, detail="invalid thread_id format")
            try:
                metadata = await apply_role_to_thread(thread_id, role_id)
            except ValueError as ve:
                if "thread_id" in str(ve).lower():
                    raise HTTPException(status_code=422, detail="invalid thread_id format")
                raise HTTPException(status_code=422, detail=_safe_error_detail(ve))
            if metadata is None:
                raise HTTPException(status_code=404, detail="角色不存在、线程不存在或应用失败")
            return {"ok": True, "thread_id": thread_id, "role_id": role_id, "metadata": metadata}

        profile = apply_role(role_id)
        if profile is None:
            raise HTTPException(status_code=404, detail="角色不存在或应用失败")
        return {"ok": True, "profile": profile}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("激活角色失败: %s", e)
        return {"ok": False, "error": _safe_error_detail(e), "profile": None}


@app.post("/roles/reload")
async def roles_reload():
    """重新发现角色（knowledge_base/roles/ + roles.json 缓存清除）"""
    try:
        from backend.engine.roles import reload_roles
        reload_roles()
        return {"ok": True}
    except Exception as e:
        logger.exception("角色重载失败: %s", e)
        return {"ok": False, "error": _safe_error_detail(e)}


@app.get("/execution-logs")
async def get_execution_logs(
    thread_id: Optional[str] = Query(default=None), limit: int = 10, status: Optional[str] = None
):
    """
    获取执行日志（Debug 模式使用）
    
    返回指定 thread 的最近执行记录，含 steps、final_result、error 等，
    供 Debug 模式分析问题根因。未传或非 UUID 的 thread_id 返回空列表（与 LangGraph 约定一致）。
    """
    from backend.api.common import is_valid_thread_id_uuid
    if not thread_id or not is_valid_thread_id_uuid(thread_id):
        return {"ok": True, "thread_id": thread_id or "", "logs": []}
    try:
        from backend.engine.logging.execution_logger import get_execution_logger
        logger_instance = get_execution_logger()
        logs = logger_instance.get_task_logs(thread_id, limit=limit, status=status)
        return {"ok": True, "thread_id": thread_id, "logs": logs}
    except Exception as e:
        logger.error("获取执行日志失败: %s", e)
        return {"ok": False, "error": _safe_error_detail(e), "logs": []}


@app.get("/observability/sli")
async def get_observability_sli(window_hours: int = Query(default=24, ge=1, le=168)):
    """调度与执行核心 SLI 聚合（用于拥塞治理与路由优化）。"""
    try:
        from backend.engine.logging.execution_logger import get_execution_logger

        summary = get_execution_logger().get_sli_summary(window_hours=window_hours)
        return {"ok": True, "summary": summary}
    except Exception as e:
        logger.error("获取 SLI 汇总失败: %s", e)
        return {"ok": False, "error": _safe_error_detail(e), "summary": {}}


class UiStreamMetricsSampleBody(BaseModel):
    request_id: Optional[str] = None
    model_id: Optional[str] = None
    ttft_ms: Optional[float] = None
    stream_to_first_token_ms: Optional[float] = None
    lmstudio_gap_overhead_ms: Optional[float] = None
    max_inter_token_gap_ms: Optional[float] = None
    message_channel_fallback_count: Optional[float] = None
    partial_suppressed_count: Optional[float] = None
    frontend_first_payload_ms: Optional[float] = None
    frontend_first_ui_yield_ms: Optional[float] = None
    frontend_max_inter_payload_gap_ms: Optional[float] = None
    total_ms: Optional[float] = None
    ts: Optional[float] = None


@app.post("/observability/ui-stream-metrics")
async def post_ui_stream_metrics_sample(body: UiStreamMetricsSampleBody):
    """接收前端 UI 流式指标样本，落盘供发布观测聚合。"""
    try:
        root = Path(__file__).resolve().parents[2]
        path = root / "backend" / "data" / "ui_stream_metrics_samples.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)

        payload = body.model_dump()
        payload["received_at"] = datetime.now(timezone.utc).isoformat()
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(payload, ensure_ascii=False) + "\n")

        return {"ok": True}
    except Exception as e:
        logger.error("写入 UI 流式指标失败: %s", e)
        return {"ok": False, "error": _safe_error_detail(e)}


def _langsmith_runtime_status() -> dict:
    """读取 LangSmith 运行时状态（通过标准环境变量驱动）。"""
    try:
        from backend.engine.observability.langsmith_eval import langsmith_runtime_status
        return langsmith_runtime_status()
    except Exception as e:
        logger.debug("langsmith_runtime_status import/call failed, using env fallback: %s", e)
        has_api_key = bool(os.getenv("LANGSMITH_API_KEY") or os.getenv("LANGCHAIN_API_KEY"))
        tracing_flag = (os.getenv("LANGCHAIN_TRACING_V2", "false") or "").lower() == "true"
        endpoint = os.getenv("LANGSMITH_ENDPOINT", "https://api.smith.langchain.com")
        project = os.getenv("LANGCHAIN_PROJECT", "maibot")
        return {
            "enabled": has_api_key and tracing_flag,
            "has_api_key": has_api_key,
            "tracing_v2": tracing_flag,
            "project": project,
            "endpoint": endpoint,
        }


@app.get("/observability/langsmith/status")
async def get_langsmith_status():
    """LangSmith 可观测性状态（用于 UI 检查与引导配置）。"""
    try:
        status = _langsmith_runtime_status()
        eval_summary = {}
        try:
            from backend.engine.observability.langsmith_eval import summarize_eval_logs

            eval_summary = summarize_eval_logs(limit=200)
        except Exception as e:
            logger.debug("summarize_eval_logs: %s", e)
            eval_summary = {}
        status["ok"] = True
        status["eval_summary"] = eval_summary
        if status["enabled"]:
            status["message"] = "LangSmith tracing 已启用"
        else:
            status["message"] = "LangSmith tracing 未启用（需配置 LANGSMITH_API_KEY，系统会自动开启 tracing）"
        return status
    except Exception as e:
        return {"ok": False, "enabled": False, "error": _safe_error_detail(e)}


@app.get("/execution-trace")
async def get_execution_trace(
    thread_id: Optional[str] = Query(default=None), limit: int = 10, status: Optional[str] = None
):
    """统一执行追踪入口：LangSmith 优先，失败时回退本地 execution logs。未传或非 UUID 的 thread_id 返回空。"""
    from backend.api.common import is_valid_thread_id_uuid
    ls = _langsmith_runtime_status()
    if not thread_id or not is_valid_thread_id_uuid(thread_id):
        return {
            "ok": True,
            "preferred": "langsmith" if ls.get("enabled") else "local",
            "thread_id": thread_id or "",
            "langsmith": ls,
            "logs": [],
        }
    try:
        from backend.engine.logging.execution_logger import get_execution_logger

        logger_instance = get_execution_logger()
        logs = logger_instance.get_task_logs(thread_id, limit=limit, status=status)
        preferred = "langsmith" if ls.get("enabled") else "local"
        return {
            "ok": True,
            "preferred": preferred,
            "thread_id": thread_id,
            "langsmith": ls,
            "logs": logs,
        }
    except Exception as e:
        return {
            "ok": False,
            "preferred": "langsmith" if ls.get("enabled") else "local",
            "thread_id": thread_id,
            "langsmith": ls,
            "logs": [],
            "error": _safe_error_detail(e),
        }


@app.get("/observability/langsmith/evals")
async def get_langsmith_evals(limit: int = Query(default=30, ge=1, le=200)):
    """读取最近 LangSmith 自动评估记录（本地落盘日志）。"""
    try:
        from backend.engine.observability.langsmith_eval import list_eval_logs
        rows = list_eval_logs(limit=limit)
        return {"ok": True, "rows": rows, "total": len(rows)}
    except Exception as e:
        return {"ok": False, "rows": [], "total": 0, "error": _safe_error_detail(e)}


class SkillFeedbackBody(BaseModel):
    skill_name: str
    was_helpful: bool
    score: int = 1
    note: Optional[str] = ""


@app.post("/learning/skill-feedback")
async def post_skill_feedback(body: SkillFeedbackBody):
    """记录技能质量反馈（用于自学习质量闭环）。"""
    try:
        from backend.tools.base.learning_middleware import record_skill_feedback

        return record_skill_feedback(
            skill_name=body.skill_name,
            was_helpful=body.was_helpful,
            score=body.score,
            note=body.note or "",
        )
    except Exception as e:
        logger.exception("记录技能反馈失败: %s", e)
        return {"ok": False, "error": _safe_error_detail(e)}


@app.get("/learning/skill-feedback/stats")
async def get_skill_feedback_stats_api(limit: int = 20):
    """获取技能反馈统计（按反馈总量排序）。"""
    try:
        from backend.tools.base.learning_middleware import get_skill_feedback_stats

        return get_skill_feedback_stats(limit=limit)
    except Exception as e:
        logger.exception("获取技能反馈统计失败: %s", e)
        return {"ok": False, "error": _safe_error_detail(e), "items": []}


@app.post("/skills/generate-draft")
async def skills_generate_draft(request: dict):
    """
    从用户提供的名称/描述（及可选 thread_id 步骤摘要）生成 SKILL 草稿。
    写入 knowledge_base/learned/skills/{name}/SKILL.md，供后续编辑完善。
    """
    try:
        from backend.tools.base.paths import KB_PATH
        import re

        name = (request.get("name") or "").strip()
        description = (request.get("description") or "从对话/执行归纳的技能草稿，请完善后迁入 knowledge_base/skills/ 使用。").strip()
        steps_summary = (request.get("steps_summary") or "").strip()
        thread_id = request.get("thread_id")

        if not name:
            raise HTTPException(status_code=400, detail="name 必填")

        safe_name = re.sub(r"[^\w\u4e00-\u9fa5\-]", "-", name).strip("-") or "draft-skill"
        skill_dir = KB_PATH / "learned" / "skills" / safe_name
        skill_dir.mkdir(parents=True, exist_ok=True)
        skill_md = skill_dir / "SKILL.md"

        body = (steps_summary or "（请在此补充步骤与示例）")
        if thread_id:
            body = f"<!-- 来自 thread_id: {thread_id} -->\n\n" + body

        content = f"""---
name: {safe_name}
description: {description}
---

# {name}

{body}
"""
        skill_md.write_text(content, encoding="utf-8")
        logger.info("✅ SKILL 草稿已生成: %s", str(skill_md))
        return {
            "ok": True,
            "path": str(skill_md),
            "relative_path": f"learned/skills/{safe_name}/SKILL.md",
            "message": "草稿已生成，可在知识库中编辑完善",
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error("❌ 生成 SKILL 草稿失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


@app.get("/skills/validate")
async def skills_validate():
    """调用 validate_all_skills() 对 Skills 进行校验，返回校验结果。"""
    try:
        from backend.engine.skills.validate_skills import validate_all_skills, ValidationResult
        
        results = validate_all_skills()
        
        def to_item(r: ValidationResult) -> dict:
            return {
                "path": r.path,
                "valid": r.valid,
                "errors": r.errors,
                "warnings": r.warnings,
                "name": r.name,
                "description": r.description[:200] if r.description else "",
            }
        
        valid_list = [to_item(r) for r in results["valid"]]
        invalid_list = [to_item(r) for r in results["invalid"]]
        warnings_list = [to_item(r) for r in results["warnings"]]
        return {
            "ok": True,
            "valid": valid_list,
            "invalid": invalid_list,
            "warnings": warnings_list,
            "total": len(valid_list) + len(invalid_list) + len(warnings_list),
            "valid_count": len(valid_list),
            "invalid_count": len(invalid_list),
            "warnings_count": len(warnings_list),
        }
    except Exception as e:
        logger.error(f"❌ Skills 校验失败: {e}")
        return {"ok": False, "error": _safe_error_detail(e)}


# ============================================================
# 技能 CRUD（create/import/update/delete），与角色一体化
# ============================================================

class SkillCreateBody(BaseModel):
    name: str
    domain: Optional[str] = "general"
    description: Optional[str] = ""
    content: Optional[str] = ""


@app.post("/skills/create")
async def skills_create(body: SkillCreateBody, _: None = Depends(verify_internal_token)):
    """创建新 Skill：在 knowledge_base/skills/{domain}/{name}/ 下创建 SKILL.md。"""
    try:
        from backend.tools.base.paths import SKILLS_ROOT
        import re
        safe_name = re.sub(r"[^\w\u4e00-\u9fa5\-]", "-", (body.name or "").strip()).strip("-") or "new-skill"
        safe_domain = re.sub(r"[^\w\u4e00-\u9fa5\-]", "-", (body.domain or "general").strip()).strip("-") or "general"
        skill_dir = SKILLS_ROOT / safe_domain / safe_name
        skill_dir.mkdir(parents=True, exist_ok=True)
        skill_md = skill_dir / "SKILL.md"
        content = body.content or f"""---
name: {safe_name}
description: {body.description or ""}
---

# {body.name or safe_name}

（在此编写技能步骤与示例）
"""
        skill_md.write_text(content, encoding="utf-8")
        logger.info("✅ Skill 已创建: %s", str(skill_md))
        return {"ok": True, "path": str(skill_md), "relative_path": f"skills/{safe_domain}/{safe_name}/SKILL.md"}
    except Exception as e:
        logger.exception("创建 Skill 失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


class SkillUpdateBody(BaseModel):
    path: Optional[str] = None
    relative_path: Optional[str] = None
    content: str


def _resolve_skill_path_allowed(raw_path: str):
    """解析 path 并校验必须在 SKILLS_ROOT / LEARNED_SKILLS_ROOT / KB_PATH 之一之下，防止路径穿越。"""
    from backend.tools.base.paths import SKILLS_ROOT, LEARNED_SKILLS_ROOT, KB_PATH
    raw = (raw_path or "").strip().replace("\\", "/")
    if not raw:
        raise HTTPException(status_code=400, detail="path is required")
    resolved = Path(raw).expanduser().resolve()
    for base in (SKILLS_ROOT.resolve(), LEARNED_SKILLS_ROOT.resolve(), KB_PATH.resolve()):
        try:
            resolved.relative_to(base)
            return resolved
        except ValueError:
            continue
    raise HTTPException(status_code=403, detail="path not allowed")


@app.put("/skills/update")
async def skills_update(body: SkillUpdateBody, _: None = Depends(verify_internal_token)):
    """更新已有 Skill 的 SKILL.md 内容（path 或 relative_path 二选一）。"""
    try:
        from backend.tools.base.paths import SKILLS_ROOT, LEARNED_SKILLS_ROOT, KB_PATH
        path = body.path
        if not path and body.relative_path:
            for base in (SKILLS_ROOT, LEARNED_SKILLS_ROOT, KB_PATH):
                base_resolved = base.resolve()
                p = (base / body.relative_path).resolve()
                try:
                    p.relative_to(base_resolved)
                except ValueError:
                    continue
                if p.exists():
                    path = str(p)
                    break
        if not path:
            raise HTTPException(status_code=400, detail="请提供 path 或 relative_path")
        file_path = _resolve_skill_path_allowed(path)
        if not file_path.exists():
            raise HTTPException(status_code=404, detail="文件不存在")
        file_path.write_text(body.content, encoding="utf-8")
        from backend.engine.skills.skill_registry import get_skill_registry
        get_skill_registry().discover_skills(force_reload=True)
        return {"ok": True, "path": str(file_path)}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("更新 Skill 失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


@app.delete("/skills/delete")
async def skills_delete(path: Optional[str] = None, relative_path: Optional[str] = None, _: None = Depends(verify_internal_token)):
    """删除 Skill（删除对应目录；path 或 relative_path 二选一）。"""
    try:
        from backend.tools.base.paths import SKILLS_ROOT, LEARNED_SKILLS_ROOT, KB_PATH
        if not path and not relative_path:
            raise HTTPException(status_code=400, detail="请提供 path 或 relative_path")
        target = None
        if path:
            target = _resolve_skill_path_allowed(path)
        else:
            for base in (SKILLS_ROOT, LEARNED_SKILLS_ROOT, KB_PATH):
                base_resolved = base.resolve()
                p = (base / relative_path).resolve()
                try:
                    p.relative_to(base_resolved)
                except ValueError:
                    continue
                if p.exists():
                    target = p
                    break
        if not target or not target.exists():
            raise HTTPException(status_code=404, detail="路径不存在")
        if target.is_file():
            target.unlink()
            skill_dir = target.parent
        else:
            skill_dir = target
            shutil.rmtree(skill_dir)
        from backend.engine.skills.skill_registry import get_skill_registry
        get_skill_registry().discover_skills(force_reload=True)
        return {"ok": True, "deleted": str(skill_dir)}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("删除 Skill 失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


class SkillImportBody(BaseModel):
    source_path: Optional[str] = None
    domain: Optional[str] = "general"


@app.post("/skills/import")
async def skills_import(
    body: Optional[SkillImportBody] = None,
    file: Optional[UploadFile] = File(None),
    domain: Optional[str] = Form(None),
):
    """
    导入 Skill：从服务端路径复制到 skills/，或上传 zip 解压到 skills/。
    body.source_path 或 multipart file (zip) 二选一；domain 可用 query/form 或 body。
    """
    try:
        from backend.tools.base.paths import SKILLS_ROOT
        import zipfile
        import re
        domain = (domain or (body.domain if body else None) or "general") or "general"
        safe_domain = re.sub(r"[^\w\u4e00-\u9fa5\-]", "-", domain).strip("-") or "general"
        if file and file.filename and file.filename.lower().endswith(".zip"):
            content = await file.read()
            target_dir = SKILLS_ROOT / safe_domain
            target_dir.mkdir(parents=True, exist_ok=True)
            with zipfile.ZipFile(io.BytesIO(content), "r") as zf:
                zf.extractall(target_dir)
            logger.info("✅ Skill zip 已导入到 %s", str(target_dir))
            return {"ok": True, "message": "zip 已解压到 skills", "path": str(target_dir)}
        if body and body.source_path:
            src = Path(body.source_path)
            if not src.exists():
                raise HTTPException(status_code=404, detail="source_path 不存在")
            dest_dir = SKILLS_ROOT / safe_domain / src.name
            if src.is_dir():
                shutil.copytree(src, dest_dir, dirs_exist_ok=True)
            else:
                dest_dir.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dest_dir / src.name)
            from backend.engine.skills.skill_registry import get_skill_registry
            get_skill_registry().discover_skills(force_reload=True)
            return {"ok": True, "path": str(dest_dir)}
        raise HTTPException(status_code=400, detail="请提供 file (zip) 或 body.source_path")
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("导入 Skill 失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


# ============================================================
# Skills 市场：浏览 / 安装 / 更新（Phase 2）
# ============================================================

def _license_profile_path() -> Path:
    return PROJECT_ROOT / "data" / "license.json"


_LICENSE_FALLBACK = {"tier": "free", "limits": {"max_custom_skills": 5, "max_mcp_connections": 2, "max_daily_autonomous_tasks": 10}}


def _load_license_profile() -> dict:
    return _load_json_file_cached(_license_profile_path(), _LICENSE_FALLBACK)


def _save_license_profile(data: dict) -> None:
    path = _license_profile_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    _invalidate_json_cache(path)


def _tier_limits() -> dict:
    return resolve_tier_limits(_load_license_profile())


def _current_tier() -> str:
    return resolve_current_tier(_load_license_profile())


def _count_custom_skills() -> int:
    try:
        from backend.tools.base.paths import SKILLS_ROOT
        if not SKILLS_ROOT.exists():
            return 0
        count = 0
        for skill_md in SKILLS_ROOT.glob("*/*/SKILL.md"):
            if skill_md.is_file():
                count += 1
        return count
    except Exception as e:
        logger.debug("_skills_count_under_root failed: %s", e)
        return 0


def _read_billing_usage(key: str) -> dict:
    try:
        from backend.engine.core.main_graph import get_sqlite_store

        store = get_sqlite_store()
        if store is None:
            return {}
        out = store.get(NS_BILLING_USAGE, key)
        raw = getattr(out, "value", out) if out else {}
        return dict(raw) if isinstance(raw, dict) else {}
    except Exception as e:
        logger.debug("_read_billing_usage failed for key=%s: %s", key, e)
        return {}


def _daily_quota_usage() -> dict:
    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    cloud = _read_billing_usage(f"cloud_model_requests:{day}")
    autonomous = _read_billing_usage(f"autonomous_tasks:{day}")
    return {
        "cloud_model_requests_today": int(cloud.get("count", 0) or 0),
        "autonomous_tasks_today": int(autonomous.get("task_count", 0) or 0),
    }


@app.get("/license/status")
async def license_status():
    profile = _load_license_profile()
    limits = _tier_limits()
    usage = _daily_quota_usage()
    usage["custom_skills"] = _count_custom_skills()
    return {
        "ok": True,
        "tier": _current_tier(),
        "limits": limits,
        "usage": usage,
        "profile": profile,
    }


class LicenseActivateBody(BaseModel):
    tier: str
    token: Optional[str] = None


@app.post("/license/activate")
async def license_activate(body: LicenseActivateBody):
    raw_tier = (body.tier or "").strip().lower()
    if raw_tier not in {"free", "pro", "max", "community", "business", "enterprise"}:
        raise HTTPException(status_code=400, detail="tier 必须是 free/pro/max/community/business/enterprise")
    tier = resolve_normalize_tier(raw_tier)
    profile = _load_license_profile()
    profile["tier"] = tier
    if body.token:
        profile["token"] = body.token.strip()
    _save_license_profile(profile)
    return {"ok": True, "tier": tier}


def _plugins_state_path() -> Path:
    return PROJECT_ROOT / "data" / "plugins_state.json"


def _load_plugins_state() -> list[str]:
    p = _plugins_state_path()
    if not p.exists():
        return []
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        if isinstance(data, list):
            return [str(x).strip() for x in data if str(x).strip()]
    except Exception as e:
        logger.debug("plugins state load failed: %s", e)
    return []


def _save_plugins_state(names: list[str]) -> None:
    p = _plugins_state_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    deduped = sorted({str(x).strip() for x in names if str(x).strip()})
    p.write_text(json.dumps(deduped, ensure_ascii=False, indent=2), encoding="utf-8")


def _build_plugin_loader() -> PluginLoader:
    store = None
    try:
        from backend.engine.core.main_graph import get_sqlite_store
        store = get_sqlite_store()
    except Exception as e:
        logger.debug("get_sqlite_store for plugin loader: %s", e)
    loader = PluginLoader(project_root=PROJECT_ROOT, profile=_load_license_profile(), store=store)
    for name in _load_plugins_state():
        try:
            loader.load(name)
        except Exception:
            continue
    return loader


def _mcp_servers_config_path() -> Path:
    return PROJECT_ROOT / "backend" / "config" / "mcp_servers.json"


def _load_mcp_servers_config() -> dict:
    p = _mcp_servers_config_path()
    if not p.exists():
        return {"servers": []}
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return data
    except Exception as e:
        logger.debug("mcp_servers_config load failed: %s", e)
    return {"servers": []}


def _save_mcp_servers_config(data: dict) -> None:
    p = _mcp_servers_config_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def _resolve_mcp_server_aliases(raw_name: str) -> list[str]:
    name = str(raw_name or "").strip()
    if not name:
        return []
    aliases = [name]
    explicit = {
        "mcp-macos": "macos-automation",
        "mcp-telegram": "telegram",
    }
    mapped = explicit.get(name)
    if mapped:
        aliases.append(mapped)
    if name.startswith("mcp-"):
        short = name[len("mcp-") :]
        aliases.append(short)
        aliases.append(f"{short}-automation")
    return [x for i, x in enumerate(aliases) if x and x not in aliases[:i]]


def _sync_plugin_mcp_servers(discovered: list, loaded_names: set[str]) -> None:
    cfg = _load_mcp_servers_config()
    servers = cfg.get("servers")
    if not isinstance(servers, list):
        return

    server_index = {}
    for idx, row in enumerate(servers):
        if isinstance(row, dict):
            n = str(row.get("name") or "").strip()
            if n:
                server_index[n] = idx

    managed_to_enabled: dict[str, bool] = {}
    for spec in discovered:
        components = getattr(spec, "components", {}) or {}
        mcp_items = components.get("mcp") if isinstance(components, dict) else None
        if not isinstance(mcp_items, list):
            continue
        spec_loaded = str(getattr(spec, "name", "") or "") in loaded_names
        for item in mcp_items:
            for alias in _resolve_mcp_server_aliases(str(item)):
                if alias in server_index:
                    managed_to_enabled[alias] = bool(spec_loaded)

    changed = False
    for server_name, enabled in managed_to_enabled.items():
        idx = server_index.get(server_name)
        if idx is None:
            continue
        row = servers[idx]
        if not isinstance(row, dict):
            continue
        if bool(row.get("enabled")) != enabled:
            row["enabled"] = enabled
            changed = True

    if changed:
        cfg["servers"] = servers
        _save_mcp_servers_config(cfg)


@app.get("/plugins/list")
async def plugins_list():
    loader = _build_plugin_loader()
    discovered = loader.discover()
    loaded_names = {p.name for p in loader.list_loaded()}
    registry_versions: dict[str, str] = {}
    registry_sources: dict[str, str] = {}
    try:
        registry = PluginRegistry(project_root=PROJECT_ROOT)
        for spec in registry.load_cached_specs():
            if spec.name:
                registry_versions[spec.name] = str(spec.version or "")
                registry_sources[spec.name] = str(spec.author_name or "")
    except Exception as e:
        logger.debug("PluginRegistry load_cached_specs: %s", e)
        registry_versions = {}
        registry_sources = {}

    def _version_tuple(raw: str) -> tuple:
        nums = []
        for part in str(raw or "").replace("-", ".").split("."):
            if part.isdigit():
                nums.append(int(part))
            else:
                nums.append(0)
        return tuple(nums)

    def _resolve_source_label(spec) -> str:
        author = str(getattr(spec, "author_name", "") or "").strip().lower()
        if author in {"anthropic", "claude", "cowork"}:
            return "Anthropic Official"
        if author in {"maibot"}:
            return "maibot"
        if spec.name in registry_sources:
            return "Community"
        return "local"

    current = _current_tier()
    limits = _tier_limits()
    max_plugins = int(limits.get("max_plugins", 0) or 0)
    usage = {"installed_plugins": len(loaded_names)}
    loaded_warnings = [
        row
        for row in loader.get_manifest_warnings()
        if isinstance(row, dict) and str(row.get("plugin") or "") in loaded_names
    ]
    loaded_errors = [
        row
        for row in loader.get_manifest_errors()
        if isinstance(row, dict) and str(row.get("plugin") or "") in loaded_names
    ]
    return {
        "ok": True,
        "tier": current,
        "limits": {
            "max_plugins": max_plugins,
        },
        "usage": usage,
        "manifest_warnings_count": len(loaded_warnings),
        "manifest_errors_count": len(loaded_errors),
        "plugins": [
            {
                "name": p.name,
                "version": p.version,
                "display_name": p.display_name,
                "description": p.description,
                "requires_tier": p.requires_tier,
                "license": p.license,
                "category": getattr(p, "category", "") or "",
                "icon": getattr(p, "icon", "") or "",
                "changelog": getattr(p, "changelog", "") or "",
                "compatibility": {
                    "min_version": getattr(p, "compatibility_min_version", "") or ""
                },
                "source_label": _resolve_source_label(p),
                "components": p.components,
                "loaded": p.name in loaded_names,
                "eligible": loader.check_tier(p, current),
                "discovered_only": bool(p.discovered_only),
                "remote_version": registry_versions.get(p.name) or None,
                "update_available": bool(
                    registry_versions.get(p.name)
                    and _version_tuple(registry_versions.get(p.name) or "") > _version_tuple(str(p.version or ""))
                ),
            }
            for p in discovered
        ],
    }


@app.get("/plugins/manifest-warnings")
async def plugins_manifest_warnings():
    loader = _build_plugin_loader()
    loader.discover()
    loaded_names = {p.name for p in loader.list_loaded()}
    warnings = [
        row
        for row in loader.get_manifest_warnings()
        if isinstance(row, dict) and str(row.get("plugin") or "") in loaded_names
    ]
    errors = [
        row
        for row in loader.get_manifest_errors()
        if isinstance(row, dict) and str(row.get("plugin") or "") in loaded_names
    ]
    return {
        "ok": True,
        "warnings": warnings,
        "errors": errors,
        "warnings_count": len(warnings),
        "errors_count": len(errors),
    }


class PluginInstallBody(BaseModel):
    name: str


@app.post("/plugins/install")
async def plugins_install(body: PluginInstallBody, _: None = Depends(verify_internal_token)):
    loader = _build_plugin_loader()
    target = str(body.name or "").strip()
    if not target:
        raise HTTPException(status_code=400, detail="name 不能为空")
    discovered = loader.discover()
    previous_installed = {p.name for p in loader.list_loaded()}
    try:
        loader.load(target)
        installed = {p.name for p in loader.list_loaded()}
        _save_plugins_state(sorted(installed))
        _sync_plugin_mcp_servers(discovered, installed)
        append_plugin_runtime_event(
            PROJECT_ROOT,
            "plugin_install",
            {"name": target, "installed": sorted(installed)},
        )
    except PermissionError as e:
        raise HTTPException(status_code=402, detail=_safe_error_detail(e))
    except ValueError as e:
        raise HTTPException(status_code=404, detail=_safe_error_detail(e))
    except Exception as e:
        # 安装链路回滚：恢复安装前插件集合与 MCP 启用态。
        try:
            _save_plugins_state(sorted(previous_installed))
            _sync_plugin_mcp_servers(discovered, previous_installed)
        except Exception as rollback_err:
            logger.error("插件安装回滚失败: %s", rollback_err)
        logger.exception("安装插件失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))
    new_spec = next((p for p in loader.list_loaded() if p.name == target), None)
    return {
        "ok": True,
        "installed": sorted(installed),
        "version": getattr(new_spec, "version", "") if new_spec else "",
    }


class PluginUninstallBody(BaseModel):
    name: str


class PluginUpgradeBody(BaseModel):
    name: str


@app.post("/plugins/upgrade")
async def plugins_upgrade(body: PluginUpgradeBody, _: None = Depends(verify_internal_token)):
    loader = _build_plugin_loader()
    target = str(body.name or "").strip()
    if not target:
        raise HTTPException(status_code=400, detail="name 不能为空")
    discovered = {p.name: p for p in loader.discover()}
    previous_spec = next((p for p in loader.list_loaded() if p.name == target), None)
    if previous_spec is None:
        raise HTTPException(status_code=404, detail=f"插件未安装: {target}")
    if target not in discovered:
        raise HTTPException(status_code=404, detail=f"未发现可升级目标: {target}")

    previous_installed = {p.name for p in loader.list_loaded()}
    try:
        loader.load(target)
        installed = {p.name for p in loader.list_loaded()}
        _save_plugins_state(sorted(installed))
        _sync_plugin_mcp_servers(list(discovered.values()), installed)
    except Exception as e:
        try:
            _save_plugins_state(sorted(previous_installed))
            _sync_plugin_mcp_servers(list(discovered.values()), previous_installed)
        except Exception as rollback_err:
            logger.error("插件升级回滚失败: %s", rollback_err)
        logger.exception("升级插件失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))

    new_spec = next((p for p in loader.list_loaded() if p.name == target), None)
    append_plugin_runtime_event(
        PROJECT_ROOT,
        "plugin_upgrade",
        {
            "name": target,
            "previous_version": getattr(previous_spec, "version", ""),
            "new_version": getattr(new_spec, "version", ""),
        },
    )
    return {
        "ok": True,
        "name": target,
        "previous_version": getattr(previous_spec, "version", ""),
        "new_version": getattr(new_spec, "version", ""),
        "upgraded": bool(
            new_spec
            and previous_spec
            and str(getattr(new_spec, "version", "")) != str(getattr(previous_spec, "version", ""))
        ),
        "installed": sorted(installed),
    }


@app.post("/plugins/uninstall")
async def plugins_uninstall(body: PluginUninstallBody, _: None = Depends(verify_internal_token)):
    loader = _build_plugin_loader()
    target = str(body.name or "").strip()
    if not target:
        raise HTTPException(status_code=400, detail="name 不能为空")
    loader.unload(target)
    installed = {p.name for p in loader.list_loaded() if p.name != target}
    _save_plugins_state(sorted(installed))
    _sync_plugin_mcp_servers(loader.discover(), installed)
    append_plugin_runtime_event(
        PROJECT_ROOT,
        "plugin_uninstall",
        {"name": target, "installed": sorted(installed)},
    )
    return {"ok": True, "installed": sorted(installed)}


@app.post("/plugins/sync")
async def plugins_sync(_: None = Depends(verify_internal_token)):
    registry = PluginRegistry(project_root=PROJECT_ROOT)
    result = registry.sync()
    return {"ok": True, **result}


def _collect_plugin_commands(loader: PluginLoader, include_content: bool = False) -> list[dict]:
    entries = []
    for path in loader.get_active_commands():
        try:
            p = Path(path)
            cmd = f"/{p.stem}"
            plugin = p.parent.parent.name
            text = p.read_text(encoding="utf-8")
            lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
            desc = ""
            for ln in lines[:8]:
                if ln.startswith("#"):
                    continue
                desc = ln
                break
            row = {
                "command": cmd,
                "command_key": f"{cmd}@{plugin}",
                "plugin": plugin,
                "path": str(p),
                "description": desc,
            }
            if include_content:
                row["content"] = text.strip()
            entries.append(row)
        except Exception as e:
            logger.debug("_collect_plugin_commands row: %s", e)
            continue
    sorted_entries = sorted(entries, key=lambda x: (str(x.get("command") or ""), str(x.get("plugin") or "")))
    # 标记同一 command 多插件冲突，便于前端展示
    from collections import defaultdict
    by_cmd = defaultdict(list)
    for e in sorted_entries:
        by_cmd[str(e.get("command") or "").strip()].append(e)
    for cmd_key, group in by_cmd.items():
        if not cmd_key or len(group) <= 1:
            continue
        plugins = [str(x.get("plugin") or "").strip() for x in group if x.get("plugin")]
        logger.warning("插件命令冲突：%s 被多个插件定义: %s", cmd_key, plugins)
        for e in group:
            e["conflict"] = True
            e["plugins"] = plugins
    return sorted_entries


@app.get("/plugins/commands")
async def plugins_commands():
    loader = _build_plugin_loader()
    return {
        "ok": True,
        "commands": _collect_plugin_commands(loader),
    }


@app.get("/plugins/runtime")
async def plugins_runtime(limit: int = Query(default=100, ge=1, le=500)):
    loader = _build_plugin_loader()
    loaded = loader.list_loaded()
    return {
        "ok": True,
        "plugins": [p.name for p in loaded],
        "versions": {p.name: getattr(p, "version", "") for p in loaded},
        "runtime": {
            "agents": loader.get_active_agents(),
            "hooks": loader.get_active_hooks(),
            "mcp": loader.get_active_mcp_configs(),
            "skills": loader.get_active_skill_paths(),
            "prompt_overlays": loader.get_active_prompt_overlays(),
        },
        "events": load_plugin_runtime_events(PROJECT_ROOT, limit=limit),
    }


class SlashCommandBody(BaseModel):
    command: str
    thread_id: Optional[str] = None


@app.post("/slash/execute")
async def slash_execute(body: SlashCommandBody):
    raw = str(body.command or "").strip()
    if not raw.startswith("/"):
        raise HTTPException(status_code=400, detail="必须以 / 开头")

    parts = raw.split()
    cmd_token = parts[0].lower()
    cmd, cmd_plugin = (cmd_token.split("@", 1) + [""])[:2]
    args = " ".join(parts[1:]).strip()

    if cmd in {"/plan", "/debug", "/review"}:
        mode = cmd[1:]
        return {"ok": True, "type": "switch_mode", "mode": mode, "thread_id": body.thread_id}

    if cmd == "/research":
        prompt = (
            f"请执行深度研究任务并输出结构化研究报告（含引用链、关键结论、证据与行动建议）：\n研究主题：{args}"
            if args
            else "请执行深度研究任务并输出结构化研究报告（含引用链、关键结论、证据与行动建议）。"
        )
        return {"ok": True, "type": "rewrite_prompt", "prompt": prompt}

    if cmd == "/plugins":
        data = await plugins_list()
        return {"ok": True, "type": "plugins_list", "plugins": data.get("plugins", []), "tier": data.get("tier")}

    if cmd == "/install":
        if not args:
            raise HTTPException(status_code=400, detail="用法：/install <plugin-name>")
        result = await plugins_install(PluginInstallBody(name=args))
        return {"ok": True, "type": "plugins_install", **result}

    if cmd == "/memory":
        return {
            "ok": True,
            "type": "rewrite_prompt",
            "prompt": (
                f"请优先检索与“{args}”相关的长期记忆，并返回来源、摘要和可执行建议。"
                if args
                else "请概览当前可用长期记忆主题，并给出可补充建议。"
            ),
        }

    if cmd == "/status":
        sub = (parts[1].lower() if len(parts) > 1 else "all").strip()
        if sub == "help":
            prompt = "\n".join(
                [
                    "请用简体中文返回系统状态命令帮助。",
                    "可用命令：",
                    "- /status",
                    "- /status all",
                    "- /status health",
                    "- /status rollout",
                    "- /status gate",
                    "- /status prompt",
                    "- /status prompt_modules|module|modules",
                    "- /status commands|command",
                    "并简要说明每个命令会返回什么。",
                ]
            )
        elif sub == "health":
            prompt = "请返回系统健康摘要（health + health_trend），并补充 health_score、components、summary，使用结构化 JSON。"
        elif sub == "rollout":
            prompt = "请返回 rollout 状态（stage、rollout_percentage、release_profile、runtime_summary），并补充 summary。"
        elif sub == "gate":
            prompt = "请返回 gate 状态与失败原因（若有），并说明是否通过质量门禁。"
        elif sub in {"commands", "command", "status_commands"}:
            prompt = "请重点返回 status commands 回归结果（status_command_regression_meta），并同时给出 health_score、components、summary。"
        elif sub in {"prompt", "prompt_modules", "module", "modules"}:
            prompt = "请重点返回 prompt modules 的健康巡检结果（prompt_module_health_meta），并同时给出 health_score、components、summary。"
        else:
            prompt = "请执行系统状态全量巡检并以结构化 JSON 返回，至少包含：health_score、components、summary、prompt_module_health_meta、status_command_regression_meta。"
        return {"ok": True, "type": "rewrite_prompt", "prompt": prompt}

    if cmd == "/compact":
        return {
            "ok": True,
            "type": "rewrite_prompt",
            "prompt": "请执行上下文压缩并返回简要结果：包含压缩前后上下文规模变化、保留的关键决策与未完成事项。",
        }

    if cmd == "/skills":
        return {
            "ok": True,
            "type": "rewrite_prompt",
            "prompt": (
                f"请调用 match_skills 检索与“{args}”最相关的技能，并返回 Top 5（skill_id、match_score、why）。"
                if args
                else "请调用 list_skills 列出当前可用技能，并按类别给出简要说明。"
            ),
        }

    if cmd == "/learn":
        return {
            "ok": True,
            "type": "rewrite_prompt",
            "prompt": (
                f"请将以下学习点写入 .learnings/LEARNINGS.md，并给出标准化条目格式：{args}"
                if args
                else "请基于当前会话生成 1-3 条可复用学习点并写入 .learnings/LEARNINGS.md。"
            ),
        }

    if cmd == "/persona":
        return {
            "ok": True,
            "type": "rewrite_prompt",
            "prompt": (
                f"请根据以下要求更新 .maibot/persona.json，并返回更新后的关键字段与变更说明：{args}"
                if args
                else "请读取并概览 .maibot/persona.json 当前配置，给出可优化建议。"
            ),
        }

    if cmd == "/trigger":
        return {
            "ok": True,
            "type": "rewrite_prompt",
            "prompt": (
                f"请基于当前触发器系统处理该请求：{args}。优先返回可执行的触发器变更建议（cron/file-watch/system-event/shortcut）。"
                if args
                else "请检查当前触发器状态，并返回已启用任务、下次触发时间与建议优化项。"
            ),
        }

    if cmd == "/scan":
        return {
            "ok": True,
            "type": "rewrite_prompt",
            "prompt": (
                f"请对以下范围执行环境扫描并返回结构化结果：{args}。包含能力缺口、可用资源、下一步建议。"
                if args
                else "请执行一次系统环境与能力扫描，返回结构化摘要：resources、capabilities、gaps、next_actions。"
            ),
        }

    if cmd == "/goals":
        return {
            "ok": True,
            "type": "rewrite_prompt",
            "prompt": (
                f"请根据以下输入更新 goals/active.md，并返回变更后的 Strategic/Current/Default：{args}"
                if args
                else "请读取 goals/active.md，返回当前目标栈并给出下一步执行建议。"
            ),
        }

    if cmd == "/approve":
        return {
            "ok": True,
            "type": "rewrite_prompt",
            "prompt": (
                f"请审阅并处理以下待审批项：{args}。返回批准建议、风险与回滚方案。"
                if args
                else "请列出当前待审批高风险动作，并给出逐项批准建议与风险说明。"
            ),
        }

    if cmd == "/evolve":
        return {
            "ok": True,
            "type": "rewrite_prompt",
            "prompt": (
                f"请针对该目标触发一次 propose-review-test-commit 自进化流程：{args}。先输出提案，再给验证计划。"
                if args
                else "请触发一次最小自我进化循环：生成提案、审查要点、测试计划与预期收益。"
            ),
        }

    if cmd == "/journal":
        return {
            "ok": True,
            "type": "rewrite_prompt",
            "prompt": (f"请聚合并总结 journal 记录，关注：{args}。" if args else "请读取今日 journal 并输出摘要：已完成、待处理、风险、下一步。"),
        }

    if cmd == "/cost":
        return {
            "ok": True,
            "type": "rewrite_prompt",
            "prompt": (
                f"请基于 data/cost_ledger.jsonl 做成本分析，重点关注：{args}，并给 ROI 优化建议。"
                if args
                else "请分析 data/cost_ledger.jsonl，返回最近成本趋势、主要开销来源和三条优化建议。"
            ),
        }

    loader = _build_plugin_loader()
    rows = _collect_plugin_commands(loader, include_content=True)
    if isinstance(rows, list):
        for row in rows:
            if not isinstance(row, dict):
                continue
            command = str(row.get("command") or "").strip().lower()
            if command != cmd:
                continue
            if cmd_plugin and str(row.get("plugin") or "").strip().lower() != cmd_plugin:
                continue
            plugin = str(row.get("plugin") or "plugin").strip()
            command_text = str(row.get("content") or "").strip()
            if not command_text:
                continue
            prompt = (
                f"请按以下插件命令执行（插件：{plugin}，命令：{cmd}）：\n\n{command_text}\n\n用户输入：{args}"
                if args
                else f"请按以下插件命令执行（插件：{plugin}，命令：{cmd}）：\n\n{command_text}"
            )
            return {
                "ok": True,
                "type": "rewrite_prompt",
                "source": "plugin_command",
                "plugin": plugin,
                "command": cmd,
                "prompt": prompt,
            }

    raise HTTPException(status_code=404, detail=f"不支持的命令: {cmd}")


class SkillInstallBody(BaseModel):
    name: Optional[str] = None
    domain: Optional[str] = "general"
    content: Optional[str] = None
    url: Optional[str] = None
    market_id: Optional[str] = None
    version: Optional[str] = None
    requires_tier: Optional[str] = None


class SkillUpdateAllBody(BaseModel):
    limit: int = 20

    @field_validator("limit")
    @classmethod
    def validate_limit(cls, v: int) -> int:
        iv = int(v)
        if iv < 1:
            return 1
        if iv > 100:
            return 100
        return iv


TRIAL_WINDOW_DAYS = 7
TRIAL_MAX_PER_WINDOW = 3


def _skills_trials_path() -> Path:
    """Skill 试用记录文件路径。"""
    try:
        from backend.tools.base.paths import DATA_PATH
        DATA_PATH.mkdir(parents=True, exist_ok=True)
        return DATA_PATH / "skills_trials.json"
    except ImportError:
        p = PROJECT_ROOT / "data"
        p.mkdir(parents=True, exist_ok=True)
        return p / "skills_trials.json"


def _load_skills_trials() -> list[dict]:
    p = _skills_trials_path()
    if not p.exists():
        return []
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except Exception as e:
        logger.debug("_load_skills_trials read_text: %s", e)
        return []
    if not isinstance(data, list):
        return []
    return [x for x in data if isinstance(x, dict)]


def _save_skills_trials(records: list[dict]) -> None:
    p = _skills_trials_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding="utf-8")


def _parse_utc_dt(value: Optional[str]) -> Optional[datetime]:
    text = (value or "").strip()
    if not text:
        return None
    try:
        dt = datetime.fromisoformat(text)
    except Exception as e:
        logger.debug("_parse_utc_dt fromisoformat: %s", e)
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _trial_status(record: dict, now: datetime) -> str:
    if bool(record.get("promoted")):
        return "promoted"
    if bool(record.get("cleaned")):
        return "cleaned"
    expires = _parse_utc_dt(str(record.get("expires_at") or ""))
    if expires and now >= expires:
        return "expired"
    return "active"


def _count_recent_trials(records: list[dict], *, now: datetime) -> int:
    window_start = now - timedelta(days=TRIAL_WINDOW_DAYS)
    count = 0
    for r in records:
        created = _parse_utc_dt(str(r.get("created_at") or ""))
        if created and created >= window_start:
            count += 1
    return count


def _relative_skill_key(relative_path: str) -> str:
    rel = (relative_path or "").strip().replace("\\", "/")
    rel = rel.removeprefix("knowledge_base/").removeprefix("skills/")
    parts = [p for p in rel.split("/") if p]
    if len(parts) < 3:
        return ""
    return f"{parts[0]}/{parts[1]}"


def _annotate_trial_record(record: dict, *, now: datetime) -> dict:
    row = dict(record)
    row["status"] = _trial_status(record, now)
    return row


class SkillTrialBody(BaseModel):
    name: Optional[str] = None
    domain: Optional[str] = "general"
    content: Optional[str] = None
    url: Optional[str] = None
    market_id: Optional[str] = None
    version: Optional[str] = None
    requires_tier: Optional[str] = None


class SkillDemoRunBody(BaseModel):
    market_id: Optional[str] = None
    name: Optional[str] = None
    domain: Optional[str] = None
    user_query: Optional[str] = None


@app.get("/skills/trial")
async def skills_trial_list():
    """列出 Skill 试用记录。"""
    now = datetime.now(timezone.utc)
    records = _load_skills_trials()
    rows = [_annotate_trial_record(r, now=now) for r in records]
    used = _count_recent_trials(records, now=now)
    return {
        "ok": True,
        "trials": rows,
        "total": len(rows),
        "limits": {
            "window_days": TRIAL_WINDOW_DAYS,
            "max_trials": TRIAL_MAX_PER_WINDOW,
            "used_in_window": used,
            "remaining": max(0, TRIAL_MAX_PER_WINDOW - used),
        },
    }


@app.post("/skills/trial")
async def skills_trial_create(body: SkillTrialBody):
    """创建 Skill 试用安装（7 天窗口最多 3 次）。"""
    now = datetime.now(timezone.utc)
    records = _load_skills_trials()
    used = _count_recent_trials(records, now=now)
    if used >= TRIAL_MAX_PER_WINDOW:
        raise HTTPException(
            status_code=429,
            detail=f"试用已达上限：{TRIAL_WINDOW_DAYS} 天内最多 {TRIAL_MAX_PER_WINDOW} 个。",
        )
    requires_tier = (body.requires_tier or "").strip().lower() or None
    if not requires_tier and (body.market_id or "").strip():
        try:
            market_data, _ = await _load_skills_market_payload()
            market_list = market_data.get("skills", []) if isinstance(market_data, dict) else []
            for item in market_list:
                if not isinstance(item, dict):
                    continue
                if str(item.get("id", "")).strip() == str(body.market_id).strip():
                    candidate = str(item.get("requires_tier", "")).strip().lower()
                    if candidate:
                        requires_tier = candidate
                    break
        except Exception as e:
            logger.debug("skill install: market tier lookup failed: %s", e)
    _ensure_skill_install_allowed(requires_tier)
    result = await _install_skill_from_market(
        name=body.name,
        domain=body.domain,
        content=body.content,
        url=body.url,
        version=body.version,
        market_id=body.market_id,
    )
    trial = {
        "id": f"trial_{uuid4().hex[:12]}",
        "name": result.get("name"),
        "domain": result.get("domain"),
        "path": result.get("path"),
        "relative_path": result.get("relative_path"),
        "market_id": (body.market_id or "").strip() or None,
        "version": (body.version or "").strip() or None,
        "created_at": now.isoformat(),
        "expires_at": (now + timedelta(days=TRIAL_WINDOW_DAYS)).isoformat(),
        "promoted": False,
        "cleaned": False,
    }
    records.append(trial)
    _save_skills_trials(records)
    return {
        "ok": True,
        "trial": _annotate_trial_record(trial, now=now),
        "limits": {
            "window_days": TRIAL_WINDOW_DAYS,
            "max_trials": TRIAL_MAX_PER_WINDOW,
            "used_in_window": used + 1,
            "remaining": max(0, TRIAL_MAX_PER_WINDOW - (used + 1)),
        },
    }


@app.post("/skills/trial/{trial_id}/promote")
async def skills_trial_promote(trial_id: str):
    """将试用 Skill 转正（保留安装并标记为正式）。"""
    now = datetime.now(timezone.utc)
    records = _load_skills_trials()
    target: Optional[dict] = None
    for r in records:
        if str(r.get("id") or "").strip() == trial_id:
            target = r
            break
    if target is None:
        raise HTTPException(status_code=404, detail="试用记录不存在")
    if bool(target.get("cleaned")):
        raise HTTPException(status_code=400, detail="该试用已清理，无法转正")
    quality_warning: Optional[dict] = None
    try:
        quality_item = {
            "name": target.get("name"),
            "domain": target.get("domain"),
            "path": target.get("path"),
            "relative_path": target.get("relative_path"),
        }
        market_id = str(target.get("market_id") or "").strip()
        if market_id:
            market_data, _ = await _load_skills_market_payload()
            market_list = market_data.get("skills", []) if isinstance(market_data, dict) else []
            market_hit = next(
                (
                    i
                    for i in market_list
                    if isinstance(i, dict) and str(i.get("id") or "").strip() == market_id
                ),
                None,
            )
            if isinstance(market_hit, dict):
                quality_item["description"] = market_hit.get("description")
                quality_item["capabilities_summary"] = market_hit.get("capabilities_summary")
        quality = _annotate_skill_quality([quality_item], default_tier="core")
        if quality and isinstance(quality[0], dict):
            quality_meta = quality[0]
            target["quality_gate_tier"] = quality_meta.get("quality_gate_tier")
            target["quality_gate_passed"] = bool(quality_meta.get("quality_gate_passed"))
            target["quality_gate_missing"] = quality_meta.get("quality_gate_missing") or []
            if not target["quality_gate_passed"]:
                quality_warning = {
                    "quality_gate_passed": False,
                    "quality_gate_tier": target.get("quality_gate_tier"),
                    "quality_gate_missing": target.get("quality_gate_missing"),
                    "message": "质量门未完全通过，已允许转正并建议尽快补齐。",
                }
                logger.warning(
                    "试用转正质量门未通过: trial_id=%s name=%s missing=%s",
                    trial_id,
                    str(target.get("name") or ""),
                    target.get("quality_gate_missing"),
                )
    except Exception as e:
        logger.debug("试用转正质量门检查失败（非关键）: %s", e)
    target["promoted"] = True
    target["promoted_at"] = now.isoformat()
    key = _relative_skill_key(str(target.get("relative_path") or ""))
    if key:
        _save_installed_version(key, target.get("version"), target.get("market_id"))
    _save_skills_trials(records)
    return {
        "ok": True,
        "trial": _annotate_trial_record(target, now=now),
        "quality_gate_warning": quality_warning,
    }


@app.post("/skills/demo-run")
async def skills_demo_run(body: SkillDemoRunBody):
    """
    Skill 效果对比演示（轻量版）：
    - baseline：无技能增强的通用回答
    - skill：根据市场 Skill 元信息生成的增强回答
    """
    user_query = str(body.user_query or "").strip() or "请给出该任务的执行步骤与风险提示。"
    market_id = str(body.market_id or "").strip()
    target_name = str(body.name or "").strip()
    target_domain = str(body.domain or "").strip().lower()

    target_item: Optional[dict] = None
    try:
        market_data, _ = await _load_skills_market_payload()
        market_list = market_data.get("skills", []) if isinstance(market_data, dict) else []
        for item in market_list:
            if not isinstance(item, dict):
                continue
            mid = str(item.get("id") or "").strip()
            name = str(item.get("name") or "").strip()
            domain = str(item.get("domain") or "general").strip().lower()
            if market_id and mid and market_id == mid:
                target_item = item
                break
            if target_name and name == target_name and (not target_domain or target_domain == domain):
                target_item = item
                break
    except Exception:
        target_item = None

    if target_item is None:
        raise HTTPException(status_code=404, detail="未找到要演示的 Skill")

    skill_name = str(target_item.get("name") or "Skill")
    skill_domain = str(target_item.get("domain") or "general")
    skill_desc = str(target_item.get("description") or "").strip()
    missing = target_item.get("quality_gate_missing")
    missing_count = len(missing) if isinstance(missing, list) else 0
    gate_passed = bool(target_item.get("quality_gate_passed")) if "quality_gate_passed" in target_item else (missing_count == 0)

    baseline_text = (
        f"【通用模式】\n"
        f"针对问题：{user_query}\n"
        f"我会先给出概览，再提供 2-3 个可执行步骤。由于没有启用领域技能，"
        f"具体术语、行业模板与风险清单可能不完整，建议后续人工补充。"
    )
    skill_text = (
        f"【{skill_name} 增强】\n"
        f"针对问题：{user_query}\n"
        f"- 领域：{skill_domain}\n"
        f"- 执行策略：先按技能内流程拆解步骤，再输出可直接执行的清单与检查点\n"
        f"- 风险控制：附带关键风险项与回退建议\n"
        + (f"- 技能说明：{skill_desc}\n" if skill_desc else "")
        + (f"- 质量门状态：{'通过' if gate_passed else f'待补齐 {missing_count} 项'}")
    )

    baseline_score = 62
    skill_score = 86 if gate_passed else max(70, 82 - min(12, missing_count * 2))
    return {
        "ok": True,
        "comparison": {
            "title": f"{skill_name} 效果对比",
            "left_title": "通用回答（未启用技能）",
            "right_title": f"{skill_name}（技能增强）",
            "left": baseline_text,
            "right": skill_text,
            "sample_input": user_query,
            "metrics": [
                {"label": "可执行度", "baseline": baseline_score, "skill": skill_score},
                {"label": "领域匹配度", "baseline": 58, "skill": 88 if gate_passed else 76},
                {"label": "风险覆盖", "baseline": 55, "skill": 84 if gate_passed else 72},
            ],
        },
    }


@app.delete("/skills/trial/{trial_id}")
async def skills_trial_delete(trial_id: str):
    """清理试用 Skill（删除文件并标记清理）。"""
    now = datetime.now(timezone.utc)
    records = _load_skills_trials()
    target: Optional[dict] = None
    for r in records:
        if str(r.get("id") or "").strip() == trial_id:
            target = r
            break
    if target is None:
        raise HTTPException(status_code=404, detail="试用记录不存在")
    if bool(target.get("promoted")):
        raise HTTPException(status_code=400, detail="已转正 Skill 不允许通过试用清理删除")
    if not bool(target.get("cleaned")):
        key = _relative_skill_key(str(target.get("relative_path") or ""))
        if key:
            from backend.tools.base.paths import SKILLS_ROOT
            domain, name = key.split("/", 1)
            skill_dir = SKILLS_ROOT / domain / name
            if skill_dir.exists():
                shutil.rmtree(skill_dir, ignore_errors=True)
            from backend.engine.skills.skill_registry import get_skill_registry
            get_skill_registry().discover_skills(force_reload=True)
        target["cleaned"] = True
        target["cleaned_at"] = now.isoformat()
        _save_skills_trials(records)
    return {"ok": True, "trial": _annotate_trial_record(target, now=now)}


async def _load_skills_market_payload() -> tuple[dict, str]:
    """
    统一加载 skills market 数据。
    支持两种模式：
    - local: 读取 backend/config/skills_market.json
    - remote: 读取 remote_url（失败时自动回退本地）
    """
    market_path = PROJECT_ROOT / "backend" / "config" / "skills_market.json"
    local_data: dict = {}
    if market_path.exists():
        try:
            local_data = json.loads(market_path.read_text(encoding="utf-8"))
        except Exception:
            local_data = {}
    source_type = str(local_data.get("source_type", "local") or "local").strip().lower() or "local"
    if source_type != "remote":
        return local_data, "local"

    remote_url = str(local_data.get("remote_url", "") or "").strip()
    if not remote_url:
        logger.warning("skills/market: source_type=remote 但未配置 remote_url，回退本地")
        return local_data, "local"
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(remote_url)
            resp.raise_for_status()
            remote_data = resp.json()
        if isinstance(remote_data, dict):
            # 继承本地默认配置字段，远端可覆盖
            merged = dict(local_data)
            merged.update(remote_data)
            return merged, "remote"
        logger.warning("skills/market: remote payload 非对象，回退本地")
        return local_data, "local"
    except Exception as e:
        logger.warning("skills/market: remote fetch failed, fallback local: %s", e)
        return local_data, "local"


def _skills_installed_versions_path() -> Path:
    """已安装 Skill 版本记录文件路径（用于检查更新）。"""
    try:
        from backend.tools.base.paths import DATA_PATH
        DATA_PATH.mkdir(parents=True, exist_ok=True)
        return DATA_PATH / "skills_installed_versions.json"
    except ImportError:
        return PROJECT_ROOT / "data" / "skills_installed_versions.json"


def _load_installed_versions() -> dict:
    """加载已安装版本记录。"""
    return _load_json_file_cached(_skills_installed_versions_path(), {})


def _save_installed_version(key: str, version: Optional[str], market_id: Optional[str]) -> None:
    """写入单条已安装版本（key 为 domain/name）。"""
    p = _skills_installed_versions_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    data = _load_installed_versions()
    data[key] = {"version": version or "", "market_id": market_id or ""}
    p.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    _invalidate_json_cache(p)


async def _install_skill_from_market(
    *,
    name: Optional[str],
    domain: Optional[str],
    content: Optional[str],
    url: Optional[str],
    version: Optional[str],
    market_id: Optional[str],
) -> dict:
    """内部复用：安装/更新单个 Skill。"""
    from backend.tools.base.paths import SKILLS_ROOT
    import re

    safe_domain = re.sub(r"[^\w\u4e00-\u9fa5\-]", "-", (domain or "general").strip()).strip("-") or "general"
    text = (content or "").strip()
    if (url or "").strip():
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.get(str(url).strip())
            r.raise_for_status()
            text = r.text
    if not text:
        raise HTTPException(status_code=400, detail="请提供 content 或 url")

    skill_name = (name or "").strip()
    if not skill_name:
        import re as re2
        m = re2.search(r"name:\s*([^\n]+)", text)
        skill_name = (m.group(1).strip() if m else "").strip() or "installed-skill"
    safe_name = re.sub(r"[^\w\u4e00-\u9fa5\-]", "-", skill_name).strip("-") or "installed-skill"

    skill_dir = SKILLS_ROOT / safe_domain / safe_name
    skill_dir.mkdir(parents=True, exist_ok=True)
    skill_md = skill_dir / "SKILL.md"
    skill_md.write_text(text, encoding="utf-8")
    if version is not None or market_id is not None:
        _save_installed_version(f"{safe_domain}/{safe_name}", version, market_id)
    from backend.engine.skills.skill_registry import get_skill_registry
    get_skill_registry().discover_skills(force_reload=True)
    return {
        "ok": True,
        "path": str(skill_md),
        "relative_path": f"skills/{safe_domain}/{safe_name}/SKILL.md",
        "name": skill_name,
        "domain": safe_domain,
    }


def _tier_rank(tier: str) -> int:
    return resolve_tier_rank(tier)


def _ensure_skill_install_allowed(requires_tier: Optional[str] = None) -> None:
    current_tier = _current_tier()
    try:
        ensure_tier_install_allowed(
            current_tier_value=current_tier,
            limits=_tier_limits(),
            current_custom_skills=_count_custom_skills(),
            requires_tier=requires_tier,
        )
    except TierPermissionError as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail)


@app.get("/skills/disabled")
async def skills_get_disabled():
    """返回全局禁用的 Skill 列表（domain/name）。P3 细粒度启用/禁用。"""
    try:
        from backend.engine.skills.skills_disabled import load_disabled_skills
        return {"ok": True, "disabled": load_disabled_skills()}
    except Exception as e:
        logger.debug("skills/disabled GET: %s", e)
        return {"ok": True, "disabled": []}


class SkillsDisabledBody(BaseModel):
    disabled: Optional[List[str]] = None  # "domain/name" 列表，空表示清空


@app.patch("/skills/disabled")
async def skills_patch_disabled(body: SkillsDisabledBody):
    """设置全局禁用的 Skill 列表（domain/name）。P3 细粒度启用/禁用。"""
    try:
        from backend.engine.skills.skills_disabled import save_disabled_skills
        keys = [str(k).strip() for k in (body.disabled or []) if str(k).strip()]
        save_disabled_skills(keys)
        return {"ok": True, "disabled": keys}
    except Exception as e:
        logger.warning("skills/disabled PATCH: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


@app.post("/skills/install")
async def skills_install(body: SkillInstallBody):
    """
    从市场安装 Skill：支持 content 直接写入，或 url 拉取后写入。
    写入 knowledge_base/skills/{domain}/{name}/SKILL.md，SkillRegistry 自动发现。
    若提供 version/market_id 则写入已安装版本记录，供检查更新使用。
    """
    try:
        requires_tier = (body.requires_tier or "").strip().lower() or None
        if not requires_tier and (body.market_id or "").strip():
            try:
                market_data, _ = await _load_skills_market_payload()
                market_list = market_data.get("skills", []) if isinstance(market_data, dict) else []
                for item in market_list:
                    if not isinstance(item, dict):
                        continue
                    if str(item.get("id", "")).strip() == str(body.market_id).strip():
                        candidate = str(item.get("requires_tier", "")).strip().lower()
                        if candidate:
                            requires_tier = candidate
                        break
            except Exception as e:
                logger.debug("market item requires_tier parse skip: %s", e)
        _ensure_skill_install_allowed(requires_tier)
        result = await _install_skill_from_market(
            name=body.name,
            domain=body.domain,
            content=body.content,
            url=body.url,
            version=body.version,
            market_id=body.market_id,
        )
        logger.info("✅ Skill 已安装: %s", result.get("path"))
        result["message"] = "安装成功"
        return result
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("安装 Skill 失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


@app.post("/skills/install-zip")
async def skills_install_zip(
    file: UploadFile = File(...),
    domain: str = Form("general"),
    name: str = Form(...),
):
    """
    上传 zip 安装 Skill（含 SKILL.md 与 scripts/ 等）。
    zip 解压到 knowledge_base/skills/{domain}/{name}/，禁止路径穿越。
    """
    import zipfile
    from backend.tools.base.paths import SKILLS_ROOT

    if not file.filename or not file.filename.lower().endswith(".zip"):
        raise HTTPException(status_code=400, detail="请上传 .zip 文件")
    safe_domain = re.sub(r"[^\w\u4e00-\u9fa5\-]", "-", (domain or "general").strip()).strip("-") or "general"
    safe_name = (name or "").strip()
    if not safe_name:
        raise HTTPException(status_code=400, detail="name 必填")
    safe_name = re.sub(r"[^\w\u4e00-\u9fa5\-]", "-", safe_name).strip("-") or "installed-skill"
    skill_dir = SKILLS_ROOT / safe_domain / safe_name
    skill_dir.mkdir(parents=True, exist_ok=True)
    base_resolved = skill_dir.resolve()
    try:
        raw = await file.read()
        with zipfile.ZipFile(io.BytesIO(raw), "r") as zf:
            for m in zf.namelist():
                if m.endswith("/"):
                    continue
                parts = Path(m).parts
                if ".." in parts:
                    raise HTTPException(status_code=400, detail="zip 内不得包含 .. 路径")
                dest = (skill_dir / m).resolve()
                if not str(dest).startswith(str(base_resolved)):
                    raise HTTPException(status_code=400, detail="路径非法")
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(zf.read(m))
    except zipfile.BadZipFile:
        raise HTTPException(status_code=400, detail="无效的 zip 文件")
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("install-zip 失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))
    from backend.engine.skills.skill_registry import get_skill_registry
    get_skill_registry().discover_skills(force_reload=True)
    return {
        "ok": True,
        "path": str(skill_dir),
        "relative_path": f"knowledge_base/skills/{safe_domain}/{safe_name}",
        "message": "安装成功",
    }


@app.get("/skills/check-updates")
async def skills_check_updates():
    """
    检查已安装 Skill 是否有市场更新。
    对比本地已安装版本与 skills_market.json 中的 version，返回可更新列表。
    """
    try:
        from backend.engine.skills.skill_registry import get_skill_registry
        from backend.tools.base.paths import SKILLS_ROOT
        registry = get_skill_registry()
        registry.discover_skills()
        installed_versions = _load_installed_versions()
        data, _ = await _load_skills_market_payload()
        market_list = data.get("skills", []) if isinstance(data, dict) else []
        updates = []
        builtin_total = 0
        builtin_by_source = {"official": 0, "builtin": 0, "learned": 0}
        for s in registry.get_all_skills():
            rel = getattr(s, "relative_path", "") or ""
            if not rel.startswith("knowledge_base/skills/") and not rel.startswith("skills/"):
                continue
            parts = rel.replace("knowledge_base/skills/", "").replace("skills/", "").strip("/").split("/")
            if len(parts) < 2:
                continue
            builtin_total += 1
            src = getattr(s, "source", "custom") or "custom"
            if src == "anthropic":
                builtin_by_source["official"] += 1
            elif src == "learned":
                builtin_by_source["learned"] += 1
            else:
                builtin_by_source["builtin"] += 1
            domain, name_dir = parts[0], parts[1]
            key = f"{domain}/{name_dir}"
            installed = installed_versions.get(key, {})
            current_ver = (installed.get("version") or "").strip()
            market_id = (installed.get("market_id") or "").strip()
            for m in market_list:
                mid = (m.get("id") or "").strip()
                mname = (m.get("name") or "").strip().lower()
                mdomain = (m.get("domain") or "general").strip().lower()
                mver = (m.get("version") or "").strip()
                murl = (m.get("url") or "").strip()
                if not murl:
                    continue
                match = (mid and mid == market_id) or (mname == name_dir.lower() and mdomain == domain.lower())
                if not match:
                    continue
                if mver and mver != current_ver:
                    updates.append({
                        "name": getattr(s, "display_name", None) or getattr(s, "name", name_dir),
                        "domain": domain,
                        "path": getattr(s, "path", ""),
                        "relative_path": rel,
                        "current_version": current_ver or None,
                        "market_version": mver,
                        "market_id": mid or None,
                        "url": murl,
                        "source": "market",
                    })
                break
        return {"ok": True, "updates": updates, "total": len(updates), "builtin_total": builtin_total, "builtin_by_source": builtin_by_source}
    except Exception as e:
        logger.warning("skills/check-updates: %s", e)
        return {"ok": True, "updates": [], "total": 0, "builtin_total": 0, "builtin_by_source": {"official": 0, "builtin": 0, "learned": 0}}


@app.post("/skills/update-all")
async def skills_update_all(body: SkillUpdateAllBody = Body(default=SkillUpdateAllBody())):
    """按更新列表批量更新 Skill（增量升级闭环）。"""
    try:
        checked = await skills_check_updates()
        updates = checked.get("updates", []) if isinstance(checked, dict) else []
        if not isinstance(updates, list):
            updates = []
        limit = body.limit if isinstance(body, SkillUpdateAllBody) else 20
        picked = updates[:limit]
        updated: List[dict] = []
        failed: List[dict] = []
        for item in picked:
            try:
                res = await _install_skill_from_market(
                    name=str((item or {}).get("name") or "").strip() or None,
                    domain=str((item or {}).get("domain") or "").strip() or "general",
                    content=None,
                    url=str((item or {}).get("url") or "").strip() or None,
                    version=str((item or {}).get("market_version") or "").strip() or None,
                    market_id=str((item or {}).get("market_id") or "").strip() or None,
                )
                updated.append(
                    {
                        "name": res.get("name"),
                        "domain": res.get("domain"),
                        "relative_path": res.get("relative_path"),
                        "market_version": (item or {}).get("market_version"),
                    }
                )
            except Exception as e:
                failed.append(
                    {
                        "name": (item or {}).get("name"),
                        "domain": (item or {}).get("domain"),
                        "url": (item or {}).get("url"),
                        "error": _safe_error_detail(e),
                    }
                )
        return {
            "ok": True,
            "checked_total": len(updates),
            "targeted": len(picked),
            "updated": updated,
            "failed": failed,
            "updated_count": len(updated),
            "failed_count": len(failed),
        }
    except Exception as e:
        logger.warning("skills/update-all: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


class VisionAnalyzeBody(BaseModel):
    path: Optional[str] = None
    url: Optional[str] = None
    max_bytes: int = 5 * 1024 * 1024

    @field_validator("max_bytes")
    @classmethod
    def validate_max_bytes(cls, v: int) -> int:
        iv = int(v)
        if iv < 64 * 1024:
            return 64 * 1024
        if iv > 20 * 1024 * 1024:
            return 20 * 1024 * 1024
        return iv


def _is_private_or_local_host(hostname: str) -> bool:
    host = (hostname or "").strip().lower()
    if not host:
        return True
    if host in {"localhost", "127.0.0.1", "::1"} or host.endswith(".local"):
        return True
    try:
        ip = ipaddress.ip_address(host)
        return ip.is_private or ip.is_loopback or ip.is_link_local
    except ValueError:
        pass
    try:
        resolved = socket.gethostbyname(host)
        ip = ipaddress.ip_address(resolved)
        return ip.is_private or ip.is_loopback or ip.is_link_local
    except Exception:
        # 解析失败视为高风险，拒绝
        return True


def _summarize_image_bytes(data: bytes) -> dict:
    basic = {
        "byte_size": len(data),
    }
    try:
        from PIL import Image, ImageStat  # type: ignore

        img = Image.open(io.BytesIO(data))
        try:
            width, height = img.size
            channels = len(img.getbands() or [])
            summary: dict = {
                **basic,
                "format": img.format,
                "mode": img.mode,
                "width": width,
                "height": height,
                "channels": channels,
                "has_alpha": "A" in (img.getbands() or ()),
                "aspect_ratio": round(width / height, 4) if height else None,
                "frames": int(getattr(img, "n_frames", 1) or 1),
            }
            try:
                exif = img.getexif()  # Pillow >= 6
                summary["exif_count"] = len(exif) if exif else 0
            except Exception:
                summary["exif_count"] = 0
            try:
                rgb = img.convert("RGB")
                stat = ImageStat.Stat(rgb)
                mean = [round(float(x), 2) for x in (stat.mean or [0, 0, 0])[:3]]
                extrema = stat.extrema[:3] if stat.extrema else []
                summary["mean_rgb"] = mean
                summary["rgb_extrema"] = extrema
            except Exception:
                pass
            return summary
        finally:
            img.close()
    except Exception:
        # Pillow 不可用或文件异常时，至少返回基础元信息
        return basic


@app.post("/multimodal/vision/analyze")
async def multimodal_vision_analyze(body: VisionAnalyzeBody):
    """轻量图像分析：本地路径或 URL 输入，返回图片元信息摘要。"""
    try:
        src_path = (body.path or "").strip()
        src_url = (body.url or "").strip()
        if not src_path and not src_url:
            raise HTTPException(status_code=400, detail="请提供 path 或 url")

        payload: bytes
        source: str
        if src_path:
            file_path = _resolve_read_path(src_path)
            payload = file_path.read_bytes()
            source = str(file_path)
        else:
            parsed = urlparse(src_url)
            if parsed.scheme not in {"http", "https"}:
                raise HTTPException(status_code=400, detail="url 仅支持 http/https")
            if _is_private_or_local_host(parsed.hostname or ""):
                raise HTTPException(status_code=400, detail="不允许访问内网/本地地址")
            async with httpx.AsyncClient(timeout=20.0, follow_redirects=True) as client:
                resp = await client.get(src_url)
                resp.raise_for_status()
                payload = resp.content
            source = src_url

        if not payload:
            raise HTTPException(status_code=400, detail="图片内容为空")
        if len(payload) > body.max_bytes:
            raise HTTPException(
                status_code=413,
                detail=f"图片过大：{len(payload)} bytes，超过限制 {body.max_bytes} bytes",
            )

        summary = _summarize_image_bytes(payload)
        width = summary.get("width")
        height = summary.get("height")
        fmt = summary.get("format") or "unknown"
        text = f"图片分析完成：{fmt}，{width or '?'}x{height or '?'}，{summary.get('byte_size', len(payload))} bytes"
        return {
            "ok": True,
            "source": source,
            "summary": text,
            "analysis": summary,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.warning("multimodal/vision/analyze: %s", e)
        return {"ok": False, "error": _safe_error_detail(e), "analysis": {}}


def _is_likely_text_file(path: Path) -> bool:
    """轻量判断：仅扫描常见文本文件，避免二进制文件误报和性能抖动。"""
    text_ext = {
        ".txt", ".md", ".json", ".yaml", ".yml", ".toml", ".ini", ".env", ".cfg", ".conf",
        ".py", ".ts", ".tsx", ".js", ".jsx", ".java", ".go", ".rs", ".sh", ".bash", ".zsh",
        ".sql", ".xml", ".properties", ".pem", ".key",
    }
    return path.suffix.lower() in text_ext or path.name.startswith(".env")


@app.get("/privacy/sensitive-files")
async def privacy_sensitive_files(limit: int = 200):
    """
    扫描工作区中可能的敏感文件（名称规则 + 内容特征），用于云端调用前风险提示。
    """
    try:
        workspace_root = get_workspace_root()
        if not workspace_root.exists():
            return {"ok": True, "workspace_root": str(workspace_root), "items": [], "total": 0}

        max_items = max(1, min(int(limit), 1000))
        ignore_dirs = {
            ".git", ".venv", "venv", "node_modules", "dist", "build", ".next", ".cache",
            "__pycache__", ".idea", ".cursor", ".maibot/logs",
        }
        filename_rules = _SENSITIVE_FILENAME_RULES
        content_rules = _SENSITIVE_CONTENT_RULES

        results: List[dict] = []
        for root, dirs, files in os.walk(workspace_root):
            dirs[:] = [d for d in dirs if d not in ignore_dirs and not d.startswith(".maibot")]
            base = Path(root)
            for fname in files:
                if len(results) >= max_items:
                    break
                path = base / fname
                rel = str(path.relative_to(workspace_root))
                reasons: List[str] = []

                for rx in filename_rules:
                    if rx.match(fname):
                        reasons.append("filename_pattern")
                        break

                # 小文件才做内容扫描，避免阻塞
                if _is_likely_text_file(path):
                    try:
                        if path.stat().st_size <= 256 * 1024:
                            text = path.read_text(encoding="utf-8", errors="ignore")
                            snippet = text[:20000]
                            for rx, tag in content_rules:
                                if rx.search(snippet):
                                    reasons.append(tag)
                    except Exception:
                        pass

                if reasons:
                    level = "high" if any(tag in reasons for tag in ("private_key_block", "openai_key_like", "aws_access_key_like")) else "medium"
                    results.append(
                        {
                            "path": rel,
                            "risk_level": level,
                            "reasons": sorted(set(reasons)),
                        }
                    )
            if len(results) >= max_items:
                break

        return {
            "ok": True,
            "workspace_root": str(workspace_root),
            "items": results,
            "total": len(results),
            "truncated": len(results) >= max_items,
        }
    except Exception as e:
        logger.warning("privacy/sensitive-files: %s", e)
        return {"ok": False, "items": [], "total": 0, "error": _safe_error_detail(e)}


# ========== 用户级文件版本（P3 Store 快照）==========
class FileVersionSnapshotBody(BaseModel):
    workspace_path: Optional[str] = None
    path: str  # 工作区相对路径
    content: str = ""
    description: str = ""


@app.post("/workspace/file-versions/snapshot")
async def workspace_file_version_snapshot(body: FileVersionSnapshotBody):
    """将文件内容保存为 Store 快照，供回退。path 为工作区相对路径；content 为空时从工作区读取。"""
    try:
        from backend.engine.core.main_graph import get_sqlite_store
        from backend.engine.file_version_store import save_file_version, prune_old_versions
        store = get_sqlite_store()
        ws = (body.workspace_path or "").strip() or str(get_workspace_root())
        path = (body.path or "").strip().lstrip("/")
        content = (body.content or "").strip()
        if not content and path:
            fp = _resolve_write_path("workspace/" + path if not path.startswith("workspace/") else path)
            if fp.exists() and fp.is_file():
                content = await asyncio.to_thread(fp.read_text, encoding="utf-8")
        if not path:
            raise HTTPException(status_code=400, detail="path is required")
        result = await asyncio.to_thread(
            save_file_version,
            store, ws, path, content or "", (body.description or "").strip()[:500]
        )
        await asyncio.to_thread(prune_old_versions, store, ws, path)
        return {"ok": True, **result}
    except HTTPException:
        raise
    except Exception as e:
        logger.warning("file-versions/snapshot: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


@app.get("/workspace/file-versions")
async def workspace_file_version_list(workspace_path: Optional[str] = None, path: str = ""):
    """列出某文件的 Store 快照列表。path 为工作区相对路径。"""
    try:
        from backend.engine.core.main_graph import get_sqlite_store
        from backend.engine.file_version_store import list_file_versions
        store = get_sqlite_store()
        ws = (workspace_path or "").strip() or str(get_workspace_root())
        path_n = (path or "").strip().lstrip("/")
        items = await asyncio.to_thread(list_file_versions, store, ws or None, path_n, 50)
        return {"ok": True, "path": path_n, "versions": items}
    except Exception as e:
        logger.debug("file-versions list: %s", e)
        return {"ok": True, "path": path or "", "versions": []}


class FileVersionGetBody(BaseModel):
    workspace_path: Optional[str] = None
    key: str


@app.post("/workspace/file-versions/get")
async def workspace_file_version_get_one(body: FileVersionGetBody):
    """按 key 取一条快照内容（含 content），用于预览或恢复。"""
    try:
        from backend.engine.core.main_graph import get_sqlite_store
        from backend.engine.file_version_store import get_file_version
        store = get_sqlite_store()
        ws = (body.workspace_path or "").strip() or str(get_workspace_root())
        val = await asyncio.to_thread(get_file_version, store, ws or None, (body.key or "").strip())
        if not val:
            raise HTTPException(status_code=404, detail="version not found")
        return {"ok": True, **val}
    except HTTPException:
        raise
    except Exception as e:
        logger.warning("file-versions/get: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


class FileVersionRestoreBody(BaseModel):
    workspace_path: Optional[str] = None
    key: str


@app.post("/workspace/file-versions/restore")
async def workspace_file_version_restore(body: FileVersionRestoreBody, _: None = Depends(verify_internal_token)):
    """将指定快照写回工作区文件。key 为 snapshot 返回的 key。"""
    try:
        from backend.engine.core.main_graph import get_sqlite_store
        from backend.engine.file_version_store import get_file_version
        store = get_sqlite_store()
        ws = (body.workspace_path or "").strip() or str(get_workspace_root())
        val = await asyncio.to_thread(get_file_version, store, ws or None, (body.key or "").strip())
        if not val or "content" not in val:
            raise HTTPException(status_code=404, detail="version not found")
        path_rel = (val.get("path") or "").strip().lstrip("/")
        if not path_rel:
            raise HTTPException(status_code=400, detail="invalid version path")
        write_path = _resolve_write_path("workspace/" + path_rel)  # from backend.api.common
        await asyncio.to_thread(_sync_write_text, write_path, val["content"])
        return {"ok": True, "path": path_rel, "restored": True}
    except HTTPException:
        raise
    except Exception as e:
        logger.warning("file-versions/restore: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


# ============================================================
# 模型管理 API（运行时 CRUD，持久化到 models.json）
# ============================================================

_ALLOWED_PROVIDERS = {"openai", "anthropic", "google_genai", "ollama", "azure_openai", "deepseek", "together", "fireworks"}


class ModelAddBody(BaseModel):
    id: str
    name: str
    display_name: Optional[str] = None
    url: Optional[str] = "http://localhost:1234/v1"
    description: Optional[str] = ""
    enabled: Optional[bool] = True
    priority: Optional[int] = 999
    context_length: Optional[int] = 65536
    config: Optional[dict] = None
    provider: Optional[str] = "openai"
    api_key: Optional[str] = None
    api_key_env: Optional[str] = None
    tier: Optional[str] = None
    cost_level: Optional[str] = None
    is_reasoning_model: Optional[bool] = None
    capability: Optional[Dict[str, Any]] = None
    role_affinity: Optional[Dict[str, float]] = None

    @field_validator("id")
    @classmethod
    def id_not_empty(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("模型 id 不能为空")
        return v.strip()

    @field_validator("name")
    @classmethod
    def name_not_empty(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("模型 name 不能为空")
        return v.strip()

    @field_validator("provider")
    @classmethod
    def provider_in_whitelist(cls, v: Optional[str]) -> Optional[str]:
        if v and v not in _ALLOWED_PROVIDERS:
            raise ValueError(f"provider 必须为以下之一: {', '.join(sorted(_ALLOWED_PROVIDERS))}")
        return v


class ModelUpdateBody(BaseModel):
    name: Optional[str] = None
    display_name: Optional[str] = None
    url: Optional[str] = None
    description: Optional[str] = None
    enabled: Optional[bool] = None
    priority: Optional[int] = None
    context_length: Optional[int] = None
    config: Optional[dict] = None
    provider: Optional[str] = None
    api_key: Optional[str] = None
    api_key_env: Optional[str] = None
    tier: Optional[str] = None
    cost_level: Optional[str] = None
    is_reasoning_model: Optional[bool] = None
    capability: Optional[Dict[str, Any]] = None
    role_affinity: Optional[Dict[str, float]] = None


@app.post("/models/add")
async def models_add(body: ModelAddBody, _: None = Depends(verify_internal_token)):
    """运行时添加模型，写入 backend/config/models.json。"""
    try:
        from backend.engine.agent.model_manager import get_model_manager
        manager = get_model_manager()
        info = manager.add_model(
            id=body.id,
            name=body.name,
            display_name=body.display_name,
            url=body.url or "http://localhost:1234/v1",
            description=body.description or "",
            enabled=body.enabled if body.enabled is not None else True,
            priority=body.priority or 999,
            context_length=body.context_length or 65536,
            config=body.config,
            provider=body.provider or "openai",
            api_key=body.api_key,
            api_key_env=body.api_key_env,
            tier=body.tier or "local",
            cost_level=body.cost_level or "unknown",
            is_reasoning_model=bool(body.is_reasoning_model) if body.is_reasoning_model is not None else False,
            capability=body.capability or {},
            role_affinity=body.role_affinity or {},
        )
        return {"ok": True, "model": {"id": info.id, "name": info.name}}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=_safe_error_detail(e))
    except Exception as e:
        logger.exception("添加模型失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


@app.put("/models/{model_id}")
async def models_update(model_id: str, body: ModelUpdateBody, _: None = Depends(verify_internal_token)):
    """运行时更新模型（部分字段）。"""
    try:
        from backend.engine.agent.model_manager import get_model_manager
        manager = get_model_manager()
        kwargs = {k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None}
        if not kwargs:
            raise HTTPException(status_code=400, detail="至少提供一个要更新的字段")
        info = manager.update_model(model_id, **kwargs)
        return {"ok": True, "model": {"id": info.id, "name": info.name}}
    except ValueError as e:
        msg = _safe_error_detail(e)
        if "云端发现模型" in (msg or ""):
            raise HTTPException(status_code=400, detail=msg)
        raise HTTPException(status_code=404, detail=msg)
    except Exception as e:
        logger.exception("更新模型失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


@app.delete("/models/{model_id}")
async def models_delete(model_id: str, _: None = Depends(verify_internal_token)):
    """运行时删除模型。不能删除当前默认模型。"""
    try:
        from backend.engine.agent.model_manager import get_model_manager
        manager = get_model_manager()
        deleted = manager.delete_model(model_id)
        if not deleted:
            raise HTTPException(status_code=404, detail=f"模型 {model_id} 不存在")
        return {"ok": True, "message": f"已删除模型 {model_id}"}
    except HTTPException:
        raise
    except ValueError as e:
        if "不能删除" in str(e):
            raise HTTPException(status_code=400, detail=_safe_error_detail(e))
        raise HTTPException(status_code=404, detail=_safe_error_detail(e))
    except Exception as e:
        logger.exception("删除模型失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


@app.get("/models/recommend")
async def models_recommend(role_id: str):
    """按角色返回模型推荐清单。"""
    try:
        from backend.engine.agent.model_manager import get_model_manager

        manager = get_model_manager()
        await manager.refresh_availability_async(force=False)
        recs = manager.get_recommended_models_for_role(role_id=role_id, limit=8)
        return {
            "ok": True,
            "role_id": role_id,
            "recommendations": recs,
        }
    except Exception as e:
        logger.exception("获取模型推荐失败: role_id=%s", role_id)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


# ============================================================
# 系统信息 API
# ============================================================

@app.get("/system/info")
async def get_system_info():
    """获取系统信息"""
    import platform
    try:
        import psutil  # type: ignore[import-untyped]
    except ImportError:
        return {"ok": False, "error": "psutil not installed", "platform": platform.system(), "python_version": platform.python_version()}
    try:
        _ws = get_workspace_root()
        _upload_dir = _ws / "uploads"
    except Exception:
        _ws = WORKSPACE_DIR
        _upload_dir = UPLOAD_DIR
    return {
        "platform": platform.system(),
        "python_version": platform.python_version(),
        "cpu_count": psutil.cpu_count(),
        "memory_total": psutil.virtual_memory().total,
        "memory_available": psutil.virtual_memory().available,
        "disk_usage": {
            "total": psutil.disk_usage('/').total,
            "used": psutil.disk_usage('/').used,
            "free": psutil.disk_usage('/').free,
        },
        "project_root": str(PROJECT_ROOT),
        "upload_dir": str(_upload_dir),
        "knowledge_dir": str(KNOWLEDGE_DIR),
        "workspace_dir": str(_ws),
    }


@app.get("/system/config")
async def get_system_config():
    """获取当前系统配置（生产级诊断）
    
    返回所有可配置参数的当前值，用于：
    - 诊断配置问题
    - 验证环境变量是否生效
    - 监控配置变更
    """
    try:
        from backend.engine.agent.deep_agent import get_config_summary
        return get_config_summary()
    except Exception as e:
        logger.error(f"❌ 获取配置失败: {e}")
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


def _upgrade_runs_log_path() -> Path:
    return PROJECT_ROOT / "data" / "upgrade_runs.jsonl"


def _append_upgrade_run(row: dict) -> None:
    try:
        p = _upgrade_runs_log_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        with p.open("a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    except Exception as e:
        logger.debug("append upgrade run failed: %s", e)


def _load_upgrade_runs(limit: int = 30) -> List[dict]:
    p = _upgrade_runs_log_path()
    if not p.exists():
        return []
    out: List[dict] = []
    try:
        for line in p.read_text(encoding="utf-8").splitlines():
            t = line.strip()
            if not t:
                continue
            try:
                row = json.loads(t)
                if isinstance(row, dict):
                    out.append(row)
            except Exception as e:
                logger.debug("read jsonl line failed: %s", e)
                continue
    except Exception as e:
        logger.warning("read_jsonl_file failed: %s", e)
        return []
    out.reverse()
    return out[: max(1, min(limit, 200))]


def _run_upgrade_status_report(section: str = "all", refresh: bool = False, timeout_sec: int = 300) -> dict:
    script = PROJECT_ROOT / "backend" / "tools" / "upgrade" / "system_status_report.py"
    argv = [
        os.environ.get("PYTHON", "python3"),
        str(script),
        "--section",
        section,
    ]
    if refresh:
        argv.append("--refresh")
    out = subprocess.run(
        argv,
        cwd=str(PROJECT_ROOT),
        capture_output=True,
        text=True,
        timeout=timeout_sec,
        check=False,
    )
    payload = {}
    stdout = (out.stdout or "").strip()
    if stdout:
        try:
            payload = json.loads(stdout.splitlines()[-1])
        except Exception:
            payload = {}
    return {
        "exit_code": int(out.returncode),
        "payload": payload if isinstance(payload, dict) else {},
        "stdout_tail": stdout[-2000:],
        "stderr_tail": (out.stderr or "")[-1200:],
    }


def _version_from_project_name() -> str:
    # 例如 ccb-v0.378 -> 0.378
    name = PROJECT_ROOT.name
    if "-v" in name:
        return name.split("-v", 1)[1].strip()
    return os.getenv("APP_VERSION", "").strip()


def _compare_version_simple(current: str, remote: str) -> bool:
    # 轻量比较：不同即视为可更新，避免强依赖 semver 解析库
    c = str(current or "").strip()
    r = str(remote or "").strip()
    return bool(r and r != c)


@app.get("/upgrade/status")
async def get_upgrade_status(section: str = Query(default="rollout"), refresh: bool = Query(default=False)):
    """读取升级运行状态（可选 refresh 会先触发升级编排脚本再汇总状态）。"""
    try:
        allowed = {"all", "health", "rollout", "gate", "prompt_modules", "status_commands"}
        sec = section if section in allowed else "rollout"
        result = await asyncio.to_thread(_run_upgrade_status_report, sec, refresh, 300)
        ok = result.get("exit_code", 1) == 0
        return {
            "ok": ok,
            "section": sec,
            "refresh": refresh,
            "status": result.get("payload", {}),
            "stdout_tail": result.get("stdout_tail", ""),
            "stderr_tail": result.get("stderr_tail", ""),
        }
    except Exception as e:
        logger.exception("读取升级状态失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


@app.get("/upgrade/runs")
async def list_upgrade_runs(limit: int = Query(default=30, ge=1, le=200)):
    """查看最近升级触发记录（本地日志）。"""
    try:
        rows = await asyncio.to_thread(_load_upgrade_runs, limit)
        return {"ok": True, "rows": rows, "total": len(rows)}
    except Exception as e:
        logger.exception("读取升级运行日志失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


@app.post("/upgrade/check")
async def check_upgrade(manifest_url: str = Body(default="", embed=True)):
    """
    检查远程升级清单。
    - 优先使用 body.manifest_url
    - 若为空，回退读取 .maibot/settings.json.upgrade.remote_manifest_url
    """
    try:
        target_url = str(manifest_url or "").strip()
        if not target_url:
            try:
                from backend.tools.base.paths import get_workspace_root
                settings_path = get_workspace_root() / ".maibot" / "settings.json"
                if settings_path.exists():
                    settings = json.loads(settings_path.read_text(encoding="utf-8"))
                    if isinstance(settings, dict):
                        up = settings.get("upgrade") if isinstance(settings.get("upgrade"), dict) else {}
                        target_url = str(up.get("remote_manifest_url", "") or "").strip()
            except Exception:
                target_url = ""
        if not target_url:
            return {
                "ok": False,
                "message": "未配置 manifest_url（可在 .maibot/settings.json.upgrade.remote_manifest_url 设置）",
                "update_available": False,
            }
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.get(target_url)
            r.raise_for_status()
            manifest = r.json()
        if not isinstance(manifest, dict):
            raise HTTPException(status_code=400, detail="远程 manifest 必须是 JSON 对象")
        current_version = _version_from_project_name()
        remote_version = str(manifest.get("version", "") or "").strip()
        update_available = _compare_version_simple(current_version, remote_version)
        return {
            "ok": True,
            "manifest_url": target_url,
            "current_version": current_version,
            "remote_version": remote_version,
            "update_available": update_available,
            "manifest": manifest,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("检查远程升级失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


@app.post("/upgrade/trigger")
async def trigger_upgrade(refresh_status: bool = Body(default=True, embed=True)):
    """
    触发升级编排脚本（auto_rollout_upgrade.py）。
    返回执行摘要，并写入本地 upgrade_runs 日志。
    """
    try:
        ts = datetime.now(timezone.utc).isoformat()
        script = PROJECT_ROOT / "backend" / "tools" / "upgrade" / "auto_rollout_upgrade.py"
        argv = [os.environ.get("PYTHON", "python3"), str(script)]
        proc = await asyncio.to_thread(
            lambda: subprocess.run(
                argv,
                cwd=str(PROJECT_ROOT),
                capture_output=True,
                text=True,
                timeout=600,
                check=False,
            )
        )
        exit_code = int(proc.returncode)
        row = {
            "ts": ts,
            "action": "auto_rollout_upgrade",
            "exit_code": exit_code,
            "stdout_tail": (proc.stdout or "")[-2000:],
            "stderr_tail": (proc.stderr or "")[-1200:],
        }
        _append_upgrade_run(row)
        status_payload = {}
        if refresh_status:
            try:
                status_res = await asyncio.to_thread(_run_upgrade_status_report, "rollout", False, 180)
                status_payload = status_res.get("payload", {}) if isinstance(status_res, dict) else {}
            except Exception:
                status_payload = {}
        return {
            "ok": exit_code == 0,
            "run": row,
            "status": status_payload,
        }
    except Exception as e:
        logger.exception("触发升级失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


@app.get("/autonomous/schedule-state")
async def get_autonomous_schedule_state(
    limit: int = Query(default=30, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    task_id: Optional[str] = Query(default=None),
    thread_id: Optional[str] = Query(default=None),
    start_at: Optional[str] = Query(default=None),
    end_at: Optional[str] = Query(default=None),
):
    """读取自治任务调度状态（最近触发记录 + 每任务最近 slot）。"""
    try:
        from backend.tools.base.paths import get_project_root
        p = get_project_root() / "data" / "autonomous_task_state.json"
        if not p.exists():
            return {"ok": True, "tasks": {}, "recent_runs": []}
        raw = json.loads(p.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            return {"ok": True, "tasks": {}, "recent_runs": []}
        tasks = raw.get("tasks", {})
        recent_runs = raw.get("recent_runs", [])
        if not isinstance(tasks, dict):
            tasks = {}
        if not isinstance(recent_runs, list):
            recent_runs = []
        normalized_runs = []
        for item in recent_runs:
            if not isinstance(item, dict):
                continue
            normalized_runs.append(
                {
                    "task_id": item.get("task_id"),
                    "subject": item.get("subject"),
                    "slot": item.get("slot"),
                    "triggered_at": item.get("triggered_at"),
                    "thread_id": item.get("thread_id"),
                    "run_id": item.get("run_id"),
                }
            )
        if task_id:
            normalized_runs = [r for r in normalized_runs if str(r.get("task_id") or "") == str(task_id)]
        if thread_id:
            normalized_runs = [r for r in normalized_runs if str(r.get("thread_id") or "") == str(thread_id)]

        def _to_dt(raw: Optional[str]) -> Optional[datetime]:
            if not raw:
                return None
            try:
                return datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
            except Exception:
                return None

        start_dt = _to_dt(start_at)
        end_dt = _to_dt(end_at)
        if start_dt or end_dt:
            filtered = []
            for r in normalized_runs:
                rt = _to_dt(r.get("triggered_at"))
                if rt is None:
                    continue
                if start_dt and rt < start_dt:
                    continue
                if end_dt and rt > end_dt:
                    continue
                filtered.append(r)
            normalized_runs = filtered

        normalized_runs.sort(key=lambda r: str(r.get("triggered_at") or ""), reverse=True)
        total = len(normalized_runs)
        paged = normalized_runs[offset: offset + limit]
        return {
            "ok": True,
            "tasks": tasks,
            "recent_runs": paged,
            "total": total,
            "offset": offset,
            "limit": limit,
        }
    except Exception as e:
        logger.exception("读取自治调度状态失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


class AutonomousWatcherConfigBody(BaseModel):
    enabled: bool
    role_id: Optional[str] = ""


class AutonomyLevelConfigBody(BaseModel):
    level: str
    require_tool_approval: Optional[bool] = None
    allow_idle_loop: Optional[bool] = None
    allow_gated_code_changes: Optional[bool] = None
    auto_accept_tools: Optional[List[str]] = None

    @field_validator("level")
    @classmethod
    def _validate_level(cls, v: str) -> str:
        level = str(v or "").upper().strip()
        if level not in {"L0", "L1", "L2", "L3"}:
            raise ValueError("level must be one of L0/L1/L2/L3")
        return level


def _list_available_roles_for_watcher() -> List[dict]:
    try:
        from backend.engine.roles import list_roles
        roles = list_roles()
        result: List[dict] = []
        for role in roles:
            if not isinstance(role, dict):
                continue
            rid = str(role.get("id", "") or "").strip()
            if not rid:
                continue
            result.append(
                {
                    "id": rid,
                    "label": str(role.get("label", "") or rid),
                    "skill_profile": str(role.get("skill_profile", "") or ""),
                }
            )
        return result
    except Exception:
        return []


@app.get("/autonomous/watcher/config")
async def get_autonomous_watcher_config():
    """读取自治巡检 watcher 配置与运行状态。"""
    try:
        settings = _load_workspace_settings_dict()
        autonomous = settings.get("autonomous", {}) if isinstance(settings, dict) else {}
        cfg_enabled = bool(autonomous.get("task_watcher_enabled", False)) if isinstance(autonomous, dict) else False
        cfg_role_id = str(autonomous.get("task_watcher_role_id", "") or "").strip() if isinstance(autonomous, dict) else ""
        runtime = {}
        try:
            from backend.engine.tasks.task_watcher import get_watcher_runtime_state
            runtime = get_watcher_runtime_state()
        except Exception as e:
            logger.debug("get_watcher_runtime_state: %s", e)
            runtime = {"enabled": False, "assistant_id": "", "scope": "personal", "scheduler_running": False, "executing_tasks": 0}
        return {
            "ok": True,
            "config": {"enabled": cfg_enabled, "role_id": cfg_role_id},
            "runtime": runtime,
            "available_roles": _list_available_roles_for_watcher(),
        }
    except Exception as e:
        logger.exception("读取自治巡检配置失败: %s", e)
        return {
            "ok": False,
            "error": _safe_error_detail(e),
            "config": {"enabled": False, "role_id": ""},
            "runtime": {},
            "available_roles": [],
        }


@app.post("/autonomous/watcher/config")
async def update_autonomous_watcher_config(body: AutonomousWatcherConfigBody):
    """更新自治巡检 watcher 配置并立即应用运行态（start/stop）。"""
    try:
        enabled = bool(body.enabled)
        role_id = str(body.role_id or "").strip()
        settings = _load_workspace_settings_dict()
        autonomous = settings.get("autonomous", {}) if isinstance(settings.get("autonomous", {}), dict) else {}

        from backend.engine.tasks.task_watcher import (
            get_watcher_runtime_state,
            register_builtin_autonomous_tasks,
            start_watcher_background,
            stop_watcher_background,
        )

        if enabled:
            runtime_pending = False
            try:
                await asyncio.wait_for(
                    register_builtin_autonomous_tasks(),
                    timeout=float(os.getenv("WATCHER_CONFIG_APPLY_TIMEOUT_SEC", "6")),
                )
            except asyncio.TimeoutError:
                runtime_pending = True
                logger.warning("watcher config apply: register_builtin_autonomous_tasks timeout，继续应用 watcher 运行态")
            resolved_role_id = role_id
            if not resolved_role_id:
                resolved_role_id = _resolve_default_watcher_role("assistant")
            if not resolved_role_id:
                autonomous["task_watcher_enabled"] = enabled
                autonomous["task_watcher_role_id"] = role_id
                settings["autonomous"] = autonomous
                _save_workspace_settings_dict(settings)
                return {
                    "ok": False,
                    "error": "未找到可用 role_id，请先配置角色或在设置中填写",
                    "config": {"enabled": enabled, "role_id": role_id},
                    "runtime": get_watcher_runtime_state(),
                    "available_roles": _list_available_roles_for_watcher(),
                }
            autonomous["task_watcher_enabled"] = enabled
            autonomous["task_watcher_role_id"] = resolved_role_id
            settings["autonomous"] = autonomous
            _save_workspace_settings_dict(settings)
            stop_watcher_background()
            start_watcher_background(resolved_role_id, scope="personal")
            runtime = get_watcher_runtime_state()
            return {
                "ok": True,
                "config": {"enabled": enabled, "role_id": resolved_role_id},
                "runtime": runtime,
                "runtime_pending": runtime_pending,
                "available_roles": _list_available_roles_for_watcher(),
            }

        autonomous["task_watcher_enabled"] = False
        autonomous["task_watcher_role_id"] = role_id
        settings["autonomous"] = autonomous
        _save_workspace_settings_dict(settings)
        stop_watcher_background()
        runtime = get_watcher_runtime_state()
        return {
            "ok": True,
            "config": {"enabled": False, "role_id": role_id},
            "runtime": runtime,
            "available_roles": _list_available_roles_for_watcher(),
        }
    except Exception as e:
        logger.exception("更新自治巡检配置失败: %s", e)
        return {"ok": False, "error": _safe_error_detail(e), "available_roles": _list_available_roles_for_watcher()}


@app.post("/autonomous/watcher/observability/reset")
async def reset_autonomous_watcher_observability():
    """重置 watcher invites 观测计数。"""
    try:
        from backend.engine.tasks.task_watcher import get_watcher_runtime_state, reset_invites_observability

        invites = reset_invites_observability()
        return {"ok": True, "invites_observability": invites, "runtime": get_watcher_runtime_state()}
    except Exception as e:
        logger.exception("重置自治巡检观测计数失败: %s", e)
        return {"ok": False, "error": _safe_error_detail(e)}


@app.get("/autonomous/level/config")
async def get_autonomy_level_config():
    """读取渐进式自主级别配置（L0-L3）。"""
    try:
        from backend.engine.autonomy.levels import get_autonomy_settings

        settings = get_autonomy_settings()
        return {"ok": True, "config": settings}
    except Exception as e:
        logger.exception("读取自主级别配置失败: %s", e)
        return {"ok": False, "error": _safe_error_detail(e), "config": {"level": "L1"}}


@app.post("/autonomous/level/config")
async def update_autonomy_level_config(body: AutonomyLevelConfigBody):
    """更新渐进式自主级别配置（持久化到 .maibot/settings.json.autonomous）。"""
    try:
        from backend.engine.autonomy.levels import get_autonomy_settings, _clamp_level_by_tier

        clamped_level = _clamp_level_by_tier(body.level)
        if clamped_level != body.level:
            logger.info("自主级别 %s 超出许可证限制，已钳位至 %s", body.level, clamped_level)

        settings = _load_workspace_settings_dict()
        autonomous = settings.get("autonomous", {}) if isinstance(settings.get("autonomous", {}), dict) else {}
        autonomous["level"] = clamped_level
        if body.require_tool_approval is not None:
            autonomous["require_tool_approval"] = bool(body.require_tool_approval)
        if body.allow_idle_loop is not None:
            autonomous["allow_idle_loop"] = bool(body.allow_idle_loop)
        if body.allow_gated_code_changes is not None:
            autonomous["allow_gated_code_changes"] = bool(body.allow_gated_code_changes)
        if body.auto_accept_tools is not None:
            autonomous["auto_accept_tools"] = [str(x).strip() for x in body.auto_accept_tools if str(x).strip()]
        settings["autonomous"] = autonomous
        _save_workspace_settings_dict(settings)
        return {"ok": True, "config": get_autonomy_settings()}
    except Exception as e:
        logger.exception("更新自主级别配置失败: %s", e)
        return {"ok": False, "error": _safe_error_detail(e)}


class AutonomousTaskUpdateBody(BaseModel):
    enabled: Optional[bool] = None
    schedule: Optional[str] = None
    description: Optional[str] = None
    auto_assign: Optional[bool] = None


def _autonomous_tasks_config_path() -> Path:
    return PROJECT_ROOT / "backend" / "config" / "autonomous_tasks.json"


def _load_autonomous_tasks() -> List[dict]:
    p = _autonomous_tasks_config_path()
    if not p.exists():
        return []
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except Exception:
        return []


def _save_autonomous_tasks(items: List[dict]) -> None:
    p = _autonomous_tasks_config_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(items, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


@app.get("/autonomous/tasks")
async def list_autonomous_tasks():
    """读取自治任务配置（autonomous_tasks.json）。"""
    try:
        tasks = _load_autonomous_tasks()
        return {"ok": True, "tasks": tasks, "total": len(tasks)}
    except Exception as e:
        logger.exception("读取自治任务配置失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


@app.patch("/autonomous/tasks/{task_id}")
async def update_autonomous_task(task_id: str, body: AutonomousTaskUpdateBody):
    """更新单个自治任务配置（启停/调度规则/描述）。"""
    try:
        items = _load_autonomous_tasks()
        idx = next((i for i, it in enumerate(items) if str((it or {}).get("id") or "") == task_id), -1)
        if idx < 0:
            raise HTTPException(status_code=404, detail="自治任务不存在")
        current = dict(items[idx] or {})
        updates = body.model_dump(exclude_unset=True)
        if not updates:
            raise HTTPException(status_code=400, detail="至少提供一个更新字段")
        current.update({k: v for k, v in updates.items() if v is not None})
        items[idx] = current
        _save_autonomous_tasks(items)
        return {"ok": True, "task": current}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("更新自治任务失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


@app.post("/autonomous/tasks/{task_id}/trigger")
async def trigger_autonomous_task(task_id: str):
    """手动触发自治任务（创建后台任务执行）。"""
    try:
        items = _load_autonomous_tasks()
        item = next((it for it in items if str((it or {}).get("id") or "") == task_id), None)
        if not isinstance(item, dict):
            raise HTTPException(status_code=404, detail="自治任务不存在")
        from backend.engine.tasks.task_service import create_task

        subject = str(item.get("subject") or task_id)
        description = str(item.get("description") or subject)
        task_type = str(item.get("task_type") or "").strip()
        required_skills = item.get("required_skills") if isinstance(item.get("required_skills"), list) else None
        created = await create_task(
            subject=subject,
            description=description,
            config={
                "mode": "agent",
                "scene": "full",
                **({"task_type": task_type} if task_type else {}),
            },
            priority=3,
            created_by="autonomous_scheduler_manual",
            use_router=False,
            required_skills=required_skills,
            background=True,
        )
        # 手动触发也写入调度状态，便于前端统一展示“触发历史/运行详情”
        try:
            from backend.tools.base.paths import get_project_root
            p = get_project_root() / "data" / "autonomous_task_state.json"
            state = {"tasks": {}, "recent_runs": []}
            if p.exists():
                raw = json.loads(p.read_text(encoding="utf-8"))
                if isinstance(raw, dict):
                    state = raw
            state.setdefault("tasks", {})
            state.setdefault("recent_runs", [])
            tasks_state = state.get("tasks") if isinstance(state.get("tasks"), dict) else {}
            tasks_state[task_id] = {
                "last_slot": f"manual:{datetime.now(timezone.utc).isoformat()}",
                "last_run_at": datetime.now(timezone.utc).isoformat(),
            }
            state["tasks"] = tasks_state
            recent = state.get("recent_runs") if isinstance(state.get("recent_runs"), list) else []
            recent.append(
                {
                    "task_id": task_id,
                    "subject": subject,
                    "slot": "manual",
                    "triggered_at": datetime.now(timezone.utc).isoformat(),
                    "thread_id": str((created or {}).get("thread_id") or ""),
                    "run_id": str((created or {}).get("run_id") or ""),
                }
            )
            state["recent_runs"] = recent[-100:]
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        except Exception as e:
            logger.debug("autonomous trigger: write recent_runs state failed: %s", e)
        return {"ok": True, "task_id": task_id, "created": created}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("手动触发自治任务失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


@app.get("/autonomous/runs/{run_id}")
async def get_autonomous_run_detail(run_id: str, limit: int = Query(default=20, ge=1, le=100)):
    """
    查询单次自治调度运行详情（线程ID、任务配置、执行日志）。
    """
    try:
        from backend.tools.base.paths import get_project_root

        p = get_project_root() / "data" / "autonomous_task_state.json"
        if not p.exists():
            raise HTTPException(status_code=404, detail="未找到自治调度状态文件")
        raw = json.loads(p.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            raise HTTPException(status_code=404, detail="自治调度状态为空")
        recent_runs = raw.get("recent_runs", [])
        if not isinstance(recent_runs, list):
            recent_runs = []
        run = next((r for r in recent_runs if isinstance(r, dict) and str(r.get("run_id") or "") == run_id), None)
        if not isinstance(run, dict):
            raise HTTPException(status_code=404, detail="未找到该 run_id 对应记录")

        thread_id = str(run.get("thread_id") or "")
        logs: List[dict] = []
        if thread_id:
            try:
                from backend.engine.logging.execution_logger import get_execution_logger
                logger_instance = get_execution_logger()
                raw_logs = logger_instance.get_task_logs(thread_id, limit=limit, status=None)
                logs = raw_logs if isinstance(raw_logs, list) else []
            except Exception as e:
                logger.debug("get_task_logs: %s", e)
                logs = []

        config_item = None
        try:
            items = _load_autonomous_tasks()
            task_key = str(run.get("task_id") or "")
            config_item = next((it for it in items if str((it or {}).get("id") or "") == task_key), None)
        except Exception as e:
            logger.debug("get_execution_trace config_item: %s", e)
            config_item = None

        return {
            "ok": True,
            "run": run,
            "thread_id": thread_id or None,
            "task_config": config_item,
            "logs": logs,
            "logs_count": len(logs),
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("读取自治运行详情失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


@app.post("/autonomous/runs/{run_id}/cancel")
async def cancel_autonomous_run(run_id: str):
    """取消单次自治运行（基于 run_id 反查 thread_id 并取消任务）。"""
    try:
        from backend.tools.base.paths import get_project_root
        from backend.engine.tasks.task_service import cancel_task, TaskNotFoundError

        p = get_project_root() / "data" / "autonomous_task_state.json"
        if not p.exists():
            raise HTTPException(status_code=404, detail="未找到自治调度状态文件")
        raw = json.loads(p.read_text(encoding="utf-8"))
        recent_runs = raw.get("recent_runs", []) if isinstance(raw, dict) else []
        if not isinstance(recent_runs, list):
            recent_runs = []
        run = next((r for r in recent_runs if isinstance(r, dict) and str(r.get("run_id") or "") == run_id), None)
        if not isinstance(run, dict):
            raise HTTPException(status_code=404, detail="未找到该 run_id")
        thread_id = str(run.get("thread_id") or "").strip()
        if not thread_id:
            raise HTTPException(status_code=400, detail="该运行记录缺少 thread_id，无法取消")
        from backend.api.common import is_valid_thread_id_uuid
        if not is_valid_thread_id_uuid(thread_id):
            raise HTTPException(status_code=422, detail="invalid thread_id format")
        try:
            result = await cancel_task(thread_id)
        except ValueError as ve:
            if "thread_id" in str(ve).lower():
                raise HTTPException(status_code=422, detail="invalid thread_id format")
            raise HTTPException(status_code=422, detail=_safe_error_detail(ve))
        except TaskNotFoundError:
            raise HTTPException(status_code=404, detail=f"任务不存在: {thread_id}")
        return {"ok": True, "run_id": run_id, "thread_id": thread_id, "result": result}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("取消自治运行失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


# ============================================================
# 健康检查
# ============================================================

@app.get("/health")
async def health_check():
    """健康检查（与 scripts/start.sh、前端 checkHealth 对齐）"""
    return {
        "status": "ok",
        "version": "1.0.0",
        "services": {"api": True},
        "assistant_id": "agent",
    }


_FRONTEND_ERROR_LOG_MAX_LINES = 100
_FRONTEND_ERROR_LOG_DIR = None
_frontend_error_log_lock = threading.Lock()


def _get_frontend_error_log_path():
    """按日期分文件，便于按天排查且避免单文件并发写冲突；目录 .cursor/logs/。"""
    global _FRONTEND_ERROR_LOG_DIR
    if _FRONTEND_ERROR_LOG_DIR is None:
        _FRONTEND_ERROR_LOG_DIR = PROJECT_ROOT / ".cursor" / "logs"
    date_suffix = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return _FRONTEND_ERROR_LOG_DIR / f"frontend-error-{date_suffix}.log"


@app.post("/log/frontend-error")
async def log_frontend_error(request: Request):
    """前端错误上报：接收 body 返回 200；开发/调试时按日期追加到 .cursor/logs/frontend-error-YYYY-MM-DD.log。"""
    body = None
    try:
        body = await request.json()
    except Exception as e:
        logger.debug("log_frontend_error body parse failed: %s", e)
        try:
            await request.body()
        except Exception as e2:
            logger.debug("log_frontend_error body consume failed: %s", e2)
        return {"ok": True}
    try:
        log_path = _get_frontend_error_log_path()
        log_path.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps({"t": time.time(), **body}, ensure_ascii=False) + "\n"
        with _frontend_error_log_lock:
            with open(log_path, "a", encoding="utf-8") as f:
                f.write(line)
            try:
                with open(log_path, "r", encoding="utf-8") as f:
                    lines = f.readlines()
                if len(lines) > _FRONTEND_ERROR_LOG_MAX_LINES:
                    with open(log_path, "w", encoding="utf-8") as f:
                        f.writelines(lines[-_FRONTEND_ERROR_LOG_MAX_LINES:])
            except Exception as e1:
                logger.debug("log_frontend_error log truncate failed: %s", e1)
    except Exception as e:
        logger.debug("log_frontend_error write failed: %s", e)
    return {"ok": True}


@app.post("/editor/complete")
async def editor_complete(request: Request):
    """编辑器内联补全 stub：返回空补全，避免前端 404。完整实现可由后端后续提供。"""
    try:
        await request.json()
    except Exception:
        pass
    return {"completion": ""}


@app.get("/health/deep")
async def deep_health_check(request: Request):
    """深度健康检查：LangGraph API、SQLite、模型连通性。"""
    checks: dict[str, dict[str, Any]] = {}
    overall = "ok"
    client = request.app.state.health_httpx_client

    # 1) LangGraph API
    langgraph_base = os.environ.get("LANGGRAPH_API_URL", "http://127.0.0.1:2024").rstrip("/")
    try:
        resp = await client.get(f"{langgraph_base}/threads")
        checks["langgraph_api"] = {
            "ok": resp.status_code < 500,
            "status_code": resp.status_code,
            "base_url": langgraph_base,
        }
        if resp.status_code >= 500:
            overall = "degraded"
    except Exception as e:
        checks["langgraph_api"] = {"ok": False, "error": _safe_error_detail(e), "base_url": langgraph_base}
        overall = "degraded"

    # 2) SQLite（Store DB 连通性）
    try:
        import sqlite3
        from backend.engine.core.main_graph import STORE_DB
        conn = sqlite3.connect(str(STORE_DB), timeout=2.0)
        try:
            cur = conn.cursor()
            cur.execute("SELECT 1")
            cur.fetchone()
        finally:
            conn.close()
        checks["sqlite_store"] = {"ok": True, "db_path": str(STORE_DB)}
    except Exception as e:
        checks["sqlite_store"] = {"ok": False, "error": _safe_error_detail(e)}
        overall = "degraded"

    # 2b) Store 运行时是否已降级（get_sqlite_store 曾失败并回退到 InMemoryStore）
    try:
        from backend.engine.core.main_graph import get_store_fallback_reason
        fallback = get_store_fallback_reason()
        checks["store_fallback"] = {"ok": fallback is None, "reason": fallback}
        if fallback:
            overall = "degraded"
    except Exception as e:
        checks["store_fallback"] = {"ok": True, "reason": None, "check_error": _safe_error_detail(e)}

    # 3) 模型服务（当前模型可用性）
    try:
        from backend.engine.agent.model_manager import get_model_manager
        manager = get_model_manager()
        current_model = manager.get_current_model()
        model_ok = manager.check_model_availability(current_model) if current_model else False
        checks["model_service"] = {
            "ok": bool(model_ok),
            "current_model": current_model,
        }
        if not model_ok:
            overall = "degraded"
    except Exception as e:
        checks["model_service"] = {"ok": False, "error": _safe_error_detail(e)}
        overall = "degraded"

    # 4) MCP 连接池（可选，失败不拉低 overall，仅上报状态）
    try:
        from backend.tools.mcp.mcp_tools import get_mcp_health
        mcp_snapshot = await asyncio.wait_for(get_mcp_health(), timeout=2.0)
        ok_count = sum(1 for v in (mcp_snapshot or {}).values() if isinstance(v, dict) and v.get("ok"))
        checks["mcp"] = {"ok": True, "connected_servers": ok_count, "detail": mcp_snapshot}
    except Exception as e:
        checks["mcp"] = {"ok": False, "error": _safe_error_detail(e)}

    return {
        "status": overall,
        "version": "1.0.0",
        "checks": checks,
    }


# ============================================================
# Token 统计 API（Cursor/Claude 风格）
# ============================================================

# Token 计数器（使用 tiktoken 精确计算）
_tiktoken_encoder = None

def _get_tiktoken_encoder():
    """获取 tiktoken 编码器（懒加载）"""
    global _tiktoken_encoder
    if _tiktoken_encoder is None:
        try:
            import tiktoken
            # 使用 cl100k_base 编码器（GPT-4, Claude 等现代模型通用）
            _tiktoken_encoder = tiktoken.get_encoding("cl100k_base")
        except ImportError:
            logger.warning("tiktoken 未安装，使用估算方法")
            return None
    return _tiktoken_encoder

def _count_tokens(text: str) -> int:
    """精确计算 token 数量"""
    if not text:
        return 0
    
    encoder = _get_tiktoken_encoder()
    if encoder:
        try:
            return len(encoder.encode(text))
        except Exception:
            pass
    
    # 回退到估算方法（中文约 1.5 token/字符，英文约 0.25 token/字符）
    cn_chars = len([c for c in text if '\u4e00' <= c <= '\u9fff'])
    en_chars = len(text) - cn_chars
    return int(cn_chars * 1.5 + en_chars * 0.25)

@app.get("/context/stats")
async def get_context_stats(thread_id: str = None):
    """
    获取上下文统计信息（Token 使用量）
    
    返回：
    - system_tokens: 系统提示词 token 数
    - history_tokens: 历史消息 token 数
    - context_tokens: 当前上下文 token 数
    - memory_tokens: 长期记忆 token 数
    - total_tokens: 总 token 数
    - limit: 模型窗口限制
    - percentage: 使用百分比
    
    注意：
    - 使用 tiktoken 进行精确计算（如已安装）
    - 如果提供 thread_id，返回该线程的统计
    - 如果不提供，返回当前活跃线程的估算
    """
    try:
        # 获取模型窗口限制（与 deep_agent 默认一致，避免 32K 硬编码）
        from backend.engine.agent.deep_agent import Config
        from backend.engine.agent.model_manager import get_model_manager
        
        manager = get_model_manager()
        current_model = manager.get_current_model()
        default_limit = getattr(Config, "DEFAULT_CONTEXT_LENGTH", 65536)

        limit = default_limit
        try:
            model_config = manager.get_model_config(current_model)
            if model_config:
                if "context_length" in model_config:
                    limit = model_config["context_length"]
                elif "config" in model_config and isinstance(model_config["config"], dict):
                    cfg = model_config["config"]
                    if "max_tokens_default" in cfg:
                        limit = cfg["max_tokens_default"]
                    elif "max_tokens" in cfg:
                        mt = cfg["max_tokens"]
                        limit = mt.get("default", default_limit) if isinstance(mt, dict) else mt
        except Exception:
            pass
        
        # 估算系统提示词 token 数（与 engine 组装量级一致：orchestrator + memory + bundle + 中间件）
        try:
            from backend.engine.utils.token_utils import DEFAULT_SYSTEM_PROMPT_TOKENS
            system_tokens = DEFAULT_SYSTEM_PROMPT_TOKENS
        except ImportError:
            system_tokens = 3500
        
        # 如果有 thread_id，尝试获取真实的历史消息 token 数（仅当为 UUID 时调用 LangGraph，避免 422）
        history_tokens = 0
        context_tokens = 0
        memory_tokens = 0
        tool_tokens = 0
        message_count = 0
        context_items_count = 0
        context_details = ""
        history_details = ""
        from backend.api.common import is_valid_thread_id_uuid
        if thread_id and is_valid_thread_id_uuid(thread_id):
            try:
                # 获取线程状态
                from langgraph_sdk import get_client
                client = get_client(url="http://localhost:2024")
                state = await client.threads.get_state(thread_id)
                if state and "values" in state:
                    messages = state["values"].get("messages", [])
                    
                    # 精确计算消息 token 数
                    for msg in messages:
                        message_count += 1
                        content = getattr(msg, "content", "") or ""
                        if isinstance(content, str):
                            msg_tokens = _count_tokens(content)
                            
                            msg_type = getattr(msg, "type", "")
                            if msg_type == "system":
                                system_tokens += msg_tokens
                            elif msg_type == "tool":
                                tool_tokens += msg_tokens
                            else:
                                history_tokens += msg_tokens
                    
                    # 获取上下文和记忆
                    context_value = state["values"].get("context", "")
                    context_str = str(context_value)
                    memory_str = str(state["values"].get("memory", ""))
                    context_tokens = _count_tokens(context_str)
                    memory_tokens = _count_tokens(memory_str)
                    if isinstance(context_value, dict):
                        items = context_value.get("items")
                        if isinstance(items, list):
                            context_items_count = len(items)
                            preview = []
                            for row in items[:3]:
                                if isinstance(row, dict):
                                    name = str(row.get("name") or row.get("path") or row.get("id") or "").strip()
                                    if name:
                                        preview.append(name)
                            if preview:
                                context_details = f"共 {context_items_count} 项，上下文示例：{', '.join(preview)}"
                    elif isinstance(context_value, list):
                        context_items_count = len(context_value)
                    if message_count > 0:
                        history_details = f"最近消息 {message_count} 条"
                    
            except Exception as e:
                logger.debug(f"获取线程状态失败: {e}")
        
        total_tokens = system_tokens + history_tokens + context_tokens + memory_tokens + tool_tokens
        percentage = min((total_tokens / limit) * 100, 100)
        
        # 检查是否使用了 tiktoken
        using_tiktoken = _get_tiktoken_encoder() is not None
        
        return {
            "success": True,
            "stats": {
                "system_tokens": system_tokens,
                "history_tokens": history_tokens,
                "context_tokens": context_tokens,
                "memory_tokens": memory_tokens,
                "tool_tokens": tool_tokens,
                "total_tokens": total_tokens,
                "limit": limit,
                "percentage": round(percentage, 1),
                "model": current_model,
                "using_tiktoken": using_tiktoken,
                "components": [
                    {
                        "name": "system_prompt",
                        "tokens": system_tokens,
                        "percentage": (system_tokens / limit) * 100 if limit > 0 else 0,
                        "details": "系统身份、模式规范、技能和中间件提示",
                    },
                    {
                        "name": "history",
                        "tokens": history_tokens,
                        "percentage": (history_tokens / limit) * 100 if limit > 0 else 0,
                        "details": history_details or "线程历史消息",
                    },
                    {
                        "name": "context",
                        "tokens": context_tokens,
                        "percentage": (context_tokens / limit) * 100 if limit > 0 else 0,
                        "details": context_details or (f"共 {context_items_count} 项上下文" if context_items_count > 0 else "本轮注入上下文"),
                    },
                    {
                        "name": "memory",
                        "tokens": memory_tokens,
                        "percentage": (memory_tokens / limit) * 100 if limit > 0 else 0,
                        "details": "长期记忆与学习记录",
                    },
                    {
                        "name": "tools",
                        "tokens": tool_tokens,
                        "percentage": (tool_tokens / limit) * 100 if limit > 0 else 0,
                        "details": "工具定义与工具调用上下文",
                    },
                ],
            },
            "health": {
                "status": "healthy" if percentage < 75 else ("warning" if percentage < 90 else "critical"),
                "message": None if percentage < 75 else (
                    "上下文即将满载，历史消息将被压缩" if percentage < 90 
                    else "上下文已满，旧消息将被移除"
                ),
            },
        }
        
    except Exception as e:
        logger.error(f"❌ 获取上下文统计失败: {e}")
        _fallback_system = 3500
        return {
            "success": False,
            "error": _safe_error_detail(e),
            "stats": {
                "system_tokens": _fallback_system,
                "history_tokens": 0,
                "context_tokens": 0,
                "memory_tokens": 0,
                "tool_tokens": 0,
                "total_tokens": _fallback_system,
                "limit": 32768,
                "percentage": round((_fallback_system / 32768) * 100, 1),
            },
        }


# ============================================================
# 内存管理 API（生产级）
# ============================================================

@app.get("/memory/stats")
async def get_memory_stats():
    """
    获取详细的内存统计信息（生产级诊断）
    
    返回：
    - Python 进程内存使用（RSS/VMS）
    - 各类缓存大小（LLM 缓存、Agent 缓存）
    - 磁盘存储文件大小（SQLite、Pickle、向量存储）
    - 存储健康状态和警告
    """
    try:
        from backend.engine.agent.deep_agent import get_memory_stats as _get_stats
        stats = _get_stats()
        
        # 添加向量存储统计
        try:
            from backend.tools.base.embedding_tools import get_vectorstore_stats
            stats["storage"]["vectorstore"] = get_vectorstore_stats()
        except Exception:
            pass
        
        return {
            "success": True,
            "stats": stats,
            "health": stats.get("health", {}),
        }
    except Exception as e:
        logger.error(f"❌ 获取内存统计失败: {e}")
        return {
            "success": False,
            "error": _safe_error_detail(e),
        }


@app.get("/vectorstore/stats")
async def get_vectorstore_stats_api():
    """
    获取向量存储统计信息
    
    返回：
    - 存储路径
    - 文件大小
    - 索引文件列表
    """
    try:
        from backend.tools.base.embedding_tools import get_vectorstore_stats, get_vectorstore_cache_stats
        stats = get_vectorstore_stats()
        try:
            stats["cache"] = get_vectorstore_cache_stats()
        except Exception:
            pass
        return {
            "success": True,
            "stats": stats,
        }
    except Exception as e:
        logger.error(f"❌ 获取向量存储统计失败: {e}")
        return {
            "success": False,
            "error": _safe_error_detail(e),
        }


@app.post("/vectorstore/rebuild", deprecated=True)
async def rebuild_vectorstore(
    force: bool = False,
    mode: Optional[str] = None,  # incremental | full，与 POST /knowledge/refresh 统一语义；若传则覆盖 force
):
    """
    重建/更新向量索引。[已废弃] 请优先使用 POST /knowledge/refresh。
    与 POST /knowledge/refresh 语义统一：
    - mode=incremental（默认）：增量更新
    - mode=full：全量重建
    - 兼容旧参数 force：force=true 等价于 mode=full。
    """
    try:
        from backend.tools.base.embedding_tools import rebuild_index

        do_full = force or (mode and str(mode).strip().lower() == "full")

        success = rebuild_index(extract_ontology=True, force=do_full)

        if success:
            return {
                "success": True,
                "message": "全量重建完成" if do_full else "增量更新完成",
                "canonical_api": "POST /knowledge/refresh",
                "mode": "full" if do_full else "incremental",
            }
        else:
            return {
                "success": False,
                "message": "向量索引重建失败",
                "canonical_api": "POST /knowledge/refresh",
            }
    except Exception as e:
        logger.error(f"❌ 重建向量索引失败: {e}")
        return {
            "success": False,
            "error": _safe_error_detail(e),
        }


def _memory_ns(workspace_path: Optional[str] = None, user_id: str = "default") -> tuple:
    """Build memory namespace tuple for store (memories, workspace_id, user_id)."""
    ws = (workspace_path or "default").strip() or "default"
    return ("memories", ws, user_id)


async def _memory_store_list(store: Any, namespace: tuple, limit: int = 100) -> List[Dict[str, Any]]:
    """List memory entries from store; returns list of { id, content, created_at, namespace }."""
    def _inner() -> List[Dict[str, Any]]:
        if not hasattr(store, "list"):
            return []
        keys = list(store.list(namespace))[:limit]
        rows: List[Dict[str, Any]] = []
        for k in keys:
            key_str = str(k)
            out = store.get(namespace, k)
            if out is None:
                continue
            v = getattr(out, "value", out) if not isinstance(out, dict) else out
            if isinstance(v, dict):
                content = v.get("content", v.get("text", str(v)))
                created_at = v.get("created_at", v.get("created", ""))
            else:
                content = str(v)
                created_at = ""
            rows.append({
                "id": key_str,
                "content": content,
                "created_at": created_at,
                "namespace": list(namespace),
            })
        return rows
    return await asyncio.to_thread(_inner)


@app.get("/memory/entries")
async def get_memory_entries(
    workspace_path: Optional[str] = Query(None),
    user_id: Optional[str] = Query(None),
    limit: int = Query(100, ge=1, le=200),
):
    """列出用户记忆条目（langmem Store 命名空间）。"""
    try:
        from backend.engine.core.main_graph import get_sqlite_store
        store = get_sqlite_store()
        if store is None:
            return {"ok": False, "error": "Store 不可用", "entries": [], "total": 0}
        ns = _memory_ns(workspace_path, user_id or "default")
        entries = await _memory_store_list(store, ns, limit=limit)
        return {"ok": True, "entries": entries, "total": len(entries)}
    except Exception as e:
        logger.exception("获取记忆条目失败: %s", e)
        return {"ok": False, "error": _safe_error_detail(e), "entries": [], "total": 0}


@app.patch("/memory/entries/{entry_id}")
async def update_memory_entry(
    entry_id: str,
    body: Dict[str, Any] = Body(...),
    workspace_path: Optional[str] = Query(None),
    user_id: Optional[str] = Query(None),
):
    """更新单条记忆的 content。"""
    try:
        from backend.engine.core.main_graph import get_sqlite_store
        store = get_sqlite_store()
        if store is None:
            raise HTTPException(status_code=503, detail="Store 不可用")
        content = (body.get("content") or body.get("text") or "").strip()
        if not content:
            raise HTTPException(status_code=400, detail="content 必填")
        ns = _memory_ns(workspace_path, user_id or "default")

        def _inner() -> Dict[str, Any]:
            existing = store.get(ns, entry_id)
            created_at = datetime.now(timezone.utc).isoformat()
            if existing is not None:
                v = getattr(existing, "value", existing) if not isinstance(existing, dict) else existing
                if isinstance(v, dict):
                    created_at = v.get("created_at", v.get("created", created_at))
            value = {"content": content, "created_at": created_at}
            store.put(ns, entry_id, value)
            return value
        await asyncio.to_thread(_inner)
        return {"ok": True, "id": entry_id, "content": content}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("更新记忆条目失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


@app.delete("/memory/entries/{entry_id}")
async def delete_memory_entry(
    entry_id: str,
    workspace_path: Optional[str] = Query(None),
    user_id: Optional[str] = Query(None),
):
    """删除单条记忆。"""
    try:
        from backend.engine.core.main_graph import get_sqlite_store
        store = get_sqlite_store()
        if store is None:
            raise HTTPException(status_code=503, detail="Store 不可用")
        ns = _memory_ns(workspace_path, user_id or "default")
        if hasattr(store, "delete"):
            await asyncio.to_thread(store.delete, ns, entry_id)
        else:
            await asyncio.to_thread(store.put, ns, entry_id, None)
        return {"ok": True, "id": entry_id}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("删除记忆条目失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


@app.post("/memory/entries")
async def create_memory_entry(
    body: Dict[str, Any] = Body(...),
    workspace_path: Optional[str] = Query(None),
    user_id: Optional[str] = Query(None),
):
    """手动添加一条记忆（可选，用于前端“手动添加”）。"""
    try:
        from backend.engine.core.main_graph import get_sqlite_store
        from uuid import uuid4
        store = get_sqlite_store()
        if store is None:
            raise HTTPException(status_code=503, detail="Store 不可用")
        content = (body.get("content") or body.get("text") or "").strip()
        if not content:
            raise HTTPException(status_code=400, detail="content 必填")
        ns = _memory_ns(workspace_path, user_id or "default")
        entry_id = str(uuid4())
        value = {"content": content, "created_at": datetime.now(timezone.utc).isoformat()}
        await asyncio.to_thread(store.put, ns, entry_id, value)
        return {"ok": True, "id": entry_id, "content": content}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("创建记忆条目失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


@app.get("/memory/health")
async def get_memory_health():
    """
    获取内存健康状态（用于监控告警）
    
    返回：
    - status: healthy | warning | critical
    - warnings: 警告信息列表
    - recommendations: 建议操作
    """
    try:
        from backend.engine.agent.deep_agent import get_memory_stats as _get_stats
        stats = _get_stats()
        health = stats.get("health", {"status": "unknown"})
        
        # 添加建议
        recommendations = []
        if health.get("status") == "critical":
            recommendations.append("立即执行 POST /memory/cleanup?aggressive=true")
            recommendations.append("检查是否有内存泄漏")
            recommendations.append("考虑重启服务")
        elif health.get("status") == "warning":
            recommendations.append("执行 POST /memory/cleanup 清理过期数据")
            recommendations.append("检查 pickle 缓存是否过大")
            recommendations.append("考虑迁移到 SQLite 存储")
        
        return {
            "success": True,
            "status": health.get("status", "unknown"),
            "warnings": health.get("warnings"),
            "recommendations": recommendations if recommendations else None,
            "process": stats.get("process"),
        }
    except Exception as e:
        logger.error(f"❌ 获取健康状态失败: {e}")
        return {
            "success": False,
            "status": "error",
            "error": _safe_error_detail(e),
        }


@app.post("/memory/cleanup")
async def cleanup_memory(aggressive: bool = False):
    """
    清理内存和缓存（生产级）
    
    Args:
        aggressive: 是否激进清理（会清理更多数据，但可能影响用户体验）
    
    执行：
    - 清理 LLM 响应缓存
    - 清理 Agent 缓存
    - 清理过期的 SQLite 检查点
    - 清理过大的 Pickle 缓存文件
    - 强制垃圾回收
    """
    try:
        from backend.engine.agent.deep_agent import (
            clear_all_caches,
            cleanup_all_storage,
            get_memory_stats as _get_stats,
        )
        
        # 获取清理前的状态
        stats_before = _get_stats()
        
        # 清理缓存
        clear_all_caches()
        
        # 清理存储
        storage_result = cleanup_all_storage(aggressive=aggressive)
        
        # 获取清理后的内存状态
        stats_after = _get_stats()
        
        # 计算释放的内存
        memory_freed = 0
        if "process" in stats_before and "process" in stats_after:
            memory_freed = stats_before["process"].get("rss_mb", 0) - stats_after["process"].get("rss_mb", 0)
        
        logger.info(f"✅ 内存清理完成: {storage_result}, 释放 {memory_freed:.1f}MB")
        
        return {
            "success": True,
            "mode": "aggressive" if aggressive else "normal",
            "cleaned": storage_result,
            "memory_freed_mb": round(memory_freed, 2) if memory_freed > 0 else 0,
            "stats_after": stats_after,
        }
    except Exception as e:
        logger.error(f"❌ 内存清理失败: {e}")
        return {
            "success": False,
            "error": _safe_error_detail(e),
        }


@app.post("/memory/gc")
async def force_gc():
    """
    强制执行垃圾回收
    
    用于紧急情况下释放内存
    """
    try:
        import gc
        
        # 获取清理前的对象数量
        before = len(gc.get_objects())
        
        # 强制垃圾回收（多次执行确保清理彻底）
        gc.collect()
        gc.collect()
        gc.collect()
        
        # 获取清理后的对象数量
        after = len(gc.get_objects())
        
        # 尝试获取内存信息
        memory_info = {}
        try:
            import psutil  # type: ignore[import-untyped]
            process = psutil.Process()
            mem = process.memory_info()
            memory_info = {
                "rss_mb": round(mem.rss / 1024 / 1024, 2),
                "vms_mb": round(mem.vms / 1024 / 1024, 2),
            }
        except ImportError:
            pass
        
        logger.info(f"✅ GC 完成: {before} -> {after} 对象")
        
        return {
            "success": True,
            "objects_before": before,
            "objects_after": after,
            "objects_freed": before - after,
            "memory": memory_info if memory_info else None,
        }
    except Exception as e:
        logger.error(f"❌ GC 失败: {e}")
        return {
            "success": False,
            "error": _safe_error_detail(e),
        }


# ============================================================
# MCP 扩展信息 API
# ============================================================

@app.get("/mcp/extensions")
async def get_mcp_extensions():
    """
    获取可用的 MCP 扩展信息
    
    返回系统支持的 MCP 服务器列表，包括：
    - 官方 MCP 服务器
    - 推荐的业务扩展
    - 安装和使用说明
    """
    try:
        from tools.mcp import get_business_mcp_extensions, MCP_SERVER_CONFIGS
        
        return {
            "success": True,
            "official_servers": MCP_SERVER_CONFIGS,
            "business_extensions": get_business_mcp_extensions(),
            "installation": {
                "python": "pip install langchain-mcp-adapters",
                "nodejs": {
                    "filesystem": "npm install -g @modelcontextprotocol/server-filesystem",
                    "puppeteer": "npm install -g @modelcontextprotocol/server-puppeteer",
                    "sqlite": "npm install -g @modelcontextprotocol/server-sqlite",
                }
            }
        }
    except ImportError as e:
        return {
            "success": False,
            "error": f"MCP module not available: {e}",
            "installation": {
                "python": "pip install langchain-mcp-adapters",
            }
        }


@app.get("/mcp/status")
async def get_mcp_status():
    """
    获取 MCP 客户端连接状态
    
    返回当前已连接的 MCP 服务器列表
    """
    try:
        from tools.mcp import get_mcp_manager
        
        manager = get_mcp_manager()
        connected = manager.get_connected_servers()
        
        return {
            "success": True,
            "connected_servers": connected,
            "tools_count": len(manager.get_tools()),
        }
    except ImportError:
        return {
            "success": False,
            "connected_servers": [],
            "tools_count": 0,
            "error": "MCP module not available"
        }


# ============================================================
# 工作区分析 API（AI 仪表盘）
# ============================================================

@app.get("/workspace/analyze")
async def analyze_workspace(path: str = None, include_ai_insights: bool = True):
    """
    分析工作区并返回统计信息（用于仪表盘）
    
    Args:
        path: 工作区路径（默认使用 WORKSPACE_DIR）
        include_ai_insights: 是否包含 AI 洞察（需要 LLM 调用）
    
    返回：
        - file_stats: 文件统计（总数、按类型、按扩展名）
        - recent_files: 最近修改的文件
        - project_health: 项目健康度指标
        - ai_insights: AI 生成的洞察（可选）
    """
    try:
        import time
        from datetime import datetime, timedelta
        from collections import defaultdict
        from backend.tools.base.paths import get_workspace_root

        workspace_path = Path(path).expanduser().resolve() if path else Path(str(WORKSPACE_DIR)).resolve()
        if path:
            ws_root = get_workspace_root().resolve()
            proot = PROJECT_ROOT.resolve()
            try:
                workspace_path.relative_to(ws_root)
            except ValueError:
                try:
                    workspace_path.relative_to(proot)
                except ValueError:
                    raise HTTPException(status_code=403, detail="工作区路径必须在当前工作区或项目根下")

        if not workspace_path.exists():
            raise HTTPException(status_code=404, detail=f"工作区不存在: {workspace_path}")
        
        # 文件统计
        file_stats = {
            "total": 0,
            "by_type": defaultdict(int),
            "by_extension": defaultdict(int),
            "recently_modified": 0,
            "total_size": 0,
        }
        
        # 最近文件列表
        recent_files = []
        
        # 文件类型映射
        type_mapping = {
            '.py': 'code', '.js': 'code', '.ts': 'code', '.tsx': 'code', '.jsx': 'code',
            '.java': 'code', '.cpp': 'code', '.c': 'code', '.go': 'code', '.rs': 'code',
            '.md': 'markdown', '.mdx': 'markdown',
            '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'json',
            '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image', '.svg': 'image', '.webp': 'image',
            '.mp4': 'video', '.webm': 'video', '.mov': 'video',
            '.mp3': 'audio', '.wav': 'audio', '.ogg': 'audio',
            '.xlsx': 'excel', '.xls': 'excel', '.csv': 'excel',
            '.pdf': 'pdf', '.docx': 'docx', '.doc': 'docx',
            '.txt': 'text', '.log': 'text',
        }
        
        # 一周前的时间戳
        one_week_ago = time.time() - (7 * 24 * 60 * 60)
        
        # 忽略的目录
        ignore_dirs = {'.git', 'node_modules', '__pycache__', '.venv', 'venv', '.next', 'dist', 'build', '.cache'}
        
        # 遍历文件
        for item in workspace_path.rglob("*"):
            # 跳过忽略的目录
            if any(ignored in item.parts for ignored in ignore_dirs):
                continue
            
            if item.is_file():
                try:
                    stat = item.stat()
                    ext = item.suffix.lower()
                    file_type = type_mapping.get(ext, 'other')
                    
                    file_stats["total"] += 1
                    file_stats["by_type"][file_type] += 1
                    file_stats["by_extension"][ext] += 1
                    file_stats["total_size"] += stat.st_size
                    
                    # 检查是否最近修改
                    if stat.st_mtime > one_week_ago:
                        file_stats["recently_modified"] += 1
                        
                        # 添加到最近文件列表
                        recent_files.append({
                            "name": item.name,
                            "path": str(item.relative_to(workspace_path)),
                            "type": file_type,
                            "size": stat.st_size,
                            "modified_at": datetime.fromtimestamp(stat.st_mtime).isoformat(),
                        })
                except (PermissionError, OSError):
                    continue
        
        # 排序最近文件（按修改时间倒序）
        recent_files.sort(key=lambda x: x["modified_at"], reverse=True)
        recent_files = recent_files[:20]  # 只保留最近 20 个
        
        # 转换 defaultdict 为普通 dict
        file_stats["by_type"] = dict(file_stats["by_type"])
        file_stats["by_extension"] = dict(file_stats["by_extension"])
        
        # 项目健康度指标
        project_health = {
            "has_readme": (workspace_path / "README.md").exists() or (workspace_path / "readme.md").exists(),
            "has_gitignore": (workspace_path / ".gitignore").exists(),
            "has_package_json": (workspace_path / "package.json").exists(),
            "has_requirements": (workspace_path / "requirements.txt").exists(),
            "code_to_doc_ratio": round(
                file_stats["by_type"].get("code", 0) / max(file_stats["by_type"].get("markdown", 1), 1), 2
            ),
        }
        
        # AI 洞察（简化版，不调用 LLM）
        ai_insights = []
        
        if include_ai_insights:
            # 基于规则生成洞察
            code_count = file_stats["by_type"].get("code", 0)
            doc_count = file_stats["by_type"].get("markdown", 0)
            
            if code_count > 50 and doc_count < 5:
                ai_insights.append({
                    "type": "warning",
                    "title": "文档不足",
                    "description": f"项目有 {code_count} 个代码文件，但只有 {doc_count} 个文档文件，建议补充文档。",
                })
            
            if file_stats["recently_modified"] > 10:
                ai_insights.append({
                    "type": "info",
                    "title": "项目活跃",
                    "description": f"本周修改了 {file_stats['recently_modified']} 个文件，项目处于活跃开发状态。",
                })
            
            if not project_health["has_readme"]:
                ai_insights.append({
                    "type": "suggestion",
                    "title": "缺少 README",
                    "description": "项目没有 README.md 文件，建议添加项目说明文档。",
                })
            
            # TODO 检测（简化版）
            todo_count = 0
            try:
                for py_file in workspace_path.rglob("*.py"):
                    if any(ignored in py_file.parts for ignored in ignore_dirs):
                        continue
                    try:
                        content = py_file.read_text(encoding='utf-8', errors='ignore')
                        todo_count += content.upper().count('TODO')
                    except OSError as e:
                        logger.debug("workspace analyze: skip file %s: %s", py_file, e)
                
                if todo_count > 0:
                    ai_insights.append({
                        "type": "warning" if todo_count > 10 else "info",
                        "title": "TODO 待处理",
                        "description": f"发现 {todo_count} 个 TODO 注释待处理。",
                    })
            except Exception as e:
                logger.debug("workspace analyze: TODO scan failed: %s", e)
            
            # 添加成功指标
            if project_health["has_readme"] and project_health["has_gitignore"]:
                ai_insights.append({
                    "type": "success",
                    "title": "项目结构良好",
                    "description": "项目包含基本的配置文件（README、.gitignore）。",
                })
        
        return {
            "success": True,
            "workspace": {
                "path": str(workspace_path.absolute()),
                "name": workspace_path.name,
            },
            "file_stats": file_stats,
            "recent_files": recent_files,
            "project_health": project_health,
            "ai_insights": ai_insights,
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"❌ 工作区分析失败: {e}")
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


@app.post("/workspace/switch")
async def switch_workspace(path: str = Body("", embed=True)):
    """切换工作区根目录（用于前端显式切换时的后端预热）。path 为空字符串时表示清空工作区（仅前端展示清空，后端保持当前根）。"""
    try:
        raw = (path or "").strip()
        if not raw:
            return {
                "ok": True,
                "workspace_root": "",
                "message": "workspace cleared",
                "hints": ["create_new_thread", "clear_context_items"],
            }
        target = Path(raw).expanduser().resolve()
        if not target.exists() or not target.is_dir():
            raise HTTPException(status_code=400, detail="工作区路径不存在或不是目录")
        from backend.tools.base.paths import set_workspace_root, get_workspace_root

        set_workspace_root(str(target))
        return {
            "ok": True,
            "workspace_root": str(get_workspace_root()),
            "message": "workspace switched",
            "hints": [
                "create_new_thread",
                "clear_context_items",
                "reload_project_memory",
            ],
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("切换工作区失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


# ============================================================
# 工作建议 API（基于 Skills 系统）
# ============================================================

_work_suggestions_cache: Dict[str, tuple] = {}
_WORK_SUGGESTIONS_CACHE_TTL_SECONDS = 45.0
_WORK_SUGGESTIONS_CACHE_MAX_ENTRIES = 100


def _workspace_mtime_signature(raw_path: str) -> float:
    p = Path(raw_path) if raw_path else WORKSPACE_DIR
    try:
        return p.stat().st_mtime if p.exists() else 0.0
    except OSError:
        return 0.0


@app.get("/suggestions/work")
async def get_work_suggestions(
    path: str = None,
    workspace_id: str = None,
    thread_id: str = None,
    mode: str = None,
    refresh: bool = False,
):
    """
    获取 AI 工作建议（基于已安装插件、授权层级、当前会话目标与工作区分析）

    Args:
        path: 工作区路径（可选），用于扫描文件类型等
        workspace_id: 工作区标识（与 UserProfile 命名空间一致），用于读取未解决意图并排在推荐首位
        thread_id: 当前会话 id（可选），与 mode 配合表示当前会话目标；供后续按会话目标动态排序
        mode: 当前会话模式（agent/plan/ask/debug/review）；为 ask 时优先展示只读/分析类建议（授权层级）
        refresh: 为 true 时跳过缓存，强制重新计算（用于用户主动刷新）

    返回：
        - suggestions: 工作建议列表（已安装插件 + 用户画像 + 工作区 + 静态技能）
        - 每个建议包含：type, title, description, priority, source
    """
    try:
        import time as _time
        from backend.tools.base.paths import get_workspace_root

        effective_path = path
        if path and (path or "").strip():
            resolved = Path(path.strip()).expanduser().resolve()
            under_ws = False
            try:
                resolved.relative_to(get_workspace_root().resolve())
                under_ws = True
            except ValueError:
                try:
                    resolved.relative_to(PROJECT_ROOT.resolve())
                    under_ws = True
                except ValueError:
                    pass
            if under_ws and resolved.exists() and resolved.is_dir():
                effective_path = str(resolved)
            else:
                effective_path = str(WORKSPACE_DIR) if path else None
        if effective_path is None:
            effective_path = str(WORKSPACE_DIR)
        cache_key = f"{effective_path or WORKSPACE_DIR}::{workspace_id or ''}::{(mode or '').strip().lower()}"
        now = _time.monotonic()
        ws_sig = _workspace_mtime_signature(effective_path or WORKSPACE_DIR)
        if not refresh:
            cached = _work_suggestions_cache.get(cache_key)
            if cached:
                payload, ts, cached_sig = cached
                if (now - ts) < _WORK_SUGGESTIONS_CACHE_TTL_SECONDS and cached_sig == ws_sig:
                    return payload

        suggestions = []

        # 1. 用户画像与未完成意图（优先级最高，与当前会话目标一致）
        if workspace_id:
            try:
                from collections import Counter
                from backend.engine.core.main_graph import get_sqlite_store
                from backend.memory.user_model import get_user_profile
                store = get_sqlite_store()
                if store:
                    profile = get_user_profile(store, workspace_id)
                    for intent in reversed((profile.unsolved_intents or [])[-2:]):
                        if isinstance(intent, dict) and intent.get("title"):
                            suggestions.append({
                                "id": f"intent_{intent.get('id', '')}",
                                "title": f"继续：{intent['title']}",
                                "description": intent.get("description", ""),
                                "type": "intent_resume",
                                "priority": "high",
                                "source": "user_profile",
                            })
                    traj = (profile.learning_trajectory or [])[-5:]
                    if traj:
                        words = []
                        for t in traj:
                            if isinstance(t, str) and t.strip():
                                words.extend(t.strip().split())
                        if words:
                            top_word = Counter(w for w in words if len(w) > 1).most_common(1)
                            if top_word:
                                kw = top_word[0][0]
                                suggestions.append({
                                    "id": "trajectory_based",
                                    "type": "trajectory_based",
                                    "title": f"基于你近期关注「{kw}」，可尝试相关分析或总结",
                                    "description": "根据你的学习轨迹生成的个性化建议",
                                    "priority": "high",
                                    "source": "user_profile",
                                })
            except Exception as e:
                logger.debug("suggestions/work user_profile: %s", e)

        # 2. 已安装插件命令（动态来源，优先于静态技能；限制条数以保留给工作区与静态补足）
        try:
            loader = _build_plugin_loader()
            plugin_cmds = _collect_plugin_commands(loader)
            for row in plugin_cmds[:4]:
                cmd = row.get("command") or ""
                plugin = row.get("plugin") or "plugin"
                desc = (row.get("description") or "").strip() or "执行插件命令"
                if cmd:
                    suggestions.append({
                        "id": (row.get("command_key") or cmd).replace("/", ""),
                        "type": "plugin_command",
                        "title": cmd,
                        "description": desc,
                        "priority": "medium",
                        "source": plugin,
                    })
        except Exception as e:
            logger.debug("suggestions/work plugin_commands: %s", e)

        # 3. 基于工作区文件类型的建议
        if effective_path:
            workspace_path = Path(effective_path)
            if workspace_path.exists():
                file_types = set()
                max_scan_files = 5000
                scanned = 0
                for item in workspace_path.rglob("*"):
                    if item.is_file():
                        scanned += 1
                        ext = item.suffix.lower()
                        if ext in {'.pdf', '.docx', '.doc'}:
                            file_types.add('document')
                        elif ext in {'.xlsx', '.xls', '.csv'}:
                            file_types.add('spreadsheet')
                        elif ext in {'.py', '.js', '.ts', '.tsx'}:
                            file_types.add('code')
                        if len(file_types) >= 3 or scanned >= max_scan_files:
                            break
                if 'document' in file_types:
                    suggestions.append({
                        "id": "analyze-docs",
                        "type": "file",
                        "title": "分析文档",
                        "description": "检测到文档文件，可以进行智能分析",
                        "priority": "high",
                        "source": "workspace",
                    })
                if 'spreadsheet' in file_types:
                    suggestions.append({
                        "id": "analyze-data",
                        "type": "file",
                        "title": "数据分析",
                        "description": "检测到表格文件，可以进行数据分析和可视化",
                        "priority": "high",
                        "source": "workspace",
                    })

        # 4. 静态技能补足（动态建议多时减少静态条数，强化「已安装插件+工作区+用户画像」为主）
        _max_static = 1 if len(suggestions) >= 4 else (2 if len(suggestions) >= 2 else 4)
        try:
            from backend.engine.skills.skill_registry import get_skill_registry
            registry = get_skill_registry()
            popular_skills = [
                ('document-analysis', '文档分析', '解析文档结构与关键要点，输出可执行摘要', 'high'),
                ('data-analysis', '数据分析报告', '分析数据并生成可视化报告', 'medium'),
                ('research-synthesis', '研究总结', '汇总多源信息并生成结论与行动建议', 'medium'),
                ('code-review', '代码审查', '检查代码质量、风险和优化点', 'medium'),
                ('reports', '报告撰写', 'AI 辅助撰写各类报告', 'medium'),
            ]
            for skill_name, title, description, priority in popular_skills:
                if len(suggestions) >= 6:
                    break
                if len([s for s in suggestions if s.get("type") == "skill"]) >= _max_static:
                    break
                skill_info = registry.get_skill(skill_name) if hasattr(registry, 'get_skill') else None
                if skill_info:
                    suggestions.append({
                        "id": skill_name,
                        "type": "skill",
                        "title": skill_info.display_name or title,
                        "description": skill_info.description or description,
                        "priority": priority,
                        "source": skill_info.domain or "general",
                    })
                else:
                    suggestions.append({
                        "id": skill_name,
                        "type": "skill",
                        "title": title,
                        "description": description,
                        "priority": priority,
                        "source": skill_name.split('-')[0] if '-' in skill_name else "general",
                    })
        except ImportError:
            if len(suggestions) < 2:
                suggestions.extend([
                    {"id": "document-analysis", "type": "skill", "title": "文档分析", "description": "解析文档结构与关键要点", "priority": "high", "source": "general"},
                    {"id": "data-analysis", "type": "skill", "title": "数据分析报告", "description": "分析数据并生成可视化报告", "priority": "medium", "source": "data"},
                ])

        # 5. 按优先级与来源排序：用户画像 > 插件命令 > 工作区 > 静态技能
        _pri = {"high": 0, "medium": 1, "low": 2}

        def _sort_key(s):
            type_ = s.get("type") or ""
            if type_ in ("intent_resume", "trajectory_based"):
                source_rank = 0
            elif type_ == "plugin_command":
                source_rank = 1
            elif type_ == "file" or s.get("source") == "workspace":
                source_rank = 2
            else:
                source_rank = 3
            return (_pri.get(s.get("priority", "medium"), 1), source_rank)

        suggestions.sort(key=_sort_key)

        # 6. 授权层级（mode=ask）：只读模式下优先展示分析/总结类建议，弱化执行类
        _ask_mode = (mode or "").strip().lower() == "ask"
        if _ask_mode and suggestions:
            _read_only_friendly_ids = {
                "intent_resume", "trajectory_based", "analyze-docs", "analyze-data",
                "document-analysis", "data-analysis", "research-synthesis",
            }
            def _ask_sort_key(s):
                sid = (s.get("id") or "").strip()
                is_ro = sid in _read_only_friendly_ids or s.get("type") in ("intent_resume", "trajectory_based")
                return (0 if is_ro else 1, _sort_key(s))
            suggestions.sort(key=_ask_sort_key)

        result = {
            "success": True,
            "suggestions": suggestions[:6],  # 最多返回 6 个建议
        }
        if len(_work_suggestions_cache) >= _WORK_SUGGESTIONS_CACHE_MAX_ENTRIES:
            by_ts = sorted(_work_suggestions_cache.items(), key=lambda x: (x[1][1] if isinstance(x[1], tuple) and len(x[1]) >= 2 else 0))
            for k, _ in by_ts[: len(_work_suggestions_cache) // 2]:
                _work_suggestions_cache.pop(k, None)
        _work_suggestions_cache[cache_key] = (result, now, ws_sig)
        return result

    except Exception as e:
        logger.exception("获取工作建议失败: %s", e)
        raise HTTPException(status_code=500, detail=_safe_error_detail(e))


@app.get("/projects/active")
async def get_active_projects():
    """
    获取活跃项目列表（从 LangGraph 线程）
    
    返回最近活跃的项目/线程，包含：
    - id: 线程 ID
    - title: 项目标题
    - status: 状态
    - lastActivity: 最后活动时间
    - messageCount: 消息数量
    - aiSummary: AI 摘要（如果有）
    """
    try:
        projects = []
        
        # 尝试从 LangGraph 获取线程列表
        try:
            from langgraph_sdk import get_client
            client = get_client(url="http://localhost:2024")
            
            # 获取最近的线程（与前端 thread-list limit 一致，提高高线程量下的可见性）
            threads = await client.threads.search(limit=50)
            
            from backend.api.common import is_valid_thread_id_uuid
            for thread in threads:
                thread_id = thread.get('thread_id') or thread.get('id')
                metadata = thread.get('metadata', {})
                message_count = 0
                if thread_id and is_valid_thread_id_uuid(thread_id):
                    try:
                        state = await client.threads.get_state(thread_id)
                        if state and 'values' in state:
                            messages = state['values'].get('messages', [])
                            message_count = len(messages)
                    except Exception as e:
                        logger.debug("projects active: get_state %s: %s", thread_id, e)
                
                projects.append({
                    "id": thread_id,
                    "title": metadata.get('title') or f"项目 {thread_id[:8]}",
                    "status": "active",
                    "lastActivity": metadata.get('last_active_at') or thread.get('created_at'),
                    "messageCount": message_count,
                    "aiSummary": metadata.get('summary'),
                    "workspacePath": metadata.get('workspace_path'),
                })
            
        except Exception as e:
            logger.warning(f"⚠️ 无法从 LangGraph 获取线程: {e}")
        
        return {
            "success": True,
            "projects": projects[:10],  # 最多返回 10 个项目，与 thread-list 可见性对齐
        }
        
    except Exception as e:
        logger.error(f"❌ 获取活跃项目失败: {e}")
        return {
            "success": False,
            "error": _safe_error_detail(e),
            "projects": [],
        }


# ============================================================
# 自我生长洞察 API（knowledge_base/learned/insights）
# ============================================================

@app.get("/insights/daily")
async def get_daily_insights(limit: int = 30):
    """获取每日洞察文件列表（按日期倒序）。"""
    try:
        insights_dir = PROJECT_ROOT / "knowledge_base" / "learned" / "insights"
        if not insights_dir.exists():
            return {"success": True, "files": []}

        files = []
        for p in insights_dir.glob("*.md"):
            if p.name == "README.md":
                continue
            stat = p.stat()
            files.append(
                {
                    "date": p.stem,
                    "filename": p.name,
                    "size": stat.st_size,
                    "updated_at": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
                }
            )
        files.sort(key=lambda x: x["date"], reverse=True)
        return {"success": True, "files": files[: max(1, min(limit, 365))]}
    except Exception as e:
        logger.error("❌ 获取每日洞察列表失败: %s", e)
        return {"success": False, "error": _safe_error_detail(e), "files": []}


@app.get("/insights/daily/content")
async def get_daily_insight_content(date: str):
    """获取某一天的洞察 Markdown 内容。"""
    try:
        # 仅允许 YYYY-MM-DD，避免路径穿越
        if not date or len(date) != 10:
            raise HTTPException(status_code=400, detail="Invalid date format, expected YYYY-MM-DD")
        try:
            datetime.strptime(date, "%Y-%m-%d")
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid date format, expected YYYY-MM-DD")

        p = PROJECT_ROOT / "knowledge_base" / "learned" / "insights" / f"{date}.md"
        if not p.exists() or not p.is_file():
            raise HTTPException(status_code=404, detail=f"Insight file not found for date: {date}")
        content = p.read_text(encoding="utf-8")
        return {"success": True, "date": date, "content": content}
    except HTTPException:
        raise
    except Exception as e:
        logger.error("❌ 获取每日洞察内容失败: %s", e)
        return {"success": False, "error": _safe_error_detail(e)}


@app.get("/insights/content")
async def get_insight_content(filename: str):
    """按文件名读取洞察 Markdown 内容（支持 growth_radar_*.md）。"""
    try:
        if not filename:
            raise HTTPException(status_code=400, detail="filename is required")
        # 仅允许当前洞察目录下的 markdown 文件名，避免路径穿越
        if "/" in filename or "\\" in filename or filename.startswith(".") or not filename.endswith(".md"):
            raise HTTPException(status_code=400, detail="Invalid insight filename")
        if filename == "README.md":
            raise HTTPException(status_code=400, detail="README is not queryable")

        insights_dir = PROJECT_ROOT / "knowledge_base" / "learned" / "insights"
        p = insights_dir / filename
        if not p.exists() or not p.is_file():
            raise HTTPException(status_code=404, detail=f"Insight file not found: {filename}")
        content = p.read_text(encoding="utf-8")
        return {"success": True, "filename": filename, "content": content}
    except HTTPException:
        raise
    except Exception as e:
        logger.error("❌ 按文件名获取洞察内容失败: %s", e)
        return {"success": False, "error": _safe_error_detail(e)}


@app.get("/insights/summary")
async def get_insights_summary(days: int = 7):
    """获取最近 N 天洞察统计摘要。"""
    try:
        days = max(1, min(days, 90))
        insights_jsonl = PROJECT_ROOT / "knowledge_base" / "learned" / "insights" / "auto_insights.jsonl"
        if not insights_jsonl.exists():
            return {
                "success": True,
                "days": days,
                "summary": {"runs": 0, "signals": 0, "roses": 0, "buds": 0, "thorns": 0},
            }

        now = datetime.now(timezone.utc)
        cutoff_ts = now.timestamp() - days * 24 * 60 * 60
        runs = 0
        signals = 0
        roses = 0
        buds = 0
        thorns = 0
        with insights_jsonl.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                    ts_raw = row.get("timestamp")
                    if not ts_raw:
                        continue
                    ts = datetime.fromisoformat(str(ts_raw).replace("Z", "+00:00"))
                    if ts.tzinfo is None:
                        ts = ts.replace(tzinfo=timezone.utc)
                    if ts.timestamp() < cutoff_ts:
                        continue
                    runs += 1
                    signals += int(row.get("signals_count", 0) or 0)
                    roses += len(row.get("roses", []) or [])
                    buds += len(row.get("buds", []) or [])
                    thorns += len(row.get("thorns", []) or [])
                except Exception:
                    continue

        return {
            "success": True,
            "days": days,
            "summary": {
                "runs": runs,
                "signals": signals,
                "roses": roses,
                "buds": buds,
                "thorns": thorns,
            },
        }
    except Exception as e:
        logger.error("❌ 获取洞察摘要失败: %s", e)
        return {"success": False, "error": _safe_error_detail(e)}


class BriefingGenerateBody(BaseModel):
    workspace_path: Optional[str] = None
    workspace_id: Optional[str] = None
    days: int = 7
    scope: str = "personal"
    include_llm: bool = True


def _briefing_greeting(now: datetime, role_label: str) -> str:
    hour = now.hour
    if hour < 6:
        prefix = "夜深了"
    elif hour < 11:
        prefix = "早上好"
    elif hour < 14:
        prefix = "中午好"
    elif hour < 18:
        prefix = "下午好"
    else:
        prefix = "晚上好"
    safe_role = role_label.strip() or "今天"
    return f"{prefix}，{safe_role}。我已为你整理当前工作重点。"


def _safe_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    return str(value).strip()


def _extract_content_text(content: Any) -> str:
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts: List[str] = []
        for item in content:
            if isinstance(item, dict):
                text = item.get("text")
                if isinstance(text, str) and text.strip():
                    parts.append(text.strip())
        return "\n".join(parts).strip()
    return _safe_text(content)


def _parse_json_from_text(raw: str) -> Optional[dict]:
    text = (raw or "").strip()
    if not text:
        return None
    # 兼容 ```json ... ``` 包裹
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    try:
        data = json.loads(text)
        return data if isinstance(data, dict) else None
    except Exception:
        pass
    # 回退：抽取首个 JSON 对象
    m = re.search(r"\{[\s\S]*\}", text)
    if not m:
        return None
    try:
        data = json.loads(m.group(0))
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def _build_briefing_markdown(briefing: dict) -> str:
    greeting = _safe_text(briefing.get("greeting"))
    cards = briefing.get("summary_cards") if isinstance(briefing.get("summary_cards"), list) else []
    suggestions = briefing.get("suggestions") if isinstance(briefing.get("suggestions"), list) else []
    lines: List[str] = []
    if greeting:
        lines.append(f"# {greeting}")
        lines.append("")
    if cards:
        lines.append("## 今日简报")
        for card in cards:
            if not isinstance(card, dict):
                continue
            title = _safe_text(card.get("title")) or "概览"
            summary = _safe_text(card.get("summary"))
            lines.append(f"### {title}")
            if summary:
                lines.append(summary)
            data = card.get("data")
            if isinstance(data, dict):
                for k, v in data.items():
                    lines.append(f"- {k}: {_safe_text(v)}")
            lines.append("")
    if suggestions:
        lines.append("## 建议动作")
        for item in suggestions[:6]:
            if isinstance(item, dict):
                lines.append(f"- {_safe_text(item.get('title') or item.get('text') or item.get('description'))}")
            elif isinstance(item, str):
                lines.append(f"- {item.strip()}")
    text = "\n".join(lines).strip()
    return text or "## 今日简报\n暂无可展示内容。"


@app.post("/briefing/generate")
async def generate_daily_briefing(body: BriefingGenerateBody):
    """
    生成启动简报：
    - 快速聚合现有业务数据（洞察/项目/看板/建议/角色）
    - 可选调用 LLM 生成个性化问候与汇报结构
    """
    try:
        now = datetime.now()
        days = max(1, min(int(body.days or 7), 30))
        scope = (body.scope or "personal").strip() or "personal"
        workspace_path = _safe_text(body.workspace_path)

        # 1) 聚合现有接口数据（与前端已用数据源保持一致）
        insights_resp = await get_insights_summary(days=days)
        summary = insights_resp.get("summary", {}) if isinstance(insights_resp, dict) else {}

        suggestions_resp = await get_work_suggestions(path=workspace_path or None, workspace_id=body.workspace_id or None)
        suggestions = suggestions_resp.get("suggestions", []) if isinstance(suggestions_resp, dict) else []

        projects_resp = await get_active_projects()
        projects = projects_resp.get("projects", []) if isinstance(projects_resp, dict) else []

        try:
            from backend.api.routers.board_api import board_list_tasks as _board_list_tasks
            board_resp = await _board_list_tasks(scope=scope, limit=10)
            board_tasks = board_resp.get("tasks", []) if isinstance(board_resp, dict) else []
        except Exception as _bt_err:
            logger.warning("简报聚合看板数据失败: %s", _bt_err)
            board_tasks = []

        profile = {}
        role_label = "工作助手"
        try:
            from backend.engine.skills.skill_profiles import load_agent_profile
            profile = load_agent_profile() or {}
            role_label = _safe_text(profile.get("name")) or role_label
        except Exception:
            profile = {}

        active_board = 0
        for task in board_tasks:
            if not isinstance(task, dict):
                continue
            st = _safe_text(task.get("status")).lower()
            if st not in {"completed", "failed", "cancelled"}:
                active_board += 1

        quick_cards = [
            {
                "type": "tasks_overview",
                "title": "任务概览",
                "summary": f"活跃会话 {len(projects)} 个，看板处理中 {active_board} 个。",
                "data": {
                    "active_projects": len(projects),
                    "active_board_tasks": active_board,
                    "scope": scope,
                },
            },
            {
                "type": "insights",
                "title": "近期洞察",
                "summary": f"最近 {days} 天累计洞察运行 {int(summary.get('runs', 0) or 0)} 次。",
                "data": {
                    "runs": int(summary.get("runs", 0) or 0),
                    "signals": int(summary.get("signals", 0) or 0),
                    "roses": int(summary.get("roses", 0) or 0),
                    "buds": int(summary.get("buds", 0) or 0),
                    "thorns": int(summary.get("thorns", 0) or 0),
                },
            },
            {
                "type": "schedule_hint",
                "title": "今日关注",
                "summary": "我已基于当前工作区和角色整理可直接执行的建议。",
                "data": {
                    "role": role_label,
                    "suggestions": min(len(suggestions), 6),
                    "workspace": workspace_path or str(get_workspace_root()),
                },
            },
        ]

        llm_briefing: Optional[dict] = None
        if body.include_llm:
            try:
                from backend.engine.agent.model_manager import get_model_manager
                manager = get_model_manager()
                llm = manager.create_llm(task_type="analysis")
                prompt_payload = {
                    "now": now.isoformat(),
                    "role": role_label,
                    "insights_summary": summary,
                    "projects": projects[:5],
                    "board_tasks": board_tasks[:8],
                    "suggestions": suggestions[:6],
                }
                try:
                    from backend.engine.core.main_graph import get_sqlite_store
                    from backend.memory.user_model import get_user_profile
                    _store = get_sqlite_store()
                    _ws_for_profile = workspace_path or str(WORKSPACE_DIR)
                    if _store and _ws_for_profile:
                        _up = get_user_profile(_store, _ws_for_profile)
                        if _up.expertise_areas:
                            prompt_payload["user_expertise"] = ", ".join(f"{k}:{v}" for k, v in _up.expertise_areas.items())
                        if _up.unsolved_intents:
                            prompt_payload["user_pending"] = "; ".join(
                                i.get("title", "") for i in _up.unsolved_intents[-3:] if i.get("title")
                            )
                        if _up.communication_style:
                            prompt_payload["user_communication_style"] = _up.communication_style
                        if _up.custom_rules:
                            prompt_payload["user_custom_rules"] = _up.custom_rules[:3]
                except Exception:
                    pass
                llm_prompt = (
                    "你是用户的执行秘书。请基于输入数据生成“启动简报”JSON。"
                    "要求：语气专业简洁；以行动为导向；不要编造不存在的数据。"
                    "若 input 中含 user_expertise/user_pending/user_communication_style/user_custom_rules，"
                    "请在 greeting 和 suggestions 中体现个性化，调整深度与优先级。"
                    "输出严格 JSON，字段必须包含："
                    "greeting(string), summary_cards(array), suggestions(array)。"
                    "summary_cards 每项包含 type,title,summary,data。"
                    f"输入数据：{json.dumps(prompt_payload, ensure_ascii=False)}"
                )
                llm_resp = await llm.ainvoke(llm_prompt)
                llm_text = _extract_content_text(getattr(llm_resp, "content", llm_resp))
                llm_briefing = _parse_json_from_text(llm_text)
            except Exception as llm_err:
                logger.warning("briefing LLM 生成失败，使用聚合回退: %s", llm_err)

        greeting = _briefing_greeting(now, role_label)
        final_cards = quick_cards
        final_suggestions: List[Any] = suggestions[:6] if isinstance(suggestions, list) else []

        if isinstance(llm_briefing, dict):
            greeting = _safe_text(llm_briefing.get("greeting")) or greeting
            cards = llm_briefing.get("summary_cards")
            if isinstance(cards, list) and cards:
                final_cards = [c for c in cards if isinstance(c, dict)][:6]
            llm_suggestions = llm_briefing.get("suggestions")
            if isinstance(llm_suggestions, list) and llm_suggestions:
                final_suggestions = llm_suggestions[:6]

        final = {
            "greeting": greeting,
            "summary_cards": final_cards,
            "suggestions": final_suggestions,
        }
        final["markdown_report"] = _build_briefing_markdown(final)

        return {
            "ok": True,
            "briefing": final,
            "meta": {
                "generated_at": now.isoformat(),
                "days": days,
                "scope": scope,
                "workspace_path": workspace_path or str(get_workspace_root()),
                "llm_enabled": bool(body.include_llm),
                "llm_used": isinstance(llm_briefing, dict),
            },
        }
    except Exception as e:
        logger.exception("生成启动简报失败: %s", e)
        return {"ok": False, "error": _safe_error_detail(e), "briefing": None}


class EvolutionProposalBody(BaseModel):
    title: str
    motivation: str
    plan: str
    target: Optional[str] = "core_engine"


@app.get("/evolution/status")
async def evolution_status():
    try:
        from backend.engine.idle.self_evolution import SelfEvolutionEngine

        engine = SelfEvolutionEngine()
        return {
            "ok": True,
            "status": engine.status(),
            "engine_kind": str(os.getenv("EVOLUTION_ENGINE_KIND", "noop") or "noop"),
        }
    except Exception as e:
        logger.exception("读取 evolution 状态失败: %s", e)
        return {"ok": False, "error": _safe_error_detail(e)}


@app.post("/evolution/propose")
async def evolution_propose(body: EvolutionProposalBody):
    try:
        from backend.engine.idle.self_evolution import SelfEvolutionEngine

        engine = SelfEvolutionEngine()
        path = engine.create_proposal(
            title=body.title,
            motivation=body.motivation,
            plan=body.plan,
        )
        return {"ok": True, "proposal_path": str(path)}
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=_safe_error_detail(e))
    except Exception as e:
        logger.exception("创建 evolution proposal 失败: %s", e)
        return {"ok": False, "error": _safe_error_detail(e)}


@app.post("/evolution/run")
async def evolution_run(body: EvolutionProposalBody):
    try:
        from backend.engine.idle.self_evolution import SelfEvolutionEngine

        engine = SelfEvolutionEngine()
        result = engine.run_pipeline(
            title=body.title,
            motivation=body.motivation,
            plan=body.plan,
            target=str(body.target or "core_engine"),
        )
        return {"ok": True, "result": result}
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=_safe_error_detail(e))
    except Exception as e:
        logger.exception("执行 evolution pipeline 失败: %s", e)
        return {"ok": False, "error": _safe_error_detail(e)}

