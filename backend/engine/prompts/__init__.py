"""
Agent Prompts - Orchestrator + 3 Sub-Agents

综合 LangChain DeepAgent 官方示例 + Cursor/Claude 最佳实践
"""

from .agent_prompts import (
    AgentConfig,
    get_orchestrator_prompt,
    get_planning_prompt,
    get_executor_prompt,
    get_knowledge_prompt,
    get_explore_prompt,
    get_human_checkpoints_prompt,
    create_config,
    get_all_prompts,
)

__all__ = [
    "AgentConfig",
    "get_orchestrator_prompt",
    "get_planning_prompt",
    "get_executor_prompt",
    "get_knowledge_prompt",
    "get_explore_prompt",
    "get_human_checkpoints_prompt",
    "create_config",
    "get_all_prompts",
]
