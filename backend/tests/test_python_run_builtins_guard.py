from __future__ import annotations

import asyncio

from backend.tools.base.code_execution import PythonExecutor


def test_python_run_blocks_builtin_table_mutation():
    result = asyncio.run(
        PythonExecutor.execute(
            "__builtins__['open'] = print\nresult = 'should-not-pass'",
            timeout=5,
            auto_install=False,
        )
    )
    assert result.get("status") == "error"
    assert "mappingproxy" in str(result.get("error", "")).lower() or "mappingproxy" in str(
        result.get("traceback", "")
    ).lower()


def test_python_run_keeps_basic_builtins_available():
    result = asyncio.run(
        PythonExecutor.execute(
            "result = sum(range(5))\nprint(result)",
            timeout=5,
            auto_install=False,
        )
    )
    assert result.get("status") == "success"
    assert result.get("result") == 10
