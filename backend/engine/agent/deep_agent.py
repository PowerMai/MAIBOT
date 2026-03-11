"""
Deep Agent - Orchestrator + SubAgents

架构（参考 LangChain DeepAgent 官方示例）：
- Orchestrator: 路由 + TODO管理 + 委派 + 综合报告
- Explore Agent: 文件/代码搜索（上下文隔离）
- General-purpose Agent（内置）: 通用多步任务（上下文隔离）

DeepAgent 原生能力（充分利用，不重复开发）：
1. 会话记录: state["messages"] (自动), state["todos"] (write_todos)
2. 工作记录: state["files"] (FilesystemMiddleware)
3. 持久记录: LangGraph Store (store 参数)
4. 会话恢复: LangGraph Checkpointer (checkpointer 参数)
5. 上下文压缩: SummarizationMiddleware (自动)
6. 人工确认: HumanInTheLoopMiddleware (interrupt_on 参数)
"""

import atexit
import os
import sys
import logging
import threading
import json
from collections import OrderedDict
import hashlib
import time
import inspect
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, TYPE_CHECKING, Dict, Any, Callable, Awaitable

logger = logging.getLogger(__name__)
_DEBUG_LOG_PATH = Path(__file__).resolve().parents[3] / ".cursor" / "debug.log"


_ENABLE_AGENT_DEBUG_LOG = os.environ.get("ENABLE_AGENT_DEBUG_LOG", "").lower() in ("1", "true", "yes")


def _agent_debug_log(hypothesis_id: str, location: str, message: str, data: dict[str, Any]) -> None:
    if not _ENABLE_AGENT_DEBUG_LOG:
        return
    try:
        payload = {
            "id": f"log_{int(time.time() * 1000)}_{hypothesis_id}",
            "timestamp": int(time.time() * 1000),
            "runId": "pre-fix",
            "hypothesisId": hypothesis_id,
            "location": location,
            "message": message,
            "data": data,
        }
        _DEBUG_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with _DEBUG_LOG_PATH.open("a", encoding="utf-8") as f:
            f.write(json.dumps(payload, ensure_ascii=False) + "\n")
    except Exception as e:
        logger.debug("agent debug log write failed: %s", e, exc_info=True)


if TYPE_CHECKING:
    from langchain_core.runnables import RunnableConfig

from deepagents import create_deep_agent
from deepagents.graph import (
    BASE_AGENT_PROMPT,
    TodoListMiddleware,
    FilesystemMiddleware,
    SubAgentMiddleware,
    SummarizationMiddleware,
    AnthropicPromptCachingMiddleware,
    PatchToolCallsMiddleware,
)

# ============================================================
# 使用统一路径模块（Claude 风格：单一数据源）
# ============================================================
try:
    from backend.tools.base.paths import (
        get_project_root, get_workspace_root, set_workspace_root,
        KB_PATH, SKILLS_ROOT, WORKSPACE_PATH, UPLOADS_PATH,
        DATA_PATH, VECTOR_STORE_PATH, CHECKPOINTS_DB_PATH, STORE_DB_PATH,
        LANGGRAPH_API_ROOT, LANGGRAPH_API_BACKEND, PROJECT_MAIBOT_PATH, MAIBOT_PATH,
    )
    PROJECT_ROOT = get_project_root()
except ImportError:
    # 回退：直接计算路径
    PROJECT_ROOT = Path(__file__).resolve().parents[3]
    KB_PATH = PROJECT_ROOT / "knowledge_base"
    SKILLS_ROOT = KB_PATH / "skills"
    WORKSPACE_PATH = PROJECT_ROOT / "tmp"
    UPLOADS_PATH = PROJECT_ROOT / "tmp" / "uploads"
    DATA_PATH = PROJECT_ROOT / "data"
    VECTOR_STORE_PATH = DATA_PATH / "vectorstore"
    CHECKPOINTS_DB_PATH = DATA_PATH / "checkpoints.db"
    STORE_DB_PATH = DATA_PATH / "store.db"
    LANGGRAPH_API_ROOT = PROJECT_ROOT / ".langgraph_api"
    LANGGRAPH_API_BACKEND = PROJECT_ROOT / "backend" / ".langgraph_api"
    PROJECT_MAIBOT_PATH = PROJECT_ROOT / ".maibot"
    MAIBOT_PATH = PROJECT_ROOT / ".maibot"


# ============================================================
# 调试工具函数（Claude 风格：避免重复代码）
# ============================================================
def _debug_print(message: str, force: bool = False):
    """统一的调试打印函数"""
    if force or (hasattr(Config, 'DEBUG') and Config.DEBUG):
        print(message, file=sys.stderr, flush=True)


from backend.utils.file_cache import MtimeFileCache

_file_read_cache = MtimeFileCache(max_entries=200)
_persona_write_lock = threading.Lock()
_json_file_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_json_file_cache_lock = threading.Lock()
_get_tools_cache: dict[tuple[str, ...], list[Any]] = {}
_get_tools_cache_lock = threading.Lock()
_GET_TOOLS_CACHE_MAX = 128


def _read_cached_file(path: Path, max_age: float = 30.0) -> str | None:
    """基于 mtime 的文件读取缓存，复用共享 MtimeFileCache。"""
    return _file_read_cache.get(path, max_age=max_age)


# ============================================================
# 记忆路径（统一从工作区 .maibot/ 加载）
# ============================================================
def _compute_memory_paths(workspace_root: Path = None) -> list[str]:
    """计算项目记忆文件路径（统一 .maibot）

    优先从 workspace_root/.maibot/ 加载（用户项目记忆），
    再回退到项目根 .maibot/（开发期）。
    """
    if workspace_root is None:
        try:
            workspace_root = get_workspace_root()
        except Exception:
            workspace_root = PROJECT_ROOT

    paths: list[str] = []

    # 主路径：.maibot/MAIBOT.md
    maibot_main = workspace_root / ".maibot" / "MAIBOT.md"
    if maibot_main.exists():
        paths.append(".maibot/MAIBOT.md")
    else:
        # 项目根回退（开发期）
        if (PROJECT_MAIBOT_PATH / "MAIBOT.md").exists():
            paths.append(str((PROJECT_MAIBOT_PATH / "MAIBOT.md").relative_to(PROJECT_ROOT)))

    # 主路径规则：.maibot/rules/*.md
    ws_maibot_rules = workspace_root / ".maibot" / "rules"
    if ws_maibot_rules.exists() and ws_maibot_rules.is_dir():
        for rule_file in ws_maibot_rules.glob("*.md"):
            paths.append(str(Path(".maibot/rules") / rule_file.name))
    else:
        # 项目根回退
        fallback_root = PROJECT_MAIBOT_PATH / "rules"
        if fallback_root.exists() and fallback_root.is_dir():
            for rule_file in fallback_root.glob("*.md"):
                paths.append(str(rule_file.relative_to(PROJECT_ROOT)))

    # 内部操作日志，不适合注入提示词
    _maibot_exclude = {"WORKING-BUFFER.md", "SESSION-STATE.md", "EVOLUTION-SCORES.md"}
    # 追加其他 .maibot/*.md（SOUL.md, TOOLS.md, AGENTS.md 等自进化产物）
    ws_maibot_dir = workspace_root / ".maibot"
    if ws_maibot_dir.exists() and ws_maibot_dir.is_dir():
        for f in ws_maibot_dir.glob("*.md"):
            if f.name in _maibot_exclude:
                continue
            rel = ".maibot/" + f.name
            if rel not in paths:
                paths.append(rel)

    return paths

# 模块加载时预计算（开发期回退值，运行时会在 create_orchestrator_agent 中重新计算）
_CACHED_MEMORY_PATHS: list[str] = _compute_memory_paths()
_BUILTIN_PROMPT_POLICY_APPLIED = False
_BUILTIN_PROMPT_POLICY_LOCK = threading.Lock()

def _get_memory_paths(workspace_root: Path = None) -> list[str]:
    """获取记忆路径。传入 workspace_root 时动态计算，否则返回缓存值。"""
    if workspace_root is not None:
        return _compute_memory_paths(workspace_root)
    return _CACHED_MEMORY_PATHS


def _init_middleware_prompt_policy() -> None:
    """保留 DeepAgent 官方中间件提示词，不再使用 __kwdefaults__ monkey patch。"""
    global _BUILTIN_PROMPT_POLICY_APPLIED
    with _BUILTIN_PROMPT_POLICY_LOCK:
        if _BUILTIN_PROMPT_POLICY_APPLIED:
            return
        logger.info("DeepAgent middleware prompt policy: official defaults enabled (no monkey-patch)")
        _BUILTIN_PROMPT_POLICY_APPLIED = True


def _load_memory_content(
    memory_paths: list[str],
    max_per_file_chars: int = 8000,
    max_total_chars: int = 20000,
) -> str:
    """读取 memory 文件内容，拼接为 Claude 风格的 <memory> 块。

    Memory 文件（.maibot/MAIBOT.md）包含项目级记忆和规则，
    相当于 Claude 的 CLAUDE.md / project memory。
    只读取存在的文件，跳过不存在或为空的文件。
    
    头部常驻策略（Claude Code 对齐）：
    - MAIBOT.md 前 200 行始终加载（always-on）

    长度保护：
    - 单文件超过 max_per_file_chars 时截断并标注
    - 总长超过 max_total_chars 时停止加载后续文件并标注
    """
    if not memory_paths:
        return ""

    parts = []
    total_len = 0
    root = get_workspace_root()
    for rel_path in memory_paths:
        abs_path = root / rel_path
        try:
            content = _read_cached_file(abs_path, max_age=60.0)
            if not content:
                continue
            content = content.strip()
            if not content:
                continue
            lower_rel = str(rel_path).lower()
            is_maibot_main = lower_rel.endswith(".maibot/maibot.md")
            if is_maibot_main:
                # Claude 风格：主记忆文件前 200 行常驻，避免关键规则被截断丢失
                lines = content.splitlines()
                _MAX_ALWAYS_ON = 12000
                always_on_raw = "\n".join(lines[:200]).strip()
                always_on = always_on_raw[:_MAX_ALWAYS_ON] + (
                    "\n\n[... always_on 已截断，原始 " + str(len(always_on_raw)) + " 字符 ...]"
                    if len(always_on_raw) > _MAX_ALWAYS_ON else ""
                )
                remainder = "\n".join(lines[200:]).strip()
                if always_on:
                    if remainder:
                        if len(remainder) > max_per_file_chars:
                            _cut = remainder.rfind("\n", 0, max_per_file_chars)
                            _cut = _cut if _cut > max_per_file_chars // 2 else max_per_file_chars
                            logger.info(
                                "[ProjectMemory] %s（200行后）被截断: %d -> %d chars",
                                rel_path, len(remainder), _cut,
                            )
                            remainder = remainder[:_cut] + "\n\n[... 已截断，完整内容请用 read_file 查看 ...]"
                        content = (
                            "<!-- ALWAYS_ON: first 200 lines -->\n"
                            + always_on
                            + "\n\n<!-- ON_DEMAND: after first 200 lines -->\n"
                            + remainder
                        )
                    else:
                        content = "<!-- ALWAYS_ON: first 200 lines -->\n" + always_on
            elif len(content) > max_per_file_chars:
                _cut = content.rfind("\n", 0, max_per_file_chars)
                _cut = _cut if _cut > max_per_file_chars // 2 else max_per_file_chars
                logger.info(
                    "[ProjectMemory] %s 被截断: %d -> %d chars",
                    rel_path, len(content), _cut,
                )
                content = content[:_cut] + "\n\n[... 已截断，完整内容请用 read_file 查看 ...]"
            part = f"<!-- {rel_path} -->\n{content}"
            if total_len + len(part) > max_total_chars:
                logger.info(
                    "[ProjectMemory] 总长已达 %d chars，跳过剩余文件（从 %s 开始）",
                    total_len, rel_path,
                )
                parts.append(f"<!-- 已省略 {rel_path} 及后续文件，总长超限 -->")
                break
                parts.append(part)
            total_len += len(part)
        except Exception as e:
            logger.debug("_load_memory_content single file read failed: %s", e, exc_info=True)

    if not parts:
        return ""

    return "<project_memory>\n" + "\n\n".join(parts) + "\n</project_memory>"


def _build_skills_catalog_from_index(
    enabled_skills: list[dict],
    *,
    max_items: int = 24,
    max_chars: int = 4000,
    desc_max: int = 120,
) -> str:
    """从 runtime index 的已启用技能列表构建 catalog：name + 短 description + 何时使用（triggers）+ 来源标识。"""
    if not enabled_skills:
        return ""
    def _source_tag(source: str) -> str:
        if source == "anthropic":
            return " [官方]"
        if source == "learned":
            return " [学习]"
        return " [内置]"
    rows: list[str] = []
    for s in enabled_skills[:max_items]:
        name = str(s.get("name") or "").strip()
        if not name:
            continue
        desc = (s.get("description") or "").strip()
        if len(desc) > desc_max:
            desc = desc[: desc_max - 1].rstrip() + "…"
        triggers = s.get("triggers") or []
        when = ""
        if triggers:
            when = " 何时用：" + "、".join(str(t) for t in triggers[:3])
        tag = _source_tag(str(s.get("source") or "").strip())
        script_tag = " [有脚本]" if s.get("has_scripts") else ""
        line = f"- **{name}**: {desc}{when}.{tag}{script_tag}"
        rows.append(line)
    if not rows:
        return ""
    text = "<skills_catalog>\n当前场景已加载能力子集（name + 短描述 + 何时使用）；需要完整流程时 get_skill_info(name) 或 read_file(SKILL.md)：\n"
    text += "\n".join(rows)
    if len(enabled_skills) >= max_items:
        text += "\n- ... 其余 Skills 已省略（按需 get_skill_info/list_skills）"
    text += "\n</skills_catalog>"
    if len(text) > max_chars:
        text = text[: max_chars - 20] + "\n...\n</skills_catalog>"
    return text


def _build_skills_catalog_summary(
    skills_paths: list[str],
    *,
    allowed_relative_paths: Optional[set[str]] = None,
    max_items: int = 24,
    max_chars: int = 4000,
) -> str:
    """构建 Skills 描述清单（仅名称+路径，不注入全文内容）。allowed_relative_paths 非空时仅包含该集合内路径（用于 tier 过滤）。无 index 时降级使用。"""
    if not skills_paths:
        return ""
    root = get_workspace_root()
    rows: list[str] = []
    seen: set[str] = set()
    for rel_path in skills_paths:
        if len(rows) >= max_items:
            break
        base = root / rel_path
        if not base.exists():
            continue
        if base.is_file() and base.name.lower() == "skill.md":
            files = [base]
        else:
            files = sorted(base.rglob("SKILL.md"))
        for skill_file in files:
            if len(rows) >= max_items:
                break
            try:
                rel = str(skill_file.relative_to(root))
            except Exception as e:
                logger.debug("skill_file.relative_to failed: %s", e, exc_info=True)
                rel = str(skill_file)
            if allowed_relative_paths is not None:
                rel_norm = rel.replace("\\", "/").strip().lower()
                if rel_norm not in allowed_relative_paths and rel not in allowed_relative_paths:
                    continue
            key = rel.lower()
            if key in seen:
                continue
            seen.add(key)
            skill_name = skill_file.parent.name or skill_file.stem
            rows.append(f"- {skill_name}: {rel}")
    if not rows:
        return ""
    text = "<skills_catalog>\n仅注入 Skills 名称清单（description-only），需要细节时按需 read_file 读取 SKILL.md：\n"
    text += "\n".join(rows)
    if len(rows) >= max_items:
        text += "\n- ... 其余 Skills 已省略（按需加载）"
    text += "\n</skills_catalog>"
    if len(text) > max_chars:
        text = text[:max_chars] + "\n...\n</skills_catalog>"
    return text


_RELEASE_PROFILE_DEFAULT: dict[str, Any] = {"stage": "global", "rollout_percentage": 100, "gate_passed": True}

def _load_release_profile() -> dict[str, Any]:
    """读取自动发布配置，供运行时灰度分流。"""
    try:
        path = PROJECT_ROOT / "knowledge_base" / "learned" / "auto_upgrade" / "release_profile.json"
        raw = _read_cached_file(path, max_age=120.0)
        if not raw:
            return _RELEASE_PROFILE_DEFAULT
        data = json.loads(raw)
        if isinstance(data, dict):
            return data
    except Exception as e:
        logger.debug("_load_release_profile failed: %s", e, exc_info=True)
    return _RELEASE_PROFILE_DEFAULT


def _resolve_rollout_candidate(configurable: dict[str, Any]) -> dict[str, Any]:
    """根据 release_profile 和会话标识，决定当前会话是否命中候选能力。"""
    profile = _load_release_profile()
    rollout_pct = int(profile.get("rollout_percentage", 100) or 100)
    rollout_pct = max(0, min(100, rollout_pct))
    gate_passed = bool(profile.get("gate_passed", True))
    stage = str(profile.get("stage", "global") or "global")

    # 会话稳定分桶（同一会话命中结果稳定）
    session_key = (
        str(configurable.get("thread_id") or "")
        or str(configurable.get("conversation_id") or "")
        or str(configurable.get("workspace_path") or "")
    )
    if not session_key:
        session_key = "anonymous-session"
    bucket = int(hashlib.sha256(session_key.encode("utf-8")).hexdigest()[:8], 16) % 100
    in_cohort = bucket < rollout_pct
    candidate_enabled = gate_passed and in_cohort

    # 手动覆盖开关仅允许在开发环境生效，避免生产环境被任意客户端强制开启候选
    if os.getenv("APP_ENV", "production") == "development" and "rollout_force_candidate" in configurable:
        candidate_enabled = bool(configurable.get("rollout_force_candidate"))

    return {
        "candidate_enabled": candidate_enabled,
        "rollout_percentage": rollout_pct,
        "bucket": bucket,
        "stage": stage,
        "gate_passed": gate_passed,
    }


_ROLLOUT_LOG_ROTATE_SEC = 24 * 3600  # 按天轮转：超过 24h 则重命名备份


def _append_rollout_runtime_log(configurable: dict[str, Any], decision: dict[str, Any]) -> None:
    """记录运行时灰度分流决策，便于线上审计与回放分析。按天轮转：mtime 超过 24h 则重命名备份后新建。"""
    try:
        path = PROJECT_ROOT / "knowledge_base" / "learned" / "auto_upgrade" / "rollout_runtime.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists():
            try:
                mtime = path.stat().st_mtime
                if (time.time() - mtime) >= _ROLLOUT_LOG_ROTATE_SEC:
                    from datetime import datetime as _dt
                    date_suffix = _dt.fromtimestamp(mtime, tz=timezone.utc).strftime("%Y-%m-%d")
                    backup = path.parent / f"rollout_runtime.{date_suffix}.jsonl"
                    if backup.exists():
                        backup = path.parent / f"rollout_runtime.{date_suffix}.{int(mtime)}.jsonl"
                    path.rename(backup)
            except Exception:
                pass
        row = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "thread_id": str(configurable.get("thread_id", "") or ""),
            "conversation_id": str(configurable.get("conversation_id", "") or ""),
            "workspace_path": str(configurable.get("workspace_path", "") or ""),
            "decision": {
                "candidate_enabled": bool(decision.get("candidate_enabled", False)),
                "rollout_percentage": int(decision.get("rollout_percentage", 100) or 100),
                "bucket": int(decision.get("bucket", 0) or 0),
                "stage": str(decision.get("stage", "global") or "global"),
                "gate_passed": bool(decision.get("gate_passed", True)),
            },
        }
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    except Exception:
        # 避免日志写入影响主链路
        pass


def _append_rollout_runtime_log_async(configurable: dict[str, Any], decision: dict[str, Any]) -> None:
    """异步写入灰度运行日志，避免阻塞主链路。"""
    payload_cfg = dict(configurable or {})
    payload_decision = dict(decision or {})
    try:
        _after_agent_async_executor.submit(_append_rollout_runtime_log, payload_cfg, payload_decision)
    except Exception:
        _append_rollout_runtime_log(payload_cfg, payload_decision)


from backend.engine.prompts.agent_prompts import (
    AgentConfig,
    UserContext,
    _format_user_context,
    get_orchestrator_prompt,
    get_dynamic_subagent_prompt,
    create_config,
)
# tool_strategy 已合并进 agent_prompts.py 的 <tool_usage>，不再独立注入
from backend.tools.base.registry import get_core_tool_by_name, get_all_core_tools

from langchain.agents.middleware.types import AgentMiddleware, dynamic_prompt, ModelRequest, ModelResponse
from langchain.agents.structured_output import ToolStrategy
from langgraph.config import get_config


# ============================================================
# 动态用户上下文（@dynamic_prompt，替代 UserContextMiddleware）
# ============================================================
def _content_to_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        chunks: list[str] = []
        for part in content:
            if isinstance(part, dict):
                text = part.get("text")
                if isinstance(text, str):
                    chunks.append(text)
        return "\n".join(chunks)
    return str(content or "")


def _collect_dynamic_prompt_snapshot(request: ModelRequest) -> dict[str, Any]:
    # Cache on request to avoid mutating LangGraph state (state updates must go through reducer).
    cached = getattr(request, "_memo_dynamic_prompt_snapshot", None)
    if isinstance(cached, dict):
        return cached

    state = request.state if isinstance(request.state, dict) else {}
    try:
        cfg = get_config() or {}
        configurable = (cfg.get("configurable") or {}) if isinstance(cfg, dict) else {}
    except Exception:
        configurable = {}

    # 装配校验：get_config() 在子图/中间件中可能为空，尝试从 request.state 或 ContextVar 兜底（Phase 2.2）
    if not configurable and isinstance(state, dict) and state.get("_run_configurable"):
        configurable = dict(state.get("_run_configurable") or {})
        if logger.isEnabledFor(logging.DEBUG):
            logger.debug("[context_verify] configurable 从 request.state._run_configurable 兜底，keys=%s", list(configurable.keys())[:20])
    if not configurable:
        try:
            from backend.tools.utils.context import get_run_configurable
            run_cfg = get_run_configurable()
            if isinstance(run_cfg, dict) and run_cfg:
                configurable = dict(run_cfg)
                if logger.isEnabledFor(logging.DEBUG):
                    logger.debug("[context_verify] configurable 从 get_run_configurable() 兜底，keys=%s", list(configurable.keys())[:20])
        except Exception:
            pass
    # 观测：configurable 为空或缺少关键键时打 WARNING，便于验证「中间件是否拿到 run 的 config」
    _has_ws = bool(str(configurable.get("workspace_path") or "").strip())
    _has_editor = bool(str(configurable.get("editor_path") or "").strip())
    if not configurable:
        logger.warning(
            "[context_verify] inject_runtime_context: get_config() 返回的 configurable 为空，UserContext 将全为默认值；"
            "请检查 LangGraph 是否将 config 传入当前执行上下文（如子图/中间件）。state.keys=%s",
            list(state.keys())[:15] if isinstance(state, dict) else None,
        )
    elif not _has_ws and logger.isEnabledFor(logging.DEBUG):
        logger.debug("[context_verify] configurable 无 workspace_path，thread_id=%s", configurable.get("thread_id"))
    if logger.isEnabledFor(logging.DEBUG) and configurable:
        logger.debug(
            "[context_verify] _collect_dynamic_prompt_snapshot configurable: workspace_path=%s, editor_path=%s, open_files_count=%s",
            _has_ws,
            _has_editor,
            len(configurable.get("open_files") or []),
        )

    messages = state.get("messages", []) if isinstance(state, dict) else []
    latest_user_text = ""
    human_count = 0
    total_chars = 0
    for msg in messages:
        content_text = _content_to_text(getattr(msg, "content", ""))
        total_chars += len(content_text)
        if getattr(msg, "type", "") in {"human", "user"}:
            human_count += 1
            latest_user_text = content_text

    snap = {
        "configurable": configurable,
        "messages": messages,
        "latest_user_text": latest_user_text,
        "human_count": human_count,
        "total_chars": total_chars,
    }
    try:
        setattr(request, "_memo_dynamic_prompt_snapshot", snap)
    except (AttributeError, TypeError):
        pass
    return snap


@dynamic_prompt
def inject_persona_context(request: ModelRequest) -> str:
    """从 .maibot/persona.json 注入拟人化身份配置（含 name_override）。已合并进 inject_runtime_context，默认链未使用。"""
    base = request.system_prompt or ""

    def _emotion_signal(text: str) -> str:
        t = (text or "").lower()
        if not t:
            return "neutral"
        negative_hits = ["卡住", "失败", "报错", "崩溃", "着急", "烦", "不行", "生气", "为什么还不行", "error", "fail"]
        positive_hits = ["谢谢", "很好", "不错", "顺利", "太棒", "满意", "great", "nice"]
        if any(x in t for x in negative_hits):
            return "frustrated"
        if any(x in t for x in positive_hits):
            return "positive"
        return "neutral"

    _SAFE_NAME_RE = re.compile(r"^[a-zA-Z0-9\u4e00-\u9fff ]{1,20}$")

    def _extract_name_override(text: str) -> str:
        t = (text or "").strip()
        if not t:
            return ""
        patterns = [
            r"^\s*你是\s*([^\n，。,.！!？?\(\)（）]{1,40})",
            r"^\s*从现在起你是\s*([^\n，。,.！!？?\(\)（）]{1,40})",
            r"^\s*你叫\s*([^\n，。,.！!？?\(\)（）]{1,40})",
            r"^\s*以后叫你\s*([^\n，。,.！!？?\(\)（）]{1,40})",
            r"^\s*you are\s+([^\n,\.!?\(\)]{1,40})",
            r"^\s*from now on you are\s+([^\n,\.!?\(\)]{1,40})",
            r"^\s*your name is\s+([^\n,\.!?\(\)]{1,40})",
        ]
        for pat in patterns:
            m = re.search(pat, t, flags=re.IGNORECASE)
            if m:
                raw = (m.group(1) or "").strip()
                if raw and _SAFE_NAME_RE.match(raw):
                    return raw
        return ""

    try:
        snap = _collect_dynamic_prompt_snapshot(request)
        configurable = snap.get("configurable", {}) or {}
        workspace_path = configurable.get("workspace_path")
        ws = Path(workspace_path).resolve() if workspace_path and Path(workspace_path).is_dir() else get_workspace_root()
        persona_path = ws / ".maibot" / "persona.json"
        if not persona_path.exists():
            return base
        raw = _read_cached_file(persona_path)
        if not raw:
            return base
        persona = json.loads(raw)
        if not isinstance(persona, dict):
            return base
        latest_user_text = str(snap.get("latest_user_text", "") or "")
        name_override = _extract_name_override(latest_user_text)
        if name_override:
            persona["name"] = name_override
            # 仅会话级使用，不写盘，避免持久化提示词注入

        name = str(persona.get("name", "MAIBOT") or "MAIBOT")
        tone = str(persona.get("tone", "professional") or "professional")
        relation = str(persona.get("relationship", "assistant") or "assistant")
        language = str(persona.get("language", "zh-CN") or "zh-CN")
        style = str(persona.get("communication_style", "concise") or "concise")
        empathy = str(persona.get("empathy", "balanced") or "balanced")
        preference_focus = str(persona.get("preference_focus", "task_first") or "task_first")
        emotion = _emotion_signal(latest_user_text)
        extra = (
            "<persona>\n"
            f"name={name}\n"
            f"tone={tone}\n"
            f"relationship={relation}\n"
            f"language={language}\n"
            f"communication_style={style}\n"
            f"empathy={empathy}\n"
            f"preference_focus={preference_focus}\n"
            f"recent_user_emotion={emotion}\n"
            "</persona>"
        )
        return f"{base}\n\n{extra}"
    except Exception:
        return base


