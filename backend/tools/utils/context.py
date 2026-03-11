"""
工具辅助函数 - 从 LangGraph context 中提取用户信息

用于让工具能够访问当前用户的 user_id 和 team_id

✅ 已升级：现在使用 ConfigManager 统一管理配置

✅ 运行上下文：DeepAgent 节点在 astream 前设置 _run_configurable，供 list_skills/match_skills 等按 tier 过滤技能。
"""

from typing import Optional, Dict, Any
import contextvars
from langchain_core.runnables import RunnableConfig

# 当前运行 configurable（由 main_graph deepagent_node 在 astream 前设置，供技能工具按 tier 过滤）
_run_configurable: contextvars.ContextVar[Optional[Dict[str, Any]]] = contextvars.ContextVar(
    "run_configurable", default=None
)


def set_run_configurable(configurable: Optional[Dict[str, Any]]) -> None:
    """设置当前运行的 configurable（供 list_skills 等按 tier 过滤）。"""
    _run_configurable.set(configurable)


def get_run_configurable() -> Optional[Dict[str, Any]]:
    """获取当前运行的 configurable；无设置时返回 None（tier 过滤不生效，等价全量）。"""
    return _run_configurable.get()

try:
    from backend.engine.utils.config_manager import get_config_manager
    _HAS_CONFIG_MANAGER = True
except ImportError:
    _HAS_CONFIG_MANAGER = False


def get_user_context_from_config(config: Optional[RunnableConfig] = None) -> Dict[str, Optional[str]]:
    """
    从 LangGraph RunnableConfig 中提取用户上下文
    
    ✅ 已升级：使用 ConfigManager 统一管理
    
    LangGraph 会自动将 thread metadata 传递到 config 中：
    config = {
        "configurable": {
            "thread_id": "...",
            "user_id": "demo-user",
            "team_id": "demo-team",
            ...
        }
    }
    
    Args:
        config: LangGraph 传递的配置对象
        
    Returns:
        {
            "user_id": "...",
            "team_id": "...",
        }
    """
    # ✅ 优先使用 ConfigManager（如果可用）
    if _HAS_CONFIG_MANAGER:
        try:
            config_mgr = get_config_manager(config)
            return {
                "user_id": config_mgr.user_id,
                "team_id": config_mgr.team_id,
            }
        except Exception:
            pass  # 降级到旧实现
    
    # 降级到旧实现（兼容性）
    if not config:
        return {"user_id": None, "team_id": None}
    
    configurable = config.get("configurable", {})
    
    return {
        "user_id": configurable.get("user_id"),
        "team_id": configurable.get("team_id"),
    }


def get_user_id_from_config(config: Optional[RunnableConfig] = None) -> Optional[str]:
    """快捷方法：获取 user_id"""
    return get_user_context_from_config(config).get("user_id")


def get_team_id_from_config(config: Optional[RunnableConfig] = None) -> Optional[str]:
    """快捷方法：获取 team_id"""
    return get_user_context_from_config(config).get("team_id")


__all__ = [
    "get_user_context_from_config",
    "get_user_id_from_config",
    "get_team_id_from_config",
    "set_run_configurable",
    "get_run_configurable",
]

