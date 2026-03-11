from __future__ import annotations

from backend.engine.agent.deep_agent import _resolve_parallel_policy_profile


def test_parallel_policy_local_when_deployment_local(monkeypatch):
    monkeypatch.setenv("DEPLOYMENT_MODE", "local")
    monkeypatch.delenv("FORCE_CLOUD_PARALLEL", raising=False)
    policy = {"cloud_activation": {"require_cloud_model_enabled": True, "allow_force_env": "FORCE_CLOUD_PARALLEL"}}
    assert _resolve_parallel_policy_profile(policy, cloud_model_enabled=True) == "local"


def test_parallel_policy_cloud_when_cloud_and_model_enabled(monkeypatch):
    monkeypatch.setenv("DEPLOYMENT_MODE", "cloud")
    monkeypatch.delenv("FORCE_CLOUD_PARALLEL", raising=False)
    policy = {"cloud_activation": {"require_cloud_model_enabled": True, "allow_force_env": "FORCE_CLOUD_PARALLEL"}}
    assert _resolve_parallel_policy_profile(policy, cloud_model_enabled=True) == "cloud"


def test_parallel_policy_falls_back_local_when_cloud_model_disabled(monkeypatch):
    monkeypatch.setenv("DEPLOYMENT_MODE", "cloud")
    monkeypatch.delenv("FORCE_CLOUD_PARALLEL", raising=False)
    policy = {"cloud_activation": {"require_cloud_model_enabled": True, "allow_force_env": "FORCE_CLOUD_PARALLEL"}}
    assert _resolve_parallel_policy_profile(policy, cloud_model_enabled=False) == "local"


def test_parallel_policy_force_env_overrides(monkeypatch):
    monkeypatch.setenv("DEPLOYMENT_MODE", "local")
    monkeypatch.setenv("FORCE_CLOUD_PARALLEL", "true")
    policy = {"cloud_activation": {"require_cloud_model_enabled": True, "allow_force_env": "FORCE_CLOUD_PARALLEL"}}
    assert _resolve_parallel_policy_profile(policy, cloud_model_enabled=False) == "cloud"