@dynamic_prompt
def inject_wal_reminder(request: ModelRequest) -> str:
    """检测纠正/决策信号，提醒先写入 WAL(SESSION-STATE.md)。已合并进 inject_runtime_context，默认链未使用。"""
    base = request.system_prompt or ""
    try:
        latest = str(_collect_dynamic_prompt_snapshot(request).get("latest_user_text", "") or "")
        low = latest.lower()
        decision_hits = ("改成", "决定", "修正", "不对", "应该", "decide", "correct", "change")
        if latest and (any(k in latest for k in decision_hits) or any(k in low for k in decision_hits)):
            return (
                f"{base}\n\n<system_reminder>"
                "WAL 检查点：检测到纠正/决策信号。"
                "请先将关键结论写入 .maibot/SESSION-STATE.md，再继续执行。"
                "</system_reminder>"
            )
    except Exception as e:
        logger.debug("inject_wal_reminder failed: %s", e, exc_info=True)
    return base


@dynamic_prompt
def inject_learnings_reminder(request: ModelRequest) -> str:
    """在会话早期提醒检查历史错误，避免重复踩坑。已合并进 inject_runtime_context，默认链未使用。"""
    base = request.system_prompt or ""
    try:
        try:
            human_count = int(_collect_dynamic_prompt_snapshot(request).get("human_count", 0) or 0)
        except (TypeError, ValueError):
            human_count = 0
        if 0 < human_count <= 2:
            return (
                f"{base}\n\n<system_reminder>"
                "新任务开始前，优先检查 .learnings/ERRORS.md 与 .maibot/TOOLS.md，避免重复错误。"
                "</system_reminder>"
            )
    except Exception as e:
        logger.debug("inject_learnings_reminder failed: %s", e, exc_info=True)
    return base


@dynamic_prompt
def inject_proactive_reminder(request: ModelRequest) -> str:
    """检测完成信号，触发反向提示（下一步建议）。已合并进 inject_runtime_context，默认链未使用。"""
    base = request.system_prompt or ""
    try:
        latest = str(_collect_dynamic_prompt_snapshot(request).get("latest_user_text", "") or "")
        low = latest.lower()
        complete_hits = ("完成", "好了", "结束", "done", "finish", "搞定")
        if latest and (any(k in latest for k in complete_hits) or any(k in low for k in complete_hits)):
            return (
                f"{base}\n\n<system_reminder>"
                "反向提示：在给出结果后，补充 1-3 条可执行下一步建议（优先低成本高收益）。"
                "</system_reminder>"
            )
    except Exception as e:
        logger.debug("inject_proactive_reminder failed: %s", e, exc_info=True)
    return base


@dynamic_prompt
def inject_context_budget(request: ModelRequest) -> str:
    """上下文预算达到 60% 时提醒写入 WORKING-BUFFER 并触发压缩策略。已合并进 inject_runtime_context，默认链未使用。"""
    base = request.system_prompt or ""
    try:
        snap = _collect_dynamic_prompt_snapshot(request)
        try:
            total_chars = int(snap.get("total_chars", 0) or 0)
        except (TypeError, ValueError):
            total_chars = 0
        approx_tokens = total_chars // 4
        context_length = 65536
        try:
            configurable = snap.get("configurable", {}) if isinstance(snap, dict) else {}
            context_length = int(configurable.get("context_length", context_length) or context_length)
        except Exception as e:
            if logger.isEnabledFor(logging.DEBUG):
                logger.debug("inject_context_budget configurable parse failed: %s", e)
        usage_ratio = float(approx_tokens / max(1, context_length))
        if usage_ratio >= 0.6:
            return (
                f"{base}\n\n<system_reminder>"
                f"上下文预算告警：当前约使用 {usage_ratio:.0%}。"
                "请将关键中间结论写入 .maibot/WORKING-BUFFER.md，优先保留可验证结论并压缩低价值历史。"
                "</system_reminder>"
            )
    except Exception as e:
        logger.debug("inject_context_budget failed: %s", e, exc_info=True)
    return base


@dynamic_prompt
def inject_runtime_context(request: ModelRequest) -> str:
    """统一注入器：合并 user/persona/提醒类动态提示，减少中间件层级。"""
    base = request.system_prompt or ""
    snap = _collect_dynamic_prompt_snapshot(request)
    configurable = snap.get("configurable", {}) or {}
    blocks: list[str] = []

    # 工作区根只解析一次，persona 与 process_files 复用，避免重复与路径不一致
    _wp = configurable.get("workspace_path")
    _ws = Path(_wp).resolve() if _wp and Path(_wp).is_dir() else get_workspace_root()
    # 最后一条用户消息只取一次，persona 与提醒块复用，避免重复 snap.get 与 .lower()
    _latest_user = str(snap.get("latest_user_text", "") or "")
    _latest_low = _latest_user.lower()

    try:
        try:
            _ctx_len = int(configurable.get("context_length") or 0)
        except (TypeError, ValueError):
            _ctx_len = 0
        uc = UserContext(
            os_version=configurable.get("os_version", ""),
            shell=configurable.get("shell", ""),
            platform=str(configurable.get("platform") or ""),
            app_runtime=str(configurable.get("app_runtime") or ""),
            context_length=_ctx_len,
            workspace_path=configurable.get("workspace_path", ""),
            business_domain=configurable.get("business_domain") or configurable.get("workspace_domain") or configurable.get("skill_profile") or "general",
            task_type=configurable.get("task_type", ""),
            open_files=configurable.get("open_files", []),
            recently_viewed_files=configurable.get("recently_viewed_files", []),
            linter_errors=configurable.get("linter_errors", []),
            edit_history=configurable.get("edit_history", []),
            context_items=configurable.get("context_items", []),
            editor_path=configurable.get("editor_path", ""),
            selected_text=configurable.get("selected_text", ""),
            editor_content=configurable.get("editor_content", ""),
            web_search_enabled=configurable.get("web_search_enabled", False),
            research_mode=configurable.get("research_mode", False),
            guardrails_context=configurable.get("guardrails_context", ""),
        )
        ctx_text = _format_user_context(AgentConfig(user_context=uc))
        if ctx_text.strip():
            blocks.append(ctx_text)
    except Exception:
        pass

    try:
        persona_path = _ws / ".maibot" / "persona.json"
        raw = _read_cached_file(persona_path) if persona_path.exists() else ""
        if raw:
            persona = json.loads(raw)
            if isinstance(persona, dict):
                emotion = "neutral"
                if any(x in _latest_low for x in ("卡住", "失败", "报错", "崩溃", "着急", "烦", "不行", "生气", "error", "fail")):
                    emotion = "frustrated"
                elif any(x in _latest_low for x in ("谢谢", "很好", "不错", "顺利", "太棒", "满意", "great", "nice")):
                    emotion = "positive"
                blocks.append(
                    "<persona>\n"
                    f"name={str(persona.get('name', 'MAIBOT') or 'MAIBOT')}\n"
                    f"tone={str(persona.get('tone', 'professional') or 'professional')}\n"
                    f"relationship={str(persona.get('relationship', 'assistant') or 'assistant')}\n"
                    f"language={str(persona.get('language', 'zh-CN') or 'zh-CN')}\n"
                    f"communication_style={str(persona.get('communication_style', 'concise') or 'concise')}\n"
                    f"empathy={str(persona.get('empathy', 'balanced') or 'balanced')}\n"
                    f"preference_focus={str(persona.get('preference_focus', 'task_first') or 'task_first')}\n"
                    f"recent_user_emotion={emotion}\n"
                    "</persona>"
                )
    except Exception:
        pass

    # Phase 1.1：首轮前主动检索已存记忆并注入（Claude/Cowork 风格「首轮即知」）
    try:
        from backend.tools.base.memory_tools import get_relevant_memories_for_prompt
        recalled = get_relevant_memories_for_prompt(
            configurable,
            query=(_latest_user or "").strip() or "",  # 用首轮用户文检索，不依赖 configurable.last_user_message
            max_items=5,
            max_chars=_safe_int("PROACTIVE_MEMORY_MAX_CHARS", 800),
        )
        if recalled and recalled.strip():
            blocks.append(recalled)
    except Exception as e:
        if logger.isEnabledFor(logging.DEBUG):
            logger.debug("inject_runtime_context recalled_memories: %s", e)

    # Phase 1.2：过程文件存在性/摘要注入（仅非只读模式），复用 _ws
    try:
        mode = str(configurable.get("mode") or "").strip().lower()
        if mode not in ("ask", "review", ""):
            process_paths = [
                (_ws / ".maibot" / "SESSION-STATE.md", "SESSION-STATE"),
                (_ws / ".maibot" / "WORKING-BUFFER.md", "WORKING-BUFFER"),
            ]
            learnings = _ws / ".learnings" / "ERRORS.md"
            if learnings.exists():
                process_paths.append((learnings, "ERRORS"))
            existing = [label for p, label in process_paths if p.exists()]
            if existing:
                summary_max = _safe_int("PROCESS_FILES_SUMMARY_CHARS", 0)
                if summary_max <= 0:
                    blocks.append(
                        "<process_files>\n"
                        f"当前存在：{', '.join(existing)}。执行前请用 read_file 查看关键结论与待办。\n"
                        "</process_files>"
                    )
                else:
                    lines = []
                    for p, label in process_paths:
                        if not p.exists():
                            continue
                        try:
                            raw = p.read_text(encoding="utf-8", errors="replace")[:summary_max]
                            if len(raw) >= summary_max:
                                raw = raw.rsplit("\n", 1)[0] + "\n... (truncated)"
                            lines.append(f"[{label}]\n{raw}")
                        except Exception:
                            lines.append(f"[{label}] (read_file 查看)")
                    if lines:
                        blocks.append(
                            "<process_files>\n"
                            "以下为过程文件摘要，详情请 read_file。\n"
                            + "\n\n".join(lines)
                            + "\n</process_files>"
                        )
    except Exception as e:
        if logger.isEnabledFor(logging.DEBUG):
            logger.debug("inject_runtime_context process_files: %s", e)

    try:
        if _latest_user and any(k in _latest_user for k in ("改成", "决定", "修正", "不对", "应该")):
            blocks.append(
                "<system_reminder>"
                "WAL 检查点：检测到纠正/决策信号。请先将关键结论写入 .maibot/SESSION-STATE.md，再继续执行。"
                "</system_reminder>"
            )
        try:
            human_count = int(snap.get("human_count", 0) or 0)
        except (TypeError, ValueError):
            human_count = 0
        if 0 < human_count <= 2:
            blocks.append(
                "<system_reminder>"
                "新任务开始前，优先检查 .learnings/ERRORS.md 与 .maibot/TOOLS.md，避免重复错误。"
                "</system_reminder>"
            )
        if _latest_user and any(k in _latest_low for k in ("完成", "好了", "结束", "done", "finish", "搞定")):
            blocks.append(
                "<system_reminder>"
                "反向提示：在给出结果后，补充 1-3 条可执行下一步建议（优先低成本高收益）。"
                "</system_reminder>"
            )
        try:
            total_chars = int(snap.get("total_chars", 0) or 0)
        except (TypeError, ValueError):
            total_chars = 0
        approx_tokens = total_chars // 4
        try:
            context_length = int(configurable.get("context_length", 65536) or 65536)
        except (TypeError, ValueError):
            context_length = 65536
        usage_ratio = float(approx_tokens / max(1, context_length))
        if usage_ratio >= 0.6:
            blocks.append(
                "<system_reminder>"
                f"上下文预算告警：当前约使用 {usage_ratio:.0%}。请将关键中间结论写入 .maibot/WORKING-BUFFER.md，优先保留可验证结论并压缩低价值历史。"
                "</system_reminder>"
            )
    except Exception:
        pass

    if not blocks:
        return base
    return f"{base}\n\n" + "\n\n".join(blocks)


def _build_escalation_context(configurable: dict[str, Any]) -> dict[str, Any]:
    """从运行时上下文推断模型升级信号（缺省时使用启发式）。"""
    # 显式字段优先（由前端/上游调用方透传）
    try:
        retry_count = int(configurable.get("retry_count", 0) or 0)
    except (TypeError, ValueError):
        retry_count = 0
    critic_quality = str(configurable.get("critic_overall_quality", "") or "")
    task_complexity = configurable.get("task_complexity_score")
    user_explicit_request = bool(configurable.get("user_explicit_request", False))

    # 兼容字段：用户明确要求“更强模型/更高质量”
    if not user_explicit_request:
        user_explicit_request = bool(
            configurable.get("force_strong_model")
            or configurable.get("prefer_quality")
            or configurable.get("escalation_requested")
        )

    # 启发式复杂度估计（仅在未显式传 task_complexity_score 时生效）
    if task_complexity is None:
        score = 0.0
        task_type = str(configurable.get("task_type", "") or "").lower()
        if task_type in {"analysis", "debug", "research"}:
            score += 0.35
        if task_type in {"code", "planning"}:
            score += 0.25
        if len(configurable.get("open_files", []) or []) >= 3:
            score += 0.15
        if len(configurable.get("context_items", []) or []) >= 2:
            score += 0.15
        if len(configurable.get("linter_errors", []) or []) >= 5:
            score += 0.10
        if configurable.get("review_policy") == "gate":
            score += 0.10
        task_complexity = min(1.0, score)

    return {
        "retry_count": retry_count,
        "critic_overall_quality": critic_quality,
        "user_explicit_request": user_explicit_request,
        "task_complexity_score": float(task_complexity or 0.0),
    }


def _with_escalation_config(config: Optional["RunnableConfig"], configurable: dict[str, Any]) -> dict[str, Any]:
    """构造带升级上下文的 config，不覆盖调用方已明确传入值。"""
    base = dict(config or {})
    merged = dict(configurable or {})
    for key, value in _build_escalation_context(configurable).items():
        merged.setdefault(key, value)
    base["configurable"] = merged
    return base


def _resolve_skill_profile(configurable: dict[str, Any]) -> str:
    """解析稳定 skill_profile：优先显式值，其次 active_role_id 映射，最后回退 general。"""
    raw_profile = str(configurable.get("skill_profile") or "").strip().lower()
    try:
        from backend.engine.skills.skill_profiles import normalize_skill_profile

        normalized = normalize_skill_profile(raw_profile)
    except Exception:
        normalized = {"document": "general", "dev": "full", "community": "general", "analytics": "general"}.get(raw_profile, raw_profile)

    valid_profiles: set[str] = {"full", "general"}
    try:
        from backend.engine.skills.skill_profiles import load_profiles
        data = load_profiles()
        valid_profiles.update(
            str(k).strip().lower()
            for k in (data.get("profiles", {}) or {}).keys()
            if str(k).strip()
        )
    except Exception:
        pass

    if normalized in valid_profiles:
        return normalized

    role_id = str(
        configurable.get("active_role_id")
        or configurable.get("active_role")
        or ""
    ).strip()
    if role_id:
        try:
            from backend.engine.roles.role_manager import get_role
            role = get_role(role_id) or {}
            role_raw = str(role.get("skill_profile") or "").strip().lower()
            try:
                from backend.engine.skills.skill_profiles import normalize_skill_profile

                role_profile = normalize_skill_profile(role_raw)
            except Exception:
                role_profile = {"document": "general", "dev": "full", "community": "general", "analytics": "general"}.get(role_raw, role_raw)
            if role_profile in valid_profiles:
                return role_profile
        except Exception:
            pass

    return "general"


# ============================================================
# SubAgent 结构化输出中间件（用于 planning/critic）
# ============================================================
PLANNING_RESPONSE_SCHEMA: dict[str, Any] = {
    "title": "PlanningAgentOutput",
    "type": "object",
    "required": ["goal", "key_info", "steps", "deliverables", "risks"],
    "properties": {
        "goal": {"type": "string"},
        "key_info": {
            "type": "array",
            "items": {"type": "string"},
        },
        "steps": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["id", "action", "input_ref", "output_path", "verification"],
                "properties": {
                    "id": {"type": "string"},
                    "action": {"type": "string"},
                    "input_ref": {"type": "string"},
                    "output_path": {"type": "string"},
                    "verification": {"type": "string"},
                },
            },
        },
        "deliverables": {
            "type": "array",
            "items": {"type": "string"},
        },
        "risks": {
            "type": "array",
            "items": {"type": "string"},
        },
    },
}

CRITIC_RESPONSE_SCHEMA: dict[str, Any] = {
    "title": "CriticAgentOutput",
    "type": "object",
    "required": ["unsupported_claims", "unverified_calculations", "overall_quality"],
    "properties": {
        "unsupported_claims": {
            "type": "array",
            "items": {"type": "string"},
        },
        "unverified_calculations": {
            "type": "array",
            "items": {"type": "string"},
        },
        "overall_quality": {
            "type": "string",
            "enum": ["pass", "revise", "reject"],
        },
    },
}


class StructuredOutputMiddleware(AgentMiddleware):
    """Inject response_format for subagents that require structured output."""

    def __init__(self, schema: dict[str, Any]) -> None:
        self._response_format = ToolStrategy(schema=schema)

    def wrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], ModelResponse],
    ):
        if request.response_format is not None:
            return handler(request)
        return handler(request.override(response_format=self._response_format))

    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelResponse]],
    ) -> ModelResponse:
        if request.response_format is not None:
            return await handler(request)
        return await handler(request.override(response_format=self._response_format))


# ============================================================
# 配置（生产级可配置参数）
# ============================================================
# 
# 所有配置项均可通过环境变量覆盖，支持 .env 文件
# 配置优先级：环境变量 > .env 文件 > 默认值
# ============================================================

def _safe_int(key: str, default: int) -> int:
    try:
        return int(os.getenv(key, str(default)))
    except (ValueError, TypeError):
        return default

def _safe_float(key: str, default: float) -> float:
    try:
        return float(os.getenv(key, str(default)))
    except (ValueError, TypeError):
        return default


class Config:
    # ============================================================
    # 模型配置（Claude/Cursor 风格）
    # ============================================================
    # 模型 API 地址（可在设置页面配置）
    MODEL_URL = os.getenv("LM_STUDIO_URL", "http://localhost:1234/v1")
    
    # 默认模型名称（前端未指定时使用）
    # 注意：前端通过 config.configurable.model 传递用户选择的模型
    # 这里只是后端的默认值，实际使用以前端传递的为准
    DEFAULT_MODEL = os.getenv("LM_STUDIO_MODEL", "")
    
    # ============================================================
    # 部署模式配置 (Cursor 风格架构)
    # ============================================================
    # LOCAL: 本地部署，工具直接执行
    # CLOUD: 云端部署，工具通过 MCP 代理到本地执行
    DEPLOYMENT_MODE = os.getenv("DEPLOYMENT_MODE", "local")
    
    # MCP Server URL (云端模式需要，从客户端连接获取)
    MCP_SERVER_URL = os.getenv("MCP_SERVER_URL", "http://localhost:3000")
    
    # ============================================================
    # LLM 性能配置
    # ============================================================
    TEMPERATURE = _safe_float("LLM_TEMPERATURE", 0.3)
    AGENT_DEBUG_TEMPERATURE = _safe_float("AGENT_DEBUG_TEMPERATURE", 0.1)
    
    # 上下文窗口配置（按任务类型分级）
    MAX_TOKENS = _safe_int("LLM_MAX_TOKENS", 32768)  # 默认 32K
    MAX_TOKENS_DOC = _safe_int("LLM_MAX_TOKENS_DOC", 131072)  # 文档处理 128K
    MAX_TOKENS_FAST = _safe_int("LLM_MAX_TOKENS_FAST", 8192)  # 快速任务 8K
    
    # 超时配置（秒）
    TIMEOUT = _safe_int("LLM_TIMEOUT", 600)
    TIMEOUT_DOC = _safe_int("LLM_TIMEOUT_DOC", 1200)  # 文档处理 20 分钟
    TOOL_DEFAULT_TIMEOUT = _safe_int("TOOL_DEFAULT_TIMEOUT", 60)
    
    # 并发配置（资源感知）
    MAX_PARALLEL_LLM = _safe_int("MAX_PARALLEL_LLM", 1)
    # 非 LLM 任务并发数：python_run, 文件操作等
    MAX_PARALLEL_TOOLS = _safe_int("MAX_PARALLEL_TOOLS", 4)
    # SubAgent 并发数（每个 SubAgent 需要 LLM，受 MAX_PARALLEL_LLM 限制）
    MAX_PARALLEL_AGENTS = _safe_int("MAX_PARALLEL_AGENTS", 2)
    # SubAgent 嵌套深度限制（默认 1：子代理不可再派生子代理）
    SUBAGENT_MAX_DEPTH = max(1, _safe_int("SUBAGENT_MAX_DEPTH", 1))
    # YAML 扩展 SubAgent（默认关闭，按需开启）
    ENABLE_YAML_SUBAGENTS = os.getenv("ENABLE_YAML_SUBAGENTS", "false").lower() == "true"
    # 资源自适应并行（默认开启）
    ENABLE_RESOURCE_ADAPTIVE_PARALLEL = os.getenv("ENABLE_RESOURCE_ADAPTIVE_PARALLEL", "true").lower() == "true"
    MAX_ROUNDS = _safe_int("MAX_DELEGATION_ROUNDS", 8)
    
    # 调试模式
    DEBUG = os.getenv("DEBUG", "false").lower() == "true"
    WORKSPACE = str(WORKSPACE_PATH)  # 使用统一路径
    
    # 持久化配置
    ENABLE_CHECKPOINTER = os.getenv("ENABLE_CHECKPOINTER", "true").lower() == "true"
    ENABLE_STORE = os.getenv("ENABLE_STORE", "true").lower() == "true"
    
    # 性能模式: FAST / BALANCED / QUALITY / DOC
    PERFORMANCE_MODE = os.getenv("PERFORMANCE_MODE", "BALANCED")
    
    # ============================================================
    # 上下文压缩配置（SummarizationMiddleware）
    # ============================================================
    # 压缩触发阈值（0.0-1.0），当上下文占用达到 context_length 的该比例时触发压缩
    # 默认 0.75（参照 Claude/Cursor 更早压缩），可设 SUMMARIZATION_TRIGGER_RATIO=0.85 延后
    SUMMARIZATION_TRIGGER_RATIO = _safe_float("SUMMARIZATION_TRIGGER_RATIO", 0.75)
    
    DEFAULT_CONTEXT_LENGTH = _safe_int("DEFAULT_CONTEXT_LENGTH", 65536)
    
    # ============================================================
    # 低内存模式（8GB 及以下机器：一键降低所有缓存）
    # ============================================================
    LOW_MEMORY_MODE = os.getenv("LOW_MEMORY_MODE", "false").lower() == "true"
    
    # ============================================================
    # 缓存配置（生产级可配置；LOW_MEMORY_MODE 时自动缩小）
    # ============================================================
    # LLM 响应缓存
    LLM_CACHE_MAX_SIZE = _safe_int("LLM_CACHE_MAX_SIZE", 200 if LOW_MEMORY_MODE else 1000)
    
    AGENT_CACHE_MAX_SIZE = _safe_int("AGENT_CACHE_MAX_SIZE", 2 if LOW_MEMORY_MODE else 5)
    
    # ============================================================
    # 存储清理配置（生产级可配置）
    # ============================================================
    # SQLite 检查点保留天数
    CHECKPOINT_TTL_DAYS = _safe_int("CHECKPOINT_TTL_DAYS", 7)
    
    STORE_TTL_DAYS = _safe_int("STORE_TTL_DAYS", 30)
    
    PICKLE_CACHE_TTL_DAYS = _safe_int("PICKLE_CACHE_TTL_DAYS", 3)
    
    # Pickle 文件大小限制（MB）
    PICKLE_STORE_MAX_SIZE_MB = _safe_int("PICKLE_STORE_MAX_SIZE_MB", 500)
    PICKLE_CHECKPOINT_MAX_SIZE_MB = _safe_int("PICKLE_CHECKPOINT_MAX_SIZE_MB", 200)
    
    # ============================================================
    # 定期清理配置
    # ============================================================
    CLEANUP_INTERVAL_SECONDS = _safe_int("CLEANUP_INTERVAL_SECONDS", 3600)
    
    CLEANUP_ON_STARTUP = os.getenv("CLEANUP_ON_STARTUP", "true").lower() == "true"
    # 任务执行可靠性 V2（断点续跑/步骤去重）
    TASK_EXECUTION_RELIABILITY_V2 = os.getenv("TASK_EXECUTION_RELIABILITY_V2", "false").lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    
    # ============================================================
    # HTTP 连接池配置
    # ============================================================
    HTTP_CONNECT_TIMEOUT = _safe_float("HTTP_CONNECT_TIMEOUT", 10.0)
    HTTP_READ_TIMEOUT = _safe_float("HTTP_READ_TIMEOUT", 300.0)
    HTTP_WRITE_TIMEOUT = _safe_float("HTTP_WRITE_TIMEOUT", 30.0)
    HTTP_POOL_TIMEOUT = _safe_float("HTTP_POOL_TIMEOUT", 10.0)
    HTTP_MAX_KEEPALIVE = _safe_int("HTTP_MAX_KEEPALIVE", 10)
    HTTP_MAX_CONNECTIONS = _safe_int("HTTP_MAX_CONNECTIONS", 20)
    HTTP_KEEPALIVE_EXPIRY = _safe_float("HTTP_KEEPALIVE_EXPIRY", 30.0)
    
    # ============================================================
    # SQLite 性能配置（LOW_MEMORY_MODE 时 8MB，否则 64MB）
    # ============================================================
    SQLITE_CACHE_SIZE_KB = _safe_int("SQLITE_CACHE_SIZE_KB", 8000 if LOW_MEMORY_MODE else 64000)
    SQLITE_MMAP_SIZE_MB = _safe_int("SQLITE_MMAP_SIZE_MB", 8 if LOW_MEMORY_MODE else 64)
    SQLITE_TIMEOUT = _safe_float("SQLITE_TIMEOUT", 30.0)
    
    # ============================================================
    # Embedding 配置
    # ============================================================
    EMBEDDING_CHUNK_SIZE = _safe_int("EMBEDDING_CHUNK_SIZE", 1000)
    EMBEDDING_MAX_RETRIES = _safe_int("EMBEDDING_MAX_RETRIES", 2)
    EMBEDDING_TIMEOUT = _safe_float("EMBEDDING_TIMEOUT", 60.0)
    
    # ============================================================
    # 知识库配置（内存优化）
    # ============================================================
    # 是否启用知识库检索工具（禁用可大幅减少内存占用）
    ENABLE_KNOWLEDGE_RETRIEVER = os.getenv("ENABLE_KNOWLEDGE_RETRIEVER", "false").lower() == "true"
    # 是否启用知识图谱工具
    ENABLE_KNOWLEDGE_GRAPH = os.getenv("ENABLE_KNOWLEDGE_GRAPH", "false").lower() == "true"
    # 是否启用自我学习工具
    ENABLE_SELF_LEARNING = os.getenv("ENABLE_SELF_LEARNING", "false").lower() == "true"
    # 是否启用 langmem 记忆管理（与 LangGraph Store 集成）
    ENABLE_LANGMEM = os.getenv("ENABLE_LANGMEM", "true").lower() == "true"
    
    # ============================================================
    # Agent 运行限制配置（防止无限循环）
    # ============================================================
    # 模型调用次数限制（每轮对话）- 支持复杂任务（如招标分析、投标文件生成）
    MODEL_CALL_LIMIT = int(os.getenv("MODEL_CALL_LIMIT", "200"))
    # 工具调用次数限制（每轮对话）
    TOOL_CALL_LIMIT = int(os.getenv("TOOL_CALL_LIMIT", "500"))
    # 工具重试次数（与 Cursor 类似：不因单次失败轻易放弃，默认 2 次重试）
    TOOL_MAX_RETRIES = int(os.getenv("TOOL_MAX_RETRIES", "2"))
    # 模型重试次数（网络/临时故障时自动重试，默认 2）
    MODEL_MAX_RETRIES = int(os.getenv("MODEL_MAX_RETRIES", "2"))
    # 文件系统最大文件大小（MB）
    FILESYSTEM_MAX_FILE_SIZE_MB = int(os.getenv("FILESYSTEM_MAX_FILE_SIZE_MB", "5"))
    # 健康检查警告阈值（MB）
    HEALTH_WARNING_SIZE_MB = int(os.getenv("HEALTH_WARNING_SIZE_MB", "100"))
    
    # ============================================================
    # 模型特定优化配置
    # ============================================================
    # 针对本地 4bit 量化模型的优化参数
    # 参考 Claude 的效率优化策略：
    # 1. 减少不必要的 token 生成（降低 temperature）
    # 2. 使用 cache_prompt 避免重复计算
    # 3. 适当的 top_k/top_p 平衡质量和速度
    # 模型参数全部从 backend/config/models.json 读取（不在代码中硬编码模型名）
    MODEL_CONFIGS = {}
    
    # ============================================================
    # Claude 风格效率优化策略
    # ============================================================
    # 
    # 1. Prompt Caching（提示词缓存）
    #    - LM Studio 支持 cache_prompt=True
    #    - 重复的系统提示词只计算一次
    #    - 对于长系统提示词效果显著
    #
    # 2. Streaming（流式输出）
    #    - 所有 LLM 调用启用 streaming=True
    #    - 用户可以看到实时输出，体验更好
    #    - 不影响总体速度，但感知延迟更低
    #
    # 3. 智能上下文管理
    #    - SummarizationMiddleware 自动压缩历史
    #    - 大文件使用 grep 定位，不全量读取
    #    - 输出写入文件，只传递路径
    #
    # 4. 批量处理
    #    - 多个独立任务可以并行执行
    #    - MAX_PARALLEL 控制并发数
    #
    # 5. 响应缓存
    #    - InMemoryCache 缓存相同请求的响应
    #    - 避免重复计算
    #
    EFFICIENCY_TIPS = """
    提升本地模型效率的方法：
    
    1. 使用 cache_prompt=True（已启用）
       - 系统提示词只计算一次
       - 对话越长，节省越多
    
    2. 降低 temperature（已优化）
       - 模型 A: 0.25
       - 模型 B: 0.3
       - 更低的温度 = 更少的随机采样 = 更快
    
    3. 减少 top_k（已优化）
       - 模型 A: 15
       - 模型 B: 20
       - 更少的候选 token = 更快的采样
    
    4. 使用 FAST 模式处理简单任务
       - 设置 PERFORMANCE_MODE=FAST
       - 或在 config 中传递 task_type="fast"
    
    5. 大文件处理
       - 使用 grep 定位关键内容
       - 不要全量读取大文件
       - 输出写入文件，只传递路径
    """


