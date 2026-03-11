"""
API 按领域拆分的 router 模块。
"""

from .board_api import router as board_router

__all__ = ["board_router"]
