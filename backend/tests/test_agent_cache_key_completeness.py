from __future__ import annotations

from backend.engine.agent.deep_agent import _build_orchestrator_cache_key


def test_orchestrator_cache_key_changes_when_runtime_behavior_changes():
    key_a, _ = _build_orchestrator_cache_key(
        model_id="m1",
        mode="agent",
        configurable={"skill_profile": "general"},
        is_reasoning_model=False,
    )
    key_b, _ = _build_orchestrator_cache_key(
        model_id="m1",
        mode="agent",
        configurable={"skill_profile": "general", "task_type": "deep_research"},
        is_reasoning_model=False,
    )
    assert key_a != key_b


def test_orchestrator_cache_key_session_plugins_order_independent():
    key_a, _ = _build_orchestrator_cache_key(
        model_id="m1",
        mode="agent",
        configurable={"session_plugins": ["b", "a"], "tool_toggles": {"x": True}},
        is_reasoning_model=False,
    )
    key_b, _ = _build_orchestrator_cache_key(
        model_id="m1",
        mode="agent",
        configurable={"session_plugins": ["a", "b"], "tool_toggles": {"x": True}},
        is_reasoning_model=False,
    )
    assert key_a == key_b


def test_orchestrator_cache_key_plan_phase_distinct():
    """Plan 规划与执行阶段使用不同 prompt，缓存键必须区分。"""
    key_planning, _ = _build_orchestrator_cache_key(
        model_id="m1",
        mode="plan",
        configurable={"plan_phase": "planning", "plan_confirmed": False},
        is_reasoning_model=False,
    )
    key_execution, _ = _build_orchestrator_cache_key(
        model_id="m1",
        mode="plan",
        configurable={"plan_phase": "execution", "plan_confirmed": True, "plan_file_path": "/p/1.md"},
        is_reasoning_model=False,
    )
    assert key_planning != key_execution
    assert "plan_planning" in key_planning
    assert "plan_execution" in key_execution
