import os
import logging

def enable_deepagent_debug(enable: bool = True):
    """
    启用或关闭 langchain 生态相关库（langchain、langgraph、deepagents 等）
    及本项目的统一调试模式。

    Args:
        enable (bool): True 启用调试，False 关闭调试（通过环境变量）

    生效范围：
    - langchain（llm交互、链调用）
    - langgraph（节点、状态流转）
    - deepagents（agent 结构化处理）
    - 项目自身（推荐配合 logging）

    调用方式：
        from backend.engine.utils.debug import enable_deepagent_debug
        enable_deepagent_debug(True)  # 启用
        enable_deepagent_debug(False) # 关闭
    """

    if enable:
        os.environ["LANGCHAIN_TRACING_V2"] = "true"
        os.environ["LANGCHAIN_VERBOSE"] = "true"
        os.environ["LANGCHAIN_HANDLER"] = "stdout"
        os.environ["LANGGRAPH_DEBUG"] = "1"
        os.environ["DEEPAGENT_DEBUG"] = "1"
        os.environ["DEBUG"] = "1"
        os.environ["LOGLEVEL"] = "DEBUG"
    else:
        os.environ["LANGCHAIN_TRACING_V2"] = "false"
        os.environ["LANGCHAIN_VERBOSE"] = "false"
        os.environ["LANGCHAIN_HANDLER"] = "null"
        os.environ["LANGGRAPH_DEBUG"] = "0"
        os.environ["DEEPAGENT_DEBUG"] = "0"
        os.environ["DEBUG"] = "0"
        os.environ["LOGLEVEL"] = "WARNING"

def enable_python_logging_debug(enable: bool = True):
    """
    启用或关闭 Python 日志调试输出，并配合 langchain 官方日志格式增强显示效果。

    Args:
        enable (bool): True 启用调试, False 关闭调试输出
    """
    # langchain推荐的日志格式
    langchain_format = '[%(asctime)s] %(levelname)s [%(name)s] %(message)s'
    if enable:
        logging.basicConfig(
            level=logging.DEBUG,
            format=langchain_format
        )
        try:
            import rich
            from rich.console import Console
            from rich.markup import escape
            console = Console()
            console.print("[bold green]✅ DeepAgent 调试模式已启用[/bold green]")
            console.print("[green]将显示所有内部处理步骤，输出风格与 langchain 官方一致[/green]")
        except ImportError:
            print("✅ DeepAgent 调试模式已启用")
            print("   将显示所有内部处理步骤")
    else:
        logging.basicConfig(
            level=logging.WARNING,
            format=langchain_format
        )
        try:
            import rich
            from rich.console import Console
            console = Console()
            console.print("[bold cyan]ℹ️ DeepAgent 日志调试已关闭[/bold cyan]")
        except ImportError:
            print("ℹ️ DeepAgent 日志调试已关闭")

def langchain_style_debug_log(msg, level="DEBUG"):
    import logging
    LEVEL_MAP = {
        "DEBUG": logging.DEBUG,
        "INFO": logging.INFO,
        "WARNING": logging.WARNING,
        "ERROR": logging.ERROR,
    }
    loglevel = LEVEL_MAP.get(level.upper(), logging.DEBUG)
    logging.log(loglevel, f"[DeepAgent Saver] {msg}")