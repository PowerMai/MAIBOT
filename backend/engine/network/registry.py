"""
A2A 数字员工网络 - 节点注册表

存储已知的 A2A 节点（base_url、agent_card_url），支持启动时种子注册与心跳。
优先对齐 Google A2A 常见发现路径：/.well-known/agent.json
同时兼容 LangGraph A2A 端点：/.well-known/agent-card.json?assistant_id={id}
"""

import asyncio
import logging
import os
from typing import Any, Dict, List, Optional
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from backend.config.store_namespaces import NS_NETWORK_NODES

logger = logging.getLogger(__name__)

@dataclass
class NodeEntry:
    node_id: str
    base_url: str
    agent_card_url: str
    name: Optional[str] = None
    last_seen: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None


@dataclass
class AgentIdentity:
    """Agent Protocol（简化版）"""
    agent_id: str
    name: str
    role: str = "general"
    capabilities: Optional[List[str]] = None
    autonomy_level: str = "L1"
    status: str = "idle"
    knowledge_domains: Optional[List[str]] = None
    cost_budget_usd_daily: float = 0.0


_memory_nodes: Dict[str, Dict[str, Any]] = {}


def _build_default_agent_card_url(base_url: str) -> str:
    """默认使用 Google A2A 风格路径；运行时回退兼容 LangGraph 路径。"""
    return f"{base_url.rstrip('/')}/.well-known/agent.json"


def _candidate_agent_card_urls(node: Dict[str, Any]) -> List[str]:
    """构造 Agent Card URL 候选列表（标准优先，兼容回退）。"""
    base_url = (node.get("base_url") or "").rstrip("/")
    configured = (node.get("agent_card_url") or "").strip()
    assistant_id = (node.get("metadata") or {}).get("assistant_id")
    candidates: List[str] = []

    if configured:
        candidates.append(configured)
    if base_url:
        candidates.append(f"{base_url}/.well-known/agent.json")
        legacy = f"{base_url}/.well-known/agent-card.json"
        if assistant_id:
            legacy = f"{legacy}?assistant_id={assistant_id}"
        candidates.append(legacy)

    unique: List[str] = []
    for url in candidates:
        if url and url not in unique:
            unique.append(url)
    return unique


def _get_store():
    try:
        from backend.engine.core.main_graph import get_sqlite_store
        return get_sqlite_store()
    except Exception:
        return None


def register_node(
    node_id: str,
    base_url: str,
    agent_card_url: Optional[str] = None,
    name: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
) -> NodeEntry:
    """注册或更新一个 A2A 节点。"""
    if not agent_card_url:
        agent_card_url = _build_default_agent_card_url(base_url)
    now = datetime.now(timezone.utc).isoformat()
    entry = NodeEntry(
        node_id=node_id,
        base_url=base_url.rstrip("/"),
        agent_card_url=agent_card_url,
        name=name,
        last_seen=now,
        metadata=metadata or {},
    )
    store = _get_store()
    if store:
        try:
            store.put(NS_NETWORK_NODES, node_id, asdict(entry))
        except Exception as e:
            logger.debug("Store 写入节点失败，回退内存: %s", e)
            _memory_nodes[node_id] = asdict(entry)
    else:
        _memory_nodes[node_id] = asdict(entry)
    logger.info("注册 A2A 节点: %s @ %s", node_id, base_url)
    return entry


def list_nodes() -> List[Dict[str, Any]]:
    """列出所有已注册节点。"""
    store = _get_store()
    if store:
        try:
            keys = list(store.list(NS_NETWORK_NODES))
            out = []
            for k in keys:
                v = store.get(NS_NETWORK_NODES, k)
                if v is not None:
                    val = getattr(v, "value", v) if not isinstance(v, dict) else v
                    if isinstance(val, dict):
                        out.append(val)
            return out
        except Exception as e:
            logger.debug("Store 读取节点列表失败: %s", e)
    return list(_memory_nodes.values())


def get_node(node_id: str) -> Optional[Dict[str, Any]]:
    """获取单个节点。"""
    store = _get_store()
    if store:
        try:
            v = store.get(NS_NETWORK_NODES, node_id)
            if v is not None:
                val = getattr(v, "value", v) if not isinstance(v, dict) else v
                if isinstance(val, dict):
                    return val
        except Exception:
            pass
    return _memory_nodes.get(node_id)


def update_node_identity(node_id: str, identity: AgentIdentity) -> bool:
    """更新节点的 Agent Identity 到 metadata.agent_identity。"""
    node = get_node(node_id)
    if not node:
        return False
    metadata = node.get("metadata") if isinstance(node.get("metadata"), dict) else {}
    metadata["agent_identity"] = asdict(identity)
    register_node(
        node_id=node_id,
        base_url=str(node.get("base_url") or ""),
        agent_card_url=str(node.get("agent_card_url") or ""),
        name=node.get("name"),
        metadata=metadata,
    )
    return True


def get_node_identity(node_id: str) -> Optional[Dict[str, Any]]:
    node = get_node(node_id)
    if not node:
        return None
    metadata = node.get("metadata") if isinstance(node.get("metadata"), dict) else {}
    identity = metadata.get("agent_identity")
    return identity if isinstance(identity, dict) else None


