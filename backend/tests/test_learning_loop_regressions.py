from __future__ import annotations

import ast
from pathlib import Path

from backend.engine.middleware.done_verifier import DoneVerifier
from backend.engine.middleware.loop_detector import LoopDetector
from backend.engine.prompts.agent_prompts import _dispatch_layer4_budget


def _block(tag: str, size: int) -> str:
    return f"<{tag}>\n" + ("x" * max(1, size)) + f"\n</{tag}>"


def test_loop_detector_escape_plan_uses_current_escalation_level():
    detector = LoopDetector(max_identical_tool_calls=2)
    detector.observe_tool_call("search", {"q": "a"})
    signal = detector.observe_tool_call("search", {"q": "a"})
    assert signal.is_looping is True
    assert signal.suggested_strategy == "retry_with_variation"

    plan = detector.generate_escape_plan()
    assert "调整参数后仅重试一次" in plan


def test_done_verifier_requires_fraction_of_query_terms_in_agent_mode():
    verifier = DoneVerifier()
    query = "实现 loop guardrails done verifier context budget"

    failed = verifier.check(
        mode="agent",
        query=query,
        result_content="本次仅完成了 loop 的部分说明。",
        configurable={},
    )
    assert failed.passed is False
    assert "任务意图对齐不足" in failed.reason

    passed = verifier.check(
        mode="agent",
        query=query,
        result_content="已实现 loop 与 guardrails，并补充 done verifier 与 context budget 的结果。",
        configurable={},
    )
    assert passed.passed is True


def test_done_verifier_ask_always_passes():
    verifier = DoneVerifier()
    r = verifier.check(mode="ask", query="任意", result_content="简短回答", configurable={})
    assert r.passed is True


def test_done_verifier_plan_markers():
    verifier = DoneVerifier()
    # 无关键词 -> 不通过
    fail = verifier.check(
        mode="plan",
        query="做个计划",
        result_content="我们将会做几件事，然后完成。",
        configurable={},
    )
    assert fail.passed is False
    assert "plan" in fail.reason.lower() or "计划" in fail.reason
    # 含步骤/deliverable/风险等任一 -> 通过
    pass1 = verifier.check(
        mode="plan",
        query="计划",
        result_content="步骤 1：先分析。步骤 2：再执行。交付物：report.md。风险：无。",
        configurable={},
    )
    assert pass1.passed is True
    pass2 = verifier.check(
        mode="plan",
        query="计划",
        result_content="Deliverables: output.txt. Dependencies: lib A. Risks: none.",
        configurable={},
    )
    assert pass2.passed is True


def test_done_verifier_debug_markers():
    verifier = DoneVerifier()
    fail = verifier.check(
        mode="debug",
        query="为什么报错",
        result_content="可能是配置问题，建议检查。",
        configurable={},
    )
    assert fail.passed is False
    pass1 = verifier.check(
        mode="debug",
        query="为什么",
        result_content="根因：缺少依赖。复现步骤：1. 运行脚本 2. 触发异常。traceback 见上。",
        configurable={},
    )
    assert pass1.passed is True
    pass2 = verifier.check(
        mode="debug",
        query="诊断",
        result_content="Cause: the config file was missing. Because we didn't copy it.",
        configurable={},
    )
    assert pass2.passed is True


def test_done_verifier_review_markers():
    verifier = DoneVerifier()
    fail = verifier.check(
        mode="review",
        query="评审文档",
        result_content="文档较长，需要逐段看。",
        configurable={},
    )
    assert fail.passed is False
    pass1 = verifier.check(
        mode="review",
        query="评审",
        result_content="评审结论：通过。发现 3 个问题，严重程度：高 1、中 2。建议修改第 2 节。",
        configurable={},
    )
    assert pass1.passed is True
    pass2 = verifier.check(
        mode="review",
        query="review",
        result_content="Review: 2 issues. Severity: high. Recommendation: fix the typo.",
        configurable={},
    )
    assert pass2.passed is True


def test_done_verifier_empty_result_fails():
    verifier = DoneVerifier()
    r = verifier.check(mode="agent", query="做某事", result_content="", configurable={})
    assert r.passed is False
    assert "空" in r.reason or "empty" in r.reason.lower()


def test_dispatch_layer4_budget_reuses_remaining_budget_for_others():
    total = 1200
    selected = _dispatch_layer4_budget(
        total_budget_chars=total,
        guardrails_block="",
        learning_block="",
        execution_replay_block="",
        knowledge_graph_block="",
        skills_block=_block("skills", 500),
        langsmith_fewshot_block=_block("fewshot", 500),
        module_extensions_block=_block("module_extensions", 500),
    )
    assert len(selected) == 3
    assert sum(len(x) for x in selected) >= 1100


def test_main_graph_does_not_double_count_round_progress_in_tool_calls_chunk():
    # 从 backend 目录运行 pytest 时路径为 engine/core/main_graph.py；用 __file__ 解析保证任意 cwd 下可用
    root = Path(__file__).resolve().parent.parent
    source = (root / "engine" / "core" / "main_graph.py").read_text(encoding="utf-8")
    tree = ast.parse(source)

    def _is_call_to_observe_round_progress(node: ast.AST) -> bool:
        if not isinstance(node, ast.Call):
            return False
        func = node.func
        return isinstance(func, ast.Attribute) and func.attr == "observe_round_progress"

    def _find_if_by_name(name: str) -> ast.If | None:
        for node in ast.walk(tree):
            if isinstance(node, ast.If) and isinstance(node.test, ast.Name) and node.test.id == name:
                return node
        return None

    def _find_elif_msg_type(value: str) -> ast.If | None:
        for node in ast.walk(tree):
            if not isinstance(node, ast.If):
                continue
            test = node.test
            if not (
                isinstance(test, ast.Compare)
                and isinstance(test.left, ast.Name)
                and test.left.id == "msg_type"
                and len(test.ops) == 1
                and isinstance(test.ops[0], ast.Eq)
                and len(test.comparators) == 1
                and isinstance(test.comparators[0], ast.Constant)
                and test.comparators[0].value == value
            ):
                continue
            return node
        return None

    chunk_if = _find_if_by_name("tool_calls")
    assert chunk_if is not None
    assert not any(_is_call_to_observe_round_progress(n) for n in ast.walk(ast.Module(body=chunk_if.body, type_ignores=[])))

    ai_if = _find_elif_msg_type("ai")
    assert ai_if is not None
    guard_if = None
    for stmt in ai_if.body:
        if (
            isinstance(stmt, ast.If)
            and isinstance(stmt.test, ast.UnaryOp)
            and isinstance(stmt.test.op, ast.Not)
            and isinstance(stmt.test.operand, ast.Name)
            and stmt.test.operand.id == "should_abort_stream"
        ):
            guard_if = stmt
            break
    assert guard_if is not None
    assert any(_is_call_to_observe_round_progress(n) for n in ast.walk(ast.Module(body=guard_if.body, type_ignores=[])))
