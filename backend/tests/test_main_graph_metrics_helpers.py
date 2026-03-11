from backend.engine.core.main_graph import (
    _resolve_model_id_with_route_prefix,
    _resolve_runtime_retry_count,
)


def test_resolve_runtime_retry_count_prefers_runtime_state_value():
    final_state = {"retry_count": 3}
    assert _resolve_runtime_retry_count(1, final_state) == 3


def test_resolve_runtime_retry_count_keeps_base_on_invalid_state():
    assert _resolve_runtime_retry_count(2, {"retry_count": "x"}) == 2


def test_resolve_model_id_with_route_prefix_for_fallback():
    cfg = {"model": "gpt-4o-mini", "model_route_reason": "fallback"}
    assert _resolve_model_id_with_route_prefix(cfg) == "fallback:gpt-4o-mini"


def test_resolve_model_id_with_route_prefix_for_direct_route():
    cfg = {"thread_model": "qwen3", "model_route_reason": "direct"}
    assert _resolve_model_id_with_route_prefix(cfg) == "qwen3"


def test_resolve_model_id_with_route_prefix_prefers_resolved_model_id():
    cfg = {
        "model": "primary-local",
        "resolved_model_id": "cloud-b",
        "model_route_reason": "fallback",
    }
    assert _resolve_model_id_with_route_prefix(cfg) == "cloud-b"
