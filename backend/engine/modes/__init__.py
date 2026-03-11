"""
模式系统 - 五种交互模式的配置和管理

模式定位：
- Agent: 自动执行者 - 完成任务，输出可交付物
- Ask: 专业顾问 - 探讨分析，给出建议
- Plan: 战略参谋 - 制定计划，评估风险
- Debug: 问题诊断 - 追踪根因，修复问题
- Review: 评审模式 - 清单化审查并输出结构化评审报告

使用方式：
模式通过消息的 additional_kwargs.mode 传递，
后端根据模式动态调整提示词、工具集、上下文策略。
"""

from .mode_config import (
    ChatMode,
    ModeConfig,
    MODE_CONFIGS,
    MODE_TOOLS,
    MODE_OUTPUT_DIRS,
    MODE_USER_DESCRIPTIONS,
    get_mode_config,
    get_mode_tools,
    get_mode_output_dir,
    is_tool_allowed,
    explain_tool_policy,
    explain_tool_policy_decision,
    get_mode_prompt,
    get_mode_user_description,
    AGENT_MODE,
    ASK_MODE,
    PLAN_MODE,
    DEBUG_MODE,
    REVIEW_MODE,
)

__all__ = [
    "ChatMode",
    "ModeConfig",
    "MODE_CONFIGS",
    "MODE_TOOLS",
    "MODE_OUTPUT_DIRS",
    "get_mode_config",
    "get_mode_tools",
    "get_mode_output_dir",
    "is_tool_allowed",
    "explain_tool_policy",
    "explain_tool_policy_decision",
    "get_mode_prompt",
    "get_mode_user_description",
    "MODE_USER_DESCRIPTIONS",
    "AGENT_MODE",
    "ASK_MODE",
    "PLAN_MODE",
    "DEBUG_MODE",
    "REVIEW_MODE",
]