def _detect_system_resources() -> dict[str, float]:
    """检测系统资源（无 psutil 时降级）。"""
    mem_gb = 0.0
    cpu_cores = float(os.cpu_count() or 1)
    try:
        import psutil  # type: ignore

        mem = psutil.virtual_memory()
        mem_gb = float(mem.available) / (1024 ** 3)
        cpu_cores = float(psutil.cpu_count(logical=False) or psutil.cpu_count() or 1)
    except Exception:
        pass
    return {"available_memory_gb": mem_gb, "cpu_cores": cpu_cores}


_parallel_policy_runtime: dict[str, Any] = {
    "profile": "local",
    "cloud_model_enabled": False,
    "limits": {"max_parallel_llm": 1, "max_parallel_agents": 2, "max_parallel_tools_per_agent": 2},
    "priority_order": ["env", "policy_profile", "resource_adaptive", "license", "agent_profile"],
}


def _load_parallel_policy() -> dict[str, Any]:
    path = PROJECT_ROOT / "backend" / "config" / "parallel_policy.json"
    default_policy: dict[str, Any] = {
        "priority_order": ["env", "policy_profile", "resource_adaptive", "license", "agent_profile"],
        "profiles": {
            "local": {"max_parallel_llm": 1, "max_parallel_agents": 2, "max_parallel_tools_per_agent": 2},
            "cloud": {"max_parallel_llm": 4, "max_parallel_agents": 6, "max_parallel_tools_per_agent": 3},
        },
        "cloud_activation": {"require_cloud_model_enabled": True, "allow_force_env": "FORCE_CLOUD_PARALLEL"},
    }
    try:
        raw = _read_cached_file(path, max_age=120.0)
        if raw:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                return parsed
    except Exception:
        logger.debug("加载 parallel_policy.json 失败，使用默认策略", exc_info=True)
    return default_policy


def _has_enabled_cloud_model() -> bool:
    models_path = PROJECT_ROOT / "backend" / "config" / "models.json"
    try:
        raw = _read_cached_file(models_path, max_age=120.0)
        if not raw:
            return False
        data = json.loads(raw)
        models = data.get("models", []) if isinstance(data, dict) else []
        for item in models:
            if not isinstance(item, dict):
                continue
            if not bool(item.get("enabled", False)):
                continue
            tier = str(item.get("tier", "") or "").strip().lower()
            if tier == "cloud" or tier.startswith("cloud-"):
                return True
    except Exception:
        logger.debug("读取 models.json 云模型状态失败", exc_info=True)
    return False


def _resolve_parallel_policy_profile(policy: dict[str, Any], cloud_model_enabled: bool) -> str:
    activation = policy.get("cloud_activation", {}) if isinstance(policy, dict) else {}
    require_cloud_model_enabled = bool((activation or {}).get("require_cloud_model_enabled", True))
    force_env = str((activation or {}).get("allow_force_env", "FORCE_CLOUD_PARALLEL") or "FORCE_CLOUD_PARALLEL")
    forced_cloud = str(os.getenv(force_env, "false")).strip().lower() in {"1", "true", "yes", "on"}
    deployment_mode = str(os.getenv("DEPLOYMENT_MODE", Config.DEPLOYMENT_MODE)).strip().lower()
    if forced_cloud:
        return "cloud"
    if deployment_mode != "cloud":
        return "local"
    if require_cloud_model_enabled and not cloud_model_enabled:
        return "local"
    return "cloud"


def _apply_resource_adaptive_parallelism() -> None:
    """按策略真源 + 机器资源调整并行参数。"""
    if not Config.ENABLE_RESOURCE_ADAPTIVE_PARALLEL:
        return
    policy = _load_parallel_policy()
    profiles = policy.get("profiles", {}) if isinstance(policy, dict) else {}
    local_limits = profiles.get("local", {}) if isinstance(profiles, dict) else {}
    cloud_limits = profiles.get("cloud", {}) if isinstance(profiles, dict) else {}
    cloud_model_enabled = _has_enabled_cloud_model()
    policy_profile = _resolve_parallel_policy_profile(policy, cloud_model_enabled)
    selected_limits = cloud_limits if policy_profile == "cloud" else local_limits
    policy_max_llm = max(1, int(selected_limits.get("max_parallel_llm", 1) or 1))
    policy_max_agents = max(1, int(selected_limits.get("max_parallel_agents", 2) or 2))
    policy_tools_per_agent = max(1, int(selected_limits.get("max_parallel_tools_per_agent", 2) or 2))
    res = _detect_system_resources()
    mem_gb = res.get("available_memory_gb", 0.0)
    cpu_cores = int(res.get("cpu_cores", 1) or 1)
    # 资源上限（先按硬件，再叠加策略配置）
    if mem_gb and mem_gb < 4:
        resource_parallel_agents_cap = 1
        resource_parallel_tools_cap = 1
    elif mem_gb and mem_gb < 8:
        resource_parallel_agents_cap = 1
        resource_parallel_tools_cap = 2
    else:
        resource_parallel_agents_cap = max(1, min(policy_max_agents, max(2, min(6, cpu_cores))))
        resource_parallel_tools_cap = max(2, min(policy_max_agents * policy_tools_per_agent, max(2, min(12, cpu_cores * 2))))

    if "MAX_PARALLEL_AGENTS" in os.environ:
        Config.MAX_PARALLEL_AGENTS = max(1, min(int(Config.MAX_PARALLEL_AGENTS or 1), resource_parallel_agents_cap, policy_max_agents))
    else:
        Config.MAX_PARALLEL_AGENTS = max(1, min(resource_parallel_agents_cap, policy_max_agents))

    if "MAX_PARALLEL_TOOLS" in os.environ:
        Config.MAX_PARALLEL_TOOLS = max(1, min(int(Config.MAX_PARALLEL_TOOLS or 1), resource_parallel_tools_cap))
    else:
        Config.MAX_PARALLEL_TOOLS = max(1, min(resource_parallel_tools_cap, max(2, Config.MAX_PARALLEL_AGENTS * policy_tools_per_agent)))

    if "MAX_PARALLEL_LLM" in os.environ:
        Config.MAX_PARALLEL_LLM = max(1, min(int(Config.MAX_PARALLEL_LLM or 1), Config.MAX_PARALLEL_AGENTS, policy_max_llm))
    else:
        Config.MAX_PARALLEL_LLM = max(1, min(policy_max_llm, Config.MAX_PARALLEL_AGENTS))

    # 统一并发上限：env/config + tier limit + agent_profile limit（取最小值）。
    try:
        tier_parallel_limit: Optional[int] = None
        from backend.engine.license.tier_service import tier_limits

        runtime_license_path = PROJECT_ROOT / "data" / "license.json"
        runtime_license: dict[str, Any] = {"tier": "free"}
        try:
            raw_license = _read_cached_file(runtime_license_path, max_age=120.0)
            if raw_license:
                parsed = json.loads(raw_license)
                if isinstance(parsed, dict):
                    runtime_license = parsed
        except Exception:
            runtime_license = {"tier": "free"}
        raw_tier_parallel = int(tier_limits(runtime_license).get("parallel_agents", 0) or 0)
        if raw_tier_parallel > 0:
            tier_parallel_limit = raw_tier_parallel
    except Exception:
        tier_parallel_limit = None

    agent_parallel_limit: Optional[int] = None
    try:
        profile_path = PROJECT_ROOT / "backend" / "config" / "agent_profile.json"
        raw_profile = _read_cached_file(profile_path, max_age=120.0)
        if raw_profile:
            profile_data = json.loads(raw_profile)
            caps = profile_data.get("capabilities") if isinstance(profile_data, dict) else {}
            if isinstance(caps, dict):
                max_parallel_tasks = int(caps.get("max_parallel_tasks", 0) or 0)
                if max_parallel_tasks > 0:
                    agent_parallel_limit = max_parallel_tasks
    except Exception:
        agent_parallel_limit = None

    effective_parallel_agents = max(1, int(Config.MAX_PARALLEL_AGENTS or 1))
    if tier_parallel_limit is not None:
        effective_parallel_agents = min(effective_parallel_agents, tier_parallel_limit)
    if agent_parallel_limit is not None:
        effective_parallel_agents = min(effective_parallel_agents, agent_parallel_limit)
    Config.MAX_PARALLEL_AGENTS = max(1, effective_parallel_agents)
    Config.MAX_PARALLEL_LLM = max(1, min(int(Config.MAX_PARALLEL_LLM or 1), Config.MAX_PARALLEL_AGENTS, policy_max_llm))
    Config.MAX_PARALLEL_TOOLS = max(1, min(int(Config.MAX_PARALLEL_TOOLS or 1), max(2, Config.MAX_PARALLEL_AGENTS * policy_tools_per_agent)))
    _parallel_policy_runtime.update({
        "profile": policy_profile,
        "cloud_model_enabled": cloud_model_enabled,
        "limits": {
            "max_parallel_llm": policy_max_llm,
            "max_parallel_agents": policy_max_agents,
            "max_parallel_tools_per_agent": policy_tools_per_agent,
        },
        "priority_order": list(policy.get("priority_order", _parallel_policy_runtime["priority_order"])),
    })


_apply_resource_adaptive_parallelism()


# ============================================================
# LangGraph Store 和 Checkpointer（由 LangGraph Server 自动注入）
# ============================================================
# 
# 重要：langgraph.json 已配置 SQLite 存储：
# - store: langgraph.store.sqlite.SqliteStore (./data/store.db)
# - checkpointer: langgraph.checkpoint.sqlite.aio.AsyncSqliteSaver (./data/checkpoints.db)
#
# LangGraph Server 会自动创建并注入这些实例到 graph 中，
# 代码中不需要手动创建，避免重复实例导致内存泄漏。
#
# 官方文档：https://langchain-ai.github.io/langgraph/concepts/persistence/
# ============================================================

def get_store():
    """获取 LangGraph Store 实例
    
    注意：LangGraph Server 通过 langgraph.json 配置自动注入 Store。
    此函数返回 None，实际 Store 由 LangGraph Server 管理。
    
    配置位置：langgraph.json -> store
    当前配置：SQLiteStore (./data/store.db)
    """
    # LangGraph Server 自动注入，不需要手动创建
    # 返回 None，让 create_deep_agent 使用 LangGraph Server 注入的 store
    if Config.DEBUG:
        import sys
        print("ℹ️ [get_store] Store 由 LangGraph Server 自动注入 (langgraph.json)", file=sys.stderr, flush=True)
    return None


def get_checkpointer():
    """获取 LangGraph Checkpointer 实例
    
    注意：LangGraph Server 通过 langgraph.json 配置自动注入 Checkpointer。
    此函数返回 None，实际 Checkpointer 由 LangGraph Server 管理。
    
    配置位置：langgraph.json -> checkpointer
    当前配置：SqliteSaver (./data/checkpoints.db)
    """
    # LangGraph Server 自动注入，不需要手动创建
    # 返回 None，让 create_deep_agent 使用 LangGraph Server 注入的 checkpointer
    if Config.DEBUG:
        import sys
        print("ℹ️ [get_checkpointer] Checkpointer 由 LangGraph Server 自动注入 (langgraph.json)", file=sys.stderr, flush=True)
    return None


# ============================================================
# 模型管理器（Claude/Cursor 风格）
# ============================================================
# 
# 使用 ModelManager 统一管理模型配置和创建：
# - 模型列表来自配置文件 (backend/config/models.json)
# - 后端维护当前使用的模型状态
# - 前端同步后端状态，不可用模型显示为灰色
# - 模型选择优先级：前端指定 > 当前使用 > 默认配置
# ============================================================
from backend.engine.agent.model_manager import (
    get_model_manager,
    get_model_from_config,
    create_llm,
    create_llm_for_subagent,
    create_configurable_llm,
)

def clear_llm_cache():
    """清除 LLM 缓存（模型切换时调用）"""
    get_model_manager().clear_cache()
    if Config.DEBUG:
        import sys
        print("🧹 [clear_llm_cache] 已清除 LLM 模型缓存", file=sys.stderr, flush=True)

def clear_llm_response_cache():
    """确保全局 LLM 缓存未启用（与 ChatOpenAI(cache=False) 一致）"""
    try:
        from langchain_core.globals import set_llm_cache
        set_llm_cache(None)
    except Exception:
        pass

def clear_all_caches():
    """清除所有缓存（用于内存清理）"""
    clear_llm_cache()
    clear_llm_response_cache()
    clear_agent_cache()
    if Config.DEBUG:
        import sys
        print("🧹 [clear_all_caches] 已清除所有缓存", file=sys.stderr, flush=True)

def get_memory_usage():
    """获取内存使用情况（诊断工具）
    
    使用 Python 标准库 + psutil（可选）获取内存信息。
    """
    import gc
    
    # 获取 LLM 响应缓存统计
    llm_response_cache_stats = get_llm_response_cache_stats()
    
    # 获取 ModelManager 缓存大小
    manager = get_model_manager()
    llm_cache_size = len(manager._llm_cache) if hasattr(manager, '_llm_cache') else 0
    
    result = {
        "llm_model_cache_size": llm_cache_size,
        "llm_response_cache": llm_response_cache_stats,
        "agent_cache_size": len(_agent_cache),
        "gc_objects": len(gc.get_objects()),
    }
    
    # 尝试使用 psutil 获取更详细的内存信息
    try:
        import psutil  # type: ignore[import-untyped]
        process = psutil.Process()
        mem_info = process.memory_info()
        result.update({
            "rss_mb": round(mem_info.rss / 1024 / 1024, 2),  # 物理内存
            "vms_mb": round(mem_info.vms / 1024 / 1024, 2),  # 虚拟内存
        })
    except ImportError:
        result["note"] = "psutil not installed, install with: pip install psutil"
    
    return result

# ============================================================
# 全局 LLM 缓存：已禁用
# ============================================================
# Agent 场景下 ChatOpenAI(cache=False)，且不设置 set_llm_cache()，
# 避免与单例 LLM 的 cache 参数冲突。加速依赖 LM Studio 的 cache_prompt（KV 前缀缓存）。

def get_llm_response_cache():
    """不再启用全局 LLM 响应缓存，确保与 ChatOpenAI(cache=False) 一致。"""
    try:
        from langchain_core.globals import set_llm_cache
        set_llm_cache(None)
    except Exception:
        pass
    return None


def get_llm_response_cache_stats():
    """LLM 响应缓存已禁用，始终返回未启用。"""
    return {"enabled": False, "size": 0, "maxsize": None}

# ============================================================
# HTTP 客户端（复用连接池）
# ============================================================
_httpx_client = None  # 复用 HTTP 客户端
_httpx_client_lock = threading.Lock()


def _get_httpx_client():
    """获取复用的 httpx 客户端（生产级连接池，使用可配置参数）"""
    global _httpx_client
    if _httpx_client is None:
        with _httpx_client_lock:
            if _httpx_client is None:
                import httpx
                _httpx_client = httpx.Client(
                    timeout=httpx.Timeout(
                        connect=Config.HTTP_CONNECT_TIMEOUT,
                        read=Config.HTTP_READ_TIMEOUT,
                        write=Config.HTTP_WRITE_TIMEOUT,
                        pool=Config.HTTP_POOL_TIMEOUT,
                    ),
                    limits=httpx.Limits(
                        max_keepalive_connections=Config.HTTP_MAX_KEEPALIVE,
                        max_connections=Config.HTTP_MAX_CONNECTIONS,
                        keepalive_expiry=Config.HTTP_KEEPALIVE_EXPIRY,
                    ),
                )
    return _httpx_client


def cleanup_httpx_client():
    """关闭复用的 httpx 客户端，避免连接池泄漏。应在应用 shutdown 时调用。"""
    global _httpx_client
    with _httpx_client_lock:
        if _httpx_client is not None:
            try:
                _httpx_client.close()
            except Exception:
                pass
            _httpx_client = None


def create_llm_for_agent(agent_type: str, config: Optional["RunnableConfig"] = None):
    """
    为不同子代理创建优化的 LLM 实例（动态窗口配置）
    
    Args:
        agent_type: 代理类型
            - "orchestrator": 协调器（中等窗口 16-32K）
            - "planning": 规划代理（中等窗口 16-32K）
            - "executor": 执行代理（大窗口 32-64K）
            - "knowledge": 知识代理（小窗口 8-16K）
        config: LangChain RunnableConfig（可选）
    
    Returns:
        配置好的 LLM 实例
    
    动态窗口策略（Claude 风格）：
    ┌─────────────────────────────────────────────────────────────┐
    │ Agent 类型    │ 窗口大小   │ 原因                           │
    ├───────────────┼────────────┼────────────────────────────────┤
    │ Orchestrator  │ 16-32K     │ 协调任务，不处理大文档          │
    │ Planning      │ 16-32K     │ 快速扫描，输出 JSON 结构化      │
    │ Executor      │ 32-64K     │ 处理大文档，生成报告            │
    │ Knowledge     │ 8-16K      │ 检索型，输入小输出中等          │
    └─────────────────────────────────────────────────────────────┘
    
    注意：
    - 每个子代理使用独立的窗口配置（在 models.json 中定义）
    - 切换参数不会很慢（LM Studio 支持动态调整 max_tokens）
    - 模型本身不需要重新加载
    """
    # 使用 ModelManager 创建 SubAgent 的 LLM，传递 agent_type 进行精细控制
    return create_llm_for_subagent(config=config, agent_type=agent_type)


# ============================================================
# 工具
# ============================================================
def get_tools(
    names: list,
    mode: Optional[str] = None,
    skill_profile: Optional[str] = None,
) -> list:
    # 工具对象解析缓存：key 含 mode/skill_profile，避免不同模式/配置复用错误。
    # 注意返回列表副本，避免调用方就地修改影响缓存内容。
    name_part = tuple(str(n).strip() for n in names if str(n).strip())
    if not name_part:
        return []
    key = (str(mode or ""), str(skill_profile or ""), *name_part)
    with _get_tools_cache_lock:
        cached = _get_tools_cache.get(key)
        if cached is not None:
            _get_tools_cache.pop(key, None)
            _get_tools_cache[key] = list(cached)
            return list(cached)

    tools = []
    for name in name_part:
        try:
            tools.append(get_core_tool_by_name(name))
        except Exception:
            pass
    with _get_tools_cache_lock:
        if len(_get_tools_cache) >= _GET_TOOLS_CACHE_MAX:
            oldest_key = next(iter(_get_tools_cache.keys()))
            _get_tools_cache.pop(oldest_key, None)
        _get_tools_cache[key] = list(tools)
    return list(tools)


# Orchestrator 核心工具配置（可配置，避免硬编码）
def _load_core_tools_json() -> dict[str, Any]:
    config_path = PROJECT_ROOT / "backend" / "config" / "core_tools.json"
    cache_key = str(config_path.resolve())
    now = time.monotonic()
    with _json_file_cache_lock:
        cached = _json_file_cache.get(cache_key)
        if cached and (now - cached[0]) < 60.0:
            return dict(cached[1])
    try:
        raw = _read_cached_file(config_path, max_age=60.0)
        if raw:
            data = json.loads(raw)
            if isinstance(data, dict):
                with _json_file_cache_lock:
                    _json_file_cache[cache_key] = (now, data)
                return data
    except Exception:
        pass
    return {}

def _load_core_tool_names() -> list[str]:
    default_tools = ["python_run", "shell_run", "web_search", "ask_user", "think_tool", "write_file_binary"]
    try:
        data = _load_core_tools_json()
        names = data.get("orchestrator_core_tools")
        if not isinstance(names, list):
            return default_tools
        cleaned = [str(x).strip() for x in names if str(x).strip()]
        return cleaned or default_tools
    except Exception:
        return default_tools


def _load_human_interrupt_tool_names() -> list[str]:
    """加载 HumanInTheLoop 中断工具配置（配置优先，默认 shell_run）。"""
    default_tools = ["shell_run"]
    try:
        data = _load_core_tools_json()
        names = data.get("human_in_the_loop_interrupt_tools")
        if not isinstance(names, list):
            return default_tools
        cleaned = [str(x).strip() for x in names if str(x).strip()]
        return cleaned or default_tools
    except Exception:
        return default_tools


def _load_subagent_tool_name_map() -> dict[str, list[str]]:
    """加载 SubAgent 工具配置（配置优先，默认回退）。"""
    default_map = {
        "explore": ["read_file", "glob", "grep", "shell_run"],
        "bash": ["shell_run", "read_file"],
        "browser": ["web_fetch"],
        "plan": ["read_file", "glob", "grep", "shell_run"],
        "knowledge": ["search_knowledge"],
        "executor": ["python_run", "shell_run"],
        "media": ["generate_image", "generate_ppt", "analyze_image", "generate_video"],
    }
    try:
        data = _load_core_tools_json()
        raw_map = data.get("subagent_tools") if isinstance(data, dict) else None
        if not isinstance(raw_map, dict):
            return default_map
        merged: dict[str, list[str]] = {}
        for role, defaults in default_map.items():
            names = raw_map.get(role)
            if isinstance(names, list):
                cleaned = [str(x).strip() for x in names if str(x).strip()]
                merged[role] = cleaned or defaults
            else:
                merged[role] = defaults
        alias_map = {"planning": "plan"}
        for role, names in raw_map.items():
            key = str(role).strip().lower()
            key = alias_map.get(key, key)
            if not key or key in merged:
                continue
            if isinstance(names, list):
                cleaned = [str(x).strip() for x in names if str(x).strip()]
                if cleaned:
                    merged[key] = cleaned
        return merged
    except Exception:
        return default_map


ORCHESTRATOR_SKILL_TOOL_NAMES = ["list_skills", "match_skills", "run_skill_script", "get_skill_info"]


def _load_orchestrator_skill_tool_names() -> list[str]:
    """加载 Orchestrator 必挂的 Skills 工具名（配置优先，默认回退）。"""
    default_tools = ORCHESTRATOR_SKILL_TOOL_NAMES
    try:
        data = _load_core_tools_json()
        names = data.get("orchestrator_skill_tools")
        if not isinstance(names, list):
            return default_tools
        cleaned = [str(x).strip() for x in names if str(x).strip()]
        return cleaned or default_tools
    except Exception:
        return default_tools


def _load_orchestrator_advanced_tool_names() -> list[str]:
    """加载 Orchestrator 高阶工具名（可选，不存在则为空）。"""
    try:
        data = _load_core_tools_json()
        names = data.get("orchestrator_advanced_tools")
        if not isinstance(names, list):
            return []
        cleaned = [str(x).strip() for x in names if str(x).strip()]
        return cleaned
    except Exception:
        return []


def _resolve_requested_extension_tools(configurable: dict[str, Any], extension_tools: list[Any]) -> list[str]:
    """解析本轮按需激活的扩展工具名（最多返回少量），避免全量 schema 注入。"""
    if not isinstance(configurable, dict) or not extension_tools:
        return []
    names = [str(getattr(t, "name", "") or "").strip() for t in extension_tools]
    names = [n for n in names if n]
    if not names:
        return []

    requested: set[str] = set()
    raw_list = configurable.get("activate_extension_tools")
    if isinstance(raw_list, str):
        raw_list = [x.strip() for x in raw_list.split(",") if x.strip()]
    if isinstance(raw_list, list):
        for item in raw_list:
            n = str(item or "").strip()
            if n and n in names:
                requested.add(n)

    text = str(configurable.get("last_user_message", "") or "").strip().lower()
    if text:
        for n in names:
            low = n.lower()
            # 支持 tool_name 与 "tool name" 两种匹配形式
            if low in text or low.replace("_", " ") in text:
                requested.add(n)

    # 每轮最多激活 2 个扩展工具，控制 schema 增量
    if not requested:
        return []
    ordered = [n for n in names if n in requested]
    return ordered[:2]


