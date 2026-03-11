from __future__ import annotations

from typing import Any, Iterable, Protocol


class _LoggerLike(Protocol):
    def warning(self, msg: str, *args: Any) -> None: ...


# DeepAgent create_deep_agent() 已内置的中间件，业务层不应重复注入
DEEPAGENT_OWNED_MIDDLEWARE_CLASS_NAMES = {
    "TodoListMiddleware",
    "FilesystemMiddleware",
    "SubAgentMiddleware",
    "SummarizationMiddleware",
    "AnthropicPromptCachingMiddleware",
    "PatchToolCallsMiddleware",
    "HumanInTheLoopMiddleware",
}


def middleware_name(middleware: Any) -> str:
    return str(getattr(middleware, "name", middleware.__class__.__name__))


def dedupe_middlewares(
    middlewares: Iterable[Any],
    *,
    logger: _LoggerLike | None = None,
    log_prefix: str = "[middleware]",
) -> list[Any]:
    deduped: list[Any] = []
    seen_names: set[str] = set()
    for mw in middlewares:
        if mw is None:
            continue
        name = middleware_name(mw)
        if name in seen_names:
            if logger is not None:
                logger.warning("%s 检测到重复中间件，已跳过: %s", log_prefix, name)
            continue
        seen_names.add(name)
        deduped.append(mw)
    return deduped


def filter_deepagent_owned_middlewares(
    middlewares: Iterable[Any],
    *,
    logger: _LoggerLike | None = None,
    log_prefix: str = "[middleware]",
) -> list[Any]:
    filtered: list[Any] = []
    for mw in middlewares:
        if mw is None:
            continue
        class_name = mw.__class__.__name__
        if class_name in DEEPAGENT_OWNED_MIDDLEWARE_CLASS_NAMES:
            if logger is not None:
                logger.warning(
                    "%s 检测到 DeepAgent 内置中间件重复注入，已剔除: %s",
                    log_prefix,
                    class_name,
                )
            continue
        filtered.append(mw)
    return filtered


def format_middleware_chain(middlewares: Iterable[Any]) -> str:
    names = [middleware_name(mw) for mw in middlewares if mw is not None]
    return " -> ".join(names)


def normalize_tool_name_list(
    raw_value: Any,
    *,
    default: list[str] | None = None,
    logger: _LoggerLike | None = None,
    log_prefix: str = "[config]",
    field_name: str = "tools",
) -> list[str]:
    """规范化工具名列表：类型校验 + 去重 + 空值回退默认值。"""
    fallback = list(default or [])
    if raw_value is None:
        return fallback
    if not isinstance(raw_value, list):
        if logger is not None:
            logger.warning("%s 字段 %s 类型非法（需 list），已回退默认值", log_prefix, field_name)
        return fallback

    cleaned: list[str] = []
    seen: set[str] = set()
    for item in raw_value:
        if not isinstance(item, str):
            if logger is not None:
                logger.warning("%s 字段 %s 存在非字符串项，已忽略: %r", log_prefix, field_name, item)
            continue
        name = item.strip()
        if not name:
            continue
        if name in seen:
            continue
        seen.add(name)
        cleaned.append(name)

    return cleaned or fallback


def normalize_subagent_tool_map(
    raw_map: Any,
    *,
    default_map: dict[str, list[str]],
    logger: _LoggerLike | None = None,
    log_prefix: str = "[config]",
    field_name: str = "subagent_tools",
) -> dict[str, list[str]]:
    """规范化 subagent_tools 映射，仅保留已知 role，并校验每个 role 的工具列表。"""
    if not isinstance(raw_map, dict):
        if logger is not None:
            logger.warning("%s 字段 %s 类型非法（需 object），已回退默认值", log_prefix, field_name)
        return {k: list(v) for k, v in default_map.items()}

    normalized: dict[str, list[str]] = {}
    for role, defaults in default_map.items():
        normalized[role] = normalize_tool_name_list(
            raw_map.get(role),
            default=defaults,
            logger=logger,
            log_prefix=log_prefix,
            field_name=f"{field_name}.{role}",
        )

    if logger is not None:
        unknown_roles = sorted(set(raw_map.keys()) - set(default_map.keys()))
        for role in unknown_roles:
            logger.warning("%s 字段 %s 包含未知 role，已忽略: %s", log_prefix, field_name, role)
    return normalized


