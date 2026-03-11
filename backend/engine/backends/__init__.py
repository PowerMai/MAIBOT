"""
Backend Extensions - 扩展 DeepAgent 官方 Backend

遵循官方指导：
- 继承 FilesystemBackend
- 只重写需要扩展的方法
- 保持与官方 API 完全兼容
"""

from .enhanced_filesystem import EnhancedFilesystemBackend

__all__ = ["EnhancedFilesystemBackend"]
