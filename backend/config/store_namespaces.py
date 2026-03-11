"""
Store namespace constants for unified access.
"""

from typing import Tuple

# === Agent ===
NS_AGENT_SOUL: Tuple[str, str] = ("agent", "soul")
NS_AGENT_IDENTITY: Tuple[str, str] = ("agent", "identity")
NS_AGENT_GOALS: Tuple[str, str] = ("agent", "goals")
NS_AGENT_EVOLUTION: Tuple[str, str] = ("agent", "evolution")
NS_AGENT_AUTONOMY: Tuple[str, str] = ("agent", "autonomy")

# === Task Board ===
NS_BOARD_PERSONAL: Tuple[str, str] = ("board", "personal")
NS_BOARD_ORG: Tuple[str, str] = ("board", "org")
NS_BOARD_PUBLIC: Tuple[str, str] = ("board", "public")
NS_BOARD_INVITES: Tuple[str, str] = ("board", "invites")
NS_BOARD_RELAY_INDEX: Tuple[str, str] = ("board", "relay_index")
NS_TASK_BOARD_LEGACY: Tuple[str] = ("task_board",)

# === Skills ===
NS_SKILLS_STATS: Tuple[str, str] = ("skills", "stats")
NS_SKILLS_MARKET: Tuple[str, str] = ("skills", "market_cache")
NS_SKILLS_CRYSTALLIZED: Tuple[str, str] = ("skills", "crystallized")

# === Knowledge ===
NS_KNOWLEDGE_ONTOLOGY: Tuple[str, str] = ("knowledge", "ontology")
NS_KNOWLEDGE_LEARNED: Tuple[str, str] = ("knowledge", "learned")

# === Network ===
NS_NETWORK_NODES: Tuple[str, str] = ("network", "nodes")

# === Billing ===
NS_BILLING_USAGE: Tuple[str, str] = ("billing", "usage")
NS_BILLING_CREDITS: Tuple[str, str] = ("billing", "credits")

# === Plugins ===
NS_PLUGINS_REGISTRY: Tuple[str, str] = ("plugins", "registry")

# === 用户级文件版本（P3 回退用）===
# namespace = ("file_versions", workspace_scope)；key = path\0timestamp
def ns_file_versions(workspace_scope: str) -> Tuple[str, str]:
    """workspace_scope 可为 workspace_path 的 hash 或稳定 id。"""
    return ("file_versions", (workspace_scope or "default").strip() or "default")

# === User model & AI leverage (认知增强计划) ===
# 按工作区隔离
def ns_user_profile(workspace_id: str) -> Tuple[str, str]:
    return ("user_profile", workspace_id or "default")


def ns_user_leverage(workspace_id: str) -> Tuple[str, str]:
    return ("user_leverage", workspace_id or "default")


# === Memories ===
# 默认工作区隔离：memories/{workspace_id}/{user_id}
NS_MEMORIES_USER: Tuple[str, str, str] = ("memories", "{workspace_id}", "{user_id}")
# 可选跨工作区共享：memories_shared/{user_id}
NS_MEMORIES_SHARED: Tuple[str, str] = ("memories_shared", "{user_id}")


def ns_user(user_id: str) -> Tuple[str, str]:
    return ("user", user_id)


def ns_feedback(user_id: str) -> Tuple[str, str]:
    return ("feedback", user_id)


def ns_bookmarks(user_id: str) -> Tuple[str, str]:
    return ("bookmarks", user_id)


def ns_reputation(agent_id: str) -> Tuple[str, str]:
    return ("reputation", agent_id)
