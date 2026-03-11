"""
LangGraph Config 管理器 - 充分利用官方功能

按照 Cursor 风格实现配置管理，支持：
- 模型选择（model_id, temperature, max_tokens）
- 任务配置（task_type, priority, timeout）
- 权限控制（user_role, allowed_tools, workspace_access）
- 调试监控（debug_mode, trace_id, log_level）
- 性能优化（max_concurrent, cache_enabled, streaming）
"""

from typing import Optional, Dict, Any, List
from langchain_core.runnables import RunnableConfig
import logging

logger = logging.getLogger(__name__)


class ConfigManager:
    """
    配置管理器 - 统一管理所有 LangGraph config 配置项
    
    按照 Cursor 风格设计：
    - 类型安全
    - 默认值合理
    - 易于扩展
    """
    
    def __init__(self, config: Optional[RunnableConfig] = None):
        """
        初始化配置管理器
        
        Args:
            config: LangGraph 传递的 RunnableConfig 对象
        """
        self.config = config or {}
        self.configurable = self.config.get("configurable", {}) or {}
    
    # ============================================================
    # 模型配置（Model Configuration）
    # ============================================================
    
    @property
    def model_id(self) -> Optional[str]:
        """选择的模型 ID"""
        return self.configurable.get("model_id")
    
    @property
    def model_temperature(self) -> float:
        """模型温度参数（0.0-2.0）"""
        return self.configurable.get("model_temperature", 0.7)
    
    @property
    def model_max_tokens(self) -> int:
        """模型最大 token 数"""
        return self.configurable.get("model_max_tokens", 32768)
    
    @property
    def model_timeout(self) -> int:
        """模型请求超时时间（秒）"""
        return self.configurable.get("model_timeout", 300)
    
    def get_model_config(self) -> Dict[str, Any]:
        """获取完整的模型配置"""
        return {
            "model_id": self.model_id,
            "temperature": self.model_temperature,
            "max_tokens": self.model_max_tokens,
            "timeout": self.model_timeout,
        }
    
    # ============================================================
    # 任务配置（Task Configuration）
    # ============================================================
    
    @property
    def task_type(self) -> str:
        """任务类型：analysis, generation, review, chat"""
        return self.configurable.get("task_type", "chat")
    
    @property
    def task_priority(self) -> str:
        """任务优先级：low, normal, high, urgent"""
        return self.configurable.get("task_priority", "normal")
    
    @property
    def task_timeout(self) -> int:
        """任务超时时间（秒）"""
        return self.configurable.get("task_timeout", 300)
    
    @property
    def task_max_iterations(self) -> int:
        """任务最大迭代次数"""
        return self.configurable.get("task_max_iterations", 10)
    
    def get_task_config(self) -> Dict[str, Any]:
        """获取完整的任务配置"""
        return {
            "task_type": self.task_type,
            "priority": self.task_priority,
            "timeout": self.task_timeout,
            "max_iterations": self.task_max_iterations,
        }
    
    # ============================================================
    # 权限配置（Permission Configuration）
    # ============================================================
    
    @property
    def user_role(self) -> str:
        """用户角色：admin, user, guest"""
        return self.configurable.get("user_role", "user")
    
    @property
    def allowed_tools(self) -> List[str]:
        """允许使用的工具列表（空列表表示全部允许）"""
        return self.configurable.get("allowed_tools", [])
    
    @property
    def workspace_access(self) -> List[str]:
        """可访问的工作区列表（空列表表示全部允许）"""
        return self.configurable.get("workspace_access", [])
    
    @property
    def user_id(self) -> Optional[str]:
        """用户 ID（从 thread metadata 自动传递）"""
        return self.configurable.get("user_id")
    
    @property
    def team_id(self) -> Optional[str]:
        """团队 ID（从 thread metadata 自动传递）"""
        return self.configurable.get("team_id")
    
    def has_permission(self, tool_name: str) -> bool:
        """检查是否有权限使用指定工具"""
        if not self.allowed_tools:
            return True  # 空列表表示全部允许
        return tool_name in self.allowed_tools
    
    def get_permission_config(self) -> Dict[str, Any]:
        """获取完整的权限配置"""
        return {
            "user_role": self.user_role,
            "user_id": self.user_id,
            "team_id": self.team_id,
            "allowed_tools": self.allowed_tools,
            "workspace_access": self.workspace_access,
        }
    
    # ============================================================
    # 调试和监控配置（Debug & Monitoring）
    # ============================================================
    
    @property
    def debug_mode(self) -> bool:
        """是否启用调试模式"""
        return self.configurable.get("debug_mode", False)
    
    @property
    def trace_id(self) -> Optional[str]:
        """追踪 ID（用于日志关联）"""
        return self.configurable.get("trace_id")
    
    @property
    def request_id(self) -> Optional[str]:
        """请求 ID（用于请求追踪）"""
        return self.configurable.get("request_id")
    
    @property
    def log_level(self) -> str:
        """日志级别：debug, info, warning, error"""
        return self.configurable.get("log_level", "info")
    
    def get_debug_config(self) -> Dict[str, Any]:
        """获取完整的调试配置"""
        return {
            "debug_mode": self.debug_mode,
            "trace_id": self.trace_id,
            "request_id": self.request_id,
            "log_level": self.log_level,
        }
    
    # ============================================================
    # 性能优化配置（Performance Configuration）
    # ============================================================
    
    @property
    def max_concurrent_tools(self) -> int:
        """最大并发工具数"""
        return self.configurable.get("max_concurrent_tools", 5)
    
    @property
    def cache_enabled(self) -> bool:
        """是否启用缓存"""
        return self.configurable.get("cache_enabled", True)
    
    @property
    def streaming_enabled(self) -> bool:
        """是否启用流式输出"""
        return self.configurable.get("streaming_enabled", True)
    
    @property
    def batch_size(self) -> int:
        """批处理大小"""
        return self.configurable.get("batch_size", 10)
    
    def get_performance_config(self) -> Dict[str, Any]:
        """获取完整的性能配置"""
        return {
            "max_concurrent_tools": self.max_concurrent_tools,
            "cache_enabled": self.cache_enabled,
            "streaming_enabled": self.streaming_enabled,
            "batch_size": self.batch_size,
        }
    
    # ============================================================
    # 编辑器上下文配置（Editor Context）
    # ============================================================
    
    @property
    def editor_path(self) -> Optional[str]:
        """编辑器当前文件路径"""
        return self.configurable.get("editor_path")
    
    @property
    def selected_text(self) -> Optional[str]:
        """编辑器选中的文本"""
        return self.configurable.get("selected_text")
    
    @property
    def workspace_path(self) -> Optional[str]:
        """工作区路径"""
        return self.configurable.get("workspace_path")
    
    def get_editor_config(self) -> Dict[str, Any]:
        """获取完整的编辑器配置"""
        return {
            "editor_path": self.editor_path,
            "selected_text": self.selected_text,
            "workspace_path": self.workspace_path,
        }
    
    # ============================================================
    # 通用方法
    # ============================================================
    
    def get(self, key: str, default: Any = None) -> Any:
        """获取配置值（通用方法）"""
        return self.configurable.get(key, default)
    
    def has(self, key: str) -> bool:
        """检查配置项是否存在"""
        return key in self.configurable
    
    def get_all(self) -> Dict[str, Any]:
        """获取所有配置项"""
        return self.configurable.copy()
    
    def log_config(self, prefix: str = ""):
        """记录配置信息（用于调试）"""
        if self.debug_mode:
            logger.debug(f"{prefix}Config: {self.get_all()}")


# ============================================================
# 便捷函数
# ============================================================

def get_config_manager(config: Optional[RunnableConfig] = None) -> ConfigManager:
    """获取配置管理器实例"""
    return ConfigManager(config)


def get_model_config(config: Optional[RunnableConfig] = None) -> Dict[str, Any]:
    """快捷函数：获取模型配置"""
    return ConfigManager(config).get_model_config()


def get_task_config(config: Optional[RunnableConfig] = None) -> Dict[str, Any]:
    """快捷函数：获取任务配置"""
    return ConfigManager(config).get_task_config()


def get_permission_config(config: Optional[RunnableConfig] = None) -> Dict[str, Any]:
    """快捷函数：获取权限配置"""
    return ConfigManager(config).get_permission_config()


__all__ = [
    "ConfigManager",
    "get_config_manager",
    "get_model_config",
    "get_task_config",
    "get_permission_config",
]

