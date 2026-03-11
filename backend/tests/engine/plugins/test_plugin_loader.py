import json
from pathlib import Path

import pytest

from backend.config.store_namespaces import NS_BILLING_USAGE
from backend.engine.plugins.plugin_loader import PluginLoader
from backend.engine.plugins.spec import PluginSpec


class DummyStore:
    def __init__(self) -> None:
        self._data: dict[tuple[tuple[str, ...], str], dict] = {}

    def get(self, namespace, key):
        return self._data.get((tuple(namespace), str(key)))

    def put(self, namespace, key, value):
        self._data[(tuple(namespace), str(key))] = dict(value)


def _write_plugin_manifest(base: Path, name: str, requires_tier: str = "free") -> None:
    p = base / "plugins" / name
    (p / ".claude-plugin").mkdir(parents=True, exist_ok=True)
    (p / ".claude-plugin" / "plugin.json").write_text(
        json.dumps(
            {
                "name": name,
                "version": "1.0.0",
                "description": f"plugin {name}",
                "requires_tier": requires_tier,
                "license": "commercial",
                "author": {"name": "test"},
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )


def _write_claude_manifest(base: Path, name: str) -> None:
    p = base / "plugins" / name
    (p / ".claude-plugin").mkdir(parents=True, exist_ok=True)
    (p / ".claude-plugin" / "plugin.json").write_text(
        json.dumps(
            {
                "name": name,
                "version": "1.1.0",
                "description": f"claude plugin {name}",
                "author": {"name": "Anthropic"},
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )


def test_discover_loads_manifest(tmp_path: Path):
    _write_plugin_manifest(tmp_path, "demo-plugin")
    loader = PluginLoader(project_root=tmp_path, profile={"tier": "pro"})
    names = [spec.name for spec in loader.discover()]
    assert "demo-plugin" in names


def test_check_tier_works_with_rank_comparison(tmp_path: Path):
    loader = PluginLoader(project_root=tmp_path, profile={"tier": "free"})
    spec = PluginSpec(name="x", version="1.0.0", display_name="x", requires_tier="pro")
    assert loader.check_tier(spec, "free") is False
    assert loader.check_tier(spec, "pro") is True
    assert loader.check_tier(spec, "enterprise") is True


def test_load_enforces_tier_and_plugin_count_limit(tmp_path: Path):
    _write_plugin_manifest(tmp_path, "p1", requires_tier="free")
    _write_plugin_manifest(tmp_path, "p2", requires_tier="free")
    loader = PluginLoader(
        project_root=tmp_path,
        profile={"tier": "free", "limits": {"max_plugins": 1}},
    )
    loader.load("p1")
    with pytest.raises(PermissionError):
        loader.load("p2")


def test_load_records_install_usage(tmp_path: Path):
    _write_plugin_manifest(tmp_path, "usage-plugin", requires_tier="free")
    store = DummyStore()
    loader = PluginLoader(
        project_root=tmp_path,
        profile={"tier": "free", "limits": {"max_plugins": 5}},
        store=store,
    )
    loader.load("usage-plugin")
    payload = store.get(NS_BILLING_USAGE, "plugins:usage-plugin")
    assert isinstance(payload, dict)
    assert payload.get("plugin_name") == "usage-plugin"
    assert int(payload.get("install_count", 0) or 0) == 1


def test_get_active_commands_returns_plugin_command_markdown(tmp_path: Path):
    _write_plugin_manifest(tmp_path, "cmd-plugin", requires_tier="free")
    cmd_dir = tmp_path / "plugins" / "cmd-plugin" / "commands"
    cmd_dir.mkdir(parents=True, exist_ok=True)
    (cmd_dir / "run.md").write_text("# run\n", encoding="utf-8")
    loader = PluginLoader(project_root=tmp_path, profile={"tier": "free"})
    loader.load("cmd-plugin")
    commands = loader.get_active_commands()
    assert len(commands) == 1
    assert commands[0].endswith("/plugins/cmd-plugin/commands/run.md")


def test_discover_supports_claude_minimal_manifest(tmp_path: Path):
    _write_claude_manifest(tmp_path, "sales")
    loader = PluginLoader(project_root=tmp_path, profile={"tier": "free"})
    specs = {spec.name: spec for spec in loader.discover()}
    assert "sales" in specs
    assert specs["sales"].requires_tier == "free"
    assert specs["sales"].author_name == "Anthropic"


def test_spec_resolves_plugin_mcp_path(tmp_path: Path):
    _write_claude_manifest(tmp_path, "data")
    mcp_path = tmp_path / "plugins" / "data" / ".mcp.json"
    mcp_path.write_text(
        json.dumps({"mcpServers": {"slack": {"type": "http", "url": "https://mcp.slack.com/mcp"}}}),
        encoding="utf-8",
    )
    loader = PluginLoader(project_root=tmp_path, profile={"tier": "free"})
    specs = {spec.name: spec for spec in loader.discover()}
    assert specs["data"].resolved_mcp_path() is not None
