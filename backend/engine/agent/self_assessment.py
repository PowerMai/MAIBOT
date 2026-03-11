"""
Agent 自我评估：任务与能力的匹配度

用于接任务前评估 can_do、技能匹配度、预估耗时等；
Phase 1 被动模式下评估结果仅用于展示，不用于自动决策。
"""

from dataclasses import dataclass
from typing import Any, Dict, List, Optional


@dataclass
class AssessmentResult:
    can_do: bool
    skill_match: float
    matched_skills: List[str]
    estimated_cost: float
    estimated_time_minutes: int
    capacity: Optional[int]


class SelfAssessment:
    """Agent 自我评估：任务与能力的匹配度"""

    def assess(self, task: Dict[str, Any], profile: Dict[str, Any]) -> AssessmentResult:
        """
        评估当前 Agent 是否适合执行该任务。

        Args:
            task: 看板任务（含 subject, description, required_skills 等）
            profile: Agent 能力档案（agent_profile.json 结构）

        Returns:
            AssessmentResult:
            - can_do: 能不能干
            - skill_match: 技能匹配度 0-1
            - matched_skills: 匹配到的 Skills
            - estimated_cost: 预估成本（预留）
            - estimated_time_minutes: 预估耗时（分钟）
            - capacity: 可拆分任务能干多少（预留，可 None）
        """
        caps = profile.get("capabilities", {}) or {}
        agent_skills: List[str] = list(caps.get("skills") or [])
        raw_required = task.get("required_skills")
        required: List[str] = raw_required if isinstance(raw_required, list) else []
        agent_set = {str(s).strip().lower() for s in agent_skills if s}
        required_norm = [str(s).strip() for s in required if s]
        required_set = {s.lower() for s in required_norm}

        matched_skills: List[str] = []
        seen = set()
        if required_set:
            for r in required_norm:
                rl = r.lower()
                if rl in seen:
                    continue
                if rl in agent_set:
                    seen.add(rl)
                    matched_skills.append(r)
                else:
                    for a in agent_skills:
                        if (str(a) or "").strip().lower() == rl:
                            seen.add(rl)
                            matched_skills.append((a or "").strip())
                            break
        else:
            matched_skills = [s for s in agent_skills if s]

        n_required = len(required_set)
        skill_match = len(matched_skills) / n_required if n_required else 1.0

        can_do = skill_match >= 1.0 or (skill_match > 0 and not required_set)
        max_parallel = caps.get("max_parallel_tasks", 1) or 1
        capacity = max_parallel if task.get("splittable") else None

        subject = (task.get("subject") or "").strip()
        desc = (task.get("description") or "").strip()
        text_len = len(subject) + len(desc)
        estimated_time_minutes = max(5, min(120, 10 + text_len // 50))

        return AssessmentResult(
            can_do=can_do,
            skill_match=round(skill_match, 2),
            matched_skills=matched_skills,
            estimated_cost=0.0,
            estimated_time_minutes=estimated_time_minutes,
            capacity=capacity,
        )
