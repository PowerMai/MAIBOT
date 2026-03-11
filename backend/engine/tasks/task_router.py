"""
任务路由 - 能力匹配（降级策略）

根据任务 subject、required_skills 从已注册角色中推荐最匹配的 role_id 与 skill_profile。
已由「自治认领」模式（task_bidding + task_watcher）替代；此处保留为无 Agent 在线竞标时的
降级：如单机仅有一个角色、或用户需要快速建议时，仍可调用 suggest_role_for_task。
"""

import logging
import re
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)


def _normalize_skills(skills: Optional[List[Any]]) -> set:
    """将 required_skills 转为小写字符串集合便于匹配。"""
    if not skills:
        return set()
    out = set()
    for s in skills:
        if isinstance(s, str):
            out.add(s.strip().lower())
        else:
            out.add(str(s).strip().lower())
    return out - {""}


def _role_skill_set(role: Dict[str, Any]) -> set:
    """从角色配置提取技能相关字符串集合（skill_profile + capabilities 中的 skill）。"""
    s = set()
    sp = role.get("skill_profile")
    if isinstance(sp, str) and sp.strip():
        s.add(sp.strip().lower())
    for cap in role.get("capabilities") or []:
        if isinstance(cap, dict) and cap.get("skill"):
            s.add(str(cap["skill"]).strip().lower())
    return s


_CJK_STOPWORDS = {"的", "与", "和", "了", "在", "是", "有", "为", "对", "将", "把", "被", "从", "到", "也", "就", "都", "而", "及", "或"}


def _tokenize_subject(text: str) -> set:
    """对中英文混合文本进行分词。优先使用 jieba，否则回退到 CJK 2-gram + 英文单词。"""
    if not text:
        return set()
    # 尝试 jieba
    try:
        import jieba
        words = set(jieba.cut(text)) - _CJK_STOPWORDS - {""}
        # 过滤单字（除非是英文单词）
        return {w for w in words if len(w) > 1 or re.match(r"[a-z0-9]", w)}
    except ImportError:
        pass
    # 回退：英文单词 + 中文连续片段 2-gram
    tokens = set()
    # 英文/数字单词
    for m in re.finditer(r"[a-z0-9]+", text):
        tokens.add(m.group())
    # 中文连续片段 2-gram
    cjk_runs = re.findall(r"[\u4e00-\u9fff]+", text)
    for run in cjk_runs:
        if len(run) >= 2:
            for i in range(len(run) - 1):
                tokens.add(run[i:i + 2])
        tokens.add(run)  # 整个片段也加入
    return tokens - _CJK_STOPWORDS - {""}


def match_task_to_roles(
    subject: str = "",
    required_skills: Optional[List[Any]] = None,
    top_k: int = 3,
) -> List[Tuple[str, str, float]]:
    """
    根据任务主题与所需技能，从角色列表中推荐匹配的角色。

    Args:
        subject: 任务标题/描述（用于关键词匹配）
        required_skills: 任务要求的技能 ID 列表
        top_k: 返回前几名

    Returns:
        [(role_id, skill_profile, score), ...]，按 score 降序。score 0~1。
    """
    try:
        from backend.engine.roles import list_roles
    except ImportError:
        logger.debug("task_router: list_roles 不可用")
        return []

    roles = list_roles()
    if not roles:
        return []

    req = _normalize_skills(required_skills)
    subject_lower = (subject or "").strip().lower()
    # 分词：中英文混合
    subject_words = _tokenize_subject(subject_lower)

    scored: List[Tuple[str, str, float]] = []
    for r in roles:
        role_id = r.get("id", "")
        skill_profile = (r.get("skill_profile") or "full").strip()
        role_skills = _role_skill_set(r)
        # 技能重叠分：required 与 role 交集 / required 并集大小
        if req:
            overlap = len(req & role_skills) / max(len(req), 1)
        else:
            overlap = 0.5  # 无明确要求时给中等分
        # 主题与描述匹配：角色 description 含 subject 关键词则加分
        desc = (r.get("description") or "").lower()
        label = (r.get("label") or "").lower()
        text_match = 0.0
        if subject_words:
            for w in subject_words:
                if len(w) < 2:
                    continue
                if w in desc or w in label:
                    text_match += 0.15
        text_match = min(text_match, 0.5)
        score = min(1.0, overlap * 0.7 + text_match + 0.1)  # 0.1 基础分
        scored.append((role_id, skill_profile, round(score, 3)))

    scored.sort(key=lambda x: -x[2])
    return scored[:top_k]


def suggest_role_for_task(
    subject: str = "",
    required_skills: Optional[List[Any]] = None,
) -> Dict[str, Any]:
    """
    为任务推荐一个角色与 skill_profile，供 create_task / 认领时使用。

    Returns:
        {"role_id": str, "skill_profile": str, "score": float, "alternatives": [...]}
    """
    matches = match_task_to_roles(subject=subject, required_skills=required_skills, top_k=3)
    if not matches:
        return {
            "role_id": "",
            "skill_profile": "full",
            "score": 0.0,
            "alternatives": [],
        }
    best = matches[0]
    return {
        "role_id": best[0],
        "skill_profile": best[1],
        "score": best[2],
        "alternatives": [{"role_id": m[0], "skill_profile": m[1], "score": m[2]} for m in matches[1:]],
    }
