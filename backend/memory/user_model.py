"""
用户画像（User Profile）持久化

字段：领域熟练度、AI 杠杆率历史、平均迭代轮次、工具使用广度、用户自定义规则等。
存储于 LangGraph Store，命名空间 ("user_profile", workspace_id)。
"""

from __future__ import annotations

import logging
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from backend.config.store_namespaces import ns_user_profile

logger = logging.getLogger(__name__)

PROFILE_KEY = "profile"


@dataclass
class UserProfile:
    """用户画像数据类。"""
    expertise_areas: Dict[str, str] = field(default_factory=dict)  # {"bidding": "expert", "python": "intermediate"}
    communication_style: str = ""
    detail_level: str = ""  # brief / normal / detailed
    domain_expertise: str = ""  # beginner / intermediate / expert
    decision_patterns: List[str] = field(default_factory=list)
    unsolved_intents: List[Dict[str, Any]] = field(default_factory=list)
    learning_trajectory: List[str] = field(default_factory=list)
    custom_rules: List[str] = field(default_factory=list)
    # 以下由杠杆率模块汇总填充
    ai_leverage_score: float = 0.0
    iteration_patterns: List[float] = field(default_factory=list)  # 近期平均迭代轮次
    tool_breadth: int = 0
    last_updated: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        d["last_updated"] = d.get("last_updated") or datetime.now(timezone.utc).isoformat()
        return d

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "UserProfile":
        if not data:
            return cls()
        kwargs = {}
        for f in ("expertise_areas", "communication_style", "detail_level", "domain_expertise", "decision_patterns",
                  "unsolved_intents", "learning_trajectory", "custom_rules", "ai_leverage_score", "iteration_patterns",
                  "tool_breadth", "last_updated"):
            if f in data:
                v = data[f]
                if f == "expertise_areas" and not isinstance(v, dict):
                    v = {}
                if f in ("decision_patterns", "custom_rules", "learning_trajectory") and not isinstance(v, list):
                    v = list(v) if v else []
                if f == "unsolved_intents" and not isinstance(v, list):
                    v = []
                kwargs[f] = v
        return cls(**kwargs)


def get_user_profile(store: Any, workspace_id: str, merge_leverage: bool = False) -> UserProfile:
    """从 Store 读取用户画像。merge_leverage 保留接口；写入钩子未接入前不合并杠杆率，避免展示恒为 0 的虚假指标。"""
    if store is None:
        return UserProfile()
    try:
        ns = ns_user_profile(workspace_id or "default")
        item = store.get(ns, PROFILE_KEY)
        if item and isinstance(item.value, dict):
            profile = UserProfile.from_dict(item.value)
        else:
            profile = UserProfile()
    except Exception as e:
        logger.debug("get_user_profile: %s", e)
        profile = UserProfile()
    return profile


def save_user_profile(store: Any, workspace_id: str, profile: UserProfile) -> bool:
    """保存用户画像到 Store。"""
    if store is None:
        return False
    try:
        ns = ns_user_profile(workspace_id or "default")
        data = profile.to_dict()
        data["last_updated"] = datetime.now(timezone.utc).isoformat()
        store.put(ns, PROFILE_KEY, data)
        return True
    except Exception as e:
        logger.warning("save_user_profile: %s", e)
        return False


def update_user_profile(
    store: Any,
    workspace_id: str,
    updates: Dict[str, Any],
) -> Optional[UserProfile]:
    """部分更新用户画像（只更新传入的键）。"""
    profile = get_user_profile(store, workspace_id, merge_leverage=False)
    for key, value in updates.items():
        if hasattr(profile, key):
            setattr(profile, key, value)
    if save_user_profile(store, workspace_id, profile):
        return profile
    return None
