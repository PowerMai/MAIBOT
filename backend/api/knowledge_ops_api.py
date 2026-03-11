from typing import Any, Callable, Dict

from fastapi import APIRouter


def create_knowledge_ops_router(
    status_provider: Callable[[], Dict[str, Any]],
) -> APIRouter:
    """创建知识链路 Ops 路由。"""
    router = APIRouter(tags=["knowledge-ops"])

    @router.get("/ops/knowledge-pipeline/status")
    async def knowledge_pipeline_status():
        return status_provider()

    return router

