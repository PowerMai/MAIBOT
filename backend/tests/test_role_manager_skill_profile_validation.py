from __future__ import annotations

from backend.engine.roles import role_manager


def test_list_roles_normalizes_invalid_skill_profile(monkeypatch):
    monkeypatch.setattr(
        role_manager,
        "_load_roles_impl",
        lambda force=False: {
            "roles": {"r1": {"label": "Role 1", "skill_profile": "invalid_profile"}},
            "aliases": {},
        },
    )
    monkeypatch.setattr(role_manager, "_discover_roles_from_filesystem_impl", lambda force=False: {})

    rows = role_manager.list_roles()
    r1 = next(r for r in rows if r["id"] == "r1")
    assert r1["skill_profile"] == "general"


def test_list_roles_keeps_valid_skill_profile(monkeypatch):
    monkeypatch.setattr(
        role_manager,
        "_load_roles_impl",
        lambda force=False: {
            "roles": {"r2": {"label": "Role 2", "skill_profile": "full"}},
            "aliases": {},
        },
    )
    monkeypatch.setattr(role_manager, "_discover_roles_from_filesystem_impl", lambda force=False: {})

    rows = role_manager.list_roles()
    r2 = next(r for r in rows if r["id"] == "r2")
    assert r2["skill_profile"] == "full"


def test_list_roles_debug_review_mutually_exclusive(monkeypatch):
    """Debug/Review 互斥：每个角色 modes 中至多含其一。"""
    monkeypatch.setattr(
        role_manager,
        "_load_roles_impl",
        lambda force=False: {
            "roles": {
                "default": {"label": "Default", "modes": ["agent", "ask", "plan", "review"]},
                "coding_engineer": {
                    "label": "Coder",
                    "modes": ["agent", "ask", "plan", "debug", "review"],
                },
                "doc": {
                    "label": "Doc",
                    "modes": ["agent", "ask", "plan", "debug", "review"],
                    "capabilities": [{"id": "document_processing", "label": "文档"}],
                },
            },
            "aliases": {},
        },
    )
    monkeypatch.setattr(role_manager, "_discover_roles_from_filesystem_impl", lambda force=False: {})

    rows = role_manager.list_roles()
    default = next(r for r in rows if r["id"] == "default")
    coder = next(r for r in rows if r["id"] == "coding_engineer")
    doc = next(r for r in rows if r["id"] == "doc")

    modes_default = default.get("modes") or []
    assert "review" in modes_default
    assert "debug" not in modes_default

    modes_coder = coder.get("modes") or []
    assert "debug" in modes_coder
    assert "review" not in modes_coder

    modes_doc = doc.get("modes") or []
    assert "review" in modes_doc
    assert "debug" not in modes_doc
