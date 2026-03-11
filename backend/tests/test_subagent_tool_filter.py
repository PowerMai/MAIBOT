from backend.engine.agent.deep_agent import create_subagent_configs
from backend.engine.prompts.agent_prompts import create_config


def test_ask_mode_subagent_tools_are_readonly():
    cfg = create_config()
    subagents = create_subagent_configs(cfg, config={"configurable": {}}, mode="ask")

    blocked = {
        "write_file",
        "edit_file",
        "delete_file",
        "create_file",
        "remove_file",
        "copy_file",
        "move_file",
        "shell_run",
        "python_run",
        "python_internal",
    }

    for spec in subagents:
        tools = spec.get("tools", []) if isinstance(spec, dict) else []
        tool_names = {getattr(t, "name", "") for t in tools}
        assert tool_names.isdisjoint(blocked), (
            f"ask 模式子代理 {spec.get('name')} 存在写入/执行工具: {tool_names & blocked}"
        )

