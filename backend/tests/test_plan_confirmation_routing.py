"""P0-2 Plan 确认回归：未确认不执行、仅 approve 类决策进入执行阶段。

- 路由层：mode=plan 时必须进入 deepagent_plan，不得直接进入 deepagent_execute。
- 图级 interrupt 恢复：仅 approve/confirmed/yes/execute 等写入 plan_confirmed 并执行。
"""
from __future__ import annotations

from langchain_core.messages import HumanMessage

from backend.engine.core.main_graph import extract_mode_from_messages, plan_route_decision


def test_plan_mode_routes_to_plan_node():
    """mode=plan 时路由必须到 deepagent_plan，不得进入执行节点。"""
    state = {
        "messages": [
            HumanMessage(
                content="请帮我规划一下",
                additional_kwargs={
                    "source": "chatarea",
                    "request_type": "agent_chat",
                    "mode": "plan",
                },
            ),
        ],
    }
    assert plan_route_decision(state) == "deepagent_plan"


def test_agent_mode_routes_to_execute_node():
    """mode=agent 时路由到 deepagent_execute。"""
    state = {
        "messages": [
            HumanMessage(
                content="执行任务",
                additional_kwargs={
                    "source": "chatarea",
                    "request_type": "agent_chat",
                    "mode": "agent",
                },
            ),
        ],
    }
    assert plan_route_decision(state) == "deepagent_execute"


def test_extract_mode_plan():
    """从消息中正确解析 mode=plan。"""
    messages = [
        HumanMessage(content="x", additional_kwargs={"mode": "plan"}),
    ]
    assert extract_mode_from_messages(messages) == "plan"


def test_extract_mode_agent_default():
    """无 mode 时默认为 agent。"""
    messages = [HumanMessage(content="x")]
    assert extract_mode_from_messages(messages) == "agent"


def test_extract_mode_latest_wins():
    """多条消息时取最近一条的 mode。"""
    messages = [
        HumanMessage(content="a", additional_kwargs={"mode": "plan"}),
        HumanMessage(content="b", additional_kwargs={"mode": "agent"}),
    ]
    assert extract_mode_from_messages(messages) == "agent"
