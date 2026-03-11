"""
统一的异步 HTTP 客户端 - 生产级连接池管理

设计原则（Claude/Cursor 风格）：
1. 单例模式：全局复用连接池
2. 异步优先：所有外部调用使用异步
3. 自动重试：网络错误自动重试
4. 超时配置：可配置的超时参数
5. 优雅关闭：应用关闭时正确释放资源
"""

import asyncio
import os
import logging
from typing import Optional, Dict, Any
from contextlib import asynccontextmanager

import httpx

logger = logging.getLogger(__name__)


# ============================================================
# 配置参数（从环境变量读取）
# ============================================================

class HttpClientConfig:
    """HTTP 客户端配置"""
    
    # 超时配置（秒）
    CONNECT_TIMEOUT = float(os.getenv("HTTP_CONNECT_TIMEOUT", "10.0"))
    READ_TIMEOUT = float(os.getenv("HTTP_READ_TIMEOUT", "300.0"))
    WRITE_TIMEOUT = float(os.getenv("HTTP_WRITE_TIMEOUT", "30.0"))
    POOL_TIMEOUT = float(os.getenv("HTTP_POOL_TIMEOUT", "10.0"))
    
    # 连接池配置
    MAX_KEEPALIVE = int(os.getenv("HTTP_MAX_KEEPALIVE", "20"))
    MAX_CONNECTIONS = int(os.getenv("HTTP_MAX_CONNECTIONS", "100"))
    KEEPALIVE_EXPIRY = float(os.getenv("HTTP_KEEPALIVE_EXPIRY", "30.0"))
    
    # 重试配置
    MAX_RETRIES = int(os.getenv("HTTP_MAX_RETRIES", "3"))
    RETRY_DELAY = float(os.getenv("HTTP_RETRY_DELAY", "1.0"))


# ============================================================
# 全局异步 HTTP 客户端
# ============================================================

_async_client: Optional[httpx.AsyncClient] = None
_sync_client: Optional[httpx.Client] = None


def get_timeout() -> httpx.Timeout:
    """获取超时配置"""
    return httpx.Timeout(
        connect=HttpClientConfig.CONNECT_TIMEOUT,
        read=HttpClientConfig.READ_TIMEOUT,
        write=HttpClientConfig.WRITE_TIMEOUT,
        pool=HttpClientConfig.POOL_TIMEOUT,
    )


def get_limits() -> httpx.Limits:
    """获取连接池限制"""
    return httpx.Limits(
        max_keepalive_connections=HttpClientConfig.MAX_KEEPALIVE,
        max_connections=HttpClientConfig.MAX_CONNECTIONS,
        keepalive_expiry=HttpClientConfig.KEEPALIVE_EXPIRY,
    )


async def get_async_client() -> httpx.AsyncClient:
    """获取全局异步 HTTP 客户端（单例）
    
    ✅ 生产级特性：
    - 连接池复用，减少 TCP 握手开销
    - 自动保持连接活跃
    - 配置化的超时和限制
    """
    global _async_client
    
    if _async_client is None or _async_client.is_closed:
        _async_client = httpx.AsyncClient(
            timeout=get_timeout(),
            limits=get_limits(),
            http2=True,  # 启用 HTTP/2
        )
        logger.info("✅ 异步 HTTP 客户端已创建")
    
    return _async_client


def get_sync_client() -> httpx.Client:
    """获取全局同步 HTTP 客户端（单例）
    
    用于不支持异步的场景
    """
    global _sync_client
    
    if _sync_client is None or _sync_client.is_closed:
        _sync_client = httpx.Client(
            timeout=get_timeout(),
            limits=get_limits(),
            http2=True,
        )
        logger.info("✅ 同步 HTTP 客户端已创建")
    
    return _sync_client


async def close_async_client():
    """关闭异步 HTTP 客户端"""
    global _async_client
    
    if _async_client is not None and not _async_client.is_closed:
        await _async_client.aclose()
        _async_client = None
        logger.info("✅ 异步 HTTP 客户端已关闭")


def close_sync_client():
    """关闭同步 HTTP 客户端"""
    global _sync_client
    
    if _sync_client is not None and not _sync_client.is_closed:
        _sync_client.close()
        _sync_client = None
        logger.info("✅ 同步 HTTP 客户端已关闭")


async def close_all_clients():
    """关闭所有 HTTP 客户端"""
    await close_async_client()
    close_sync_client()


