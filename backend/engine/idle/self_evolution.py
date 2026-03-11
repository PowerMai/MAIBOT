from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any, Dict
import json

from backend.engine.evolution import EvolutionProposal, get_evolution_engine
from backend.engine.autonomy.levels import get_autonomy_settings
from backend.engine.license.tier_service import is_evolution_allowed
from backend.tools.base.paths import get_workspace_root


class SelfEvolutionEngine:
    """
    自我进化提案引擎（propose-review-test-commit 流程骨架）。
    当前阶段生成提案文档，后续接入多模型评审与自动测试。
    """

    def __init__(self, proposals_dir: Path | None = None):
        ws = get_workspace_root()
        self.proposals_dir = proposals_dir or (ws / "proposals")
        self.engine = get_evolution_engine()

    def _load_license_profile(self) -> dict:
        path = get_workspace_root() / "backend" / "data" / "license_profile.json"
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    def create_proposal(self, title: str, motivation: str, plan: str) -> Path:
        settings = get_autonomy_settings()
        if not bool(settings.get("allow_gated_code_changes", False)):
            raise PermissionError("当前自主级别未允许 gated 代码升级（需要 L3）。")
        if not is_evolution_allowed(self._load_license_profile()):
            raise PermissionError("当前许可证层级未启用进化能力，请升级到 pro 或 enterprise。")

        safe_title = "-".join((title or "proposal").strip().lower().split())[:80]
        day = datetime.now().strftime("%Y-%m-%d")
        filename = f"{day}-{safe_title}.md"
        self.proposals_dir.mkdir(parents=True, exist_ok=True)
        path = self.proposals_dir / filename
        content = (
            f"# Proposal: {title}\n\n"
            f"- Created: {datetime.now().isoformat()}\n"
            f"- Flow: propose -> review -> test -> commit\n\n"
            "## Motivation\n"
            f"{motivation.strip()}\n\n"
            "## Plan\n"
            f"{plan.strip()}\n\n"
            "## Checklist\n"
            "- [ ] Multi-model review passed\n"
            "- [ ] Tests passed\n"
            "- [ ] Safety checks passed\n"
            "- [ ] Ready to commit\n"
        )
        path.write_text(content, encoding="utf-8")
        return path

    def run_pipeline(self, title: str, motivation: str, plan: str, target: str = "core_engine") -> Dict[str, Any]:
        """执行 propose -> review -> test -> commit 流程（当前默认 Noop 引擎）。"""
        proposal_path = self.create_proposal(title=title, motivation=motivation, plan=plan)
        proposal = EvolutionProposal(
            title=title,
            motivation=motivation,
            plan=plan,
            target=target,
            metadata={"proposal_path": str(proposal_path)},
        )
        stages = [
            self.engine.propose(proposal),
            self.engine.review(proposal),
            self.engine.test(proposal),
            self.engine.commit(proposal),
        ]
        return {
            "ok": all(bool(s.ok) for s in stages),
            "proposal_path": str(proposal_path),
            "stages": [
                {
                    "ok": bool(s.ok),
                    "stage": s.stage,
                    "message": s.message,
                    "data": dict(s.data),
                    "created_at": s.created_at,
                }
                for s in stages
            ],
        }

    def status(self) -> Dict[str, bool]:
        settings = get_autonomy_settings()
        return {
            "allow_gated_code_changes": bool(settings.get("allow_gated_code_changes", False)),
            "allow_idle_loop": bool(settings.get("allow_idle_loop", False)),
        }

