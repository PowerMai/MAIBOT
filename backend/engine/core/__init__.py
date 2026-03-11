"""
Core Engine 模块 - 系统核心组件

包含：
- main_graph: 主路由 Graph
- resource_scheduler: 资源调度器
- http_client: 统一 HTTP 客户端
- parallel_executor: 并行工具执行器
"""

from .resource_scheduler import (
    ResourceScheduler,
    ResourceType,
    SystemResources,
    ResourceLimits,
    get_scheduler,
    with_llm_resource,
    with_embedding_resource,
    with_tool_resource,
)

from .http_client import (
    HttpClientConfig,
    get_async_client,
    get_sync_client,
    close_async_client,
    close_sync_client,
    close_all_clients,
    async_request,
    async_get,
    async_post,
    async_put,
    async_delete,
    LMStudioClient,
    get_lm_studio_client,
)

from .parallel_executor import (
    ToolStatus,
    ToolTask,
    ExecutionResult,
    ParallelExecutor,
    run_tools_parallel,
)

__all__ = [
    # Resource Scheduler
    "ResourceScheduler",
    "ResourceType",
    "SystemResources",
    "ResourceLimits",
    "get_scheduler",
    "with_llm_resource",
    "with_embedding_resource",
    "with_tool_resource",
    # HTTP Client
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
    # Parallel Executor
    "ToolStatus",
    "ToolTask",
    "ExecutionResult",
    "ParallelExecutor",
    "run_tools_parallel",
]
