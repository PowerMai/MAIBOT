"""P1-1 插件 manifest 强校验回归：Schema 与 from_dict 行为。"""
from __future__ import annotations

import pytest

from backend.engine.plugins.spec import PluginSpec, MANIFEST_REQUIRED_KEYS


def test_validate_manifest_schema_rejects_missing_name():
    r = PluginSpec.validate_manifest_schema({"version": "1.0.0"})
    assert r["errors"]
    assert any("name" in e for e in r["errors"])


def test_validate_manifest_schema_rejects_empty_name():
    r = PluginSpec.validate_manifest_schema({"name": "  ", "version": "1.0.0"})
    assert r["errors"]
    assert any("name" in e for e in r["errors"])


def test_validate_manifest_schema_rejects_missing_version():
    r = PluginSpec.validate_manifest_schema({"name": "x"})
    assert r["errors"]
    assert any("version" in e for e in r["errors"])


def test_validate_manifest_schema_accepts_valid_minimal():
    r = PluginSpec.validate_manifest_schema({"name": "p", "version": "0.1.0"})
    assert not r["errors"]


def test_validate_manifest_schema_rejects_non_dict():
    r = PluginSpec.validate_manifest_schema([])
    assert r["errors"]
    assert "根节点" in r["errors"][0]


def test_validate_manifest_schema_rejects_invalid_requires_tier():
    r = PluginSpec.validate_manifest_schema({
        "name": "p",
        "version": "1.0.0",
        "requires_tier": "invalid_tier",
    })
    assert r["errors"]
    assert any("requires_tier" in e for e in r["errors"])


def test_from_dict_raises_on_schema_errors():
    with pytest.raises(ValueError, match="Schema 校验失败"):
        PluginSpec.from_dict({"version": "1.0.0"})


def test_from_dict_succeeds_on_valid():
    spec = PluginSpec.from_dict({"name": "my-plugin", "version": "0.2.0"})
    assert spec.name == "my-plugin"
    assert spec.version == "0.2.0"
