"""
Memory Tools - langmem 官方工具封装

直接使用 langmem 官方库，无重复实现：
- create_manage_memory_tool: 创建/更新/删除记忆
- create_search_memory_tool: 语义搜索记忆

参考：
- langmem: https://langchain-ai.github.io/langmem/
- LangGraph Store: https://docs.langchain.com/oss/python/langgraph/persistence#memory-store

注意：
- Store 由 LangGraph Server 自动注入（运行时配置）
- 使用 {user_id} 占位符支持多用户隔离
"""

from typing import Any, Dict, List, Optional, Tuple
import os
import logging
import json

from backend.config.store_namespaces import NS_MEMORIES_SHARED, NS_MEMORIES_USER

logger = logging.getLogger(__name__)

# langmem 导入
try:
    from langmem import create_manage_memory_tool, create_search_memory_tool
    _HAS_LANGMEM = True
except ImportError:
    _HAS_LANGMEM = False
    create_manage_memory_tool = None
    create_search_memory_tool = None


def _normalize_category(category: str) -> str:
    """将分类名规范为稳定标签，避免命名漂移。"""
    raw = (category or "general").strip().lower().replace(" ", "_")
    return "".join(ch for ch in raw if ch.isalnum() or ch in ("_", "-")) or "general"


def get_memory_tools(namespace: Tuple[str, ...] = NS_MEMORIES_USER) -> List:
    """获取 langmem 记忆工具
    
    Args:
        namespace: Store 命名空间，支持 {user_id} 占位符用于运行时替换
    
    Returns:
        List of langmem tools
    
    Note:
        这些工具需要 LangGraph Store 环境。
        Store 由 LangGraph Server 自动注入，无需手动创建。
        {user_id} 占位符会在运行时从 config 中替换。
    """
    if not _HAS_LANGMEM:
        return []
    
    try:
        from langchain_core.tools import tool

        manage_tool = create_manage_memory_tool(namespace=namespace)
        search_tool = create_search_memory_tool(namespace=namespace)

        @tool("manage_memory_with_category")
        def manage_memory_with_category(
            content: Optional[str] = None,
            category: str = "general",
            action: str = "create",
            id: Optional[str] = None,
        ) -> str:
            """按分类管理记忆（基于 langmem manage_memory 封装）。

            Use when:
            - 需要为记忆打业务分类标签（如 `preference` / `project` / `risk`）。
            - 需要后续按分类检索或统计记忆条目。
            """
            cat = _normalize_category(category)
            payload: Dict[str, Any] = {"action": action, "id": id}
            if action in ("create", "update"):
                tagged = f"[category:{cat}] {(content or '').strip()}".strip()
                payload["content"] = tagged
            try:
                # 直接调用底层函数，复用当前图运行时上下文（避免二次 invoke 丢失 runtime）
                result = manage_tool.func(**payload)
            except KeyError as e:
                if str(e) == "'__pregel_runtime'":
                    return json.dumps(
                        {
                            "ok": False,
                            "category": cat,
                            "action": action,
                            "error": "manage_memory_with_category must run inside LangGraph agent runtime",
                        },
                        ensure_ascii=False,
                    )
                raise
            return json.dumps(
                {"ok": True, "category": cat, "action": action, "result": result},
                ensure_ascii=False,
                default=str,
            )

        @tool("search_memory_by_category")
        def search_memory_by_category(
            query: str,
            category: str = "general",
            limit: int = 10,
            offset: int = 0,
        ) -> str:
            """按分类检索记忆（基于 langmem search_memory 封装）。

            默认通过分类前缀增强查询语义：`[category:<name>]`.
            """
            cat = _normalize_category(category)
            q = query if cat in ("all", "*") else f"[category:{cat}] {query}".strip()
            try:
                result = search_tool.func(
                    query=q, limit=int(limit), offset=int(offset), filter=None
                )
            except KeyError as e:
                if str(e) == "'__pregel_runtime'":
                    return json.dumps(
                        {
                            "ok": False,
                            "category": cat,
                            "query": query,
                            "error": "search_memory_by_category must run inside LangGraph agent runtime",
                        },
                        ensure_ascii=False,
                    )
                raise
            return json.dumps(
                {"ok": True, "category": cat, "query": query, "result": result},
                ensure_ascii=False,
                default=str,
            )

        return [manage_tool, search_tool, manage_memory_with_category, search_memory_by_category]
    except Exception as e:
        logger.warning("langmem 工具创建失败: %s", e)
        return []


