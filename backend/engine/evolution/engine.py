from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone
import os
from typing import Any


@dataclass
class EvolutionProposal:
    """统一进化提案结构，便于后续接入多模型评审/执行流水线。"""

    title: str
    motivation: str
    plan: str
    target: str = "core_engine"  # core_engine | skills | knowledge | tools | ontology
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class EvolutionResult:
    """统一进化执行结果。"""

    ok: bool
    stage: str
    message: str = ""
    data: dict[str, Any] = field(default_factory=dict)
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


class EvolutionEngine(ABC):
    """进化引擎抽象：后续可替换为云端版本或组织协同版本。"""

    @abstractmethod
    def propose(self, proposal: EvolutionProposal) -> EvolutionResult:
        raise NotImplementedError

    @abstractmethod
    def review(self, proposal: EvolutionProposal) -> EvolutionResult:
        raise NotImplementedError

    @abstractmethod
    def test(self, proposal: EvolutionProposal) -> EvolutionResult:
        raise NotImplementedError

    @abstractmethod
    def commit(self, proposal: EvolutionProposal) -> EvolutionResult:
        raise NotImplementedError


class NoopEvolutionEngine(EvolutionEngine):
    """默认空实现：保留接口稳定性，不改变当前运行行为。"""

    def propose(self, proposal: EvolutionProposal) -> EvolutionResult:
        return EvolutionResult(ok=True, stage="propose", message="proposal accepted", data={"target": proposal.target})

    def review(self, proposal: EvolutionProposal) -> EvolutionResult:
        return EvolutionResult(ok=True, stage="review", message="review skipped (noop)")

    def test(self, proposal: EvolutionProposal) -> EvolutionResult:
        return EvolutionResult(ok=True, stage="test", message="test skipped (noop)")

    def commit(self, proposal: EvolutionProposal) -> EvolutionResult:
        return EvolutionResult(ok=False, stage="commit", message="commit disabled in noop engine")


def get_evolution_engine() -> EvolutionEngine:
    """进化引擎工厂（当前默认 Noop，后续可按配置切换实现）。"""
    kind = str(os.getenv("EVOLUTION_ENGINE_KIND", "noop") or "noop").strip().lower()
    if kind == "noop":
        return NoopEvolutionEngine()
    # 预留：后续可扩展 cloud/local/organization 等实现
    return NoopEvolutionEngine()