# ============================================================
# 便捷的请求方法（带自动重试）
# ============================================================

async def async_request(
    method: str,
    url: str,
    *,
    json: Optional[Dict[str, Any]] = None,
    data: Optional[Dict[str, Any]] = None,
    headers: Optional[Dict[str, str]] = None,
    timeout: Optional[float] = None,
    max_retries: Optional[int] = None,
) -> httpx.Response:
    """
    发送异步 HTTP 请求（带自动重试）
    
    Args:
        method: HTTP 方法 (GET, POST, PUT, DELETE, etc.)
        url: 请求 URL
        json: JSON 请求体
        data: 表单数据
        headers: 请求头
        timeout: 超时时间（覆盖默认值）
        max_retries: 最大重试次数（覆盖默认值）
    
    Returns:
        httpx.Response
    
    Raises:
        httpx.HTTPError: 请求失败
    """
    client = await get_async_client()
    retries = max_retries or HttpClientConfig.MAX_RETRIES
    last_error = None
    
    for attempt in range(retries + 1):
        try:
            response = await client.request(
                method=method,
                url=url,
                json=json,
                data=data,
                headers=headers,
                timeout=timeout,
            )
            response.raise_for_status()
            return response
            
        except (httpx.ConnectError, httpx.ReadTimeout, httpx.WriteTimeout) as e:
            last_error = e
            if attempt < retries:
                delay = HttpClientConfig.RETRY_DELAY * (2 ** attempt)  # 指数退避
                logger.warning(f"⚠️ HTTP 请求失败 (尝试 {attempt + 1}/{retries + 1}): {e}，{delay}秒后重试")
                await asyncio.sleep(delay)
            else:
                logger.error(f"❌ HTTP 请求最终失败: {e}")
                raise
        except httpx.HTTPStatusError as e:
            # 状态码错误不重试
            logger.error(f"❌ HTTP 状态错误: {e.response.status_code}")
            raise
    
    raise last_error


async def async_get(url: str, **kwargs) -> httpx.Response:
    """异步 GET 请求"""
    return await async_request("GET", url, **kwargs)


async def async_post(url: str, **kwargs) -> httpx.Response:
    """异步 POST 请求"""
    return await async_request("POST", url, **kwargs)


async def async_put(url: str, **kwargs) -> httpx.Response:
    """异步 PUT 请求"""
    return await async_request("PUT", url, **kwargs)


async def async_delete(url: str, **kwargs) -> httpx.Response:
    """异步 DELETE 请求"""
    return await async_request("DELETE", url, **kwargs)


# ============================================================
# LM Studio 专用客户端
# ============================================================

class LMStudioClient:
    """LM Studio API 客户端
    
    专门用于与 LM Studio 通信，支持：
    - 模型列表获取
    - 模型可用性检测
    - Chat Completions API
    """
    
    def __init__(self, base_url: Optional[str] = None):
        self.base_url = base_url or os.getenv("LM_STUDIO_URL", "http://localhost:1234/v1")
    
    async def check_health(self) -> bool:
        """检查 LM Studio 是否可用"""
        try:
            response = await async_get(
                f"{self.base_url}/models",
                timeout=5.0,
                max_retries=1,
            )
            return response.status_code == 200
        except Exception:
            return False
    
    async def list_models(self) -> list:
        """获取可用模型列表"""
        try:
            response = await async_get(f"{self.base_url}/models")
            data = response.json()
            return data.get("data", [])
        except Exception as e:
            logger.error(f"❌ 获取模型列表失败: {e}")
            return []
    
    async def check_model_available(self, model_id: str) -> bool:
        """检查特定模型是否可用"""
        models = await self.list_models()
        return any(m.get("id") == model_id for m in models)


# 全局 LM Studio 客户端
_lm_studio_client: Optional[LMStudioClient] = None


def get_lm_studio_client() -> LMStudioClient:
    """获取 LM Studio 客户端（单例）"""
    global _lm_studio_client
    
    if _lm_studio_client is None:
        _lm_studio_client = LMStudioClient()
    
    return _lm_studio_client


# ============================================================
# 导出
# ============================================================

__all__ = [
    "HttpClientConfig",
    "get_async_client",
    "get_sync_client",
    "close_async_client",
    "close_sync_client",
    "close_all_clients",
    "async_request",
    "async_get",
    "async_post",
    "async_put",
    "async_delete",
    "LMStudioClient",
    "get_lm_studio_client",
]
