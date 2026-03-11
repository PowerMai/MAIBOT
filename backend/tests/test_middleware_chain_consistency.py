"""链顺序一致性：middleware_chain.json 的 ask 链与 deep_agent 兜底 default_chain 一致。

与 INTEGRATION_CONTRACTS、架构优化建议 P3 一致：CI/启动时可校验 JSON 与代码回退链一致，
避免 JSON 缺失时行为与「ask 模式」不一致。若有意让 default_chain 与 JSON ask 不同，请在此处文档化并放宽断言。
"""
import json
from pathlib import Path

import pytest

# 与 backend/config/middleware_chain.json chains.ask 一致（链顺序以 JSON 为唯一来源；兜底 default_chain 与之对齐）
DEFAULT_CHAIN_ASK = [
    "mode_permission",
    "cloud_call_gate",
    "license_gate",
    "content_fix",
    "ontology_context",
    "context_guard",
    "reflection",
    "llm_tool_selector",
    "mcp",
    "inject_runtime_context",
    "streaming",
]

# 与 deep_agent.create_orchestrator_agent 中 middleware_candidates 的 key 保持一致；用于校验 JSON 链中无未定义 name
VALID_MIDDLEWARE_NAMES = {
    "streaming",
    "context_editing",
    "context_guard",
    "human_in_the_loop",
    "execution_trace",
    "mode_permission",
    "content_fix",
    "ontology_context",
    "cloud_call_gate",
    "license_gate",
    "reflection",
    "llm_tool_selector",
    "model_fallback",
    "pii_redact",
    "mcp",
    "skill_evolution",
    "self_improvement",
    "distillation",
    "scheduling_guard",
    "model_call_limit",
    "tool_call_limit",
    "tool_retry",
    "model_retry",
    "inject_runtime_context",
}


def test_middleware_chain_json_ask_matches_default_chain():
    """JSON 中 ask 链与 deep_agent 兜底链一致，便于回退时行为可预期。"""
    root = Path(__file__).resolve().parents[1]
    config_path = root / "config" / "middleware_chain.json"
    if not config_path.is_file():
        pytest.skip("middleware_chain.json not found")
    raw = config_path.read_text(encoding="utf-8")
    data = json.loads(raw)
    chains = data.get("chains", {}) or {}
    ask_chain = chains.get("ask")
    assert ask_chain is not None, "chains.ask 缺失"
    assert isinstance(ask_chain, list), "chains.ask 应为 list"
    cleaned = [str(x).strip() for x in ask_chain if str(x).strip()]
    assert cleaned == DEFAULT_CHAIN_ASK, (
        "chains.ask 与 deep_agent 中 default_chain 不一致："
        " 修改 backend/engine/agent/deep_agent.py _load_middleware_chain 的 default_chain，"
        " 或修改本测试的 DEFAULT_CHAIN_ASK 并文档化例外。"
    )


def test_middleware_chain_all_modes_use_defined_names():
    """各 mode（agent/ask/plan/debug/review）链中的 name 均为 middleware_candidates 中已定义。"""
    root = Path(__file__).resolve().parents[1]
    config_path = root / "config" / "middleware_chain.json"
    if not config_path.is_file():
        pytest.skip("middleware_chain.json not found")
    raw = config_path.read_text(encoding="utf-8")
    data = json.loads(raw)
    chains = data.get("chains", {}) or {}
    for mode, chain in chains.items():
        if not isinstance(chain, list):
            continue
        for name in chain:
            n = str(name).strip()
            if not n:
                continue
            assert n in VALID_MIDDLEWARE_NAMES, (
                f"chains.{mode} 中存在未在 deep_agent middleware_candidates 中定义的 name: {n!r}"
            )
