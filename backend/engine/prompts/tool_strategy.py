"""
工具调用策略 - 基于 Claude 官方最佳实践

参考：https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview

设计原则：只保留实际注入到系统提示词的内容，其他策略按需加载。
"""

from typing import List, Dict, Any, Optional


def get_tool_strategy_prompt(subagent_configs: Optional[List[Dict[str, Any]]] = None) -> str:
    """获取工具选择策略提示词（注入到系统提示词）
    
    Args:
        subagent_configs: SubAgent 配置列表，用于动态生成多源信息收集的推荐组合。
                          为 None 或空列表时省略 SubAgent 相关行。
    """
    # 基础速查行（始终存在）
    rows = [
        "| 文件分析 | python_run（解析）→ write_file（保存）|",
        "| 内容搜索 | grep（定位）→ read_file（读取）|",
        "| 文件定位 | glob（按模式找文件）→ read_file/grep（按需读或搜）|",
        "| 复杂任务 | task()（委派子代理）|",
    ]
    # 动态生成多源信息收集行
    if subagent_configs:
        _sa_names = [sa.get("name", "") for sa in subagent_configs]
        _explore = next((n for n in _sa_names if "explore" in n), None)
        _knowledge = next((n for n in _sa_names if "knowledge" in n), None)
        if _explore and _knowledge:
            rows.append(f"| 多源信息收集 | 并行 task({_explore}) + task({_knowledge})，再综合 |")
        elif _explore:
            rows.append(f"| 信息收集 | task({_explore})（探索）|")
    
    table = "\n".join(rows)
    
    return f"""
<tool_strategy>
工具选择速查（详细规则见上方 <tool_usage>，此处仅为优先级与组合速查表）。

选择优先级：Skills > python_run > 专用工具（search_knowledge / task()）> 文件工具。

| 任务 | 推荐组合 |
|-----|-----|
{table}

约定：先 grep/glob 定位再 read_file，避免对未知大文件直接 read_file。
</tool_strategy>
"""


# 向后兼容：无参数调用时返回不含 SubAgent 名称的通用版本
TOOL_SELECTION_STRATEGY = get_tool_strategy_prompt()


__all__ = [
    "get_tool_strategy_prompt",
    "TOOL_SELECTION_STRATEGY",
]