def _load_middleware_chain(mode: str) -> list[str]:
    """按模式读取中间件链配置。完整链以 middleware_chain.json 为唯一来源；仅当 JSON 缺失或异常时回退最小兜底链。"""
    # 最小兜底链（与 middleware_chain.json chains.ask 一致）：content_fix 须在 license_gate 之后；context_guard 在 reflection 前，与 JSON 顺序统一
    default_chain = [
        "mode_permission",
        "cloud_call_gate",
        "license_gate",
        "content_fix",
        "ontology_context",
        "context_guard",
        "reflection",
        "llm_tool_selector",
        "mcp",
        "inject_runtime_context",
        "streaming",
    ]
    config_path = PROJECT_ROOT / "backend" / "config" / "middleware_chain.json"
    mode_key = str(mode).strip().lower()
    try:
        raw = _read_cached_file(config_path, max_age=60.0)
        if not raw:
            return default_chain
        data = json.loads(raw)
        chains = data.get("chains", {}) if isinstance(data, dict) else {}
        mode_chain = chains.get(mode_key, []) if isinstance(chains, dict) else []
        if not isinstance(mode_chain, list) or not mode_chain:
            logger.warning(
                "Unknown or missing mode %r in middleware_chain.json, using default_chain (ask-like). Add chains.%s if needed.",
                mode_key or "(empty)",
                mode_key or "default",
            )
            return default_chain
        cleaned = [str(x).strip() for x in mode_chain if str(x).strip()]
        return cleaned or default_chain
    except Exception as e:
        logger.debug(
            "middleware_chain.json 加载失败，使用 default_chain: %s (%s)",
            type(e).__name__,
            e,
            exc_info=logger.isEnabledFor(logging.DEBUG),
        )
        return default_chain


def _load_runtime_license_profile() -> dict[str, Any]:
    path = PROJECT_ROOT / "data" / "license.json"
    cache_key = str(path.resolve())
    now = time.monotonic()
    with _json_file_cache_lock:
        cached = _json_file_cache.get(cache_key)
        if cached and (now - cached[0]) < 120.0:
            return dict(cached[1])
    try:
        raw = _read_cached_file(path, max_age=120.0)
        if raw:
            data = json.loads(raw)
            if isinstance(data, dict):
                with _json_file_cache_lock:
                    _json_file_cache[cache_key] = (now, data)
                return data
    except Exception:
        pass
    return {"tier": "free"}


def _load_plugins_state_names() -> list[str]:
    path = PROJECT_ROOT / "data" / "plugins_state.json"
    try:
        raw = _read_cached_file(path, max_age=60.0)
        if not raw:
            return []
        data = json.loads(raw)
        if isinstance(data, list):
            return [str(x).strip() for x in data if str(x).strip()]
    except Exception:
        pass
    return []


# ============================================================
# SubAgent 工具配置（精简版）
# ============================================================
# DeepAgent FilesystemMiddleware 自动提供：
#   ls, read_file, write_file, edit_file, glob, grep（共 6 个）
# 
# 我们只添加 FilesystemMiddleware 不提供的工具
# delete/copy/move 通过 shell_run 或 python_run 实现

# ============================================================
# 子代理工具配置
# ============================================================
# 
# FilesystemMiddleware 提供 6 个工具：
#   ls, read_file, write_file, edit_file, glob, grep
# 
# 注意：FilesystemMiddleware 不提供 execute 工具！
# 如需执行命令，使用 python_run 或在 Orchestrator 层添加
# ============================================================

# SubAgent 工具集由 backend/config/core_tools.json 驱动（支持默认回退）


# ============================================================
# 初始化自我学习管理器（连接 LangGraph Store）
# ============================================================
def init_learning_system():
    """
    初始化自我学习系统
    
    学习系统功能：
    1. 知识图谱 - 存储实体和关系
    2. 推理路径 - 存储成功的推理链
    3. 成功/失败模式 - 学习任务执行模式
    4. 置信度衰减 - 自动清理过期知识
    
    注意：Memory 功能由 langmem 管理（memory_tools.py）
    """
    import sys
    
    # 检查是否启用学习系统
    if not Config.ENABLE_SELF_LEARNING:
        if Config.DEBUG:
            print(f"ℹ️ [Learning] 自我学习系统已禁用（ENABLE_SELF_LEARNING=false）", file=sys.stderr, flush=True)
        return None
    
    try:
        from backend.tools.base.learning_middleware import get_learning_manager
        
        # 获取学习管理器（单例）
        manager = get_learning_manager()
        
        if Config.DEBUG:
            stats = manager.get_learning_stats()
            print(f"✅ [Learning] 自我学习系统已初始化", file=sys.stderr, flush=True)
            print(f"   知识图谱: {stats.get('entities', 0)} 实体, {stats.get('relations', 0)} 关系", file=sys.stderr, flush=True)
            print(f"   推理路径: {stats.get('reasoning_paths', 0)} 个", file=sys.stderr, flush=True)
            print(f"   成功模式: {stats.get('success_patterns', 0)} 个", file=sys.stderr, flush=True)
        
        return manager
    except Exception as e:
        if Config.DEBUG:
            print(f"⚠️ [Learning] 自我学习系统初始化失败: {e}", file=sys.stderr, flush=True)
        return None

# 初始化学习系统（如果启用）
_learning_manager = init_learning_system()


# ============================================================
# Sub-Agent 配置（上下文隔离）
# ============================================================

# 子代理 LLM 缓存（效率优化：相同配置共享实例），LRU 上限 32
_SUBAGENT_LLM_CACHE_MAX = 32
_subagent_llm_cache: OrderedDict[str, Any] = OrderedDict()
_subagent_llm_cache_lock = threading.Lock()


def _get_cached_subagent_llm(agent_type: str, config: Optional["RunnableConfig"] = None):
    """
    获取缓存的子代理 LLM 实例
    
    优化：相同 agent_type + model_id 共享 LLM 实例
    避免为每个子代理重复创建 LLM；LRU 驱逐，上限 32。
    """
    # 缓存键使用“解析后的实际模型 + agent_type”，避免 model/model_id 字段差异导致错绑
    resolved_model = ""
    try:
        resolved_model = str(
            get_model_manager().get_subagent_model(config, agent_type=agent_type) or ""
        ).strip()
    except Exception:
        resolved_model = ""
    if not resolved_model and isinstance(config, dict):
        configurable = config.get("configurable", {}) if isinstance(config.get("configurable"), dict) else {}
        resolved_model = str(
            configurable.get("model", "") or configurable.get("model_id", "") or ""
        ).strip()
    if not resolved_model:
        resolved_model = "default"
    normalized_agent_type = str(agent_type or "").strip().lower() or "default"
    cache_key = f"{resolved_model}:{normalized_agent_type}"
    # 锁外构造 + setdefault 原子写入，避免持锁期间执行 LLM 初始化阻塞全局
    with _subagent_llm_cache_lock:
        if cache_key in _subagent_llm_cache:
            _subagent_llm_cache.move_to_end(cache_key)
            return _subagent_llm_cache[cache_key]
    new_llm = create_llm_for_agent(agent_type, config)
    with _subagent_llm_cache_lock:
        _subagent_llm_cache.setdefault(cache_key, new_llm)
        _subagent_llm_cache.move_to_end(cache_key)
        while len(_subagent_llm_cache) > _SUBAGENT_LLM_CACHE_MAX:
            _subagent_llm_cache.popitem(last=False)
        return _subagent_llm_cache[cache_key]


def clear_subagent_llm_cache(model_id: str = None):
    """
    清除子代理 LLM 缓存
    
    Args:
        model_id: 指定模型 ID，None 则清除所有
    """
    with _subagent_llm_cache_lock:
        if model_id is None:
            _subagent_llm_cache.clear()
        else:
            keys_to_remove = [k for k in _subagent_llm_cache if k.startswith(f"{model_id}:")]
            for k in keys_to_remove:
                del _subagent_llm_cache[k]


def create_subagent_configs(
    prompt_cfg: AgentConfig,
    config: Optional["RunnableConfig"] = None,
    mode: str = "agent",
) -> list:
    """2+N SubAgent 架构（general-purpose 内置 + explore 默认 + YAML 按需扩展）
    
    核心价值：上下文隔离，避免主 Agent 上下文膨胀
    
    | Layer | Agent | 说明 |
    |-------|-------|------|
    | 1 | general-purpose（内置） | 上下文隔离的通用子代理 |
    | 2 | explore（默认） | 只读探索 |
    | 3 | YAML 扩展（按需） | 仅在显式启用时加载 |
    
    五种模式的 SubAgent 使用：
    - Agent：general-purpose + explore（可按需加载 YAML 扩展）
    - Plan：general-purpose + explore（可按需加载 YAML 扩展）
    - Debug：general-purpose + explore（可按需加载 YAML 扩展）
    - Review：general-purpose + explore（可按需加载 YAML 扩展）
    - Ask：general-purpose + explore（只读探索）
    """
    configurable = (config or {}).get("configurable", {}) if isinstance(config, dict) else (getattr(config, "configurable", {}) or {})
    try:
        _current_subagent_depth = int(configurable.get("_subagent_depth", 0) or 0)
    except Exception:
        _current_subagent_depth = 0
    _next_subagent_depth = _current_subagent_depth + 1
    _max_subagent_depth = max(
        1,
        int(configurable.get("subagent_max_depth") or Config.SUBAGENT_MAX_DEPTH or 1),
    )
    tool_toggles = configurable.get("tool_toggles", {}) or {}
    if isinstance(tool_toggles, str):
        try:
            tool_toggles = json.loads(tool_toggles)
        except Exception:
            tool_toggles = {}
    disabled_tools = {k for k, v in tool_toggles.items() if isinstance(k, str) and v is False} if isinstance(tool_toggles, dict) else set()
    subagent_tool_name_map = _load_subagent_tool_name_map()
    _enable_yaml_subagents = configurable.get("enable_yaml_subagents", Config.ENABLE_YAML_SUBAGENTS)
    if isinstance(_enable_yaml_subagents, str):
        _enable_yaml_subagents = _enable_yaml_subagents.strip().lower() in {"1", "true", "yes", "on"}
    else:
        _enable_yaml_subagents = bool(_enable_yaml_subagents)
    try:
        from backend.engine.modes import (
            is_tool_allowed as _is_tool_allowed,
            get_mode_config as _get_mode_config,
        )
    except Exception:
        _is_tool_allowed = None
        _get_mode_config = None
    _mode_allowed_tools: set[str] | None = None
    if _get_mode_config is not None:
        try:
            mode_cfg = _get_mode_config(mode)
            if mode_cfg and mode_cfg.allowed_tools:
                _mode_allowed_tools = {str(x).strip() for x in mode_cfg.allowed_tools if str(x).strip()}
        except Exception:
            _mode_allowed_tools = None
    skill_profile = _resolve_skill_profile(configurable)

    def _with_bundle_context(prompt: str) -> str:
        return prompt

    def _filter_tools(tools: list[Any]) -> list[Any]:
        if not disabled_tools:
            return list(tools)
        return [t for t in tools if getattr(t, "name", "") not in disabled_tools]

    def _filter_tools_by_mode(tools: list[Any]) -> list[Any]:
        if _is_tool_allowed is not None:
            result = [t for t in tools if _is_tool_allowed(mode, getattr(t, "name", ""))]
        elif _mode_allowed_tools is not None:
            result = [t for t in tools if getattr(t, "name", "") in _mode_allowed_tools]
        # 防御性回退：Ask 模式在极端情况下仍保证只读
        elif mode == "ask":
            blocked = {
                "write_file", "edit_file", "delete_file", "create_file",
                "remove_file", "copy_file", "move_file",
                "shell_run", "python_run",
            }
            result = [t for t in tools if getattr(t, "name", "") not in blocked]
        else:
            result = list(tools)

        # 显式限制子代理再派生：达到上限深度时移除 task。
        if _next_subagent_depth >= _max_subagent_depth:
            result = [t for t in result if str(getattr(t, "name", "") or "") != "task"]
        return result

    default_specs: list[dict[str, Any]] = [
        {
            "name": "explore-agent",
            "description": "Read-only explorer for files and content search across directories.",
            "tool_group": "explore",
            "prompt_template": "explore",
            "use_bundle_context": False,
            "model_alias": "explore",
        },
        {
            "name": "bash-agent",
            "description": "Runs shell commands in isolation. Use when running series of terminal commands or scripts; keeps verbose output out of main context.",
            "tool_group": "bash",
            "prompt_template": "general-purpose",
            "use_bundle_context": False,
            "model_alias": "fast",
        },
        {
            "name": "browser-agent",
            "description": "Browser automation and web fetch. Use when navigating pages, taking screenshots, or fetching web content; isolates DOM/snapshots from main context.",
            "tool_group": "browser",
            "prompt_template": "general-purpose",
            "use_bundle_context": False,
            "model_alias": "fast",
        },
    ]
    # 始终以内置子代理（explore/bash/browser）为基底，YAML 仅做合并扩展，不替换（与 Cursor 仅上下文隔离型子代理一致）
    default_names = {str(s.get("name", "") or "").strip() for s in default_specs}
    specs: list[dict[str, Any]] = list(default_specs)
    has_cloud_model = False
    try:
        import time as _time
        _hint_ttl_s = 30.0
        _hint_key = "_subagent_has_cloud_hint"
        _hint_ts_key = "_subagent_has_cloud_hint_ts"
        _now = _time.monotonic()
        with _middleware_singletons_lock:
            _hint = _middleware_singletons.get(_hint_key)
            _hint_ts = float(_middleware_singletons.get(_hint_ts_key, 0.0) or 0.0)
        if isinstance(_hint, bool) and (_now - _hint_ts) < _hint_ttl_s:
            has_cloud_model = _hint
        else:
            manager = get_model_manager()
            # 主链路避免触发 refresh_availability 的网络探测，仅使用当前快照状态。
            for item in manager.get_models_list(include_auto=False):
                model_id = str(item.get("id", "") or "").strip()
                tier = str(item.get("tier", "local") or "local").strip().lower()
                if not model_id or not bool(item.get("enabled", True)) or not tier.startswith("cloud-"):
                    continue
                model_info = manager.get_model_info(model_id)
                if model_info is None:
                    continue
                if manager.is_model_runtime_eligible(model_info, configurable):
                    has_cloud_model = True
                    break
            with _middleware_singletons_lock:
                _middleware_singletons[_hint_key] = has_cloud_model
                _middleware_singletons[_hint_ts_key] = _now
    except Exception:
        has_cloud_model = False
    can_parallel_llm = Config.MAX_PARALLEL_LLM > 1

    # YAML 扩展：与 default_specs 合并，同名保留内置、仅追加非内置名（planning/executor/knowledge/critic 等为可选扩展）
    if _enable_yaml_subagents and mode in {"agent", "plan", "debug", "review"}:
        agents_dir = get_workspace_root() / ".maibot" / "agents"
        if agents_dir.exists() and agents_dir.is_dir():
            try:
                import yaml
                with _middleware_singletons_lock:
                    _sa_cache = _middleware_singletons.get("_subagent_yaml_cache")
                    _sa_mtime = _middleware_singletons.get("_subagent_yaml_mtime", 0.0)
                _dir_mt = agents_dir.stat().st_mtime
                if _sa_cache is not None and _dir_mt == _sa_mtime:
                    _parsed = _sa_cache
                else:
                    _parsed = []
                    for yml in sorted(agents_dir.glob("*.yaml")):
                        try:
                            data = yaml.safe_load(_read_cached_file(yml, max_age=120.0) or "")
                        except Exception:
                            data = None
                        if isinstance(data, dict) and str(data.get("name", "")).strip():
                            _parsed.append(data)
                    with _middleware_singletons_lock:
                        _middleware_singletons["_subagent_yaml_cache"] = _parsed
                        _middleware_singletons["_subagent_yaml_mtime"] = _dir_mt
                for item in _parsed:
                    name = str(item.get("name", "") or "").strip()
                    if name and name not in default_names:
                        specs.append(item)
            except Exception:
                pass

    tool_groups: dict[str, list[Any]] = {
        str(group_name or "").strip().lower(): get_tools(
            [str(t) for t in (tool_names or []) if str(t).strip()],
            mode=mode,
            skill_profile=skill_profile,
        )
        for group_name, tool_names in (subagent_tool_name_map or {}).items()
        if str(group_name or "").strip()
    }

    def _resolve_prompt(spec: dict[str, Any], resolved_tools: list[Any]) -> str:
        prompt = get_dynamic_subagent_prompt(
            cfg=prompt_cfg,
            agent_name=str(spec.get("name", "") or "").strip(),
            prompt_template=str(spec.get("prompt_template", "") or "").strip().lower(),
            mode=mode,
            custom_system_prompt=str(spec.get("system_prompt") or "").strip() or None,
        )
        if bool(spec.get("use_bundle_context", False)):
            prompt = _with_bundle_context(prompt)
        return prompt

    configs: list[dict[str, Any]] = []
    for spec in specs:
        name = str(spec.get("name", "") or "").strip()
        if not name:
            continue
        group = str(spec.get("tool_group", "") or "").strip().lower()
        if group == "planning":
            group = "plan"
        explicit_tools = spec.get("tools")
        if isinstance(explicit_tools, list) and explicit_tools:
            tools = get_tools(
                [str(t) for t in explicit_tools if str(t).strip()],
                mode=mode,
                skill_profile=skill_profile,
            )
        else:
            tools = tool_groups.get(group, [])
            if group and group not in tool_groups:
                logger.warning("[SubAgent] 未知 tool_group='%s'，agent=%s", group, name)
        filtered_tools = _filter_tools_by_mode(_filter_tools(tools))
        # Explore 子代理保持只读：禁止写操作与执行型 Python 调用。
        if name in {"explore-agent"} or group in {"explore"}:
            readonly_blocked = {
                "write_file",
                "edit_file",
                "delete_file",
                "create_file",
                "remove_file",
                "copy_file",
                "move_file",
                "python_run",
                "run_skill_script",
                "enter_plan_mode",
                "exit_plan_mode",
                "request_human_review",
            }
            filtered_tools = [
                t for t in filtered_tools
                if str(getattr(t, "name", "") or "") not in readonly_blocked
            ]
        cfg_item: dict[str, Any] = {
            "name": name,
            "description": str(spec.get("description", "") or "").strip(),
            "system_prompt": _resolve_prompt(spec, filtered_tools),
            "tools": filtered_tools,
            "config": {
                "configurable": {
                    "mode": mode,
                    "_subagent_depth": _next_subagent_depth,
                    "subagent_max_depth": _max_subagent_depth,
                }
            },
            "model": _get_cached_subagent_llm(
                (
                    "plan"
                    if str(spec.get("model_alias", group or "explore") or "explore").strip().lower() == "planning"
                    else str(spec.get("model_alias", group or "explore") or "explore")
                ),
                config,
            ),
        }
        configs.append(cfg_item)

    # region agent log
    _agent_debug_log(
        "H8",
        "backend/engine/agent/deep_agent.py:create_subagent_configs",
        "subagent configs constructed",
        {
            "subagents": [
                {
                    "name": c.get("name"),
                    "tools": [getattr(t, "name", str(t)) for t in (c.get("tools") or [])],
                }
                for c in configs
            ],
            "resource_adaptive": {
                "mode": mode,
                "has_cloud_model": has_cloud_model,
                "can_parallel_llm": can_parallel_llm,
                "yaml_extension_enabled": bool(_enable_yaml_subagents),
            },
        },
    )
    # endregion
    return configs


# ============================================================
# Agent 缓存（生产级优化）
# ============================================================
# 
# 缓存策略：
# 1. Agent 实例缓存：避免重复创建（创建开销大）
# 2. LRU 淘汰：防止缓存无限增长
# 3. 弱引用：允许 GC 回收不再使用的 Agent
# ============================================================

_agent_cache: dict[str, any] = {}
_agent_cache_lock = threading.RLock()
# 缓存的中间件必须为无请求/会话状态，或仅从 Runtime/config 按请求读取；新增单例中间件时需满足该约定。
_middleware_singletons: dict[str, Any] = {}
_middleware_singletons_lock = threading.Lock()
_after_agent_async_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="after-agent-bg")
atexit.register(lambda: _after_agent_async_executor.shutdown(wait=False))
_agent_build_inflight: dict[str, threading.Event] = {}
_agent_build_inflight_lock = threading.Lock()
# 与 Cursor 类似：不因延时简单放弃，给予足够等待预算（并发构建 Agent 时等待同 key 完成）
_AGENT_BUILD_WAIT_SECONDS = max(1, int(os.environ.get("AGENT_BUILD_WAIT_SECONDS", "20") or 20))
_AGENT_BUILD_POST_WAIT_POLL_STEPS = max(0, int(os.environ.get("AGENT_BUILD_POST_WAIT_POLL_STEPS", "5") or 5))
_AGENT_BUILD_POST_WAIT_POLL_INTERVAL_MS = max(20, int(os.environ.get("AGENT_BUILD_POST_WAIT_POLL_INTERVAL_MS", "100") or 100))
_AGENT_BUILD_WAIT_SECONDS_INTERACTIVE = max(
    1, int(os.environ.get("AGENT_BUILD_WAIT_SECONDS_INTERACTIVE", "6") or 6)
)
_AGENT_BUILD_WAIT_SECONDS_ANALYSIS = max(
    _AGENT_BUILD_WAIT_SECONDS_INTERACTIVE,
    int(os.environ.get("AGENT_BUILD_WAIT_SECONDS_ANALYSIS", "15") or 15),
)


def _resolve_agent_build_wait_seconds(configurable: Dict[str, Any]) -> int:
    """按任务形态分层 singleflight 等待预算，交互优先更短。"""
    mode = str(configurable.get("mode") or "").strip().lower()
    task_type = str(configurable.get("task_type") or "").strip().lower()
    if mode in {"ask", "agent"} or task_type in {"fast", "quick_answer"}:
        return _AGENT_BUILD_WAIT_SECONDS_INTERACTIVE
    if mode in {"plan", "debug", "review"} or task_type in {"analysis", "document_analysis", "deep_research"}:
        return _AGENT_BUILD_WAIT_SECONDS_ANALYSIS
    return _AGENT_BUILD_WAIT_SECONDS


def _resolve_safe_bundle_path(bundle_rel: Optional[str]) -> Optional[Path]:
    """解析并校验 BUNDLE 路径，防止越界读取。"""
    if not bundle_rel:
        return None
    rel = str(bundle_rel).strip()
    if not rel:
        return None
    candidate = (SKILLS_ROOT / rel).resolve()
    try:
        if not candidate.is_relative_to(SKILLS_ROOT.resolve()):
            logger.warning("忽略越界 BUNDLE 路径: %s", rel)
            return None
    except Exception:
        logger.warning("校验 BUNDLE 路径失败，已忽略: %s", rel, exc_info=True)
        return None
    return candidate

def clear_agent_cache():
    """清除 Agent 缓存（模型切换时调用）"""
    global _agent_cache
    with _agent_cache_lock:
        _agent_cache.clear()
    clear_subagent_llm_cache()
    
    # 同时触发垃圾回收
    import gc
    gc.collect()


def _trim_agent_cache_fifo():
    """按 FIFO 策略裁剪 Agent 缓存到最大容量。"""
    global _agent_cache
    max_size = Config.AGENT_CACHE_MAX_SIZE
    with _agent_cache_lock:
        if len(_agent_cache) > max_size:
            # 删除最早添加的（dict 保持插入顺序）。
            keys_to_remove = list(_agent_cache.keys())[:-max_size]
            for key in keys_to_remove:
                del _agent_cache[key]


def _prune_agent_cache():
    """兼容旧调用名：实际执行 FIFO 裁剪。"""
    _trim_agent_cache_fifo()

def switch_model(model_id: str):
    """
    切换当前使用的模型
    
    使用 ModelManager 统一管理模型切换：
    - "auto": 使用默认模型
    - 具体模型 ID: 切换到指定模型
    
    运行时切换模型的方法：
    1. 前端在发送消息时传递 config: { configurable: { model: '<model_id>' } }
    2. LangGraph 自动将 config 传递给 LLM
    3. LLM 在运行时使用指定的模型
    
    Args:
        model_id: 新模型 ID，如 "<provider>/<model>" 或 "auto"
    
    Returns:
        是否切换成功
    """
    import sys
    
    manager = get_model_manager()
    success = manager.set_current_model(model_id)
    
    if success:
        # 模型切换后必须清理 Agent/SubAgent 缓存，避免继续命中旧模型实例
        clear_agent_cache()
        try:
            manager.clear_cache()
        except Exception:
            pass
        if Config.DEBUG:
            print(f"✅ [switch_model] 模型已切换到: {model_id}", file=sys.stderr, flush=True)
    else:
        print(f"❌ [switch_model] 模型切换失败: {model_id}", file=sys.stderr, flush=True)
    
    return success


def _has_non_error_attachments(context_items: Any) -> bool:
    if not context_items:
        return False
    if not isinstance(context_items, list):
        return False
    return any(
        isinstance(it, dict)
        and it.get("status") not in ("error", "uploading")
        and it.get("path")
        for it in context_items
    )


