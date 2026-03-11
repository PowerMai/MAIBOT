"""✅ 节点模块 - 官方标准实现

注意：deepagent 现在作为 Subgraph 直接集成到 main_graph.py 中，
不再需要 deepagent_node 包装函数。

同样，生成式UI处理已经集成到各个处理节点中，
不需要单独的后处理节点（违反官方标准）。
"""
from backend.engine.nodes.router_node import router_node, route_decision
from backend.engine.nodes.editor_tool_node import editor_tool_node
from backend.engine.nodes.error_node import error_node

__all__ = [
    "router_node",
    "route_decision",
    "editor_tool_node",
    "error_node",
]

