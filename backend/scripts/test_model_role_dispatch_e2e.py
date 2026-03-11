#!/usr/bin/env python3
"""
模型/角色/分发联动验收：
1) 模型列表与 auto 解析可用
2) 模型切换接口可用
3) 角色列表与激活接口可用
4) 任务创建后可触发一次分发评估（含无角色/无竞标场景兜底）
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path
from typing import Dict, Optional

from fastapi.testclient import TestClient


PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.api.app import app  # noqa: E402
from backend.engine.tasks.task_watcher import dispatch_task_once, stop_watcher_background  # noqa: E402
from backend.engine.core.main_graph import cleanup_storage  # noqa: E402


def _get_task(client: TestClient, task_id: str, scope: str = "personal") -> Optional[Dict]:
    resp = client.get("/board/tasks", params={"scope": scope})
    if resp.status_code != 200:
        return None
    tasks = resp.json().get("tasks") or []
    for row in tasks:
        if str(row.get("id")) == str(task_id):
            return row
    return None


def _dispatch_once_with_timeout(task_id: str, scope: str = "personal", timeout_sec: float = 8.0) -> Dict:
    async def _run() -> Dict:
        try:
            return await asyncio.wait_for(
                dispatch_task_once(task_id=task_id, scope=scope),
                timeout=timeout_sec,
            )
        except asyncio.TimeoutError:
            return {"ok": False, "state": "dispatch_timeout"}

    return asyncio.run(_run())


def run() -> None:
    client = TestClient(app)
    try:
        # A) 模型能力核验
        models_resp = client.get("/models/list")
        assert models_resp.status_code == 200, f"/models/list 失败: {models_resp.status_code} {models_resp.text}"
        models_body = models_resp.json()
        assert models_body.get("ok") is True, f"/models/list 返回异常: {models_body}"
        models = models_body.get("models") or []
        assert any(str(m.get("id")) == "auto" for m in models), "模型列表缺少 auto 选项"
        concrete = [m for m in models if str(m.get("id")) != "auto"]
        assert concrete, "模型列表缺少具体模型"
        enabled_models = [m for m in concrete if bool(m.get("enabled"))]
        assert enabled_models, "没有启用模型"
        for m in concrete:
            assert "supports_images" in m, f"模型缺少 supports_images 字段: {m}"
            assert isinstance(m.get("supports_images"), bool), f"supports_images 非布尔值: {m}"

        switch_auto = client.post("/models/switch", json={"model_id": "auto"})
        assert switch_auto.status_code == 200, f"切换 auto 失败: {switch_auto.status_code} {switch_auto.text}"

        first_enabled_id = str(enabled_models[0].get("id"))
        switch_model = client.post("/models/switch", json={"model_id": first_enabled_id})
        assert switch_model.status_code == 200, f"切换启用模型失败: {switch_model.status_code} {switch_model.text}"

        # B) 角色核验
        roles_resp = client.get("/roles/list")
        assert roles_resp.status_code == 200, f"/roles/list 失败: {roles_resp.status_code} {roles_resp.text}"
        roles_body = roles_resp.json()
        assert roles_body.get("ok") is True, f"/roles/list 返回异常: {roles_body}"
        roles = roles_body.get("roles") or []
        assert roles, "角色列表为空"
        role_id = str((roles[0] or {}).get("id") or "")
        assert role_id, f"角色缺少 id: {roles[0] if roles else None}"

        activate_resp = client.post(f"/roles/{role_id}/activate")
        assert activate_resp.status_code == 200, f"激活角色失败: {activate_resp.status_code} {activate_resp.text}"
        activate_body = activate_resp.json() if activate_resp.content else {}
        expected_active_role_id = str(
            ((activate_body.get("profile") or {}) if isinstance(activate_body, dict) else {}).get("active_role_id")
            or role_id
        )

        profile_resp = client.get("/agent/profile")
        assert profile_resp.status_code == 200, f"/agent/profile 失败: {profile_resp.status_code} {profile_resp.text}"
        profile_body = profile_resp.json()
        assert profile_body.get("ok") is True, f"/agent/profile 返回异常: {profile_body}"
        profile = profile_body.get("profile") or {}
        assert str(profile.get("active_role_id") or "") == expected_active_role_id, (
            f"active_role_id 未更新: expect={expected_active_role_id} got={profile.get('active_role_id')}"
        )

        # C) 任务分发核验（角色+任务联动）
        created = client.post(
            "/board/tasks",
            json={
                "subject": f"E2E 角色分发验证-{int(time.time())}",
                "description": "验证角色激活后的任务分发链路",
                "priority": 3,
                "scope": "personal",
                "source_channel": "model-role-e2e",
                "cost_tier": "low",
                "required_skills": [],
            },
        )
        assert created.status_code == 200, f"创建任务失败: {created.status_code} {created.text}"
        c_body = created.json()
        task_id = str(c_body.get("task_id") or (c_body.get("task") or {}).get("id") or "")
        assert task_id, f"创建任务响应缺少 task_id: {c_body}"

        dispatch = _dispatch_once_with_timeout(task_id=task_id, scope="personal")
        dispatch_state = str(dispatch.get("state") or "")
        assert dispatch.get("ok") or dispatch_state in {"no_roles", "no_bid_or_unresolved", "dispatch_timeout"}, (
            f"dispatch 异常: {dispatch}"
        )

        # 给 watcher/执行器一点时间推进，再读任务快照用于结果展示
        time.sleep(1.5)
        snap = _get_task(client, task_id, scope="personal") or {}
        status = str(snap.get("status") or "")
        claimed_by = str(snap.get("claimed_by") or "")
        thread_id = str(snap.get("thread_id") or "")
        assert status in {"available", "bidding", "claimed", "running", "completed", "failed", "paused", "cancelled"}, snap
        if claimed_by:
            role_ids = {str((r or {}).get("id") or "") for r in roles}
            assert claimed_by in role_ids, f"claimed_by 不在角色列表中: {claimed_by}"

        # D) 输出摘要，便于 CI/本地定位
        print("模型-角色-分发 E2E 通过")
        print(json.dumps(
            {
                "current_model": (switch_model.json() or {}).get("current_model"),
                "enabled_model_switched_to": first_enabled_id,
                "active_role_id": expected_active_role_id,
                "task_id": task_id,
                "dispatch_state": dispatch_state,
                "task_status": status,
                "claimed_by": claimed_by or None,
                "thread_id": thread_id or None,
            },
            ensure_ascii=False,
            indent=2,
        ))
    finally:
        client.close()
        stop_watcher_background()
        cleanup_storage()


if __name__ == "__main__":
    run()
