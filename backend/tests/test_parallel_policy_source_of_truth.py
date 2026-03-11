from __future__ import annotations

import json

from backend.engine.agent import deep_agent


def _mock_read_factory(policy: dict, models: dict, license_data: dict, profile_data: dict):
    def _mock_read(path, max_age=120.0):  # noqa: ARG001
        p = str(path)
        if p.endswith("parallel_policy.json"):
            return json.dumps(policy)
        if p.endswith("models.json"):
            return json.dumps(models)
        if p.endswith("license.json"):
            return json.dumps(license_data)
        if p.endswith("agent_profile.json"):
            return json.dumps(profile_data)
        return None

    return _mock_read


def test_parallel_policy_local_profile(monkeypatch):
    policy = {
        "profiles": {
            "local": {"max_parallel_llm": 1, "max_parallel_agents": 2, "max_parallel_tools_per_agent": 2},
            "cloud": {"max_parallel_llm": 4, "max_parallel_agents": 6, "max_parallel_tools_per_agent": 3},
        },
        "cloud_activation": {"require_cloud_model_enabled": True, "allow_force_env": "FORCE_CLOUD_PARALLEL"},
        "priority_order": ["env", "policy_profile", "resource_adaptive", "license", "agent_profile"],
    }
    models = {"models": [{"id": "m-local", "enabled": True, "tier": "local"}]}
    license_data = {"tier": "enterprise"}
    profile_data = {"capabilities": {"max_parallel_tasks": 99}}

    monkeypatch.setenv("DEPLOYMENT_MODE", "local")
    monkeypatch.delenv("FORCE_CLOUD_PARALLEL", raising=False)
    monkeypatch.setattr(deep_agent, "_read_cached_file", _mock_read_factory(policy, models, license_data, profile_data))
    monkeypatch.setattr(deep_agent, "_detect_system_resources", lambda: {"available_memory_gb": 16.0, "cpu_cores": 12})

    deep_agent.Config.MAX_PARALLEL_LLM = 8
    deep_agent.Config.MAX_PARALLEL_AGENTS = 8
    deep_agent.Config.MAX_PARALLEL_TOOLS = 16
    deep_agent._apply_resource_adaptive_parallelism()

    assert deep_agent.Config.MAX_PARALLEL_LLM == 1
    assert deep_agent.Config.MAX_PARALLEL_AGENTS == 2
    assert deep_agent.Config.MAX_PARALLEL_TOOLS == 4
    assert deep_agent.get_config_summary()["parallel"]["policy_profile"] == "local"


def test_parallel_policy_cloud_profile(monkeypatch):
    policy = {
        "profiles": {
            "local": {"max_parallel_llm": 1, "max_parallel_agents": 2, "max_parallel_tools_per_agent": 2},
            "cloud": {"max_parallel_llm": 4, "max_parallel_agents": 6, "max_parallel_tools_per_agent": 3},
        },
        "cloud_activation": {"require_cloud_model_enabled": True, "allow_force_env": "FORCE_CLOUD_PARALLEL"},
        "priority_order": ["env", "policy_profile", "resource_adaptive", "license", "agent_profile"],
    }
    models = {
        "models": [
            {"id": "m-local", "enabled": True, "tier": "local"},
            {"id": "m-cloud", "enabled": True, "tier": "cloud-strong"},
        ]
    }
    license_data = {"tier": "enterprise"}
    profile_data = {"capabilities": {"max_parallel_tasks": 99}}

    monkeypatch.setenv("DEPLOYMENT_MODE", "cloud")
    monkeypatch.delenv("FORCE_CLOUD_PARALLEL", raising=False)
    monkeypatch.setattr(deep_agent, "_read_cached_file", _mock_read_factory(policy, models, license_data, profile_data))
    monkeypatch.setattr(deep_agent, "_detect_system_resources", lambda: {"available_memory_gb": 16.0, "cpu_cores": 12})

    deep_agent.Config.MAX_PARALLEL_LLM = 8
    deep_agent.Config.MAX_PARALLEL_AGENTS = 8
    deep_agent.Config.MAX_PARALLEL_TOOLS = 16
    deep_agent._apply_resource_adaptive_parallelism()

    assert deep_agent.Config.MAX_PARALLEL_LLM == 4
    assert deep_agent.Config.MAX_PARALLEL_AGENTS == 6
    assert deep_agent.Config.MAX_PARALLEL_TOOLS == 12
    summary = deep_agent.get_config_summary()["parallel"]
    assert summary["policy_profile"] == "cloud"
    assert summary["policy_cloud_model_enabled"] is True
