from typing import Any, Callable, Dict

from fastapi import APIRouter


def create_workspace_auto_index_router(
    status_provider: Callable[[], Dict[str, Any]],
) -> APIRouter:
    """创建工作区自动索引 Ops 路由。"""
    router = APIRouter(tags=["workspace-auto-index-ops"])

    @router.get("/ops/workspace-auto-index/status")
    async def workspace_auto_index_status():
        return status_provider()

    return router

