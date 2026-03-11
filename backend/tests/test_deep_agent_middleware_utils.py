from backend.engine.agent.middleware_utils import (
    dedupe_middlewares,
    filter_deepagent_owned_middlewares,
    format_middleware_chain,
    normalize_interrupt_on_config,
    normalize_subagent_tool_map,
    normalize_tool_name_list,
    sanitize_subagent_configs,
)


class _NamedMiddleware:
    def __init__(self, name: str):
        self.name = name


class HumanInTheLoopMiddleware:
    pass


class _Tool:
    def __init__(self, name: str):
        self.name = name


def test_dedupe_middlewares_by_name():
    m1 = _NamedMiddleware("alpha")
    m2 = _NamedMiddleware("beta")
    m3 = _NamedMiddleware("alpha")

    out = dedupe_middlewares([m1, m2, m3])

    assert out == [m1, m2]


def test_dedupe_middlewares_skips_none():
    m1 = _NamedMiddleware("alpha")
    out = dedupe_middlewares([None, m1, None, _NamedMiddleware("alpha")])
    assert out == [m1]


def test_filter_deepagent_owned_middlewares_removes_hitl():
    custom = _NamedMiddleware("custom")
    hitl = HumanInTheLoopMiddleware()

    out = filter_deepagent_owned_middlewares([custom, hitl])

    assert out == [custom]


def test_format_middleware_chain_uses_middleware_name():
    out = format_middleware_chain([_NamedMiddleware("one"), _NamedMiddleware("two")])
    assert out == "one -> two"


def test_sanitize_subagent_configs_filters_owned_and_dedupes():
    configs = [
        {
            "name": "explore-agent",
            "middleware": [_NamedMiddleware("x"), HumanInTheLoopMiddleware(), _NamedMiddleware("x")],
        }
    ]

    out = sanitize_subagent_configs(configs)

    assert len(out) == 1
    assert [mw.name for mw in out[0]["middleware"]] == ["x"]


def test_normalize_interrupt_on_config_filters_unknown_tools():
    out = normalize_interrupt_on_config(
        ["shell_run", "unknown_tool"],
        allowed_tool_names=["shell_run", "python_run"],
    )
    assert out == {"shell_run": True}


def test_normalize_interrupt_on_config_none_returns_empty_dict():
    out = normalize_interrupt_on_config(None, allowed_tool_names=["shell_run"])
    assert out == {}


def test_normalize_interrupt_on_config_string_input():
    out = normalize_interrupt_on_config(
        "shell_run",
        allowed_tool_names=["shell_run", "python_run"],
    )
    assert out == {"shell_run": True}


def test_normalize_interrupt_on_config_dict_value_passthrough():
    out = normalize_interrupt_on_config(
        {"shell_run": {"allowed_decisions": ["approve", "reject"]}},
        allowed_tool_names=["shell_run"],
    )
    assert out == {"shell_run": {"allowed_decisions": ["approve", "reject"]}}


def test_sanitize_subagent_configs_normalizes_interrupt_on_by_subagent_tools():
    configs = [
        {
            "name": "explore-agent",
            "tools": [_Tool("shell_run")],
            "interrupt_on": {"shell_run": True, "python_run": True},
        }
    ]
    out = sanitize_subagent_configs(configs)
    assert out[0]["interrupt_on"] == {"shell_run": True}


def test_sanitize_subagent_configs_combined_normalization():
    configs = [
        {
            "name": "explore-agent",
            "tools": [_Tool("shell_run")],
            "middleware": [HumanInTheLoopMiddleware(), _NamedMiddleware("x"), _NamedMiddleware("x"), None],
            "interrupt_on": {"shell_run": True, "python_run": True},
        }
    ]
    out = sanitize_subagent_configs(configs)
    assert [mw.name for mw in out[0]["middleware"]] == ["x"]
    assert out[0]["interrupt_on"] == {"shell_run": True}


def test_normalize_tool_name_list_dedupes_and_fallbacks():
    out = normalize_tool_name_list(["shell_run", "shell_run", " ", "python_run"], default=["x"])
    assert out == ["shell_run", "python_run"]

    bad = normalize_tool_name_list("not-list", default=["fallback"])
    assert bad == ["fallback"]

    missing = normalize_tool_name_list(None, default=["fallback"])
    assert missing == ["fallback"]


def test_normalize_subagent_tool_map_uses_defaults_and_ignores_unknown_role():
    defaults = {"explore": ["web_search"]}
    out = normalize_subagent_tool_map(
        {"explore": ["shell_run", "shell_run"], "unknown": ["x"]},
        default_map=defaults,
    )
    assert out == {"explore": ["shell_run"]}