def unregister_node(node_id: str) -> bool:
    """移除节点。"""
    store = _get_store()
    if store and hasattr(store, "delete"):
        try:
            store.delete(NS_NETWORK_NODES, node_id)
            if node_id in _memory_nodes:
                del _memory_nodes[node_id]
            return True
        except Exception as e:
            logger.debug("Store 删除节点失败: %s", e)
    if node_id in _memory_nodes:
        del _memory_nodes[node_id]
        return True
    return False


# ---------------------------------------------------------------------------
# 心跳 & 种子注册
# ---------------------------------------------------------------------------

_heartbeat_task: Optional[asyncio.Task] = None
HEARTBEAT_INTERVAL = int(os.environ.get("A2A_HEARTBEAT_INTERVAL", "60"))


async def heartbeat_node(node_id: str) -> bool:
    """对单个节点执行心跳检测，成功则更新 last_seen，失败返回 False。"""
    import httpx
    node = get_node(node_id)
    if not node or not node.get("base_url"):
        return False
    urls = _candidate_agent_card_urls(node)
    for url in urls:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                r = await client.get(url)
                if r.status_code == 200:
                    # 更新 last_seen，同时将当前可用 URL 回写到节点记录
                    register_node(
                        node_id=node_id,
                        base_url=node.get("base_url", ""),
                        agent_card_url=url,
                        name=node.get("name"),
                        metadata=node.get("metadata"),
                    )
                    return True
        except Exception as e:
            logger.debug("心跳检测 %s via %s 失败: %s", node_id, url, e)
    return False


async def _heartbeat_loop():
    """后台定期心跳循环：每 HEARTBEAT_INTERVAL 秒检测所有节点。"""
    while True:
        try:
            await asyncio.sleep(HEARTBEAT_INTERVAL)
            nodes = list_nodes()
            for n in nodes:
                nid = n.get("node_id")
                if nid:
                    alive = await heartbeat_node(nid)
                    if not alive:
                        logger.info("A2A 节点 %s 心跳失败", nid)
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.debug("心跳循环异常: %s", e)


def start_heartbeat_background():
    """启动后台心跳 asyncio task（在 app lifespan startup 中调用）。"""
    global _heartbeat_task
    if _heartbeat_task is not None and not _heartbeat_task.done():
        return
    try:
        loop = asyncio.get_running_loop()
        _heartbeat_task = loop.create_task(_heartbeat_loop())
        logger.info("A2A 心跳后台任务已启动（间隔 %ds）", HEARTBEAT_INTERVAL)
    except RuntimeError:
        logger.debug("无法启动心跳后台任务：没有运行中的事件循环")


def stop_heartbeat_background():
    """停止后台心跳任务。"""
    global _heartbeat_task
    if _heartbeat_task and not _heartbeat_task.done():
        _heartbeat_task.cancel()
        _heartbeat_task = None


async def register_seed_nodes():
    """从环境变量 A2A_SEED_NODES 注册种子节点。
    
    格式：逗号分隔的 base_url 列表，如：
    A2A_SEED_NODES=http://192.168.1.10:2024,http://192.168.1.11:2024
    """
    seeds = os.environ.get("A2A_SEED_NODES", "").strip()
    if not seeds:
        return
    for url in seeds.split(","):
        url = url.strip()
        if not url:
            continue
        # 用 URL 的 host:port 作为 node_id
        try:
            from urllib.parse import urlparse
            parsed = urlparse(url)
            node_id = f"{parsed.hostname}:{parsed.port or 80}"
        except Exception:
            node_id = url.replace("http://", "").replace("https://", "").replace("/", "_")
        register_node(node_id=node_id, base_url=url, name=f"seed-{node_id}")
        logger.info("种子节点已注册: %s @ %s", node_id, url)


async def broadcast_task_to_network(
    task: dict,
    local_bid_callback_url: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """
    向已注册的 A2A 节点广播任务邀请；远程节点可据此让本地 Agent 自评估后向
    local_bid_callback_url 提交竞标（POST /board/tasks/{task_id}/bids）。

    task: 至少含 task_id, subject, description, required_skills
    local_bid_callback_url: 本机用于接收远程竞标的 base URL（如 http://host:2024），
                            远程节点 POST {base}/board/tasks/{task_id}/bids 提交竞标。

    Returns:
        各节点调用结果列表 [{ "node_id", "ok", "error" }]，不包含竞标内容（竞标异步回调）。
    """
    import httpx
    nodes = list_nodes()
    results = []
    payload = {
        "task_id": task.get("task_id") or task.get("id"),
        "subject": task.get("subject", ""),
        "description": task.get("description", ""),
        "required_skills": task.get("required_skills") or [],
        "callback_url": (local_bid_callback_url or "").rstrip("/") + f"/board/tasks/{task.get('task_id') or task.get('id')}/bids",
    }
    for node in nodes:
        node_id = node.get("node_id", "")
        base_url = (node.get("base_url") or "").rstrip("/")
        if not base_url:
            results.append({"node_id": node_id, "ok": False, "error": "no base_url"})
            continue
        invite_url = f"{base_url}/board/task-invite"
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                r = await client.post(invite_url, json=payload)
                results.append({
                    "node_id": node_id,
                    "ok": r.status_code == 200,
                    "error": None if r.is_success else r.text[:200],
                })
        except Exception as e:
            logger.debug("broadcast_task_to_network %s: %s", node_id, e)
            results.append({"node_id": node_id, "ok": False, "error": str(e)[:200]})
    return results