def get_shared_memory_tools() -> List:
    """
    获取组织共享记忆工具（Phase 2 预留）。
    命名空间固定在 NS_MEMORIES_SHARED，用于跨 Agent 共享经验与模式。
    """
    return get_memory_tools(namespace=NS_MEMORIES_SHARED)


def is_langmem_available() -> bool:
    """检查 langmem 是否可用"""
    return _HAS_LANGMEM


def get_relevant_memories_for_prompt(
    configurable: Dict[str, Any],
    query: str = "",
    max_items: int = 5,
    max_chars: int = 800,
) -> str:
    """
    首轮前主动检索与当前任务/用户相关的已存记忆，用于注入 system prompt（Claude/Cowork 风格「首轮即知」）。

    仅当 ENABLE_LANGMEM=true 且 ENABLE_PROACTIVE_MEMORY_INJECT=true 时执行。
    若 store 不可用或检索异常，返回空字符串，不阻塞主流程。

    Args:
        configurable: 当前 run 的 configurable（含 workspace_id、user_id、task_type、business_domain 等）
        query: 检索查询；若为空则从 configurable 拼出
        max_items: 最多返回条数
        max_chars: 格式化后最大字符数

    Returns:
        格式化的 <recalled_memories> 块或空字符串
    """
    if not configurable or not isinstance(configurable, dict):
        return ""
    if str(os.getenv("ENABLE_LANGMEM", "true")).strip().lower() not in ("1", "true", "yes", "on"):
        return ""
    if str(os.getenv("ENABLE_PROACTIVE_MEMORY_INJECT", "true")).strip().lower() not in ("1", "true", "yes", "on"):
        return ""
    if not _HAS_LANGMEM:
        return ""
    try:
        from backend.config.memory_scope import resolve_memory_scope
        scope = resolve_memory_scope(configurable)
        workspace_id = scope.get("workspace_id", "default")
        user_id = scope.get("user_id", "default_user")
        ns = ("memories", workspace_id, user_id)
    except Exception as e:
        logger.debug("get_relevant_memories_for_prompt resolve_scope: %s", e)
        return ""
    if not query or not query.strip():
        parts = [
            str(configurable.get("task_type") or ""),
            str(configurable.get("business_domain") or ""),
            str(configurable.get("last_user_message") or configurable.get("last_user_message_text") or "")[:200],
        ]
        query = " ".join(p for p in parts if p).strip() or "user context and preferences"
    try:
        store = None
        try:
            from backend.engine.core.main_graph import get_sqlite_store
            store = get_sqlite_store()
        except Exception as e:
            logger.debug("get_relevant_memories_for_prompt get_sqlite_store: %s", e)
        if store is None:
            return ""
        search_tool = create_search_memory_tool(
            namespace=ns,
            store=store,
        )
        result = search_tool.invoke({"query": query, "limit": max_items, "offset": 0, "filter": None})
    except Exception as e:
        logger.debug("get_relevant_memories_for_prompt search: %s", e)
        return ""
    if not result:
        return ""
    # 兼容 response_format=content_and_artifact 时返回 (serialized_str, raw_list)
    if isinstance(result, tuple) and len(result) >= 1:
        result = result[0]
    try:
        import json
        if isinstance(result, str):
            items = json.loads(result) if result.strip() else []
        elif isinstance(result, (list, tuple)):
            items = list(result) if result else []
        else:
            items = []
    except Exception:
        items = []
    if not items:
        return ""
    lines = []
    used = 0
    for i, m in enumerate(items[:max_items]):
        if used >= max_chars:
            break
        text = ""
        if isinstance(m, dict):
            val = m.get("value") or m
            if isinstance(val, dict):
                text = (val.get("content") or str(val)).strip()[:400]
            else:
                text = (m.get("content") or str(m)).strip()[:400]
        else:
            # 兼容 langmem Item 等对象：.value 或 .content
            val = getattr(m, "value", m)
            content = getattr(val, "content", None) if val is not None else None
            text = (str(content) if content is not None else str(m)).strip()[:400]
        if text:
            lines.append(f"- {text}")
            used += len(text) + 4
    if not lines:
        return ""
    body = "\n".join(lines)
    if len(body) > max_chars:
        body = body[: max_chars - 20].rsplit("\n", 1)[0] + "\n... (truncated)"
    return f"<recalled_memories>\n以下为与本任务/用户相关的已存记忆，供首轮参考。\n{body}\n</recalled_memories>"


__all__ = [
    "get_memory_tools",
    "get_shared_memory_tools",
    "is_langmem_available",
    "get_relevant_memories_for_prompt",
]