def normalize_interrupt_on_config(
    interrupt_on: Any,
    *,
    allowed_tool_names: Iterable[str] | None = None,
    logger: _LoggerLike | None = None,
    log_prefix: str = "[middleware]",
) -> dict[str, Any]:
    """将 interrupt_on 规范化为 LangChain 可接受的 dict 结构。

    支持输入：
    - list[str] / set[str] / tuple[str, ...]：等价于 {name: True}
    - str：等价于 {name: True}
    - dict[str, bool | dict]：保留原值（dict 透传）
    """
    allowed = {str(x).strip() for x in (allowed_tool_names or []) if str(x).strip()}
    out: dict[str, Any] = {}

    if interrupt_on is None:
        return out

    if isinstance(interrupt_on, str):
        candidates: list[tuple[str, Any]] = [(interrupt_on, True)]
    elif isinstance(interrupt_on, (list, tuple, set)):
        candidates = [(str(name), True) for name in interrupt_on]
    elif isinstance(interrupt_on, dict):
        candidates = [(str(k), v) for k, v in interrupt_on.items()]
    else:
        if logger is not None:
            logger.warning("%s interrupt_on 类型非法，已忽略: %s", log_prefix, type(interrupt_on).__name__)
        return out

    for raw_name, raw_value in candidates:
        name = raw_name.strip()
        if not name:
            continue
        if allowed and name not in allowed:
            if logger is not None:
                logger.warning("%s interrupt_on 包含未知工具，已忽略: %s", log_prefix, name)
            continue
        if isinstance(raw_value, bool):
            out[name] = raw_value
        elif isinstance(raw_value, dict):
            out[name] = raw_value
        else:
            if logger is not None:
                logger.warning(
                    "%s interrupt_on[%s] 类型非法（需 bool/dict），已忽略",
                    log_prefix,
                    name,
                )
    return out


def sanitize_subagent_configs(
    subagent_configs: Iterable[dict[str, Any]],
    *,
    logger: _LoggerLike | None = None,
    log_prefix: str = "[middleware]",
) -> list[dict[str, Any]]:
    """净化 SubAgent 配置中的 middleware 字段，防止与 DeepAgent 默认链路冲突。

    说明：
    - 当前项目默认不向 subagent 显式注入 middleware；
    - 该函数用于兼容未来的 YAML / 动态扩展场景；
    - 若配置中存在 middleware，会先剔除 DeepAgent 内置类，再按 middleware.name 去重。
    """
    sanitized: list[dict[str, Any]] = []
    for cfg in subagent_configs:
        item = dict(cfg)
        middleware = item.get("middleware")
        if isinstance(middleware, list):
            middleware = filter_deepagent_owned_middlewares(
                middleware,
                logger=logger,
                log_prefix=f"{log_prefix}[subagent:{item.get('name', 'unknown')}]",
            )
            middleware = dedupe_middlewares(
                middleware,
                logger=logger,
                log_prefix=f"{log_prefix}[subagent:{item.get('name', 'unknown')}]",
            )
            item["middleware"] = middleware
        tools = item.get("tools")
        allowed_tool_names = [
            str(getattr(t, "name", "")).strip()
            for t in (tools or [])
            if str(getattr(t, "name", "")).strip()
        ]
        if "interrupt_on" in item:
            item["interrupt_on"] = normalize_interrupt_on_config(
                item.get("interrupt_on"),
                allowed_tool_names=allowed_tool_names,
                logger=logger,
                log_prefix=f"{log_prefix}[subagent:{item.get('name', 'unknown')}]",
            )
        sanitized.append(item)
    return sanitized
