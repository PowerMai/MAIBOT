"""
工具流式输出辅助模块

提供统一的流式输出接口，所有工具都可以使用。

产成品展示约定（与前端 Cursor 风格对齐）：
- 产成品优先写入消息体（tool result / AIMessage 的交付块），在聊天区内联展示。
- 仅当产物未作为 tool result 内联时，才通过 emit_tool_event(writer, "artifact", ...) 发送
  type="artifact" 的 custom 事件，供 ArtifactPanel 展示；避免同一内容在聊天区与侧栏重复展示。
- 前端可根据消息内是否已有产成品决定是否再渲染 Artifact 卡片，避免双重展示。
"""

import time
import logging
from typing import Optional, Callable, Any, Dict

logger = logging.getLogger(__name__)

# ✅ LangGraph 流式输出支持
try:
    from langgraph.config import get_stream_writer
    STREAM_WRITER_AVAILABLE = True
except ImportError:
    STREAM_WRITER_AVAILABLE = False
    get_stream_writer = None


def get_tool_stream_writer() -> Optional[Callable]:
    """
    获取工具流式写入器
    
    Returns:
        流式写入器函数，如果不可用则返回 None
    """
    if not STREAM_WRITER_AVAILABLE:
        return None
    
    try:
        return get_stream_writer()
    except Exception as e:
        logger.debug(f"Stream writer not available: {e}")
        return None


def emit_tool_event(
    writer: Optional[Callable],
    event_type: str,
    **kwargs
) -> None:
    """
    发送工具事件。

    产成品约定：仅当产物未作为 tool result 内联到聊天区时，才发送 event_type="artifact"；
    避免同一内容在聊天区与 ArtifactPanel 重复展示。
    
    Args:
        writer: 流式写入器
        event_type: 事件类型
        **kwargs: 事件数据
    """
    if writer is None:
        return
    
    try:
        event = {
            "type": event_type,
            "timestamp": time.time(),
            **kwargs
        }
        writer(event)
    except Exception as e:
        logger.debug(f"Failed to emit event {event_type}: {e}")


class ToolStreamContext:
    """
    工具流式输出上下文管理器
    
    使用方式:
    ```python
    with ToolStreamContext("read_file") as ctx:
        ctx.emit("start", file_path=path)
        # ... 执行操作 ...
        ctx.emit("progress", bytes_read=1000, total_bytes=5000)
        # ... 继续执行 ...
        ctx.emit("complete", status="success")
    ```
    """
    
    def __init__(self, tool_name: str):
        self.tool_name = tool_name
        self.writer = get_tool_stream_writer()
        self.start_time = time.time()
    
    def __enter__(self):
        return self
    
    def __exit__(self, exc_type, exc_val, exc_tb):
        # 如果有异常，发送错误事件
        if exc_type is not None:
            self.emit("error", error=str(exc_val))
        return False
    
    def emit(self, event_suffix: str, **kwargs) -> None:
        """
        发送事件
        
        Args:
            event_suffix: 事件后缀（如 "start", "progress", "complete"）
            **kwargs: 事件数据
        """
        event_type = f"{self.tool_name}_{event_suffix}"
        emit_tool_event(self.writer, event_type, **kwargs)
    
    @property
    def elapsed(self) -> float:
        """已用时间（秒）"""
        return time.time() - self.start_time
    
    @property
    def is_streaming(self) -> bool:
        """是否支持流式输出"""
        return self.writer is not None


# 预定义的事件类型
class ToolEvents:
    """工具事件类型常量"""
    
    # 文件操作
    FILE_READ_START = "file_read_start"
    FILE_READ_PROGRESS = "file_read_progress"
    FILE_READ_COMPLETE = "file_read_complete"
    
    FILE_WRITE_START = "file_write_start"
    FILE_WRITE_PROGRESS = "file_write_progress"
    FILE_WRITE_COMPLETE = "file_write_complete"
    
    # Python 执行
    PYTHON_START = "python_start"
    PYTHON_LIBS_LOADED = "python_libs_loaded"
    PYTHON_INSTALLING = "python_installing"
    PYTHON_OUTPUT = "python_output"
    PYTHON_COMPLETE = "python_complete"
    
    # 库安装
    LIBRARY_INSTALL_START = "library_install_start"
    LIBRARY_INSTALL_COMPLETE = "library_install_complete"
    
    # Shell 执行
    SHELL_START = "shell_start"
    SHELL_OUTPUT = "shell_output"
    SHELL_COMPLETE = "shell_complete"
    
    # 搜索
    SEARCH_START = "search_start"
    SEARCH_FILES_FOUND = "search_files_found"
    SEARCH_PROGRESS = "search_progress"
    SEARCH_MATCH = "search_match"
    SEARCH_COMPLETE = "search_complete"
    
    # 网络搜索
    WEB_SEARCH_START = "web_search_start"
    WEB_SEARCH_QUERYING = "web_search_querying"
    WEB_SEARCH_RESULT = "web_search_result"
    WEB_SEARCH_COMPLETE = "web_search_complete"
    
    # 思考/规划
    THINK_START = "think_start"
    THINK_COMPLETE = "think_complete"
    
    PLAN_START = "plan_start"
    PLAN_COMPLETE = "plan_complete"


__all__ = [
    "STREAM_WRITER_AVAILABLE",
    "get_tool_stream_writer",
    "emit_tool_event",
    "ToolStreamContext",
    "ToolEvents",
]
