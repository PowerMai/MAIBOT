"""
Evolution module namespace.

当前作为商业能力边界占位目录，供后续进化引擎实现（Phase 2/3）扩展。
"""

from .engine import (
    EvolutionEngine,
    EvolutionProposal,
    EvolutionResult,
    NoopEvolutionEngine,
    get_evolution_engine,
)

__all__ = [
    "EvolutionEngine",
    "EvolutionProposal",
    "EvolutionResult",
    "NoopEvolutionEngine",
    "get_evolution_engine",
]