def _build_orchestrator_cache_key(
    *,
    model_id: str,
    mode: str,
    configurable: dict[str, Any],
    is_reasoning_model: bool,
) -> tuple[str, bool]:
    skill_profile = _resolve_skill_profile(configurable)
    role_id = str(configurable.get("active_role_id") or configurable.get("role_id") or "default").strip() or "default"
    user_id = str(configurable.get("user_id") or "").strip() or "default"
    session_id = str(configurable.get("session_id") or configurable.get("thread_id") or "").strip() or "default"
    raw_workspace_path = (configurable.get("workspace_path") or "").strip()
    if raw_workspace_path:
        try:
            # 归一化路径写法，避免同一工作区因字符串差异造成缓存 miss。
            workspace_path = str(Path(raw_workspace_path).expanduser().resolve(strict=False))
        except Exception:
            workspace_path = raw_workspace_path.rstrip("/") or "default"
    else:
        workspace_path = "default"
    # 补齐缓存键：纳入会影响工具与提示词行为的运行时设置，避免跨会话/跨模式错复用。
    session_plugins_raw = configurable.get("session_plugins", [])
    session_plugins = (
        sorted({str(x or "").strip() for x in session_plugins_raw if str(x or "").strip()})
        if isinstance(session_plugins_raw, list)
        else []
    )
    tool_toggles_raw = configurable.get("tool_toggles", {})
    tool_toggles = (
        {str(k): bool(v) for k, v in tool_toggles_raw.items() if str(k).strip()}
        if isinstance(tool_toggles_raw, dict)
        else {}
    )
    behavior_payload = {
        "task_type": str(configurable.get("task_type") or "").strip().lower(),
        "web_search_enabled": bool(configurable.get("web_search_enabled", False)),
        "review_policy": str(configurable.get("review_policy") or "").strip().lower(),
        "review_template": str(configurable.get("review_template") or "").strip().lower(),
        "session_plugins": session_plugins,
        "tool_toggles": tool_toggles,
    }
    behavior_sig = hashlib.sha1(
        json.dumps(behavior_payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()[:12]
    # Plan 模式：规划与执行使用不同 system prompt（<plan_execution> 仅执行阶段注入），必须区分缓存
    plan_phase = str(configurable.get("plan_phase") or "").strip().lower()
    if mode == "plan":
        plan_sig = "execution" if plan_phase == "execution" else "planning"
    else:
        plan_sig = "none"
    context_items = configurable.get("context_items", [])
    has_attachments = _has_non_error_attachments(context_items)
    cache_key = (
        f"agent:{model_id}:{mode}:{skill_profile}:{role_id}:{user_id}:{session_id}:{workspace_path}:"
        f"reasoning_{is_reasoning_model}:behavior_{behavior_sig}:plan_{plan_sig}"
    )
    return cache_key, has_attachments


def _build_user_context_from_config(
    config: Optional["RunnableConfig"],
    configurable: dict[str, Any],
):
    """将前端 configurable 归一化为 UserContext，便于提示词注入。"""
    if not config or not configurable:
        return None
    from backend.engine.prompts.agent_prompts import UserContext

    _MAX_OPEN_FILES = 20
    _MAX_RECENT_FILES = 30
    _MAX_CONTEXT_ITEMS = 20
    _MAX_LINTER_ERRORS = 30
    _MAX_EDIT_HISTORY = 30

    os_version = configurable.get("os_version", "")
    shell = configurable.get("shell", "")
    platform = str(configurable.get("platform") or "")
    app_runtime = str(configurable.get("app_runtime") or "")
    context_length = int(configurable.get("context_length") or 0)
    workspace_path = configurable.get("workspace_path", "")
    workspace_domain = configurable.get("workspace_domain", "general")
    project_type = str(configurable.get("project_type") or "")
    open_files = configurable.get("open_files", [])
    recently_viewed_files = configurable.get("recently_viewed_files", [])
    editor_path = configurable.get("editor_path", "")
    selected_text = configurable.get("selected_text", "")
    linter_errors = configurable.get("linter_errors", [])
    edit_history = configurable.get("edit_history", [])

    user_ctx_data = configurable.get("user_context", {})
    if not editor_path:
        editor_path = user_ctx_data.get("editor_path", "")
    if not selected_text:
        selected_text = user_ctx_data.get("selected_text", "")
    if not linter_errors:
        linter_errors = user_ctx_data.get("linter_errors", [])
    if not edit_history:
        edit_history = user_ctx_data.get("edit_history", [])

    context_items = configurable.get("context_items", [])
    if logger.isEnabledFor(logging.DEBUG):
        logger.debug("context_items: %s items", len(context_items))
    if context_items and logger.isEnabledFor(logging.DEBUG):
        for item in context_items[:5]:
            logger.debug(
                "   - %s: %s (type: %s)",
                item.get("name"),
                item.get("path", "no path"),
                item.get("type"),
            )
    web_search_enabled = configurable.get("web_search_enabled", False)
    research_mode = configurable.get("research_mode", False)
    business_domain = (
        configurable.get("business_domain")
        or configurable.get("skill_profile")
        or workspace_domain
        or user_ctx_data.get("business_domain", "general")
    )
    _open_files = open_files or user_ctx_data.get("open_files", [])
    _recent_files = recently_viewed_files or user_ctx_data.get("recently_viewed_files", [])
    _lints = linter_errors or []
    _history = edit_history or []
    _ctx_items = context_items or user_ctx_data.get("context_items", [])

    if isinstance(_open_files, list):
        _open_files = _open_files[:_MAX_OPEN_FILES]
    if isinstance(_recent_files, list):
        _recent_files = _recent_files[:_MAX_RECENT_FILES]
    if isinstance(_lints, list):
        _lints = _lints[:_MAX_LINTER_ERRORS]
    if isinstance(_history, list):
        _history = _history[:_MAX_EDIT_HISTORY]
    if isinstance(_ctx_items, list):
        _ctx_items = _ctx_items[:_MAX_CONTEXT_ITEMS]

    # 从 configurable 取运行时 user_preferences，再合并持久化 UserProfile（对标 Cursor Memories 自动注入）
    user_prefs = dict(configurable.get("user_preferences") or user_ctx_data.get("user_preferences") or {})
    try:
        from backend.engine.core.main_graph import get_sqlite_store
        from backend.memory.user_model import get_user_profile
        store = get_sqlite_store()
        ws_id = (configurable.get("workspace_id") or workspace_path or "default").strip() or "default"
        if store and ws_id:
            profile = get_user_profile(store, ws_id)
            if profile.communication_style:
                user_prefs.setdefault("communication_style", profile.communication_style)
            if profile.detail_level:
                user_prefs.setdefault("detail_level", profile.detail_level)
            if profile.domain_expertise:
                user_prefs.setdefault("domain_expertise", profile.domain_expertise)
            if profile.custom_rules:
                existing = user_prefs.get("custom_rules") or []
                user_prefs["custom_rules"] = list(dict.fromkeys(list(existing) + list(profile.custom_rules)))
            if profile.expertise_areas:
                areas_str = ", ".join(f"{k}:{v}" for k, v in profile.expertise_areas.items())
                user_prefs.setdefault("expertise_areas", areas_str)
            if profile.decision_patterns:
                user_prefs.setdefault("decision_patterns", profile.decision_patterns)
            if profile.learning_trajectory:
                user_prefs.setdefault("learning_trajectory", profile.learning_trajectory[-5:])
            if profile.unsolved_intents:
                user_prefs.setdefault("unsolved_intents", profile.unsolved_intents[-3:])
    except Exception:
        pass

    editor_content = str(configurable.get("editor_content") or user_ctx_data.get("editor_content", "") or "")
    return UserContext(
        os_version=os_version or user_ctx_data.get("os_version", ""),
        shell=shell or user_ctx_data.get("shell", ""),
        platform=platform or user_ctx_data.get("platform", ""),
        app_runtime=app_runtime or user_ctx_data.get("app_runtime", ""),
        context_length=context_length or int(user_ctx_data.get("context_length") or 0),
        workspace_path=workspace_path or user_ctx_data.get("workspace_path", ""),
        project_type=project_type or user_ctx_data.get("project_type", ""),
        business_domain=business_domain,
        task_type=configurable.get("task_type", "") or user_ctx_data.get("task_type", ""),
        open_files=_open_files,
        recently_viewed_files=_recent_files,
        linter_errors=_lints,
        edit_history=_history,
        context_items=_ctx_items,
        editor_path=editor_path,
        selected_text=selected_text or "",
        editor_content=editor_content,
        web_search_enabled=web_search_enabled,
        research_mode=research_mode,
        guardrails_context=str(configurable.get("guardrails_context", "") or user_ctx_data.get("guardrails_context", "")),
        user_preferences=user_prefs,
    )

# ============================================================
# 创建 Agent
# ============================================================
def create_orchestrator_agent(
    model_id: Optional[str] = None,
    config: Optional["RunnableConfig"] = None,
    domains: dict = None,
    mode: str = "agent",  # 新增：支持 agent/ask/plan/debug/review 五种模式
):
    """创建 Orchestrator + 3 Sub-Agents（带缓存）
    
    充分利用 DeepAgent 原生能力：
    1. TodoListMiddleware → write_todos (任务跟踪到 state["todos"])
    2. FilesystemMiddleware → 文件操作 (记录到 state["files"])
    3. SubAgentMiddleware → task (子代理委派)
    4. SummarizationMiddleware → 自动上下文压缩（显式配置）
    5. Store → 持久化记忆 (跨会话)
    6. Checkpointer → 会话恢复 (断点续传)
    
    模式说明（与 Cursor 对齐）：
    - agent: 全部工具，自主执行
    - ask: 只读工具，分析建议
    - plan: 分析+写入，制定计划
    - debug: 分析+脚本，问题诊断
    - review: 只读分析+评审报告输出，清单驱动审查
    """
    from backend.engine.backends import EnhancedFilesystemBackend
    from deepagents.backends import CompositeBackend, StoreBackend
    from backend.engine.modes import get_mode_config, get_mode_tools, is_tool_allowed, get_mode_output_dir
    # region agent log
    try:
        import deepagents
        import deepagents.middleware.subagents as _da_sub
        _agent_debug_log(
            "H13",
            "backend/engine/agent/deep_agent.py:create_orchestrator_agent:module_paths",
            "runtime deepagents module paths",
            {
                "deepagents_file": getattr(deepagents, "__file__", ""),
                "subagents_file": getattr(_da_sub, "__file__", ""),
            },
        )
    except Exception:
        pass
    # endregion
    
    # 单次解析 configurable，后续复用
    configurable = (config or {}).get("configurable", {}) or {}
    if isinstance(configurable, dict):
        configurable = dict(configurable)
        configurable["skill_profile"] = _resolve_skill_profile(configurable)
    config_with_escalation = _with_escalation_config(config, configurable)
    effective_configurable = (config_with_escalation or {}).get("configurable", {}) or {}
    rollout_decision = _resolve_rollout_candidate(effective_configurable)
    _append_rollout_runtime_log_async(effective_configurable, rollout_decision)
    mode = configurable.get("mode", mode)
    # 获取模式配置
    mode_config = get_mode_config(mode)
    if logger.isEnabledFor(logging.DEBUG):
        logger.debug("[Mode] 当前模式: %s, 允许工具: %s", mode, len(mode_config.allowed_tools) or "全部")
    
    manager = get_model_manager()
    model_id = manager.get_model(config_with_escalation)
    is_reasoning_for_cache = False
    try:
        model_config = manager.get_model_config(model_id)
        if model_config:
            is_reasoning_for_cache = model_config.get("is_reasoning_model", False)
    except Exception:
        pass

    # Agent 缓存（model_id + mode + skill_profile + role_id + workspace_path + is_reasoning_model，避免角色切换错配）
    cache_key, _has_attachments = _build_orchestrator_cache_key(
        model_id=model_id,
        mode=mode,
        configurable=configurable,
        is_reasoning_model=is_reasoning_for_cache,
    )
    if not _has_attachments:
        with _agent_cache_lock:
            _cached_agent = _agent_cache.get(cache_key)
        if _cached_agent is not None:
            if logger.isEnabledFor(logging.DEBUG):
                logger.debug("[create_orchestrator_agent] 使用缓存的 Agent: %s, 模式: %s", model_id, mode)
            return _cached_agent
    elif logger.isEnabledFor(logging.DEBUG):
        logger.debug("[create_orchestrator_agent] 检测到附件，跳过 Agent 缓存以避免上下文错配")

    # 创建新 Agent
    logger.info("创建新 Agent，模型: %s, 模式: %s", model_id, mode)
    if os.getenv("LANGSMITH_API_KEY"):
        os.environ.setdefault("LANGCHAIN_TRACING_V2", "true")
        os.environ.setdefault("LANGCHAIN_PROJECT", "maibot")

 # 直接创建 LLM（不使用 configurable_fields，因为模型已确定）
    # 这样可以避免 configurable_fields 的复杂性
    model = manager.create_llm(config=config_with_escalation, task_type="default")
    model_id = manager.get_current_model() or model_id
    if mode in ("agent", "debug") and hasattr(model, "temperature"):
        try:
            model.temperature = Config.AGENT_DEBUG_TEMPERATURE
        except Exception:
            pass
    
    # 从 config 中提取用户上下文（Cursor/Claude 风格，复用已解析的 configurable）
    # 约定：当前打开文件、最近查看、编辑历史、linter、附件、当前选中等按 Claude/Cursor 顺序组装，
    # 由 agent_prompts._format_user_context 注入系统提示词末尾，等价于 Cursor「随用户消息附加的 IDE 状态信息」。
    user_context = _build_user_context_from_config(config, configurable)

    is_reasoning_model = is_reasoning_for_cache
    
    # ============================================================
    # 提前设置工作区根目录（在 run_in_executor 线程中执行，避免 async 事件循环中 os.mkdir 阻塞）
    # create_backend 是 DeepAgent 的工厂函数，在 astream() 异步上下文中被调用，
    # 因此不能在其中执行 set_workspace_root（含 mkdir 等同步 IO）。
    # ============================================================
    _ws_path = (configurable.get("workspace_path", "") or "").strip()
    if _ws_path and Path(_ws_path).is_dir():
        set_workspace_root(_ws_path)
    else:
        # 未提供或无效时回退到项目下的 tmp（与 paths 默认一致），避免写入项目根 ccb-v0.378 导致用户困惑
        _fallback = str(PROJECT_ROOT / "tmp")
        Path(_fallback).mkdir(parents=True, exist_ok=True)
        set_workspace_root(_fallback)
        # region agent log
        _agent_debug_log(
            "H17",
            "backend/engine/agent/deep_agent.py:create_orchestrator_agent:workspace_fallback",
            "workspace_path missing/invalid, fallback to project/tmp (not project root)",
            {"incoming_workspace_path": _ws_path, "fallback_workspace_root": _fallback},
        )
        # endregion

    # 注入实际绝对路径到 AgentConfig（Claude/Cursor 规范：模式专用输出目录）
    # 请求级 workspace：优先用 configurable.workspace_path 解析，避免并发下 get_workspace_root() 被其他请求覆盖
    from backend.tools.base.paths import (
        UPLOADS_PATH, KB_PATH, MAIBOT_PATH, get_workspace_root,
    )
    try:
        _request_ws = Path(_ws_path).resolve() if _ws_path and Path(_ws_path).is_dir() else None
    except Exception:
        _request_ws = None
    _ws_root = _request_ws if _request_ws is not None else get_workspace_root()
    _mode_output_dir = str(_ws_root / get_mode_output_dir(mode))
    # region agent log
    _agent_debug_log(
        "H10",
        "backend/engine/agent/deep_agent.py:create_orchestrator_agent:workspace_output",
        "workspace and output dir resolved",
        {
            "mode": mode,
            "workspace_root": str(_ws_root),
            "output_dir": _mode_output_dir,
            "configured_workspace_path": configurable.get("workspace_path", ""),
            "context_items_count": len(configurable.get("context_items", []) or []),
        },
    )
    # endregion
    prompt_cfg = AgentConfig(
        domains=domains or {
            "bidding": ["analyze", "parse", "identify", "generate", "evaluate"],
            "contracts": ["review", "risk"],
            "reports": ["writing"],
        },
        max_rounds=Config.MAX_ROUNDS,
        workspace=str(_ws_root),
        upload_dir=str(UPLOADS_PATH),
        output_dir=_mode_output_dir,
        context_dir=str(MAIBOT_PATH),
        knowledge_base=str(KB_PATH),
        is_reasoning_model=is_reasoning_model,
    )
    # 如果有用户上下文，覆盖默认值
    if user_context:
        prompt_cfg.user_context = user_context
    
 # DeepAgent 原生能力配置
    store = get_store()
    checkpointer = get_checkpointer()
    
 # 创建 Backend（Cursor 风格架构）
    # 
    # 部署模式：
    # - LOCAL: 直接使用 FilesystemBackend，工具在本地执行
    # - CLOUD: 使用 MCP Client 代理到本地 MCP Server
    #
    # 架构说明：
    # - 用户文件始终在本地（前端 Electron App 所在机器）
    # - 云端只存储：记忆、向量索引、全局知识库
    # - 文件操作通过 MCP 协议远程调用本地执行
    def create_backend(runtime):
        # 从 runtime.config 获取配置（请求级 workspace，避免并发下用错工作区）
        workspace_path = None
        mcp_server_url = None
        deployment_mode = Config.DEPLOYMENT_MODE
        
        if hasattr(runtime, 'config') and runtime.config:
            config = runtime.config.get('configurable', {}) if isinstance(runtime.config, dict) else {}
            workspace_path = config.get('workspace_path')
            mcp_server_url = config.get('mcp_server_url', Config.MCP_SERVER_URL)
            deployment_mode = config.get('deployment_mode', deployment_mode)
        
        # 请求级工作区根：优先 runtime.config，否则用创建 Agent 时解析的 _ws_root（闭包），不再用全局 get_workspace_root()
        _raw_ws = (workspace_path or "").strip()
        if _raw_ws and Path(_raw_ws).is_dir():
            _request_workspace_root = Path(_raw_ws).resolve()
        else:
            _request_workspace_root = _ws_root
        
        # ============================================================
        # 本地模式：Backend root = 当前请求的工作区根（用户项目目录）
        #
        # 方案 A：不再依赖全局 get_workspace_root()，从 runtime.config 取 workspace_path，
        # 使每个请求的 default_backend 绑定自己的 workspace，消除并发下文件工具用错工作区的问题。
        # ============================================================
        if deployment_mode == "local":
            root_dir = str(_request_workspace_root)
            
            if logger.isEnabledFor(logging.DEBUG):
                logger.debug("[Backend] LOCAL mode, workspace root: %s, App root: %s", root_dir, PROJECT_ROOT)
            
            # 创建主文件系统后端（root = 当前请求工作区根）
            default_backend = EnhancedFilesystemBackend(
                root_dir=root_dir,
                virtual_mode=False,
            )
        
        # ============================================================
        # 云端模式：使用 StateBackend 作为临时存储
        # 文件操作通过 MCP 工具代理到本地
        # ============================================================
        else:
            if logger.isEnabledFor(logging.DEBUG):
                logger.debug("[Backend] CLOUD mode, MCP: %s", mcp_server_url)
            
            # 云端使用 StateBackend 作为默认后端
            # 实际文件操作通过 MCP 工具完成
            from deepagents.backends import StateBackend
            default_backend = StateBackend()
        
        # ============================================================
        # 创建知识库后端（使用统一路径）
        # ============================================================
        knowledge_backend = EnhancedFilesystemBackend(
            root_dir=str(KB_PATH),
            virtual_mode=False,
        )
        _debug_print(f"📚 [Backend] Knowledge base: {KB_PATH}")
        
        # ============================================================
        # 使用 CompositeBackend 实现混合存储
        # ============================================================
        routes = {
            # 知识库路由（指向应用根的 knowledge_base/）
            "knowledge_base/": knowledge_backend,
            "/knowledge_base/": knowledge_backend,
        }
        # 上传目录路由（请求级：当前请求工作区下的 uploads/，与 default_backend 一致）
        _uploads_root = _request_workspace_root / "uploads"
        if _uploads_root.exists():
            uploads_backend = EnhancedFilesystemBackend(root_dir=str(_uploads_root), virtual_mode=True)
            routes[str(_uploads_root) + "/"] = uploads_backend
        
        # 如果启用了 Store，添加持久化路由
        if store is not None:
            store_backend = StoreBackend(runtime)
            routes.update({
                # 持久化路由（跨会话保持）
                "/memories/": store_backend,      # 长期记忆
                "/cache/": store_backend,         # 缓存数据
                "/user_profiles/": store_backend, # 用户配置
                # 注意：/.maibot/ 下的项目记忆由文件系统维护，便于人工查看和编辑
            })
        
        return CompositeBackend(
            default=default_backend,
            routes=routes,
        )
    
 # Orchestrator 工具配置
    # 
    # DeepAgent 中间件自动提供：
    # - task: 子代理委派（SubAgentMiddleware）
    # - ls, read_file, write_file, edit_file, glob, grep（FilesystemMiddleware，共 6 个）
    # - write_todos: 任务跟踪（TodoListMiddleware）
    #
    # Orchestrator 补充工具（Skills 工具名与 validate_skills 校验一致，配置可覆盖）
    orchestrator_core_tool_names = _load_core_tool_names()
    orchestrator_advanced_tool_names = _load_orchestrator_advanced_tool_names()
    orchestrator_skill_tool_names = _load_orchestrator_skill_tool_names()
    plugin_tool_names: list[str] = []
    plugin_middleware_names: list[str] = []
    plugin_skill_paths: list[str] = []
    plugin_prompt_overlays: dict[str, str] = {}
    plugin_agents: list[str] = []
    plugin_hooks: list[str] = []
    plugin_mcp_configs: list[str] = []
    try:
        from backend.engine.plugins import PluginLoader

        license_profile = _load_runtime_license_profile()
        installed_plugin_names = _load_plugins_state_names()
        session_plugin_names = configurable.get("session_plugins") if isinstance(configurable.get("session_plugins"), list) else []
        if session_plugin_names:
            session_set = {str(x).strip() for x in session_plugin_names if str(x).strip()}
            installed_plugin_names = [x for x in installed_plugin_names if x in session_set]
        if not installed_plugin_names:
            raise RuntimeError("no_plugins_enabled")

        # 插件加载热点缓存：同一插件集/授权组合在短时间内复用，降低每轮冷解析开销。
        _plugin_cache_ttl_s = 30.0
        _plugin_cache_key = (
            "_plugin_runtime_cache",
            tuple(sorted(str(x).strip() for x in installed_plugin_names if str(x).strip())),
            tuple(sorted(str(x).strip() for x in session_plugin_names if str(x).strip())),
            json.dumps(license_profile, ensure_ascii=False, sort_keys=True),
        )
        _plugin_cached_payload = None
        with _middleware_singletons_lock:
            _plugin_cached_payload = _middleware_singletons.get(_plugin_cache_key)
        if (
            isinstance(_plugin_cached_payload, tuple)
            and len(_plugin_cached_payload) == 2
            and (time.monotonic() - float(_plugin_cached_payload[0] or 0.0)) < _plugin_cache_ttl_s
        ):
            _plugin_payload = _plugin_cached_payload[1]
            if isinstance(_plugin_payload, dict):
                plugin_tool_names = list(_plugin_payload.get("tool_names", []) or [])
                plugin_middleware_names = list(_plugin_payload.get("middleware_names", []) or [])
                plugin_skill_paths = list(_plugin_payload.get("skill_paths", []) or [])
                plugin_prompt_overlays = dict(_plugin_payload.get("prompt_overlays", {}) or {})
                plugin_agents = list(_plugin_payload.get("agents", []) or [])
                plugin_hooks = list(_plugin_payload.get("hooks", []) or [])
                plugin_mcp_configs = list(_plugin_payload.get("mcp", []) or [])
        else:
            plugin_loader = PluginLoader(
                project_root=PROJECT_ROOT,
                profile=license_profile,
            )
            for plugin_name in installed_plugin_names:
                try:
                    plugin_loader.load(plugin_name)
                except Exception as e:
                    logger.debug("[PluginLoader] 跳过插件 %s: %s", plugin_name, e)
            loaded_specs = plugin_loader.list_loaded()
            plugin_skill_paths = plugin_loader.get_active_skill_paths()
            plugin_prompt_overlays = plugin_loader.get_active_prompt_overlays()
            plugin_agents = plugin_loader.get_active_agents()
            plugin_hooks = plugin_loader.get_active_hooks()
            plugin_mcp_configs = plugin_loader.get_active_mcp_configs()
            for spec in loaded_specs:
                components = spec.components or {}
                tools = components.get("tools")
                mids = components.get("middleware")
                if isinstance(tools, list):
                    plugin_tool_names.extend([str(x).strip() for x in tools if str(x).strip() and str(x).strip() != "*"])
                if isinstance(mids, list):
                    plugin_middleware_names.extend([str(x).strip() for x in mids if str(x).strip() and str(x).strip() != "*"])
            with _middleware_singletons_lock:
                _middleware_singletons[_plugin_cache_key] = (
                    time.monotonic(),
                    {
                        "tool_names": list(plugin_tool_names),
                        "middleware_names": list(plugin_middleware_names),
                        "skill_paths": list(plugin_skill_paths),
                        "prompt_overlays": dict(plugin_prompt_overlays),
                        "agents": list(plugin_agents),
                        "hooks": list(plugin_hooks),
                        "mcp": list(plugin_mcp_configs),
                    },
                )

        if plugin_prompt_overlays:
            configurable["_active_plugin_prompt_overlays"] = plugin_prompt_overlays
        if plugin_agents:
            configurable["_active_plugin_agents"] = plugin_agents
        if plugin_hooks:
            configurable["_active_plugin_hooks"] = plugin_hooks
        if plugin_mcp_configs:
            configurable["_active_plugin_mcp_configs"] = plugin_mcp_configs
        try:
            from backend.engine.plugins.runtime_events import append_plugin_runtime_event

            append_plugin_runtime_event(
                PROJECT_ROOT,
                "plugin_runtime_activated",
                {
                    "installed_plugins": installed_plugin_names,
                    "tool_count": len(plugin_tool_names),
                    "middleware_count": len(plugin_middleware_names),
                    "agents": len(plugin_agents),
                    "hooks": len(plugin_hooks),
                    "mcp": len(plugin_mcp_configs),
                },
            )
        except Exception:
            pass
        if logger.isEnabledFor(logging.DEBUG):
            logger.debug(
                "[PluginLoader] 已加载插件=%s 额外工具=%s 额外中间件=%s",
                installed_plugin_names,
                plugin_tool_names,
                plugin_middleware_names,
            )
    except Exception as e:
        if str(e) != "no_plugins_enabled":
            logger.debug("[PluginLoader] 集成失败，回退默认能力: %s", e)

    _orc_mode = str(configurable.get("mode") or "agent").strip()
    _orc_skill_profile = _resolve_skill_profile(configurable)
    orchestrator_tools = get_tools(
        [
            *orchestrator_core_tool_names,
            *orchestrator_advanced_tool_names,
            *orchestrator_skill_tool_names,  # 发现、匹配、执行 Skill（渐进式加载）
            *plugin_tool_names,
        ],
        mode=_orc_mode,
        skill_profile=_orc_skill_profile,
    )
    # 工具分层：核心工具组优先暴露（默认 <=16），扩展工具默认延迟为“仅描述”。
    _tool_core_max = max(8, int(configurable.get("tool_core_max") or os.getenv("TOOL_CORE_MAX", "16") or 16))
    _tool_extension_schema_mode = str(
        configurable.get("tool_extension_schema_mode")
        or os.getenv("TOOL_EXTENSION_SCHEMA_MODE", "deferred")
        or "deferred"
    ).strip().lower()
    _core_tool_priority = [
        "search_memory",
        "search_memory_by_category",
        "search_learning_experience",
        "search_knowledge",
        "read_file",
        "batch_read_files",
        "glob",
        "grep",
        "think_tool",
        "web_search",
        "web_fetch",
        "edit_file",
        "write_file",
        "write_file_binary",
        "python_run",
        "shell_run",
        "ask_user",
        "task",
        "manage_memory",
        "get_skill_info",
        "list_skills",
        "enter_plan_mode",
        "exit_plan_mode",
    ]
    _core_tool_priority_set = set(_core_tool_priority)

    def _dedupe_tools_keep_order(tools: list[Any]) -> list[Any]:
        deduped: list[Any] = []
        seen: set[str] = set()
        for t in tools:
            name = str(getattr(t, "name", "") or "")
            if not name or name in seen:
                continue
            seen.add(name)
            deduped.append(t)
        return deduped

    def _apply_tool_tiering(tools: list[Any]) -> tuple[list[Any], list[Any]]:
        ordered = _dedupe_tools_keep_order(tools)
        if len(ordered) <= _tool_core_max:
            configurable["_tool_tiering_enabled"] = False
            configurable["_core_tool_names"] = [getattr(t, "name", "") for t in ordered]
            configurable["_extension_tool_names"] = []
            configurable["_tool_schema_deferred"] = False
            return ordered, []
        core: list[Any] = []
        ext: list[Any] = []
        for t in ordered:
            name = str(getattr(t, "name", "") or "")
            (core if name in _core_tool_priority_set else ext).append(t)
        core_names = [str(getattr(t, "name", "") or "") for t in core]
        if len(core) < _tool_core_max:
            remain = _tool_core_max - len(core)
            core.extend(ext[:remain])
            ext = ext[remain:]
        elif len(core) > _tool_core_max:
            ext = core[_tool_core_max:] + ext
            core = core[:_tool_core_max]
        configurable["_tool_tiering_enabled"] = True
        configurable["_core_tool_names"] = [str(getattr(t, "name", "") or "") for t in core]
        configurable["_extension_tool_names"] = [str(getattr(t, "name", "") or "") for t in ext]
        configurable["_tool_schema_deferred"] = _tool_extension_schema_mode == "deferred"
        return core, ext
    # 用户工具开关过滤（来自前端 maibot_tool_toggles）
    tool_toggles = configurable.get("tool_toggles", {}) or {}
    if isinstance(tool_toggles, str):
        try:
            tool_toggles = json.loads(tool_toggles)
        except Exception:
            tool_toggles = {}
    disabled_tools = set()
    if isinstance(tool_toggles, dict):
        disabled_tools = {k for k, v in tool_toggles.items() if v is False and isinstance(k, str)}

    def _filter_disabled_tools(tools: list[Any], stage: str) -> list[Any]:
        if not disabled_tools:
            return tools
        before_count = len(tools)
        filtered = [tool for tool in tools if tool.name not in disabled_tools]
        if logger.isEnabledFor(logging.DEBUG) and before_count != len(filtered):
            logger.debug(
                "[ToolToggles] 阶段=%s 已禁用工具: %s | 过滤后: %s -> %s",
                stage,
                sorted(disabled_tools),
                before_count,
                len(filtered),
            )
        return filtered

    orchestrator_tools = _filter_disabled_tools(orchestrator_tools, "initial")

    # 角色白名单过滤已弃用：统一改为「通用 Agent + Plugin + LicenseGate」模型
    # region agent log
    _agent_debug_log(
        "H9",
        "backend/engine/agent/deep_agent.py:create_orchestrator_agent:orchestrator_tools_initial",
        "initial orchestrator tools",
        {"mode": mode, "tools": [getattr(t, "name", str(t)) for t in orchestrator_tools]},
    )
    # endregion
    
    # 模式工具过滤已移至动态加载后统一执行（避免重复遍历）
    
    def _load_cached_tool_list(cache_key: str, loader, ttl_s: float = 30.0) -> list[Any]:
        now = time.monotonic()
        with _middleware_singletons_lock:
            cached = _middleware_singletons.get(cache_key)
        if (
            isinstance(cached, tuple)
            and len(cached) == 2
            and (now - float(cached[0] or 0.0)) < ttl_s
        ):
            payload = cached[1]
            if isinstance(payload, list):
                return list(payload)
        loaded: list[Any] = []
        try:
            result = loader()
            if isinstance(result, list):
                loaded = list(result)
            elif result:
                loaded = [result]
        except Exception as e:
            logger.warning("[ToolCache] 工具加载失败: %s", e)
            loaded = []
        with _middleware_singletons_lock:
            _middleware_singletons[cache_key] = (now, list(loaded))
        return loaded

 # langmem 记忆工具集成
    # 
    # 功能：
    # - manage_memory: Agent 主动保存重要信息
    # - search_memory: 语义搜索历史记忆（比 Claude memory_tool 更强）
    # 
    # 与 Claude 的差异：
    # - Claude memory_tool: 文件操作（view/create/edit/delete）
    # - langmem: 语义搜索（向量检索）
    if Config.ENABLE_LANGMEM:
        try:
            from backend.tools.base.memory_tools import (
                get_memory_tools,
                get_shared_memory_tools,
                is_langmem_available,
            )
            if is_langmem_available():
                memory_tools = _load_cached_tool_list("langmem_tools_cache", get_memory_tools, ttl_s=30.0)
                if memory_tools:
                    orchestrator_tools = orchestrator_tools + memory_tools
                    if logger.isEnabledFor(logging.DEBUG):
                        logger.debug("[Memory] 已加载 %s 个 langmem 工具", len(memory_tools))
                # Phase 2: 组织共享记忆（默认关闭，按环境变量启用）
                if os.getenv("ENABLE_SHARED_LANGMEM", "false").lower() == "true":
                    shared_memory_tools = _load_cached_tool_list(
                        "shared_langmem_tools_cache",
                        get_shared_memory_tools,
                        ttl_s=30.0,
                    )
                    if shared_memory_tools:
                        orchestrator_tools = orchestrator_tools + shared_memory_tools
                        if logger.isEnabledFor(logging.DEBUG):
                            logger.debug("[Memory] 已加载 %s 个共享记忆工具", len(shared_memory_tools))
        except ImportError as e:
            if logger.isEnabledFor(logging.DEBUG):
                logger.debug("[Memory] langmem 模块导入失败: %s", e)
        except Exception as e:
            if logger.isEnabledFor(logging.DEBUG):
                logger.debug("[Memory] langmem 工具加载失败: %s", e)
    
    # ============================================================
    # 任务看板工具（Phase 2：Store 共享看板，多 Thread 协作）
    # 看板是数据不是 Agent；独立运行时 Store 由 main_graph 注入
    # ============================================================
    try:
        from backend.tools.base.task_board_tools import get_task_board_tools
        board_tools = _load_cached_tool_list("task_board_tools_cache", get_task_board_tools, ttl_s=30.0)
        if board_tools:
            orchestrator_tools = orchestrator_tools + board_tools
            if logger.isEnabledFor(logging.DEBUG):
                logger.debug("[TaskBoard] 已加载 %s 个看板工具", len(board_tools))
    except ImportError as e:
        if logger.isEnabledFor(logging.DEBUG):
            logger.debug("[TaskBoard] 看板工具导入失败: %s", e)
    except Exception as e:
        if logger.isEnabledFor(logging.DEBUG):
            logger.debug("[TaskBoard] 看板工具加载失败: %s", e)

    # ============================================================
    # 人类检查点工具（到达检查点时暂停并请求人工审核）
    # ============================================================
    try:
        def _load_human_checkpoint_tools():
            from backend.tools.base.human_checkpoint import request_human_review
            return [request_human_review]
        checkpoint_tools = _load_cached_tool_list(
            "human_checkpoint_tools_cache",
            _load_human_checkpoint_tools,
            ttl_s=60.0,
        )
        if checkpoint_tools:
            orchestrator_tools = orchestrator_tools + checkpoint_tools
        if logger.isEnabledFor(logging.DEBUG):
            logger.debug("[HumanCheckpoint] 已加载 request_human_review")
    except ImportError as e:
        if logger.isEnabledFor(logging.DEBUG):
            logger.debug("[HumanCheckpoint] 导入失败: %s", e)
    except Exception as e:
        if logger.isEnabledFor(logging.DEBUG):
            logger.debug("[HumanCheckpoint] 加载失败: %s", e)
    
    # MCP 工具集成（通过 MCPMiddleware 管理连接与动态工具加载）
    mcp_middleware = None
    try:
        from backend.engine.middleware.mcp_middleware import MCPMiddleware

        with _middleware_singletons_lock:
            mcp_middleware = _middleware_singletons.get("mcp")
            if mcp_middleware is None:
                mcp_middleware = MCPMiddleware()
                _middleware_singletons["mcp"] = mcp_middleware
        mcp_tools = mcp_middleware.tools
        if mcp_tools:
            orchestrator_tools = orchestrator_tools + mcp_tools
            if logger.isEnabledFor(logging.DEBUG):
                logger.debug("[MCPMiddleware] 已加载 %s 个 MCP 工具", len(mcp_tools))
    except Exception as e:
        logger.warning("MCPMiddleware 初始化失败: %s", e)

    # 统一二次过滤：确保动态追加工具也遵守 mode 与 tool_toggles
    _before_count = len(orchestrator_tools)
    if mode != "agent" and mode_config.allowed_tools:
        orchestrator_tools = [
            tool for tool in orchestrator_tools
            if is_tool_allowed(mode, tool.name)
        ]
    # Plan 工具对齐 Claude：enter 仅在 agent；exit 仅在 plan。
    if mode == "agent":
        orchestrator_tools = [tool for tool in orchestrator_tools if tool.name != "exit_plan_mode"]
    elif mode == "plan":
        orchestrator_tools = [tool for tool in orchestrator_tools if tool.name != "enter_plan_mode"]
    else:
        orchestrator_tools = [
            tool for tool in orchestrator_tools
            if tool.name not in {"enter_plan_mode", "exit_plan_mode"}
        ]
    # 联网开关：未开启时移除 web_search/web_fetch，避免模型误用
    _cfg = configurable if isinstance(configurable, dict) else {}
    if not _cfg.get("web_search_enabled", False):
        orchestrator_tools = [
            t for t in orchestrator_tools
            if getattr(t, "name", "") not in ("web_search", "web_fetch")
        ]
    orchestrator_tools = _filter_disabled_tools(orchestrator_tools, "post_dynamic_load")
    if logger.isEnabledFor(logging.DEBUG) and _before_count != len(orchestrator_tools):
        logger.debug(
            "[ToolFilterFinal] 动态加载后统一过滤: %s -> %s（mode=%s）",
            _before_count,
            len(orchestrator_tools),
            mode,
        )
    # 去重与分层：_apply_tool_tiering 内通过 _dedupe_tools_keep_order 按工具名去重，保证同一工具名只保留首次出现
    _core_tools, _extension_tools = _apply_tool_tiering(orchestrator_tools)
    if bool(_cfg.get("_tool_schema_deferred")):
        # 仅注入核心工具 schema；扩展工具默认 description-only。
        # 若本轮明确请求了少量扩展工具，则按需激活（最多 2 个），避免全量 schema 注入。
        _requested_ext_names = _resolve_requested_extension_tools(configurable if isinstance(configurable, dict) else _cfg, _extension_tools)
        _activated_ext_tools: list[Any] = []
        if _requested_ext_names:
            _requested_set = set(_requested_ext_names)
            _activated_ext_tools = [
                t for t in _extension_tools
                if str(getattr(t, "name", "") or "") in _requested_set
            ][:2]
        _activated_set = {str(getattr(t, "name", "") or "") for t in _activated_ext_tools}
        _remaining_extensions = [
            t for t in _extension_tools
            if str(getattr(t, "name", "") or "") not in _activated_set
        ]
        orchestrator_tools = list(_core_tools) + list(_activated_ext_tools)
        configurable["_activated_extension_tool_names"] = sorted(_activated_set)
        configurable["_extension_tool_names"] = [
            str(getattr(t, "name", "") or "") for t in _remaining_extensions
        ]
    else:
        orchestrator_tools = list(_core_tools) + list(_extension_tools)
    
    # ============================================================
    # Skills 配置（Claude Agent Skills 设计）
    # 
    # 工作机制：
    # - Skills 工具（list_skills/match_skills）+ BUNDLE.md 内联提供能力发现
    # - 模型根据 description 判断何时使用该 Skill
    # - 详细内容通过 read_file("...SKILL.md") 按需加载
    # ============================================================
    # ============================================================
    # Skills 路径配置（支持 Skill Profile 动态加载）
    # 
    # Skills 加载机制（本项目自定义，DeepAgent 无 SkillsMiddleware）：
    # 1. BUNDLE.md 按 skill_profile 内联到系统提示词（能力速查）
    # 2. list_skills/match_skills/get_skill_info 工具按需发现
    # 3. read_file("...SKILL.md") 按需加载详细内容
    # 
    # skill_profile（来自 config.configurable）：full / office / report / research / bidding / contract
    # full 或未指定时使用默认全量路径；其他 profile 使用 skill_profiles.json 子集（document/dev 已弃用并映射）
    # ============================================================
    _default_skills_paths = [
        # Claude 风格：统一扫描内置 skills 根目录
        "knowledge_base/skills/",
        # 学习沉淀
        "knowledge_base/learned/skills/",
    ]
    _default_skills_paths = [p for p in _default_skills_paths if p]
    skill_profile = _cfg.get("skill_profile")
    from backend.engine.skills.skill_profiles import get_skills_paths_for_profile
    skills_paths = get_skills_paths_for_profile(skill_profile, mode, _default_skills_paths)
    if plugin_skill_paths:
        _seen_paths = set(skills_paths)
        for p in plugin_skill_paths:
            if p and p not in _seen_paths:
                skills_paths.append(p)
                _seen_paths.add(p)
    
 # Memory 配置（Claude 四层记忆架构）
    # 
    # Layer 0: 系统提示词（system_prompt）
    # Layer 1: 项目记忆（CLAUDE.md 风格）
    # Layer 2: 对话历史（自动管理）
    # Layer 3: 当前消息
    # 
    # 记忆层级（按优先级）：
    # 1. .maibot/MAIBOT.md - 项目级记忆（团队共享）
    # 2. .maibot/rules/*.md - 模块化规则（按需加载）
    # 3. .maibot/local/* - 个人偏好（不提交）
    # 使用本请求的 workspace_path 计算记忆路径，避免缓存复用时加载错工作区记忆目录
    _wp = _cfg.get("workspace_path") or ""
    _workspace_root = Path(_wp).resolve() if _wp and Path(_wp).is_dir() else get_workspace_root()
    memory_paths = _get_memory_paths(workspace_root=_workspace_root)
    _create_agent_params = inspect.signature(create_deep_agent).parameters
    _supports_native_skills = "skills" in _create_agent_params
    _supports_native_memory = "memory" in _create_agent_params
    _prefer_native_skills_memory = str(
        configurable.get("prefer_native_skills_memory", os.getenv("PREFER_NATIVE_SKILLS_MEMORY", "true"))
    ).strip().lower() in {"1", "true", "yes", "on"}
    
 # HumanInTheLoop 配置：需审批工具在聊天区展示 diff/预览 + 接受/拒绝；自治等级与 auto_accept_tools 决定是否中断
    # ============================================================
    interrupt_tool_names = _load_human_interrupt_tool_names()
    try:
        from backend.engine.autonomy.levels import get_autonomy_settings
        settings = get_autonomy_settings()
        auto_accept = set(settings.get("auto_accept_tools") or [])
        level = str(settings.get("level") or "L1").upper()
        # 从配置的 interrupt 列表中剔除「默认接受」的工具
        interrupt_tool_names = [t for t in interrupt_tool_names if t not in auto_accept]
        # L2/L3：仅 shell_run、python_run 等高风险需确认；文件类不中断
        if level in ("L2", "L3"):
            file_tools = {"write_file", "edit_file", "delete_file", "write_file_binary"}
            interrupt_tool_names = [t for t in interrupt_tool_names if t in ("shell_run", "python_run") or t not in file_tools]
    except Exception as e:
        logger.debug("autonomy settings for interrupt filter: %s", e)
    interrupt_config = {name: True for name in interrupt_tool_names}
    
    # ============================================================
    # 额外中间件
    #
    # DeepAgent 0.3.0 自动加载（不要重复添加）：
    # - TodoListMiddleware: write_todos 工具 + 用法说明注入
    # - FilesystemMiddleware: ls/read_file/write_file/edit_file/glob/grep + 用法说明注入
    # - SubAgentMiddleware: task 工具 + 用法说明注入（含 general-purpose 子代理）
    # - SummarizationMiddleware: 自动上下文压缩
    #   · model.profile 有 max_input_tokens → fraction 模式（85% 触发，保留 10%）
    #   · model.profile 无 max_input_tokens → 绝对值模式（170K tokens 触发，保留 6 条消息）
    # - AnthropicPromptCachingMiddleware: Anthropic 缓存（非 Anthropic 模型自动忽略）
    # - PatchToolCallsMiddleware: 修复悬空工具调用（before_agent 阶段）
    #   · 适用所有工具（ls/read_file/task/python_run/shell_run/think_tool 等）
    #   · 当 AIMessage 含有 tool_calls 但后续没有对应 tool_call_id 的 ToolMessage 时，
    #     补一条「已取消」的 ToolMessage，保证 messages 序列一致，避免模型看到半截对话
    #   · 典型场景：用户中途发新消息、或 interrupt 导致某次工具调用未执行
    #
    # 我们额外添加的（不与 DeepAgent 重复）：
    # - ModelCallLimitMiddleware / ToolCallLimitMiddleware: 限流保护
    # - ToolRetryMiddleware / ModelRetryMiddleware: 重试机制
    # - inject_runtime_context: @dynamic_prompt 动态用户/persona/提醒（最内层，已合并原 inject_user_context）
    #
    # 已移除：
    # - FilesystemFileSearchMiddleware: 与 DeepAgent 的 glob/grep 重复
    # - UserContextMiddleware: 已用 @dynamic_prompt inject_runtime_context 替代
    #
    # 注意：create_deep_agent 已支持 skills/memory 参数（SkillsMiddleware/MemoryMiddleware），
    # 当前 Skills 通过 BUNDLE.md 内联，Memory 通过 _load_memory_content() 拼接到 system_prompt。
    # 后续可考虑迁移到原生 skills/memory 参数。
    # ============================================================
    from langchain.agents.middleware import (
        ContextEditingMiddleware,
        HumanInTheLoopMiddleware,
        ToolRetryMiddleware,
        ModelRetryMiddleware,
        ModelCallLimitMiddleware,
        ToolCallLimitMiddleware,
        LLMToolSelectorMiddleware,
        ModelFallbackMiddleware,
        PIIMiddleware,
    )
    from backend.engine.middleware.diff_approval_middleware import DiffAwareHumanInTheLoopMiddleware
    from backend.engine.middleware.content_fix_middleware import ContentFixMiddleware
    from backend.engine.middleware.cloud_call_gate_middleware import CloudCallGateMiddleware
    from backend.engine.middleware.license_gate_middleware import LicenseGateMiddleware
    from backend.engine.middleware.mode_permission_middleware import ModePermissionMiddleware
    from backend.engine.middleware.execution_trace_middleware import ExecutionTraceMiddleware
    from backend.engine.middleware.scheduling_guard_middleware import SchedulingGuardMiddleware

    def _optional_middleware_instance(module_path: str, class_name: str, **kwargs):
        cache_key = f"{module_path}.{class_name}"
        with _middleware_singletons_lock:
            cached = _middleware_singletons.get(cache_key)
            if cached is not None:
                return cached
            try:
                module = __import__(module_path, fromlist=[class_name])
                cls = getattr(module, class_name, None)
                if cls is None:
                    return None
                inst = cls(**kwargs)
                _middleware_singletons[cache_key] = inst
                return inst
            except Exception as e:
                logger.warning(
                    "可选中间件加载失败: %s.%s (%s)",
                    module_path,
                    class_name,
                    getattr(e, "message", str(e))[:200],
                    exc_info=False,
                )
                return None

    class _AsyncAfterAgentMiddleware(AgentMiddleware):
        """仅将 after_agent 后处理异步化，不影响 wrap_model_call。"""

        _label = "after_agent"

        def __init__(self, inner: AgentMiddleware):
            super().__init__()
            self._inner = inner

        def __getattr__(self, name: str):
            return getattr(self._inner, name)

        def after_agent(self, state, runtime) -> dict[str, Any] | None:
            result = None
            try:
                result = self._inner.after_agent(state, runtime)
            except Exception as e:
                logger.debug("[%s] after_agent 执行失败: %s", self._label, e)
            return result

    class _AsyncSkillEvolutionMiddleware(_AsyncAfterAgentMiddleware):
        _label = "skill_evolution"

    class _AsyncSelfImprovementMiddleware(_AsyncAfterAgentMiddleware):
        """自我改进 after_agent 提交到线程池执行，主链不等待，避免阻塞。"""
        _label = "self_improvement"

        def after_agent(self, state, runtime) -> dict[str, Any] | None:
            def _run() -> None:
                try:
                    self._inner.after_agent(state, runtime)
                except Exception as e:
                    logger.debug("[self_improvement] after_agent 执行失败（后台）: %s", e)

            _after_agent_async_executor.submit(_run)
            return None  # 不阻塞主链，不写回 state

    class _AsyncDistillationMiddleware(_AsyncAfterAgentMiddleware):
        _label = "distillation"

    def _wrap_after_agent_async(name: str, inst: AgentMiddleware | None) -> AgentMiddleware | None:
        if inst is None:
            return None
        if name == "skill_evolution":
            return _AsyncSkillEvolutionMiddleware(inst)
        if name == "self_improvement":
            return _AsyncSelfImprovementMiddleware(inst)
        if name == "distillation":
            return _AsyncDistillationMiddleware(inst)
        return inst

    # ============================================================
    # 额外中间件配置
    #
    # 中间件执行顺序（洋葱模型，列表第一个=最外层）：
    # [DeepAgent 内置] TodoList → Filesystem → SubAgent → Summarization → PromptCaching → PatchToolCalls
    # [我们添加的]    ContextEditing → HumanInTheLoop → ModePermission → ContentFix → Ontology
    #                 → CloudCallGate → LicenseGate → Reflection → LLMToolSelector → ModelFallback
    #                 → PII*N → MCP → SkillEvolution → SelfImprovement → Distillation
    #                 → Model/Tool Limits → Retries → dynamic_prompt hooks（persona/user/wal/...）
    #                 → ExecutionTrace(可选，ENV: ENABLE_MIDDLEWARE_TRACE=true)
    # ============================================================
    _fallback_llm = None
    policy = manager.get_escalation_policy() or {}
    try:
        configurable.setdefault("budget_max_usd", float(policy.get("max_budget_per_task_usd", 0.0) or 0.0))
    except Exception:
        configurable.setdefault("budget_max_usd", 0.0)
    if policy.get("enabled", False):
        _fallback_model = manager.get_fallback_model_for(model_id)
        if _fallback_model:
            try:
                _fallback_llm = manager.create_llm(
                    config={"configurable": {"model": _fallback_model}},
                    task_type="default",
                )
            except Exception as e:
                logger.warning("[deep_agent] fallback LLM 初始化失败: %s", e)

    def _get_singleton(key: str, factory):
        with _middleware_singletons_lock:
            if key in _middleware_singletons:
                return _middleware_singletons[key]
        new_inst = factory()
        with _middleware_singletons_lock:
            return _middleware_singletons.setdefault(key, new_inst)

    from backend.engine.middleware.streaming_middleware import StreamingMiddleware

    middleware_candidates = {
        "streaming": _get_singleton("streaming", StreamingMiddleware),
        "context_editing": _get_singleton("context_editing", ContextEditingMiddleware),
        "context_guard": _get_singleton(
            "context_guard",
            lambda: __import__("backend.engine.middleware.context_guard_middleware", fromlist=["ContextGuardMiddleware"]).ContextGuardMiddleware(),
        ),
        "human_in_the_loop": DiffAwareHumanInTheLoopMiddleware(interrupt_on=interrupt_config),
        "execution_trace": _get_singleton("execution_trace", ExecutionTraceMiddleware),
        "mode_permission": _get_singleton("mode_permission", ModePermissionMiddleware),
        "content_fix": _get_singleton("content_fix", ContentFixMiddleware),
        "ontology_context": _optional_middleware_instance(
            "backend.engine.middleware.ontology_middleware",
            "OntologyContextMiddleware",
        ),
        "cloud_call_gate": _get_singleton("cloud_call_gate", CloudCallGateMiddleware),
        "license_gate": _get_singleton("license_gate", LicenseGateMiddleware),
        "reflection": _optional_middleware_instance(
            "backend.engine.middleware.reflection_middleware",
            "ReflectionMiddleware",
            every_n_tool_calls=max(1, int(os.getenv("REFLECTION_EVERY_N_TOOL_CALLS", "5"))),
        ),
        "llm_tool_selector": LLMToolSelectorMiddleware(max_tools=_tool_core_max) if bool(configurable.get("_tool_tiering_enabled")) else None,
        "model_fallback": ModelFallbackMiddleware(_fallback_llm) if _fallback_llm else None,
        "pii_redact": _get_singleton("pii_redact", lambda: PIIMiddleware("email", strategy="redact", apply_to_input=True, apply_to_output=True, apply_to_tool_results=True)),
        "mcp": mcp_middleware,
        "skill_evolution": _wrap_after_agent_async(
            "skill_evolution",
            _optional_middleware_instance(
                "backend.engine.middleware.skill_evolution_middleware",
                "SkillEvolutionMiddleware",
            ),
        ),
        "self_improvement": _wrap_after_agent_async(
            "self_improvement",
            _optional_middleware_instance(
                "backend.engine.middleware.self_improvement_middleware_v10",
                "SelfImprovementMiddlewareV10",
            ),
        ),
        "distillation": _wrap_after_agent_async(
            "distillation",
            _optional_middleware_instance(
                "backend.engine.middleware.distillation_middleware",
                "DistillationMiddleware",
            ),
        ),
        "scheduling_guard": _get_singleton("scheduling_guard", SchedulingGuardMiddleware),
        "model_call_limit": _get_singleton("model_call_limit", lambda: ModelCallLimitMiddleware(run_limit=Config.MODEL_CALL_LIMIT)),
        "tool_call_limit": _get_singleton("tool_call_limit", lambda: ToolCallLimitMiddleware(run_limit=Config.TOOL_CALL_LIMIT)),
        "tool_retry": _get_singleton("tool_retry", lambda: ToolRetryMiddleware(max_retries=Config.TOOL_MAX_RETRIES)),
        "model_retry": _get_singleton("model_retry", lambda: ModelRetryMiddleware(max_retries=Config.MODEL_MAX_RETRIES)),
        # dynamic_prompt hook, not AgentMiddleware; runs at model call time to append system fragment.
        "inject_runtime_context": inject_runtime_context,
    }
    # 使用本项目的 DiffAwareHumanInTheLoopMiddleware（带 diff/preview），不传 interrupt_on 给 create_deep_agent 以免重复 HITL
    middleware_chain = _load_middleware_chain(mode)
    # 兼容旧配置：多个 inject_* 中间件已合并为 inject_runtime_context。
    _runtime_inject_legacy = {
        "inject_runtime_context",
        "inject_user_context",
        "inject_persona_context",
        "inject_wal_reminder",
        "inject_learnings_reminder",
        "inject_proactive_reminder",
        "inject_context_budget",
    }
    _normalized_chain: list[str] = []
    _runtime_inject_added = False
    for _name in middleware_chain:
        if _name in _runtime_inject_legacy:
            if logger.isEnabledFor(logging.DEBUG):
                logger.debug("Legacy inject name \"%s\" normalized to inject_runtime_context.", _name)
            if not _runtime_inject_added:
                _normalized_chain.append("inject_runtime_context")
                _runtime_inject_added = True
            continue
        _normalized_chain.append(_name)
    middleware_chain = _normalized_chain
    # 中间件分层：core 严格控制在 5-7 个，optional 按模式/角色启用。
    middleware_profile = str(os.getenv("MIDDLEWARE_PROFILE", "core")).strip().lower()
    active_role_id = str(
        configurable.get("active_role_id")
        or configurable.get("role_id")
        or ""
    ).strip().lower()
    active_skill_profile = str(configurable.get("skill_profile") or "").strip().lower()
    # 核心链路：安全/稳定守卫 + 流式与运行时注入（始终保留，避免 MIDDLEWARE_PROFILE=core 时误删）。新增中间件时须同步更新此处与 middleware_chain.json。
    core_middleware = {
        "mode_permission",
        "content_fix",
        "cloud_call_gate",
        "license_gate",
        "model_call_limit",
        "tool_call_limit",
        "inject_runtime_context",
        "streaming",
    }
    optional_middleware = {
        "execution_trace",
        "context_editing",
        "context_guard",
        "human_in_the_loop",
        "ontology_context",
        "reflection",
        "llm_tool_selector",
        "model_fallback",
        "pii_redact",
        "mcp",
        "skill_evolution",
        "self_improvement",
        "distillation",
        "scheduling_guard",
        "tool_retry",
        "model_retry",
    }
    if middleware_profile != "full":
        optional_enabled: set[str] = set()
        # core 档默认只保留必要可观测与只读增强，重型能力按需开启。
        if mode in {"debug", "review"}:
            optional_enabled.update({"execution_trace", "context_editing"})
        if mode in {"agent", "plan", "ask"} and str(os.getenv("ENABLE_CONTEXT_GUARD", "true")).strip().lower() in ("1", "true", "yes", "on"):
            optional_enabled.add("context_guard")
        if mode in {"agent", "plan", "debug"} and str(
            os.getenv("ENABLE_MCP_IN_CORE_PROFILE", "true")
        ).strip().lower() in {"1", "true", "yes", "on"}:
            optional_enabled.add("mcp")
        if mode in {"agent", "plan", "debug", "review"} and str(
            os.getenv("ENABLE_REFLECTION_IN_CORE_PROFILE", "false")
        ).strip().lower() in {"1", "true", "yes", "on"}:
            optional_enabled.add("reflection")
        if mode in {"agent", "debug"} and str(
            os.getenv("ENABLE_PII_REDACT_IN_CORE_PROFILE", "false")
        ).strip().lower() in {"1", "true", "yes", "on"}:
            optional_enabled.add("pii_redact")
        if str(os.getenv("ENABLE_MIDDLEWARE_TRACE", "false")).strip().lower() in {"1", "true", "yes", "on"}:
            optional_enabled.add("execution_trace")
        # 计划/审查模式可选启用工具选择与模型回退。
        if mode in {"plan", "review"}:
            optional_enabled.update({"llm_tool_selector", "model_fallback"})
        if mode == "agent" and str(
            os.getenv("ENABLE_RETRY_MIDDLEWARE_IN_CORE_PROFILE", "false")
        ).strip().lower() in {"1", "true", "yes", "on"}:
            optional_enabled.update({"tool_retry", "model_retry"})
        # 知识/自治增强默认关闭，避免主链路增重。
        # 知识构建角色或知识型 profile 开启本体和进化类中间件。
        if (
            str(os.getenv("ENABLE_KNOWLEDGE_MIDDLEWARE", "false")).strip().lower()
            in {"1", "true", "yes", "on"}
        ) and (
            active_role_id in {"engineer", "knowledge_builder"} or active_skill_profile in {
                "knowledge",
                "knowledge_engineering",
                "sales",
            }
        ):
            optional_enabled.update(
                {"ontology_context", "skill_evolution", "distillation", "self_improvement"}
            )
        if bool(configurable.get("_tool_tiering_enabled")):
            optional_enabled.add("llm_tool_selector")
        middleware_chain = [
            name
            for name in middleware_chain
            if (
                (name in core_middleware)
                or (name in optional_middleware and name in optional_enabled)
                or (name not in optional_middleware and name not in core_middleware)
            )
        ]
    if plugin_middleware_names:
        existing = set(middleware_chain)
        middleware_chain.extend([name for name in plugin_middleware_names if name not in existing])
    try:
        from backend.engine.license.tier_service import is_middleware_allowed

        license_profile = _load_runtime_license_profile()
        middleware_chain = [
            name for name in middleware_chain
            if is_middleware_allowed(name, license_profile)
        ]
    except Exception as e:
        logger.debug("middleware tier 过滤失败，使用原链路: %s", e)
    additional_middleware = [middleware_candidates.get(name) for name in middleware_chain]
    additional_middleware = [m for m in additional_middleware if m is not None]
    # 兜底去重：按中间件类型去重，避免配置重复或动态拼接导致冲突
    _deduped_middleware = []
    _seen_middleware_types = set()
    for _mw in additional_middleware:
        _mw_key = type(_mw).__qualname__
        if _mw_key in _seen_middleware_types:
            logger.warning("[MiddlewareChain] 检测到重复中间件，已跳过: %s", _mw_key)
            continue
        _seen_middleware_types.add(_mw_key)
        _deduped_middleware.append(_mw)
    additional_middleware = _deduped_middleware
    
    # ============================================================
    # 模式特定配置
    # ============================================================
    # SubAgent 配置（需在提示词组装前创建，以便动态注入 SubAgent 信息）
    # Ask 模式保留只读探索所需子代理：explore-agent + general-purpose
    if mode == "ask":
        ask_subagents = create_subagent_configs(prompt_cfg, config, mode=mode)
        ask_keep = {"general-purpose", "explore-agent"}
        subagent_configs = [
            s for s in ask_subagents
            if str(s.get("name", "")).strip() in ask_keep
        ]
        prompt_subagent_configs = subagent_configs
    else:
        subagent_configs = create_subagent_configs(prompt_cfg, config, mode=mode)
        prompt_subagent_configs = subagent_configs
    
    # 使用模式配置的系统提示词（传入运行时数据：工具列表、SubAgent 配置、模型类型）
    system_prompt = get_orchestrator_prompt(
        prompt_cfg, mode=mode,
        tool_names=[t.name for t in orchestrator_tools],
        subagent_configs=prompt_subagent_configs,
        is_reasoning_model=is_reasoning_model,
        enable_distilled_examples=bool(rollout_decision.get("candidate_enabled", True)),
        model_id=str(model_id or ""),
        configurable=configurable,
    )
    _len_orchestrator = len(system_prompt)

    # ============================================================
    # 系统提示词组装（Claude Code 风格：独立段落列表 + 条件化拼接）
    # 
    # 顺序（稳定 → 动态）：
    # 1. orchestrator_prompt: 核心身份 + 行为规则 + 工具策略
    # 2. project_memory: 项目记忆（.maibot/MAIBOT.md + .maibot/rules/*.md）
    # 3. scene_context: 场景身份（skill_profile 非 general/full 时）
    # 4. human_checkpoints: 人类检查点（任务带检查点时）
    # 5. BUNDLE.md: 场景能力速查（按 skill_profile 选择）
    # 6. [create_deep_agent 追加] BASE_AGENT_PROMPT
    # 7. [中间件动态注入] TodoList → Filesystem → SubAgent → inject_runtime_context
    # ============================================================
    _prompt_segments = [system_prompt]  # orchestrator prompt 始终存在
    
    # --- 项目记忆（优先使用 deepagents 原生 memory 参数）---
    _len_memory = 0
    if not (_supports_native_memory and _prefer_native_skills_memory):
        memory_content = _load_memory_content(memory_paths)
        _len_memory = len(memory_content) if memory_content else 0
        if memory_content:
            _prompt_segments.append(memory_content)

    # --- 项目规则（.cursor/rules：alwaysApply / globs / description 智能选取，与 Guardrails 分工）---
    try:
        from backend.engine.prompts.project_rules_loader import get_rules_for_context
        _wp = configurable.get("workspace_path") or ""
        _editor_path = configurable.get("editor_path") or ""
        _open_files = configurable.get("open_files") or []
        _task_type = str(configurable.get("task_type") or "").strip()
        _business_domain = str(configurable.get("business_domain") or configurable.get("workspace_domain") or "").strip()
        _selected_text = (str(configurable.get("selected_text") or "") or "")[:150]
        _query_parts = [p for p in (_task_type, _business_domain, Path(_editor_path).name if _editor_path else "", _selected_text) if p]
        _rules_block = get_rules_for_context(
            workspace_path=_wp or None,
            editor_path=_editor_path or None,
            open_files=_open_files if isinstance(_open_files, list) else None,
            query=" ".join(_query_parts) or None,
            max_rules=6,
            max_total_chars=6000,
        )
        if _rules_block:
            _prompt_segments.append(_rules_block)
    except Exception as _rules_err:
        logger.debug("[ProjectRules] load failed: %s", _rules_err)

    # --- Plan 执行阶段：引用落盘计划文件，保证按 steps/deliverables 执行 ---
    _plan_file_path = str(configurable.get("plan_file_path") or "").strip()
    if _plan_file_path and str(configurable.get("plan_phase") or "").strip().lower() == "execution":
        _prompt_segments.append(
            "<plan_execution>\n"
            f"当前执行计划文件：{_plan_file_path}\n"
            "执行前请先 read_file 读取上述计划文件，再按其中 steps 与 deliverables 逐项执行；不得随意新增文件或跳过已列步骤，若有偏差需在回复中说明。\n"
            "</plan_execution>"
        )

    # --- 延迟工具目录（只注入描述，不注入 schema）---
    _deferred_tool_names = configurable.get("_extension_tool_names") or []
    _activated_tool_names = configurable.get("_activated_extension_tool_names") or []
    if isinstance(_activated_tool_names, list) and _activated_tool_names:
        _active_rows = [f"- {str(name).strip()}" for name in _activated_tool_names if str(name).strip()]
        if _active_rows:
            _prompt_segments.append(
                "<activated_deferred_tools>\n"
                "本回合已按需激活以下扩展工具（schema 已注入）：\n"
                + "\n".join(_active_rows[:8])
                + "\n</activated_deferred_tools>"
            )
    if bool(configurable.get("_tool_schema_deferred")) and isinstance(_deferred_tool_names, list) and _deferred_tool_names:
        _tool_rows = [f"- {str(name).strip()}" for name in _deferred_tool_names if str(name).strip()]
        if _tool_rows:
            _prompt_segments.append(
                "<deferred_tools>\n"
                "以下扩展工具以 description-only 方式注册，用于降低上下文和 schema 负载；"
                "当前回合默认只使用已注入 schema 的核心工具；若用户明确需要，系统会按需激活少量扩展工具。\n"
                + "\n".join(_tool_rows[:24])
                + ("\n- ... 其余扩展工具已省略" if len(_tool_rows) > 24 else "")
                + "\n</deferred_tools>"
            )

    # --- 场景身份（skill_profile 非 general/full 时）---
    _sp = (str(skill_profile) or "").strip().lower()
    _profile_data = {}
    try:
        from backend.engine.skills.skill_profiles import load_profiles
        _profiles = load_profiles()
        _profile_data = _profiles.get("profiles", {}).get(_sp, {})
    except Exception:
        pass
    if _sp and _sp not in ("general", "full", ""):
        _scene_name = _profile_data.get("label") or skill_profile
        _prompt_segments.append(
            f"<scene_context>\n当前场景：{_scene_name}。"
            "请优先使用已发现的相关 Skills，再调用通用工具与 SubAgent。\n</scene_context>"
        )

    # --- 结构化审查策略（由前端设置透传）---
    _review_policy = str(configurable.get("review_policy", "notify") or "notify").lower()
    _effective_review_policy = _review_policy
    if "critic_review" in disabled_tools and _review_policy in ("auto", "gate"):
        _effective_review_policy = "notify"
        logger.warning(
            "[ReviewPolicy] critic_review 已禁用，审查策略从 %s 自动降级为 notify",
            _review_policy,
        )
    if _effective_review_policy in ("notify", "auto", "gate"):
        _policy_text = {
            "notify": "仅提示：关键结论建议调用 critic_review 做结构化审查，不强制阻断流程。",
            "auto": "自动审查：在提交关键结论前，优先调用 critic_review 并按结果修订。",
            "gate": "门禁审查：若 critic_review 发现待补证断言或待验证计算，禁止继续下一步，必须先修订。",
        }[_effective_review_policy]
        _prompt_segments.append(
            f"<review_policy>\n当前审查策略：{_effective_review_policy}\n要求：{_policy_text}\n</review_policy>"
        )
    _review_template = str(configurable.get("review_template", "standard") or "standard").lower()
    _effective_review_template = _review_template
    if "critic_review" in disabled_tools and _review_template == "strict":
        _effective_review_template = "standard"
        logger.warning(
            "[ReviewTemplate] critic_review 已禁用，修订模板从 %s 自动降级为 standard",
            _review_template,
        )
    if _effective_review_template in ("short", "standard", "strict"):
        _template_text = {
            "short": "短版修订：聚焦关键问题，尽快给出可执行修订稿。",
            "standard": "标准修订：覆盖断言与计算问题，保持结论与证据一致。",
            "strict": "严格修订：逐条映射问题-证据-修订动作，未补齐前不得宣称完成。",
        }[_effective_review_template]
        _prompt_segments.append(
            f"<review_template>\n当前修订模板：{_effective_review_template}\n要求：{_template_text}\n</review_template>"
        )

    # --- 人类检查点（任务带 human_checkpoints 时）---
    _board_task = configurable.get("board_task") or {}
    _human_checkpoints = _board_task.get("human_checkpoints") if isinstance(_board_task, dict) else []
    if not _human_checkpoints:
        _human_checkpoints = configurable.get("human_checkpoints") or []
    if _human_checkpoints and isinstance(_human_checkpoints, list):
        try:
            from backend.engine.prompts.agent_prompts import get_human_checkpoints_prompt
            _hc_block = get_human_checkpoints_prompt(_human_checkpoints)
            if _hc_block:
                _prompt_segments.append(_hc_block)
                if logger.isEnabledFor(logging.DEBUG):
                    logger.debug("[HumanCheckpoints] 已注入 %s 个检查点", len(_human_checkpoints))
        except Exception as e:
            if logger.isEnabledFor(logging.DEBUG):
                logger.debug("[HumanCheckpoints] 注入失败: %s", e)

    # --- 任务治理（看板任务时启用）：阻塞上报 + 成果物审计 ---
    try:
        _tool_name_set = {str(getattr(t, "name", "") or "") for t in (orchestrator_tools or [])}
        _has_board_context = bool(
            isinstance(_board_task, dict)
            and (
                str(_board_task.get("task_id") or "").strip()
                or str(_board_task.get("id") or "").strip()
            )
        )
        if _has_board_context and ("report_blocked" in _tool_name_set or "report_artifacts" in _tool_name_set):
            _prompt_segments.append(
                "<task_governance>\n"
                "当前任务绑定看板。执行中请遵循：\n"
                "1) 若因信息缺失/依赖未就绪无法继续，先调用 report_blocked(task_id, reason, missing_info)。\n"
                "2) 阶段完成或任务完成后，调用 report_artifacts(task_id, deliverables, changed_files, rollback_hint) 记录交付物与回滚建议。\n"
                "3) 进度变化继续使用 report_progress，避免无状态长执行。\n"
                "</task_governance>"
            )
    except Exception:
        pass

    # --- 技能速查内联已移除（对齐 Claude：仅依赖 SKILL frontmatter + 按需加载）---
    _skills_description_only = str(
        configurable.get("skills_description_only", os.getenv("SKILLS_DESCRIPTION_ONLY", "true"))
    ).strip().lower() in {"1", "true", "yes", "on"}
    _allowed_skill_paths: Optional[set[str]] = None
    enabled: list = []
    try:
        from backend.engine.skills.skill_registry import get_skill_registry
        _idx = get_skill_registry().build_runtime_index(
            profile=skill_profile,
            mode=mode,
            tier_profile=configurable,
        )
        enabled = [s for s in (_idx.get("skills") or []) if s.get("runtime_enabled")]
        if enabled:
            _allowed_skill_paths = {str(s.get("relative_path", "")).replace("\\", "/").strip().lower() for s in enabled if s.get("relative_path")}
    except Exception:
        pass
    if _skills_description_only:
        _catalog_max_chars = 3500  # 收紧以降低提示词体积，细节按需 get_skill_info
        if enabled:
            _skills_catalog = _build_skills_catalog_from_index(enabled, max_chars=_catalog_max_chars)
        else:
            _skills_catalog = _build_skills_catalog_summary(
                skills_paths,
                allowed_relative_paths=_allowed_skill_paths,
                max_chars=_catalog_max_chars,
            )
        if _skills_catalog:
            _prompt_segments.append(_skills_catalog)
    _len_bundle = 0

    # --- 最终拼接与长度保护（见 orchestrator_prompt_assembly）---
    from backend.engine.agent.orchestrator_prompt_assembly import assemble_system_prompt, DEFAULT_MAX_SYSTEM_PROMPT_CHARS
    system_prompt = assemble_system_prompt(_prompt_segments, max_chars=DEFAULT_MAX_SYSTEM_PROMPT_CHARS)

    # ============================================================
    # 系统提示词结构诊断日志
    # ============================================================
    _total_chars = len(system_prompt)
    _est_tokens = _total_chars // 4
    logger.info(
        "[SystemPrompt] 总长: %d chars (~%dk tokens) | "
        "orchestrator: %d | memory: %d | bundle: %d | mode: %s",
        _total_chars, _est_tokens // 1000,
        _len_orchestrator, _len_memory, _len_bundle, mode,
    )
    if _est_tokens > 20000:
        logger.warning("[SystemPrompt] 估算 ~%dk tokens，可能过长", _est_tokens // 1000)
    if Config.DEBUG:
        _debug_segments = [
            ("orchestrator", _len_orchestrator),
            ("project_memory", _len_memory),
            ("bundle", _len_bundle),
            ("total_assembled", _total_chars),
        ]
        for _seg_name, _seg_len in _debug_segments:
            logger.debug("[SystemPrompt][%s] %d chars", _seg_name, _seg_len)
        
        # 写入临时文件供人工检查（注意：此文件仅在 DEBUG=true 时生成）
        try:
            _dump_dir = WORKSPACE_PATH / "tmp"
            _dump_dir.mkdir(parents=True, exist_ok=True)
            _dump_path = _dump_dir / "_debug_system_prompt.txt"
            _dump_path.write_text(
                f"# System Prompt Debug Dump (mode={mode}, {_total_chars} chars, ~{_est_tokens} tokens)\n"
                f"# orchestrator={_len_orchestrator} | tool_strategy=0(已合并) | "
                f"memory={_len_memory} | bundle={_len_bundle}\n"
                f"# 注意：此文件不含中间件注入部分（TodoList/Filesystem/SubAgent）和 inject_runtime_context\n\n"
                + system_prompt,
                encoding="utf-8",
            )
            logger.debug("[SystemPrompt] DEBUG dump 已写入: %s", _dump_path)
        except Exception as _dump_err:
            logger.debug("[SystemPrompt] DEBUG dump 写入失败: %s", _dump_err)

    if logger.isEnabledFor(logging.DEBUG):
        subagent_names = [s.get("name") for s in subagent_configs] if subagent_configs else []
        logger.debug("[SubAgents] 配置 %s 个子代理: %s", len(subagent_configs), subagent_names)

    _deepagent_kwargs = {}
    if _supports_native_skills and _prefer_native_skills_memory:
        _deepagent_kwargs["skills"] = skills_paths
    if _supports_native_memory and _prefer_native_skills_memory:
        _deepagent_kwargs["memory"] = memory_paths

    _init_middleware_prompt_policy()

    agent = create_deep_agent(
        model=model,
        tools=orchestrator_tools,
        system_prompt=system_prompt,
        middleware=additional_middleware,  # 含 DiffAwareHumanInTheLoopMiddleware(interrupt_on=...)，不再传 interrupt_on 避免重复 HITL
        subagents=subagent_configs,
        backend=create_backend,
        store=store,
        checkpointer=checkpointer,
        debug=Config.DEBUG,
        name=f"orchestrator-{mode}",
        **_deepagent_kwargs,
    )
    
    # 设置合理的 recursion_limit
    # 注意：不要设置太低，因为 SubAgent 也会消耗 recursion_limit
    # 每个 SubAgent 的 model → tools 循环都会计入总数
    # 默认 25 太低，会导致复杂任务提前中止
    agent = agent.with_config({"recursion_limit": 100})
    
    # 缓存 Agent 并修剪，保证大小受 Config 控制（附件场景不缓存，避免上下文错配）
    if not _has_attachments:
        with _agent_cache_lock:
            _agent_cache[cache_key] = agent
        _prune_agent_cache()
    return agent


# ============================================================
# Agent 预热（减少首次请求延迟）
# ============================================================

def warmup_agent(mode: str = "agent", config: Optional["RunnableConfig"] = None) -> bool:
    """预热 Agent，减少首次请求的延迟
    
    在应用启动时调用此函数，可以提前创建 Agent 实例，
    避免用户首次发送消息时的长时间等待。
    
    Args:
        mode: 要预热的模式（agent/ask/plan/debug/review）
        config: 可选的配置
    
    Returns:
        是否预热成功
    """
    import time
    
    start_time = time.time()
    logger.info("[warmup_agent] 开始预热 Agent (模式: %s)", mode)
    
    try:
        get_llm_response_cache()
        create_orchestrator_agent(mode=mode, config=config)
        elapsed = time.time() - start_time
        logger.info("[warmup_agent] Agent 预热完成 (耗时: %.2fs)", elapsed)
        return True
    except Exception as e:
        elapsed = time.time() - start_time
        logger.exception("[warmup_agent] Agent 预热失败 (耗时: %.2fs): %s", elapsed, e)
        return False


def warmup_all_modes(config: Optional["RunnableConfig"] = None) -> dict:
    """预热所有模式的 Agent
    
    Returns:
        各模式的预热结果
    """
    import time
    
    modes = ["agent", "ask", "plan", "debug", "review"]
    results = {}
    total_start = time.time()
    logger.info("[warmup_all_modes] 开始预热所有模式")
    for mode in modes:
        results[mode] = warmup_agent(mode, config)
    total_elapsed = time.time() - total_start
    success_count = sum(1 for v in results.values() if v)
    logger.info("[warmup_all_modes] 预热完成 (%s/%s 成功, 总耗时: %.2fs)", success_count, len(modes), total_elapsed)
    return results


# ============================================================
# 导出
# ============================================================
# 获取所有 Sub-Agent 配置（用于验证）
def get_all_subagents(config: Optional["RunnableConfig"] = None) -> list:
    cfg = create_config()
    return create_subagent_configs(cfg, config, mode="agent")


# ============================================================
# 生产级存储管理（LangGraph/DeepAgent 框架）
# ============================================================
# 
# 存储架构说明：
# 
# 1. SQLite 持久化存储（生产推荐）
#    - ./data/checkpoints.db: 会话状态检查点（支持会话恢复）
#    - ./data/store.db: 长期记忆存储（跨会话持久化）
#    - 特点：文件数据库，按需读取，不常驻内存
#    - 配置：langgraph.json -> checkpointer/store
# 
# 2. Pickle 临时缓存（langgraph dev 模式）
#    - .langgraph_api/*.pckl: 开发模式的内存存储序列化
#    - 问题：全量加载到内存，会导致内存暴涨
#    - 解决：生产环境使用 SQLite，或定期清理
# 
# 3. 向量存储（FAISS）
#    - ./data/vectorstore/: 知识库向量索引
#    - 特点：懒加载，使用后释放
# 
# ============================================================

def cleanup_sqlite_checkpoints(max_age_days: int = None, vacuum: bool = True):
    """清理 SQLite 检查点数据库中的过期数据
    
    ✅ 生产级清理策略：
    - 保留最近 N 天的检查点（默认使用 Config.CHECKPOINT_TTL_DAYS）
    - 执行 VACUUM 释放磁盘空间
    - 不影响活跃会话
    
    Args:
        max_age_days: 保留最近 N 天的检查点（默认使用配置值）
        vacuum: 是否执行 VACUUM 压缩数据库
    
    Returns:
        dict: 清理结果统计
    """
    # 使用可配置的默认值
    if max_age_days is None:
        max_age_days = Config.CHECKPOINT_TTL_DAYS
    result = {"deleted": 0, "vacuumed": False, "error": None}
    
    try:
        if not CHECKPOINTS_DB_PATH.exists():
            return result
        
        import sqlite3
        from datetime import datetime, timedelta
        
        cutoff_date = datetime.now() - timedelta(days=max_age_days)
        cutoff_timestamp = cutoff_date.timestamp()
        
        conn = sqlite3.connect(str(CHECKPOINTS_DB_PATH))
        try:
            cursor = conn.cursor()
            
            # 检查表是否存在
            cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='checkpoints'")
            if not cursor.fetchone():
                return result
            
            # 检查表结构，找到时间戳字段
            cursor.execute("PRAGMA table_info(checkpoints)")
            columns = {row[1] for row in cursor.fetchall()}
            
            # 根据实际表结构选择删除条件
            if "created_at" in columns:
                cursor.execute("DELETE FROM checkpoints WHERE created_at < ?", (cutoff_timestamp,))
            elif "timestamp" in columns:
                cursor.execute("DELETE FROM checkpoints WHERE timestamp < ?", (cutoff_timestamp,))
            else:
                # 如果没有时间字段，跳过清理
                return result
            
            result["deleted"] = cursor.rowcount
            conn.commit()
            
            # VACUUM 压缩数据库（释放磁盘空间）
            if vacuum and result["deleted"] > 0:
                cursor.execute("VACUUM")
                result["vacuumed"] = True
                
        finally:
            conn.close()
        
        if result["deleted"] > 0 and Config.DEBUG:
            import sys
            print(f"🧹 [cleanup_sqlite_checkpoints] 已清理 {result['deleted']} 条过期检查点", file=sys.stderr, flush=True)
        
    except Exception as e:
        result["error"] = str(e)
        if Config.DEBUG:
            import sys
            print(f"⚠️ [cleanup_sqlite_checkpoints] 清理失败: {e}", file=sys.stderr, flush=True)
    
    return result


def cleanup_pickle_cache(
    max_store_size_mb: int = None,
    max_checkpoint_size_mb: int = None,
    max_age_days: int = None,
):
    """清理 .langgraph_api 目录中的 pickle 缓存文件
    
    ✅ 生产级清理策略：
    - 这些文件是 langgraph dev 模式的内存存储序列化
    - 会被全量加载到内存，导致内存暴涨
    - 清理策略：
      1. store.pckl 超过阈值时清理（会丢失长期记忆，但释放内存）
      2. 检查点文件超过阈值时清理（会丢失会话状态）
      3. 超过 N 天的文件清理
    
    ⚠️ 注意：清理会丢失数据，生产环境应使用 SQLite 存储
    
    Args:
        max_store_size_mb: store.pckl 最大大小（MB），默认使用配置值
        max_checkpoint_size_mb: 单个检查点文件最大大小（MB），默认使用配置值
        max_age_days: 保留最近 N 天的文件，默认使用配置值
    
    Returns:
        dict: 清理结果统计
    """
    # 使用可配置的默认值
    if max_store_size_mb is None:
        max_store_size_mb = Config.PICKLE_STORE_MAX_SIZE_MB
    if max_checkpoint_size_mb is None:
        max_checkpoint_size_mb = Config.PICKLE_CHECKPOINT_MAX_SIZE_MB
    if max_age_days is None:
        max_age_days = Config.PICKLE_CACHE_TTL_DAYS
    result = {"files_cleaned": 0, "freed_mb": 0.0, "warnings": [], "dirs_checked": []}
    
    from datetime import datetime, timedelta
    import sys
    
    cutoff_time = datetime.now() - timedelta(days=max_age_days)
    
    # 检查多个可能的 .langgraph_api 目录（使用统一路径）
    possible_dirs = [
        LANGGRAPH_API_ROOT,
        LANGGRAPH_API_BACKEND,
    ]
    
    for langgraph_api_dir in possible_dirs:
        if not langgraph_api_dir.exists():
            continue
        
        result["dirs_checked"].append(str(langgraph_api_dir))
        
        try:
            # 1. 检查 store.pckl（长期记忆）
            store_pckl = langgraph_api_dir / "store.pckl"
            if store_pckl.exists():
                size_mb = store_pckl.stat().st_size / (1024 * 1024)
                if size_mb > max_store_size_mb:
                    result["warnings"].append(
                        f"store.pckl 过大 ({size_mb:.1f}MB)，建议迁移到 SQLite 存储"
                    )
                    print(f"⚠️ [cleanup] store.pckl 过大 ({size_mb:.1f}MB > {max_store_size_mb}MB)", file=sys.stderr, flush=True)
                    print(f"   建议：使用 langgraph up 或配置 SQLite 存储", file=sys.stderr, flush=True)
                    # 不自动删除，因为会丢失长期记忆
            
            # 2. 检查检查点文件（会话状态）
            for pckl_file in langgraph_api_dir.glob(".langgraph_checkpoint.*.pckl"):
                try:
                    size_mb = pckl_file.stat().st_size / (1024 * 1024)
                    mtime = datetime.fromtimestamp(pckl_file.stat().st_mtime)
                    
                    should_clean = False
                    reason = ""
                    
                    if size_mb > max_checkpoint_size_mb:
                        should_clean = True
                        reason = f"过大 ({size_mb:.1f}MB > {max_checkpoint_size_mb}MB)"
                    elif mtime < cutoff_time:
                        should_clean = True
                        reason = f"过期 ({max_age_days} 天前)"
                    
                    if should_clean:
                        print(f"🧹 [cleanup] 清理 {pckl_file.name}: {reason}", file=sys.stderr, flush=True)
                        pckl_file.unlink()
                        result["files_cleaned"] += 1
                        result["freed_mb"] += size_mb
                        
                except Exception as e:
                    result["warnings"].append(f"清理 {pckl_file.name} 失败: {e}")
            
            # 3. 清理其他过期的 pckl 文件
            for pckl_file in langgraph_api_dir.glob("*.pckl"):
                if pckl_file.name in ("store.pckl", "store.vectors.pckl"):
                    continue  # 不自动删除 store 文件
                if pckl_file.name.startswith(".langgraph_checkpoint."):
                    continue  # 已处理
                
                try:
                    mtime = datetime.fromtimestamp(pckl_file.stat().st_mtime)
                    if mtime < cutoff_time:
                        size_mb = pckl_file.stat().st_size / (1024 * 1024)
                        pckl_file.unlink()
                        result["files_cleaned"] += 1
                        result["freed_mb"] += size_mb
                except Exception:
                    pass
            
            # 4. 清理 .langgraph_ops.pckl（操作日志，可能很大）
            ops_pckl = langgraph_api_dir / ".langgraph_ops.pckl"
            if ops_pckl.exists():
                try:
                    size_mb = ops_pckl.stat().st_size / (1024 * 1024)
                    mtime = datetime.fromtimestamp(ops_pckl.stat().st_mtime)
                    
                    # 超过阈值或超过保留期就清理（使用 Config 配置）
                    if size_mb > Config.HEALTH_WARNING_SIZE_MB or mtime < cutoff_time:
                        print(f"🧹 [cleanup] 清理 {ops_pckl.name}: {size_mb:.1f}MB", file=sys.stderr, flush=True)
                        ops_pckl.unlink()
                        result["files_cleaned"] += 1
                        result["freed_mb"] += size_mb
                except Exception as e:
                    result["warnings"].append(f"清理 {ops_pckl.name} 失败: {e}")
                    
        except Exception as e:
            result["warnings"].append(f"清理 {langgraph_api_dir} 失败: {e}")
    
    if result["files_cleaned"] > 0:
        print(f"🧹 [cleanup_pickle_cache] 已清理 {result['files_cleaned']} 个文件，释放 {result['freed_mb']:.1f}MB", file=sys.stderr, flush=True)
    
    return result


def cleanup_old_checkpoints(max_age_days: int = 7):
    """清理旧的检查点（兼容旧 API）
    
    内部调用 cleanup_sqlite_checkpoints
    """
    result = cleanup_sqlite_checkpoints(max_age_days=max_age_days)
    return result.get("deleted", 0)


def cleanup_langgraph_api_cache(max_size_mb: int = 500, max_checkpoint_size_mb: int = 200):
    """清理 LangGraph API 缓存（兼容旧 API）
    
    内部调用 cleanup_pickle_cache
    """
    result = cleanup_pickle_cache(
        max_store_size_mb=max_size_mb,
        max_checkpoint_size_mb=max_checkpoint_size_mb,
    )
    return result.get("files_cleaned", 0)


def cleanup_all_storage(aggressive: bool = False):
    """清理所有存储
    
    ✅ 生产级清理策略：
    - SQLite 检查点：清理过期数据（使用可配置的 TTL）
    - Pickle 缓存：清理过大或过期的文件（使用可配置的阈值）
    - 垃圾回收：释放 Python 内存
    
    Args:
        aggressive: 是否激进清理（会使用更短的 TTL 和更小的阈值）
    
    Returns:
        dict: 清理结果统计
    """
    import gc
    
    # 使用可配置参数，激进模式使用更短的 TTL
    if aggressive:
        max_age_days = max(1, Config.CHECKPOINT_TTL_DAYS // 2)  # 一半的 TTL
        max_store_mb = Config.PICKLE_STORE_MAX_SIZE_MB // 2
        max_checkpoint_mb = Config.PICKLE_CHECKPOINT_MAX_SIZE_MB // 2
    else:
        max_age_days = Config.CHECKPOINT_TTL_DAYS
        max_store_mb = Config.PICKLE_STORE_MAX_SIZE_MB
        max_checkpoint_mb = Config.PICKLE_CHECKPOINT_MAX_SIZE_MB
    
    # 1. 清理 SQLite 检查点
    sqlite_result = cleanup_sqlite_checkpoints(max_age_days=max_age_days)
    
    # 2. 清理 Pickle 缓存
    pickle_result = cleanup_pickle_cache(
        max_store_size_mb=max_store_mb,
        max_checkpoint_size_mb=max_checkpoint_mb,
        max_age_days=max_age_days,
    )
    
    # 3. 垃圾回收
    gc.collect()
    gc.collect()
    
    return {
        "sqlite_checkpoints_deleted": sqlite_result.get("deleted", 0),
        "pickle_files_cleaned": pickle_result.get("files_cleaned", 0),
        "freed_mb": pickle_result.get("freed_mb", 0),
        "warnings": pickle_result.get("warnings", []),
        "config": {
            "max_age_days": max_age_days,
            "max_store_mb": max_store_mb,
            "max_checkpoint_mb": max_checkpoint_mb,
            "aggressive": aggressive,
        }
    }


def get_memory_stats():
    """获取详细的内存统计信息（生产级诊断）
    
    返回：
    - Python 进程内存使用
    - 各类缓存大小
    - 磁盘存储文件大小
    - 存储健康状态
    """
    import gc
    
    # 获取 ModelManager 缓存大小
    manager = get_model_manager()
    llm_cache_size = len(manager._llm_cache) if hasattr(manager, '_llm_cache') else 0
    
    result = {
        "caches": {
            "llm_model_cache_size": llm_cache_size,
            "llm_response_cache": get_llm_response_cache_stats(),
            "agent_cache_size": len(_agent_cache),
        },
        "gc_objects": len(gc.get_objects()),
        "storage": {},
        "health": {"status": "healthy", "warnings": []},
    }
    
    # 检查 SQLite 数据库（使用统一路径）
    sqlite_files = [
        ("checkpoints.db", CHECKPOINTS_DB_PATH),
        ("store.db", STORE_DB_PATH),
    ]
    for name, path in sqlite_files:
        if path.exists():
            size_mb = path.stat().st_size / (1024 * 1024)
            result["storage"][name] = {"size_mb": round(size_mb, 2), "type": "sqlite"}
    
    # 检查 .langgraph_api 目录（pickle 缓存，使用统一路径）
    possible_dirs = [
        ("root", LANGGRAPH_API_ROOT),
        ("backend", LANGGRAPH_API_BACKEND),
    ]
    
    total_pickle_size = 0
    all_pickle_files = []
    
    for location, langgraph_api_dir in possible_dirs:
        if langgraph_api_dir.exists():
            for f in langgraph_api_dir.glob("*.pckl"):
                try:
                    size = f.stat().st_size
                    total_pickle_size += size
                    size_mb = size / (1024 * 1024)
                    all_pickle_files.append({
                        "name": f.name,
                        "location": location,
                        "path": str(f),
                        "size_mb": round(size_mb, 2),
                    })
                    # 检查健康状态（使用 Config 配置）
                    if size_mb > Config.HEALTH_WARNING_SIZE_MB:
                        result["health"]["warnings"].append(
                            f"{location}/{f.name} 过大 ({size_mb:.1f}MB)，可能导致内存问题"
                        )
                except Exception:
                    pass
    
    if all_pickle_files:
        result["storage"]["langgraph_api_cache"] = {
            "total_mb": round(total_pickle_size / 1024 / 1024, 2),
            "files": all_pickle_files,
            "type": "pickle",
        }
        
        if total_pickle_size > 500 * 1024 * 1024:  # 500MB
            result["health"]["status"] = "warning"
            result["health"]["warnings"].append(
                "Pickle 缓存过大，建议使用 SQLite 存储或执行清理"
            )
    
    # 检查向量存储（使用统一路径）
    if VECTOR_STORE_PATH.exists():
        total_size = 0
        index_files = []
        for f in VECTOR_STORE_PATH.rglob("*"):
            if f.is_file():
                size = f.stat().st_size
                total_size += size
                if f.suffix in (".faiss", ".pkl"):
                    index_files.append({
                        "name": str(f.relative_to(VECTOR_STORE_PATH)),
                        "size_mb": round(size / 1024 / 1024, 2),
                    })
        
        result["storage"]["vectorstore"] = {
            "size_mb": round(total_size / 1024 / 1024, 2),
            "type": "faiss",
            "location": str(VECTOR_STORE_PATH),
            "files": index_files,
            "note": "文件存储，按需加载，不常驻内存",
        }
    
    # 尝试使用 psutil 获取进程内存信息
    try:
        import psutil  # type: ignore[import-untyped]
        process = psutil.Process()
        mem_info = process.memory_info()
        result["process"] = {
            "rss_mb": round(mem_info.rss / 1024 / 1024, 2),
            "vms_mb": round(mem_info.vms / 1024 / 1024, 2),
        }
        
        # 检查内存健康状态
        if mem_info.rss > 4 * 1024 * 1024 * 1024:  # 4GB
            result["health"]["status"] = "critical"
            result["health"]["warnings"].append(
                f"进程内存使用过高 ({mem_info.rss / 1024 / 1024 / 1024:.1f}GB)"
            )
        elif mem_info.rss > 2 * 1024 * 1024 * 1024:  # 2GB
            result["health"]["status"] = "warning"
            result["health"]["warnings"].append(
                f"进程内存使用较高 ({mem_info.rss / 1024 / 1024 / 1024:.1f}GB)"
            )
    except ImportError:
        result["process"] = {"note": "psutil not installed"}
    
    if not result["health"]["warnings"]:
        result["health"]["warnings"] = None
    
    return result


# ============================================================
# 启动时初始化和健康检查
# ============================================================
def _startup_init():
    """启动时初始化存储和执行健康检查
    
    ✅ 生产级启动流程：
    1. 确保数据目录存在
    2. 检查存储健康状态
    3. 清理过期数据（可配置是否启用）
    4. 输出诊断信息
    
    配置项：
    - CLEANUP_ON_STARTUP: 是否在启动时执行清理（默认 true）
    - CHECKPOINT_TTL_DAYS: 检查点保留天数
    - DEBUG: 是否输出详细诊断信息
    """
    try:
        # 1. 确保数据目录存在（使用统一路径）
        DATA_PATH.mkdir(parents=True, exist_ok=True)
        
        # 2. 检查存储健康状态
        stats = get_memory_stats()
        health = stats.get("health", {})
        
        if health.get("status") == "critical":
            print("❌ [startup] 存储健康状态：严重", file=sys.stderr, flush=True)
            for warning in health.get("warnings") or []:
                print(f"   ⚠️ {warning}", file=sys.stderr, flush=True)
            print("   建议：执行 cleanup_all_storage(aggressive=True)", file=sys.stderr, flush=True)
        elif health.get("status") == "warning":
            print("⚠️ [startup] 存储健康状态：警告", file=sys.stderr, flush=True)
            for warning in health.get("warnings") or []:
                print(f"   ⚠️ {warning}", file=sys.stderr, flush=True)
        
        # 3. 清理过期数据（可配置）
        if Config.CLEANUP_ON_STARTUP:
            cleanup_result = cleanup_all_storage(aggressive=False)
            
            if cleanup_result.get("sqlite_checkpoints_deleted", 0) > 0 or cleanup_result.get("pickle_files_cleaned", 0) > 0:
                print(f"🧹 [startup] 自动清理完成: SQLite={cleanup_result.get('sqlite_checkpoints_deleted', 0)}, Pickle={cleanup_result.get('pickle_files_cleaned', 0)}", file=sys.stderr, flush=True)
        
        # 4. 输出存储配置信息
        if Config.DEBUG:
            print("✅ [startup] 存储配置:", file=sys.stderr, flush=True)
            print(f"   SQLite Checkpoints: {CHECKPOINTS_DB_PATH}", file=sys.stderr, flush=True)
            print(f"   SQLite Store: {STORE_DB_PATH}", file=sys.stderr, flush=True)
            print(f"   Vectorstore: {VECTOR_STORE_PATH}", file=sys.stderr, flush=True)
            print(f"   Checkpoint TTL: {Config.CHECKPOINT_TTL_DAYS} 天", file=sys.stderr, flush=True)
            print(f"   Store TTL: {Config.STORE_TTL_DAYS} 天", file=sys.stderr, flush=True)
            print(f"   清理间隔: {Config.CLEANUP_INTERVAL_SECONDS} 秒", file=sys.stderr, flush=True)
            
            # 检查 langgraph dev 模式警告
            if LANGGRAPH_API_ROOT.exists():
                pckl_files = list(LANGGRAPH_API_ROOT.glob("*.pckl"))
                if pckl_files:
                    total_size = sum(f.stat().st_size for f in pckl_files)
                    if total_size > 10 * 1024 * 1024:  # 10MB
                        print(f"   ⚠️ 检测到 pickle 缓存 ({total_size / 1024 / 1024:.1f}MB)", file=sys.stderr, flush=True)
                        print(f"      这可能是 langgraph dev 模式产生的", file=sys.stderr, flush=True)
                        print(f"      生产环境建议使用 langgraph up 或直接运行", file=sys.stderr, flush=True)
        
        return True
        
    except Exception as e:
        print(f"⚠️ [startup] 初始化失败: {e}", file=sys.stderr, flush=True)
        return False


_startup_init_lock = threading.Lock()
_startup_init_done = False
_agent_prewarm_started = False
_agent_prewarm_lock = threading.Lock()


def _prewarm_agent_cache_once() -> None:
    """后台预热常用模式 Agent，降低首轮冷启动等待。"""
    global _agent_prewarm_started
    with _agent_prewarm_lock:
        if _agent_prewarm_started:
            return
        _agent_prewarm_started = True
    try:
        base_cfg = {"configurable": {"mode": "agent", "model": "auto", "skill_profile": "general"}}
        get_agent(base_cfg)
        ask_cfg = {"configurable": {"mode": "ask", "model": "auto", "skill_profile": "general"}}
        get_agent(ask_cfg)
    except Exception as e:
        logger.debug("agent prewarm skipped: %s", e)

def ensure_startup_initialized(force: bool = False) -> bool:
    """在应用生命周期中显式触发一次启动初始化（幂等）。"""
    global _startup_init_done
    with _startup_init_lock:
        if _startup_init_done and not force:
            return True
        ok = _startup_init()
        _startup_init_done = bool(ok)
        if ok:
            try:
                threading.Thread(target=_prewarm_agent_cache_once, daemon=True, name="agent-prewarm").start()
            except Exception as e:
                logger.debug("agent prewarm thread start failed: %s", e)
        return bool(ok)

# ============================================================
# 定期清理任务（防止内存泄漏）
# ============================================================
import time

_cleanup_thread = None
_cleanup_stop_event = threading.Event()

def _periodic_cleanup_task():
    """定期清理任务（后台线程）
    
    功能：
    1. 定期清理过期的 pickle 缓存
    2. 定期清理 SQLite 检查点
    3. 触发 Python 垃圾回收
    
    运行间隔由 Config.CLEANUP_INTERVAL_SECONDS 控制（默认 1 小时）
    """
    import gc
    import sys
    
    interval = Config.CLEANUP_INTERVAL_SECONDS
    print(f"🧹 [Cleanup] 定期清理任务已启动，间隔: {interval} 秒", file=sys.stderr, flush=True)
    
    while not _cleanup_stop_event.wait(interval):
        try:
            # 1. 清理 pickle 缓存
            pickle_result = cleanup_pickle_cache()
            
            # 2. 清理 SQLite 检查点
            sqlite_result = cleanup_sqlite_checkpoints()
            
            # 3. 垃圾回收
            gc.collect()
            
            # 记录日志
            if pickle_result.get("files_cleaned", 0) > 0 or sqlite_result.get("deleted", 0) > 0:
                print(f"🧹 [Cleanup] 定期清理完成: Pickle={pickle_result.get('files_cleaned', 0)}, SQLite={sqlite_result.get('deleted', 0)}", file=sys.stderr, flush=True)
                
        except Exception as e:
            print(f"⚠️ [Cleanup] 定期清理失败: {e}", file=sys.stderr, flush=True)

def start_periodic_cleanup():
    """启动定期清理任务"""
    global _cleanup_thread
    
    if _cleanup_thread is not None and _cleanup_thread.is_alive():
        return  # 已经在运行
    
    _cleanup_stop_event.clear()
    _cleanup_thread = threading.Thread(target=_periodic_cleanup_task, daemon=True)
    _cleanup_thread.start()

def stop_periodic_cleanup():
    """停止定期清理任务"""
    global _cleanup_thread
    
    _cleanup_stop_event.set()
    if _cleanup_thread is not None:
        _cleanup_thread.join(timeout=5)
        _cleanup_thread = None

# ️ 注意：定期清理任务已移至 backend/api/app.py 的异步版本
# 使用 run_in_executor 避免阻塞调用警告
# 这里的同步版本仅作为备用，不再自动启动
# 
# 如果需要手动启动同步清理（用于非 LangGraph 环境）：
# from backend.engine.agent.deep_agent import start_periodic_cleanup
# start_periodic_cleanup()
#
# if Config.CLEANUP_ON_STARTUP and not os.getenv("PYTEST_CURRENT_TEST"):
#     start_periodic_cleanup()

# ============================================================
# 全局 Agent（延迟创建，支持动态模型切换）
# ============================================================
# 
# ️ 重要：不要在模块加载时创建 Agent！
# 
# 原因：
# 1. 模块加载时没有 config，无法获取前端选择的模型
# 2. 如果在这里创建 Agent，会使用默认模型配置
# 3. 前端切换模型后，Agent 不会更新
# 
# 解决方案：
# - 使用 get_agent() 函数延迟创建
# - LangGraph Server 通过 config 传递模型选择
# - Agent 在首次调用时创建，并缓存
# ============================================================

# 上次请求的模型（用于检测模型切换并清除缓存）
_last_requested_model = None
_last_requested_model_lock = threading.Lock()
_global_subagents = None


def get_agent(config: Optional["RunnableConfig"] = None):
    """获取 Agent（按 model_id + mode + skill_profile 缓存，支持动态模型与模式切换）
    
    对外语义：本函数返回的编译图即为「Agent」—— Orchestrator + SubAgents。
    数据流：main_graph.deepagent_node → get_agent(config) → create_orchestrator_agent(config, mode)。
    
    Args:
        config: LangChain RunnableConfig，须含 configurable.model、configurable.mode 等
        
    Returns:
        CompiledStateGraph: DeepAgent 实例（来自 _agent_cache 或新建）
    """
    global _last_requested_model
    
    configurable = (config or {}).get("configurable", {}) or {}
    mode = configurable.get("mode", "agent")
    if mode not in ("agent", "ask", "plan", "debug", "review"):
        logger.warning("[Agent] 无效 mode %s，回退为 agent", mode)
        mode = "agent"
    requested_model = configurable.get("model") or configurable.get("model_id") or configurable.get("thread_model")
    singleflight_key: Optional[str] = None
    is_build_owner = False
    inflight_event: Optional[threading.Event] = None
    
    if config and logger.isEnabledFor(logging.DEBUG):
        logger.debug("[Agent] get_agent configurable keys: %s, mode: %s", list(configurable.keys()), mode)
    
    # 模型切换时清除缓存，避免旧模型实例残留（读-比较-写受锁保护，锁内立即更新避免 TOCTOU）
    with _last_requested_model_lock:
        _last = _last_requested_model
        if requested_model and _last is not None and requested_model != _last and requested_model != "auto":
            logger.debug("[Agent] 模型切换: %s → %s，清除缓存", _last, requested_model)
            clear_agent_cache()
            get_model_manager().clear_cache()
            _last_requested_model = requested_model

    # 同一 key 并发请求只允许一个线程创建 Agent，其余线程等待并复用缓存结果。
    has_attachments = _has_non_error_attachments(configurable.get("context_items", []))
    if not has_attachments:
        try:
            manager = get_model_manager()
            resolved_model_id = manager.get_model(config)
            is_reasoning_for_cache = False
            try:
                model_cfg_for_cache = manager.get_model_config(resolved_model_id)
                if model_cfg_for_cache:
                    is_reasoning_for_cache = bool(model_cfg_for_cache.get("is_reasoning_model", False))
            except Exception:
                pass
            singleflight_key, _ = _build_orchestrator_cache_key(
                model_id=resolved_model_id,
                mode=mode,
                configurable=configurable,
                is_reasoning_model=is_reasoning_for_cache,
            )
            with _agent_build_inflight_lock:
                inflight_event = _agent_build_inflight.get(singleflight_key)
                if inflight_event is None:
                    inflight_event = threading.Event()
                    _agent_build_inflight[singleflight_key] = inflight_event
                    is_build_owner = True
            if not is_build_owner and inflight_event is not None:
                wait_budget_seconds = _resolve_agent_build_wait_seconds(configurable)
                wait_completed = inflight_event.wait(timeout=wait_budget_seconds)
                with _agent_cache_lock:
                    cached_after_wait = _agent_cache.get(singleflight_key)
                if cached_after_wait is None and not wait_completed:
                    # owner 线程可能刚完成 set()/缓存落盘，短轮询一次避免并发重复构建
                    for _ in range(_AGENT_BUILD_POST_WAIT_POLL_STEPS):
                        time.sleep(_AGENT_BUILD_POST_WAIT_POLL_INTERVAL_MS / 1000.0)
                        with _agent_cache_lock:
                            cached_after_wait = _agent_cache.get(singleflight_key)
                        if cached_after_wait is not None:
                            break
                if cached_after_wait is not None:
                    if not hasattr(cached_after_wait, "_model_id"):
                        cached_after_wait._model_id = resolved_model_id
                    with _last_requested_model_lock:
                        _last_requested_model = requested_model
                    return cached_after_wait
        except Exception as sf_err:
            logger.debug("[Agent] single-flight setup skipped (non-critical): %s", sf_err)
    
    try:
        agent = create_orchestrator_agent(config=config, mode=mode)
    finally:
        if is_build_owner and singleflight_key:
            with _agent_build_inflight_lock:
                event = _agent_build_inflight.pop(singleflight_key, None)
            if event is not None:
                event.set()
    if not hasattr(agent, "_model_id"):
        agent._model_id = get_model_manager().get_model(config)
    with _last_requested_model_lock:
        _last_requested_model = requested_model
    return agent


def get_subagents(config: Optional["RunnableConfig"] = None):
    """获取所有子代理（延迟创建）。整段 check-and-init 在锁内，防并发重复初始化。"""
    global _global_subagents
    with _agent_build_inflight_lock:
        if _global_subagents is None:
            try:
                _global_subagents = get_all_subagents(config=config)
            except Exception as e:
                logger.exception("[Agent] 获取子代理失败: %s", e)
                _global_subagents = []
        return _global_subagents


# 为了向后兼容，提供 agent 和 deepagent_graph 变量（延迟创建，无 config 时使用默认 model/mode）
# 生产入口应通过 main_graph.deepagent_node → get_agent(config) 调用，以保证 mode/workspace 等来自请求
class _LazyAgent:
    """延迟加载的 Agent 代理类，适用于测试或脚本中无 config 的场景"""
    
    def __getattr__(self, name):
        agent = get_agent()
        return getattr(agent, name)
    
    def __call__(self, *args, **kwargs):
        agent = get_agent()
        return agent(*args, **kwargs)


# 导出延迟加载的 Agent
agent = _LazyAgent()
deepagent_graph = agent
all_subagents = []  # 延迟加载，使用 get_subagents() 获取


def _parallel_block_with_observability() -> dict:
    """并行配置块，含 MAX_PARALLEL_* 与可观测埋点（当前并行 run 数）。"""
    out = {
        "max_parallel_llm": Config.MAX_PARALLEL_LLM,
        "max_parallel_tools": Config.MAX_PARALLEL_TOOLS,
        "max_parallel_agents": Config.MAX_PARALLEL_AGENTS,
        "resource_adaptive_enabled": Config.ENABLE_RESOURCE_ADAPTIVE_PARALLEL,
        "policy_profile": _parallel_policy_runtime.get("profile", "local"),
        "policy_cloud_model_enabled": bool(_parallel_policy_runtime.get("cloud_model_enabled", False)),
        "policy_limits": _parallel_policy_runtime.get("limits", {}),
        "policy_priority_order": _parallel_policy_runtime.get("priority_order", []),
    }
    try:
        from backend.engine.core.resource_scheduler import get_scheduler
        st = get_scheduler().get_status()
        cur = (st or {}).get("current") or {}
        details = cur.get("task_details") or {}
        out["current_parallel_llm_runs"] = sum(1 for t in details.values() if (t or {}).get("type") == "llm")
        out["current_parallel_tool_runs"] = sum(1 for t in details.values() if (t or {}).get("type") == "tool")
    except Exception:
        out["current_parallel_llm_runs"] = 0
        out["current_parallel_tool_runs"] = 0
    return out


def get_config_summary() -> dict:
    """获取当前配置摘要（用于诊断和 API）
    
    Returns:
        dict: 所有可配置参数的当前值
    """
    return {
        "model": {
            "url": Config.MODEL_URL,
            "default_model": Config.DEFAULT_MODEL,
            "temperature": Config.TEMPERATURE,
            "max_tokens": Config.MAX_TOKENS,
            "timeout": Config.TIMEOUT,
        },
        "parallel": _parallel_block_with_observability(),
        "cache": {
            "llm_cache_max_size": Config.LLM_CACHE_MAX_SIZE,
            "agent_cache_max_size": Config.AGENT_CACHE_MAX_SIZE,
        },
        "storage": {
            "checkpoint_ttl_days": Config.CHECKPOINT_TTL_DAYS,
            "store_ttl_days": Config.STORE_TTL_DAYS,
            "pickle_cache_ttl_days": Config.PICKLE_CACHE_TTL_DAYS,
            "pickle_store_max_size_mb": Config.PICKLE_STORE_MAX_SIZE_MB,
            "pickle_checkpoint_max_size_mb": Config.PICKLE_CHECKPOINT_MAX_SIZE_MB,
        },
        "cleanup": {
            "interval_seconds": Config.CLEANUP_INTERVAL_SECONDS,
            "on_startup": Config.CLEANUP_ON_STARTUP,
        },
        "http": {
            "connect_timeout": Config.HTTP_CONNECT_TIMEOUT,
            "read_timeout": Config.HTTP_READ_TIMEOUT,
            "max_connections": Config.HTTP_MAX_CONNECTIONS,
        },
        "sqlite": {
            "cache_size_kb": Config.SQLITE_CACHE_SIZE_KB,
            "timeout": Config.SQLITE_TIMEOUT,
        },
        "embedding": {
            "chunk_size": Config.EMBEDDING_CHUNK_SIZE,
            "max_retries": Config.EMBEDDING_MAX_RETRIES,
            "timeout": Config.EMBEDDING_TIMEOUT,
        },
        "debug": Config.DEBUG,
    }


__all__ = [
    "agent",
    "deepagent_graph", 
    "all_subagents",
    "create_orchestrator_agent",
    "create_llm",
    "get_all_subagents",
    "clear_agent_cache",
    "clear_llm_cache",
    "clear_llm_response_cache",
    "clear_all_caches",
    "get_memory_usage",
    "get_memory_stats",
    "get_llm_response_cache_stats",
    "cleanup_old_checkpoints",
    "cleanup_langgraph_api_cache",
    "cleanup_all_storage",
    "cleanup_sqlite_checkpoints",
    "cleanup_pickle_cache",
    "ensure_startup_initialized",
    "switch_model",
    "get_config_summary",
    "Config",
    # 定期清理
    "start_periodic_cleanup",
    "stop_periodic_cleanup",
]
