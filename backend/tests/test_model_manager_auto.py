from backend.engine.agent.model_manager import ModelConfig, ModelInfo, ModelManager


def _build_single_model_manager(
    *,
    model_id: str = "primary",
    enabled: bool = True,
    available: bool = True,
    last_check: str | None = "2026-01-01T00:00:00+00:00",
) -> ModelManager:
    manager = ModelManager()
    manager._config = ModelConfig(
        models=[
            ModelInfo(
                id=model_id,
                name=model_id,
                description="",
                url="http://localhost:1",
                enabled=enabled,
                available=available,
                last_check=last_check,
                priority=1,
                tier="local",
            )
        ],
        default_model=model_id,
        subagent_model="same_as_main",
    )
    manager._rebuild_model_index()
    return manager


def test_resolve_auto_prefers_available_enabled_model():
    manager = ModelManager()
    manager._config = ModelConfig(
        models=[
            ModelInfo(
                id="m1",
                name="m1",
                description="",
                url="http://localhost:1",
                enabled=True,
                priority=1,
                available=False,
                last_check="2026-01-01T00:00:00+00:00",
            ),
            ModelInfo(
                id="m2",
                name="m2",
                description="",
                url="http://localhost:1",
                enabled=True,
                priority=2,
                available=True,
                last_check="2026-01-01T00:00:00+00:00",
            ),
        ],
        default_model="m1",
        subagent_model="same_as_main",
    )
    manager._rebuild_model_index()
    assert manager._resolve_auto_model() == "m2"


def test_create_llm_marks_fallback_route_reason_when_retry_high():
    manager = ModelManager()
    manager._ensure_llm_cache_initialized = lambda: None
    manager._config = ModelConfig(
        models=[
            ModelInfo(
                id="primary",
                name="primary",
                description="",
                url="http://localhost:1",
                enabled=True,
                available=True,
                priority=1,
                tier="local",
                config={"max_tokens_default": 16384, "enable_thinking": True},
            ),
            ModelInfo(
                id="backup",
                name="backup",
                description="",
                url="http://localhost:1",
                enabled=True,
                available=True,
                priority=2,
                tier="local",
                config={"max_tokens_default": 16384, "enable_thinking": True},
            ),
        ],
        default_model="primary",
        subagent_model="same_as_main",
        escalation_policy={"enabled": True, "fallback_order": ["local"]},
    )
    manager._rebuild_model_index()

    sentinel = object()
    manager._llm_cache["backup:16384:default:-:1:balanced"] = sentinel
    cfg = {"configurable": {"model": "primary", "retry_count": 2}}
    llm = manager.create_llm(config=cfg)

    assert llm is sentinel
    assert cfg["configurable"]["model_route_reason"] == "fallback"
    assert cfg["configurable"]["resolved_model_id"] == "backup"


def test_get_subagent_model_fallbacks_to_main_when_empty_config():
    manager = ModelManager()
    manager._config = ModelConfig(
        models=[
            ModelInfo(
                id="primary",
                name="primary",
                description="",
                url="http://localhost:1",
                enabled=True,
                available=True,
                priority=1,
                tier="local",
            )
        ],
        default_model="primary",
        subagent_model="",  # 回归场景：配置异常为空字符串
        subagent_model_mapping={"executor": ""},
    )
    manager._rebuild_model_index()

    cfg = {"configurable": {"model": "primary"}}
    resolved = manager.get_subagent_model(cfg, agent_type="executor")
    assert resolved == "primary"


def test_get_model_for_thread_raises_when_pinned_model_unavailable():
    manager = _build_single_model_manager(available=False)
    cfg = {"configurable": {"pinned_model": "primary"}}

    try:
        manager.get_model_for_thread(cfg)
        assert False, "expected ValueError when pinned model unavailable"
    except ValueError as e:
        assert "pinned_model=primary" in str(e)
        assert "拒绝自动回退" in str(e)


def test_get_model_for_thread_raises_when_thread_model_unavailable():
    manager = _build_single_model_manager(available=False)
    cfg = {"configurable": {"thread_model": "primary"}}

    try:
        manager.get_model_for_thread(cfg)
        assert False, "expected ValueError when thread model unavailable"
    except ValueError as e:
        assert "thread_model=primary" in str(e)
        assert "拒绝自动回退" in str(e)


def test_resolve_auto_priority_then_available_prefers_default_when_available():
    """priority_then_available 时，default_model 可用则优先用 default，不因 capability 分数高而选 35B。"""
    manager = ModelManager()
    manager._config = ModelConfig(
        models=[
            ModelInfo(
                id="qwen/qwen3.5-9b",
                name="9B",
                description="",
                url="http://localhost:1",
                enabled=True,
                available=True,
                priority=0,
                tier="local",
                last_check="2026-01-01T00:00:00+00:00",
                capability={"reasoning_depth": 0.85, "writing": 0.84},
            ),
            ModelInfo(
                id="qwen/qwen3.5-35b-a3b",
                name="35B",
                description="",
                url="http://localhost:1",
                enabled=True,
                available=True,
                priority=1,
                tier="local",
                last_check="2026-01-01T00:00:00+00:00",
                capability={"reasoning_depth": 0.9, "writing": 0.86},
            ),
        ],
        default_model="qwen/qwen3.5-9b",
        subagent_model="same_as_main",
        auto_selection_rule="priority_then_available",
    )
    manager._rebuild_model_index()
    assert manager._resolve_auto_model() == "qwen/qwen3.5-9b"


def test_fallback_prefers_default_model_when_available():
    """get_fallback_model_for 在无云模型时优先返回 default_model（非主模型时）。"""
    manager = ModelManager()
    manager._config = ModelConfig(
        models=[
            ModelInfo(
                id="qwen/qwen3.5-9b",
                name="9B",
                description="",
                url="http://localhost:1",
                enabled=True,
                available=True,
                priority=0,
                tier="local",
                last_check="2026-01-01T00:00:00+00:00",
            ),
            ModelInfo(
                id="qwen/qwen3.5-35b-a3b",
                name="35B",
                description="",
                url="http://localhost:1",
                enabled=True,
                available=True,
                priority=1,
                tier="local",
                last_check="2026-01-01T00:00:00+00:00",
            ),
        ],
        default_model="qwen/qwen3.5-9b",
        subagent_model="same_as_main",
        escalation_policy={"enabled": True, "fallback_order": ["cloud-reasoning"]},
    )
    manager._rebuild_model_index()
    # 主模型为 35B 时，回退应优先 9B（default_model）
    fallback = manager.get_fallback_model_for("qwen/qwen3.5-35b-a3b")
    assert fallback == "qwen/qwen3.5-9b"


def test_resolve_best_local_prefers_default():
    """_resolve_best_local_model 优先返回 default_model（若为 local 且可用）。"""
    manager = ModelManager()
    manager._config = ModelConfig(
        models=[
            ModelInfo(
                id="qwen/qwen3.5-35b-a3b",
                name="35B",
                description="",
                url="http://localhost:1",
                enabled=True,
                available=True,
                priority=1,
                tier="local",
                last_check="2026-01-01T00:00:00+00:00",
            ),
            ModelInfo(
                id="qwen/qwen3.5-9b",
                name="9B",
                description="",
                url="http://localhost:1",
                enabled=True,
                available=True,
                priority=0,
                tier="local",
                last_check="2026-01-01T00:00:00+00:00",
            ),
        ],
        default_model="qwen/qwen3.5-9b",
        subagent_model="same_as_main",
    )
    manager._rebuild_model_index()
    best = manager._resolve_best_local_model()
    assert best == "qwen/qwen3.5-9b"
