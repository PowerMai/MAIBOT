# Role management - capability profiles (Claude/Cursor style)

from .role_manager import (
    RoleManager,
    get_role_manager,
    list_roles,
    get_role,
    apply_role,
    apply_role_to_thread,
    reload_roles,
)

__all__ = [
    "RoleManager",
    "get_role_manager",
    "list_roles",
    "get_role",
    "apply_role",
    "apply_role_to_thread",
    "reload_roles",
]
