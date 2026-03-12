"""主路由 Graph - 系统唯一入口

这是整个系统的入口点，负责：
1. 接收前端请求
2. 解析路由信息
3. 分发到不同的处理节点（DeepAgent 或工具）
4. 返回处理结果

架构设计：
┌─ router (信息提取)
│   ↓
├─ route_decision() (路由决策)
│   ├─ "deepagent" → deepagent 节点（DeepAgent 完整工作流）
│   ├─ "editor_tool" → editor_tool 节点（快速工具）
│   └─ "error" → error 节点
│
└─ 所有节点 → END
（确定性文件操作建议前端直接调用 REST /files/*；图中保留 editor_tool 以兼容未迁移请求）

✅ 模型与业务场景（config.configurable）：
- model: 前端传递模型选择，DeepAgent 在运行时读取
- skill_profile: 业务场景（full/bidding/document/dev），决定加载的能力子集（多能力组合）
- mode: 聊天模式（agent/ask/plan/debug/review）
- LangGraph 自动将 config 传递给所有节点；使用 Subgraph 保证完整流式输出

✅ 生产级存储架构：
- Checkpointer: SqliteSaver (./data/checkpoints.db) - 会话状态持久化
- Store: SQLiteStore (./data/store.db) - 长期记忆存储
- TTL: 7天自动清理过期数据，防止无限增长
- 注意：langgraph dev 会忽略配置，生产环境需手动注入
"""

from langgraph.graph import StateGraph, END
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
import sys
import os
import json
import re
import urllib.request
import asyncio
import time
import hashlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional
import threading
import uuid

_debug_log_file_lock = threading.Lock()

# 添加项目根目录到 Python 路径
backend_root = Path(__file__).parent.parent.parent
if str(backend_root) not in sys.path:
    sys.path.insert(0, str(backend_root))

from backend.api.common import is_valid_thread_id_uuid
from backend.engine.state.agent_state import AgentState
from backend.engine.nodes import (
    router_node,
    route_decision,
    editor_tool_node,
    error_node,
)


def extract_mode_from_messages(messages: list) -> str:
    """从 messages 中取最近一条携带 mode 的消息，供路由与测试使用。与图内 _extract_mode_from_messages 逻辑一致。"""
    mode = "agent"
    try:
        for msg in reversed(messages or []):
            kwargs = getattr(msg, "additional_kwargs", {}) or {}
            raw = str(kwargs.get("mode") or "").strip().lower()
            if raw in {"agent", "ask", "plan", "debug", "review"}:
                return raw
    except Exception as e:
        logger.debug("extract_mode_from_messages fallback: %s", e)
    return mode


def _filter_content_leakage(content: str) -> str:
    """过滤 Qwen3/推理模型泄漏到 message.content 的 chat 模板或提示词，避免在聊天区展示。

    仅过滤明确的模板泄漏（chat template token），不过滤正常代码内容。
    """
    # #region agent log（并发写加锁，避免交叉）
    _debug_log_path = (Path(__file__).resolve().parents[3] / ".cursor" / "debug-e543f7.log")
    def _dbg(m: str, data: dict, hid: str):
        try:
            import json as _dj
            with _debug_log_file_lock:
                with open(_debug_log_path, "a", encoding="utf-8") as _f:
                    _f.write(_dj.dumps({"sessionId": "e543f7", "timestamp": int(time.time() * 1000), "location": "main_graph:_filter_content_leakage", "message": m, "data": data, "hypothesisId": hid}) + "\n")
        except Exception:
            pass
    # #endregion
    if not content or not isinstance(content, str):
        return content or ""
    s = content.strip()
    if not s:
        return content
    in_len, in_preview = len(s), (s[:100] if s else "")
    # Chat 模板特殊 token（明确的模型内部标记，正常回复不会包含）
    if "<|im_start|" in s or "<|im_end|" in s:
        _dbg("filter_hit", {"input_len": in_len, "output_len": 0, "filtered_hit": True, "input_preview": in_preview}, "H2")
        return ""
    if "<|vision_start|" in s or "<|image_pad|" in s or "<|vision_end|" in s:
        _dbg("filter_hit", {"input_len": in_len, "output_len": 0, "filtered_hit": True, "input_preview": in_preview}, "H2")
        return ""
    # 纯 Jinja chat 模板泄漏：同时包含 {%...%} 和 im_start/system 等关键词
    if ("{%" in s and "%}" in s) and ("<|im_start|" in s or "system" in s[:50]):
        _dbg("filter_hit", {"input_len": in_len, "output_len": 0, "filtered_hit": True, "input_preview": in_preview}, "H2")
        return ""
    out_len, out_preview = len(content), (content[:100] if content else "")
    _dbg("filter_pass", {"input_len": in_len, "output_len": out_len, "filtered_hit": False, "output_preview": out_preview}, "H2")
    return content


def _debug_log_agent(msg: str, data: dict, hypothesis_id: str) -> None:
    # #region agent log（并发写加锁）
    try:
        _p = (Path(__file__).resolve().parents[3] / ".cursor" / "debug-e543f7.log")
        with _debug_log_file_lock:
            with open(_p, "a", encoding="utf-8") as _f:
                _f.write(json.dumps({"sessionId": "e543f7", "timestamp": int(time.time() * 1000), "location": "main_graph", "message": msg, "data": data, "hypothesisId": hypothesis_id}) + "\n")
    except Exception:
        pass
    # #endregion


def _normalize_tool_message_ids(messages: list) -> list:
    """确保所有 ToolMessage 的 tool_call_id 为 str，且 AIMessage.tool_calls[].id 不为 None，避免 Pydantic 校验失败。"""
    if not messages:
        return messages
    out = []
    for m in messages:
        if isinstance(m, ToolMessage) and getattr(m, "tool_call_id", None) is None:
            out.append(ToolMessage(content=getattr(m, "content", "") or "", tool_call_id="", name=getattr(m, "name", None)))
        elif isinstance(m, AIMessage):
            tcs = getattr(m, "tool_calls", None) or []
            if not tcs:
                out.append(m)
                continue
            fixed = []
            changed = False
            for tc in tcs:
                if isinstance(tc, dict):
                    tid, name, args = tc.get("id"), tc.get("name"), tc.get("args")
                else:
                    tid, name, args = getattr(tc, "id", None), getattr(tc, "name", None), getattr(tc, "args", None)
                if tid is None or not isinstance(tid, str):
                    fixed.append({"id": "" if tid is None else str(tid), "name": name, "args": args or {}})
                    changed = True
                else:
                    fixed.append({"id": tid, "name": name, "args": args or {}})
            if changed:
                out.append(AIMessage(content=m.content, tool_calls=fixed, additional_kwargs=getattr(m, "additional_kwargs", None) or {}))
            else:
                out.append(m)
        else:
            out.append(m)
    return out if out != messages else messages


def _normalize_messages_system_first(messages: list) -> list:
    """将消息列表中所有 SystemMessage 移到开头并合并为一条，满足 OpenAI/云端 API「System message must be at the beginning」要求。
    对话中插入的 loop_guidance、done_verifier 等会生成中间的 SystemMessage，若不置前会导致 400 bad_response_status_code。
    """
    if not messages:
        return messages
    system_parts = []
    others = []
    for m in messages:
        if isinstance(m, SystemMessage):
            content = getattr(m, "content", None)
            if content is not None and (isinstance(content, str) and content.strip() or content):
                system_parts.append(content if isinstance(content, str) else str(content))
        else:
            others.append(m)
    if not system_parts:
        return messages
    merged_system = SystemMessage(content="\n\n".join(system_parts))
    return [merged_system] + others


def _content_blocks_to_str(content: Any) -> str:
    """将 content 为 list（content_blocks）或非字符串时转为单字符串，避免上游 API 400 No schema matches。"""
    from backend.engine.utils.message_normalize import content_blocks_to_str
    return content_blocks_to_str(content)


def _normalize_messages_content_to_string(messages: list) -> list:
    """将 messages 中所有 content 非 string 的消息转为 content 为 string，避免第三轮及以后请求因 state 中 AIMessage.content 为 list 导致上游 API 400 No schema matches。"""
    from backend.engine.utils.message_normalize import normalize_messages_content_to_string
    return normalize_messages_content_to_string(messages)


def plan_route_decision(state: AgentState) -> str:
    """Plan 模式路由：在 base=deepagent 时返回 deepagent_plan 或 deepagent_execute。供回归测试与图内条件边一致。"""
    base = route_decision(state)
    if base != "deepagent":
        return base
    mode = extract_mode_from_messages(state.get("messages") or [])
    return "deepagent_plan" if mode == "plan" else "deepagent_execute"
# ✅ 使用 DeepAgent Graph（支持动态模型切换 + 流式输出）
# 注意：使用 get_agent() 延迟创建，支持动态模型切换
from backend.engine.agent.deep_agent import get_agent
import logging
from backend.engine.middleware.loop_detector import LoopDetector, LoopSignal
from backend.engine.middleware.guardrails_manager import GuardrailsManager
from backend.config.memory_scope import resolve_memory_scope

logger = logging.getLogger(__name__)


def _env_int(key: str, default: int) -> int:
    """安全解析整型环境变量，解析失败时回退 default，避免模块加载时 ValueError。"""
    try:
        return max(0, int(os.environ.get(key, str(default)) or str(default)))
    except (ValueError, TypeError):
        return default


# ── 可调常量 ──
_DEFAULT_STREAM_TIMEOUT_SECONDS = 180
_DEFAULT_CONTEXT_LENGTH = 32768
_GRAPH_RECURSION_LIMIT = 1000
_TOOL_RESULT_SUMMARY_MAX_CHARS = 1000
_TOKEN_STREAM_BATCH_MS = _env_int("TOKEN_STREAM_BATCH_MS", 15)
_TOKEN_STREAM_BATCH_SECONDS = _TOKEN_STREAM_BATCH_MS / 1000.0
_TOKEN_STREAM_WARMUP_MS = _env_int("TOKEN_STREAM_WARMUP_MS", 1200)
_TOKEN_STREAM_WARMUP_SECONDS = _TOKEN_STREAM_WARMUP_MS / 1000.0
_REASONING_STREAM_MIN_CHARS = max(1, _env_int("REASONING_STREAM_MIN_CHARS", 1))
_FIRST_VISIBLE_PAYLOAD_TIMEOUT_MS = max(200, _env_int("FIRST_VISIBLE_PAYLOAD_TIMEOUT_MS", 1200))
_FIRST_VISIBLE_PROGRESS_INTERVAL_MS = max(500, _env_int("FIRST_VISIBLE_PROGRESS_INTERVAL_MS", 2500))
_PREPARE_PROGRESS_HINT_MS = max(300, _env_int("PREPARE_PROGRESS_HINT_MS", 800))
_PREPARE_PROGRESS_INTERVAL_MS = max(300, _env_int("PREPARE_PROGRESS_INTERVAL_MS", 1200))
_PREPARE_MAX_WAIT_SECONDS = max(60, _env_int("PREPARE_MAX_WAIT_SECONDS", 600))
_ADAPTIVE_HOTPATH_ENABLED = str(
    os.environ.get("ADAPTIVE_HOTPATH_ENABLED", "true")
).strip().lower() in {"1", "true", "yes", "on"}
_ADAPTIVE_HOTPATH_QUEUE_WAIT_MS = max(500, _env_int("ADAPTIVE_HOTPATH_QUEUE_WAIT_MS", 2500))
_TASK_PROGRESS_DEDUP_WINDOW_MS = max(100, _env_int("TASK_PROGRESS_DEDUP_WINDOW_MS", 300))
_STREAM_EVENT_SURFACE = str(
    os.environ.get("STREAM_EVENT_SURFACE", "core")
).strip().lower()
if _STREAM_EVENT_SURFACE not in {"core", "compat"}:
    _STREAM_EVENT_SURFACE = "core"
_legacy_stats_override = os.environ.get("EMIT_LEGACY_STATS_EVENTS")
if _legacy_stats_override is not None:
    _EMIT_LEGACY_STATS_EVENTS = str(_legacy_stats_override).strip().lower() in {"1", "true", "yes", "on"}
else:
    # 单点收敛：默认核心事件面，仅在 compat 模式下输出 legacy 统计事件。
    _EMIT_LEGACY_STATS_EVENTS = _STREAM_EVENT_SURFACE == "compat"
_CONTEXT_STATS_MAX_HISTORY_MSGS = max(20, _env_int("CONTEXT_STATS_MAX_HISTORY_MSGS", 80))
_CONTEXT_STATS_MAX_MSG_CHARS = max(512, _env_int("CONTEXT_STATS_MAX_MSG_CHARS", 4000))
_GUARDRAILS_CACHE_TTL_MS = _env_int("GUARDRAILS_CACHE_TTL_MS", 15000)
_GUARDRAILS_CACHE_MAX_SIZE = max(8, _env_int("GUARDRAILS_CACHE_MAX_SIZE", 128))

# #region agent log
_DEBUG_INGEST_PATH = Path(__file__).resolve().parents[3] / ".cursor" / "debug-e543f7.log"

def _debug_ingest(message: str, data: dict, hypothesis_id: str) -> None:
    try:
        with _debug_log_file_lock:
            with open(_DEBUG_INGEST_PATH, "a", encoding="utf-8") as _f:
                _f.write(
                    json.dumps(
                        {
                            "sessionId": "e543f7",
                            "timestamp": int(time.time() * 1000),
                            "location": "main_graph",
                            "message": message,
                            "data": data,
                            "hypothesisId": hypothesis_id,
                        }
                    )
                    + "\n"
                )
    except Exception as e:
        logger.debug("_debug_ingest write failed: %s", e)
# #endregion


def _format_tool_result_preview(tc_name: str, content_str: str, max_chars: int = 500) -> str:
    """对各类工具生成可读的 result_preview，便于前端即时展示（Cursor 式）。"""
    if content_str is None:
        return ""
    if not isinstance(content_str, str):
        content_str = str(content_str) if content_str else ""
    content_str = (content_str or "").strip()
    if not content_str:
        return ""
    name = (tc_name or "").strip().lower()
    lines = [ln.strip() for ln in content_str.splitlines() if ln.strip()]
    parsed = None
    if content_str.strip().startswith("{"):
        try:
            parsed = json.loads(content_str)
        except Exception as e:
            logger.debug("_format_tool_result_preview json.loads: %s", e)

    if name in ("ls", "list_directory", "glob", "glob_file_search"):
        n = len(lines)
        if n == 0:
            return "（无条目）"
        head = lines[:8]
        preview = "、".join((p[:60] + "…" if len(p) > 60 else p for p in head))
        if n > 8:
            preview += f" … 共 {n} 项"
        else:
            preview += f"（共 {n} 项）"
        return preview[:max_chars] + ("…" if len(preview) > max_chars else "")
    if name in ("grep_search", "grep"):
        n = len(lines)
        if n == 0:
            return "（无匹配）"
        head = lines[:5]
        preview = "\n".join((ln[:120] + "…" if len(ln) > 120 else ln for ln in head))
        if n > 5:
            preview += f"\n… 共 {n} 处匹配"
        return preview[:max_chars] + ("…" if len(preview) > max_chars else "")
    if name in ("read_file", "file_read", "batch_read_files"):
        n = len(lines)
        if n == 0:
            return "（空文件）"
        first_line = lines[0][:200] + ("…" if len(lines[0]) > 200 else "")
        return f"{n} 行 · {first_line}"[:max_chars] + ("…" if len(f"{n} 行 · {first_line}") > max_chars else "")

    if name in ("python_run", "execute_python_code", "execute"):
        if parsed and isinstance(parsed, dict):
            status = parsed.get("status") or parsed.get("result")
            err = parsed.get("error") or parsed.get("stderr")
            out = parsed.get("output") or parsed.get("stdout") or parsed.get("result")
            if err and isinstance(err, str) and err.strip():
                return ("执行异常 · " + err.strip()[:200])[:max_chars] + ("…" if len(err) > 200 else "")
            if out is not None:
                out_str = "\n".join(out) if isinstance(out, list) else str(out).strip()
                if out_str:
                    first = (out_str.splitlines()[0][:150] if out_str.splitlines() else out_str[:150]).strip()
                    return ("执行成功 · " + first)[:max_chars] + ("…" if len(out_str) > 150 else "")
            if status:
                return f"执行完成 · {str(status)[:100]}"
        if lines:
            first_ln = lines[0][:180]
            return ("执行输出 · " + first_ln)[:max_chars] + ("…" if len(lines[0]) > 180 else "")
        return "执行完成"

    if name in ("shell_run", "shell"):
        if parsed and isinstance(parsed, dict):
            code = parsed.get("exit_code") if "exit_code" in parsed else parsed.get("returncode")
            out = parsed.get("stdout") or parsed.get("output")
            err = parsed.get("stderr") or parsed.get("error")
            if err and str(err).strip():
                return ("命令异常 · " + str(err).strip()[:180])[:max_chars] + ("…" if len(str(err)) > 180 else "")
            if code is not None:
                suffix = f"退出码 {code}"
                if out and str(out).strip():
                    first = str(out).strip().splitlines()[0][:120]
                    return (first + " · " + suffix)[:max_chars]
                return suffix
            if out is not None and str(out).strip():
                return str(out).strip()[:max_chars] + ("…" if len(str(out)) > max_chars else "")
        if lines:
            return lines[0][:max_chars] + ("…" if len(lines[0]) > max_chars else "")
        return "命令已执行"

    if name in ("web_search", "web_fetch"):
        if parsed and isinstance(parsed, dict):
            results = parsed.get("results") or parsed.get("data") or parsed.get("items")
            if isinstance(results, list) and results:
                n = len(results)
                first = results[0] if isinstance(results[0], dict) else {}
                title = (first.get("title") or first.get("name") or first.get("snippet") or str(first))[:80]
                return f"找到 {n} 条 · 首条：{title}"[:max_chars] + ("…" if len(title) >= 80 else "")
            if "results" in parsed and isinstance(parsed.get("results"), list):
                return f"找到 {len(parsed['results'])} 条结果"
        if lines:
            return lines[0][:max_chars] + ("…" if len(lines[0]) > max_chars else "")
        return content_str[:max_chars] + ("…" if len(content_str) > max_chars else "")

    if name in ("search_knowledge", "search_memory", "search_learning_experience"):
        if lines:
            n = len(lines)
            first = lines[0][:180] + ("…" if len(lines[0]) > 180 else "")
            if n > 1:
                return f"共 {n} 条相关 · {first}"[:max_chars]
            return first[:max_chars] + ("…" if len(first) > max_chars else "")
        if not content_str.strip():
            return "（无匹配）"
        return content_str[:max_chars] + ("…" if len(content_str) > max_chars else "")

    if name in ("write_file", "edit_file", "delete_file"):
        for ln in lines[:3]:
            if "已写入" in ln or "已保存" in ln or "written" in ln.lower() or "saved" in ln.lower():
                return ln[:max_chars] + ("…" if len(ln) > max_chars else "")
            if "已删除" in ln or "deleted" in ln.lower():
                return ln[:max_chars] + ("…" if len(ln) > max_chars else "")
            if "已修改" in ln or "modified" in ln.lower():
                return ln[:max_chars] + ("…" if len(ln) > max_chars else "")
        if lines:
            return lines[0][:max_chars] + ("…" if len(lines[0]) > max_chars else "")
        return "文件操作完成"

    if name == "task":
        return content_str[:max_chars] + ("…" if len(content_str) > max_chars else "")

    if name in ("create_chart", "generate_ppt", "generate_pdf", "generate_word", "generate_image"):
        if "path" in content_str.lower() or "已生成" in content_str or "生成" in content_str:
            for ln in lines[:2]:
                if "/" in ln or "\\" in ln or "path" in ln.lower():
                    return ln[:max_chars] + ("…" if len(ln) > max_chars else "")
        if lines:
            return lines[0][:max_chars] + ("…" if len(lines[0]) > max_chars else "")
        return "已生成"

    if name in ("manage_memory", "record_result"):
        if lines:
            return lines[0][:max_chars] + ("…" if len(lines[0]) > max_chars else "")
        if "已保存" in content_str or "saved" in content_str.lower():
            return "已保存到记忆"
        return content_str[:max_chars] + ("…" if len(content_str) > max_chars else "")

    if name in ("analyze_document", "content_extract"):
        if lines:
            first = lines[0][:220] + ("…" if len(lines[0]) > 220 else "")
            return first[:max_chars] + ("…" if len(first) > max_chars else "")
        return content_str[:max_chars] + ("…" if len(content_str) > max_chars else "")

    if name in ("list_skills", "match_skills", "get_skill_info"):
        if parsed and isinstance(parsed, dict):
            skills = parsed.get("skills") or parsed.get("results")
            if isinstance(skills, list):
                extra = ""
                if skills and isinstance(skills[0], dict) and skills[0].get("name"):
                    extra = f" · {str(skills[0]['name'])[:50]}"
                return f"共 {len(skills)} 个技能{extra}"[:max_chars]
        if lines:
            return lines[0][:max_chars] + ("…" if len(lines[0]) > max_chars else "")
        return content_str[:max_chars] + ("…" if len(content_str) > max_chars else "")

    if name in ("query_kg", "knowledge_graph", "ontology", "ontology_query", "ontology_extract", "extract_entities"):
        if parsed and isinstance(parsed, dict):
            entities = parsed.get("entities") or parsed.get("results") or parsed.get("data")
            if isinstance(entities, list):
                return f"共 {len(entities)} 条" + (f" · {str(entities[0])[:60]}…" if entities and len(str(entities[0])) > 40 else "")[:max_chars]
        if lines:
            return lines[0][:max_chars] + ("…" if len(lines[0]) > max_chars else "")
        return content_str[:max_chars] + ("…" if len(content_str) > max_chars else "")

    if name == "write_todos":
        if "完成" in content_str or "completed" in content_str.lower() or "pending" in content_str.lower():
            for ln in lines[:2]:
                if any(k in ln for k in ("完成", "待办", "completed", "pending", "项")):
                    return ln[:max_chars] + ("…" if len(ln) > max_chars else "")
        if lines:
            return lines[0][:max_chars] + ("…" if len(lines[0]) > max_chars else "")
        return "任务列表已更新"

    return (content_str[:max_chars] + "…") if len(content_str) > max_chars else content_str


def _get_tool_step_label(tc_name: str, tc_args: dict) -> str:
    """根据工具名和参数生成业务可读的步骤描述，供 task_progress tool_call 使用。"""
    args = tc_args if isinstance(tc_args, dict) else {}
    labels = {
        "read_file": lambda a: f"读取文件：{(a.get('file_path') or '')[:50]}",
        "batch_read_files": lambda a: f"读取 {len(a.get('file_paths') or [])} 个文件",
        "edit_file": lambda a: f"修改文件：{(a.get('target_file') or '')[:50]}",
        "write_file": lambda a: f"写入文件：{(a.get('path') or '')[:50]}",
        "write_file_binary": lambda a: f"写入二进制：{(a.get('file_path') or '')[:50]}",
        "python_run": lambda a: "执行 Python 代码",
        "shell_run": lambda a: f"执行命令：{str(a.get('command') or '')[:40]}",
        "web_search": lambda a: f"搜索：{(a.get('query') or '')[:40]}",
        "glob": lambda a: f"扫描文件：{(a.get('pattern') or '')[:40]}",
        "grep": lambda a: f"搜索内容：{(a.get('pattern') or '')[:40]}",
        "search_knowledge": lambda a: f"检索知识库：{(a.get('query') or '')[:40]}",
        "think_tool": lambda a: "结构化思考",
        "task": lambda a: f"启动子任务：{str(a.get('description') or '')[:50]}",
    }
    fn = labels.get(tc_name)
    if fn is not None:
        try:
            return (fn(args) or "").strip() or f"执行：{tc_name}"
        except Exception as e:
            logger.debug("_get_tool_step_label failed for %s: %s", tc_name, e, exc_info=True)
            return f"执行：{tc_name}"
    return f"执行：{tc_name}"


def _extract_subagent_summary(content: str | list | None, max_len: int = 200) -> str:
    """从 subagent 返回内容中提取摘要：优先 JSON 多字段，其次 Markdown ## 段落，最后按句边界截断。"""
    if content is None:
        return ""
    if isinstance(content, list):
        raw = " ".join(
            (c.get("text", "") if isinstance(c, dict) else str(c)) for c in content[:5]
        ) if content else ""
    else:
        raw = content if isinstance(content, str) else str(content)
    if not raw.strip():
        return ""
    text = raw.strip()
    # 1) JSON
    if text.startswith("{"):
        try:
            parsed = json.loads(text)
            if isinstance(parsed, dict):
                for key in ("summary", "result_summary", "content", "key_points", "deliverables_created"):
                    v = parsed.get(key)
                    if isinstance(v, str) and v.strip():
                        return v.strip()[:max_len]
                    if isinstance(v, list) and v:
                        parts = [str(x)[:80] for x in v[:3]]
                        return "；".join(parts)[:max_len]
        except (json.JSONDecodeError, TypeError) as e:
            logger.debug("_extract_subagent_summary JSON parse failed: %s", e, exc_info=True)
    # 2) Markdown ## 段落
    if "## " in text:
        import re
        m = re.search(r"##\s*(?:summary|Summary|摘要)?\s*\n(.*?)(?=\n##|\Z)", text, re.DOTALL | re.IGNORECASE)
        if m:
            block = m.group(1).strip()
            if block:
                return _truncate_at_sentence(block, max_len)
        m = re.search(r"##\s+.+?\n(.*?)(?=\n##|\Z)", text, re.DOTALL)
        if m:
            block = m.group(1).strip()
            if block:
                return _truncate_at_sentence(block, max_len)
    # 3) 按句边界截断
    return _truncate_at_sentence(text, max_len)


def _truncate_at_sentence(text: str, max_len: int) -> str:
    """在 max_len 内按句号或换行截断，避免截在词中间。"""
    if len(text) <= max_len:
        return text
    cand = text[: max_len + 1]
    for sep in ("。\n", "。", ".\n", ". ", "\n\n", "\n"):
        idx = cand.rfind(sep)
        if idx > max_len // 2:
            return (cand[: idx + len(sep)].rstrip() or cand[:max_len])[:max_len]
    return cand.rstrip() or text[:max_len]


_ROUTER_INLINE_FASTPATH = str(
    os.environ.get("ROUTER_INLINE_FASTPATH", "true")
).strip().lower() in {"1", "true", "yes", "on"}

_DEBUG_LOG_PATH = Path(__file__).resolve().parents[3] / ".cursor" / "debug.log"


_ENABLE_DEBUG_LOG = os.environ.get("ENABLE_MAIN_GRAPH_DEBUG_LOG", "").lower() in ("1", "true", "yes")
_GUARDRAILS_MANAGER: GuardrailsManager | None = None
_GUARDRAILS_MANAGER_LOCK = threading.Lock()
_GUARDRAILS_PROMPT_CACHE: dict[str, tuple[float, str]] = {}
_GUARDRAILS_PROMPT_CACHE_LOCK = threading.Lock()


def _get_guardrails_manager() -> GuardrailsManager:
    global _GUARDRAILS_MANAGER
    if _GUARDRAILS_MANAGER is not None:
        return _GUARDRAILS_MANAGER
    with _GUARDRAILS_MANAGER_LOCK:
        if _GUARDRAILS_MANAGER is None:
            _GUARDRAILS_MANAGER = GuardrailsManager()
    return _GUARDRAILS_MANAGER


def _render_guardrails_cached(manager: GuardrailsManager, query: str, limit: int = 4) -> str:
    q = (query or "").strip()
    if not q:
        return ""
    cache_key = hashlib.sha1(f"{limit}:{q}".encode("utf-8")).hexdigest()
    now = time.perf_counter()
    if _GUARDRAILS_CACHE_TTL_MS > 0:
        with _GUARDRAILS_PROMPT_CACHE_LOCK:
            hit = _GUARDRAILS_PROMPT_CACHE.get(cache_key)
            if hit and hit[0] > now:
                return hit[1]
    result = manager.render_prompt_block(query=q, limit=limit) or ""
    if _GUARDRAILS_CACHE_TTL_MS <= 0:
        return result
    expire_at = now + (_GUARDRAILS_CACHE_TTL_MS / 1000.0)
    with _GUARDRAILS_PROMPT_CACHE_LOCK:
        _GUARDRAILS_PROMPT_CACHE[cache_key] = (expire_at, result)
        # 轻量裁剪：先清理过期项，再限制最大容量。
        if len(_GUARDRAILS_PROMPT_CACHE) > _GUARDRAILS_CACHE_MAX_SIZE:
            stale_keys = [k for k, (exp, _) in _GUARDRAILS_PROMPT_CACHE.items() if exp <= now]
            for k in stale_keys:
                _GUARDRAILS_PROMPT_CACHE.pop(k, None)
        while len(_GUARDRAILS_PROMPT_CACHE) > _GUARDRAILS_CACHE_MAX_SIZE:
            _GUARDRAILS_PROMPT_CACHE.pop(next(iter(_GUARDRAILS_PROMPT_CACHE)), None)
    return result


def _debug_log(hypothesis_id: str, location: str, message: str, data: dict) -> None:
    if not _ENABLE_DEBUG_LOG:
        return
    try:
        now_ms = int(time.time() * 1000)
        payload = {
            "id": f"log_{now_ms}_{hypothesis_id}",
            "timestamp": now_ms,
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
        logger.debug("main_graph debug log write failed: %s", e, exc_info=True)


def _update_thread_title(thread_id: str, title: str) -> None:
    """首条用户消息后异步写入 thread metadata.title，供列表与仪表盘展示。静默失败。"""
    if not thread_id or thread_id == "unknown" or not title or not is_valid_thread_id_uuid(thread_id):
        return
    base_url = os.environ.get("LANGGRAPH_API_URL", "http://127.0.0.1:2024").rstrip("/")
    url = f"{base_url}/threads/{thread_id}"
    try:
        data = json.dumps({"metadata": {"title": title}}).encode("utf-8")
        req = urllib.request.Request(url, data=data, method="PATCH")
        req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req, timeout=5) as resp:
            if 200 <= resp.status < 300:
                logger.debug("thread title updated: %s", thread_id)
    except Exception as e:
        logger.debug("update thread title failed (non-critical): %s", e)


def _update_thread_model_binding(thread_id: str, pinned_model: str, model_source: str) -> None:
    """为会话写入模型绑定信息（幂等，静默失败）。"""
    if not thread_id or thread_id == "unknown" or not pinned_model or not is_valid_thread_id_uuid(thread_id):
        return
    base_url = os.environ.get("LANGGRAPH_API_URL", "http://127.0.0.1:2024").rstrip("/")
    url = f"{base_url}/threads/{thread_id}"
    try:
        data = json.dumps(
            {
                "metadata": {
                    "pinned_model": pinned_model,
                    "thread_model": pinned_model,
                    "model_source": model_source or "auto",
                }
            }
        ).encode("utf-8")
        req = urllib.request.Request(url, data=data, method="PATCH")
        req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req, timeout=5) as resp:
            if 200 <= resp.status < 300:
                _THREAD_MODEL_BINDING_CACHE[thread_id] = (
                    time.monotonic(),
                    {
                        "thread_model": pinned_model,
                        "pinned_model": pinned_model,
                        "model_source": model_source or "auto",
                    },
                )
                while len(_THREAD_MODEL_BINDING_CACHE) > _THREAD_MODEL_BINDING_CACHE_MAX_SIZE:
                    oldest = min(_THREAD_MODEL_BINDING_CACHE.items(), key=lambda x: x[1][0])
                    _THREAD_MODEL_BINDING_CACHE.pop(oldest[0], None)
                logger.debug("thread model binding updated: %s -> %s", thread_id, pinned_model)
    except Exception as e:
        logger.debug("update thread model binding failed (non-critical): %s", e)


_THREAD_MODEL_BINDING_CACHE: Dict[str, tuple[float, Dict[str, str]]] = {}
_THREAD_MODEL_BINDING_CACHE_TTL_SEC = max(5, _env_int("THREAD_MODEL_BINDING_CACHE_TTL_SEC", 30))
_THREAD_MODEL_BINDING_CACHE_MAX_SIZE = max(100, _env_int("THREAD_MODEL_BINDING_CACHE_MAX_SIZE", 500))

# 流式 yield 时 messages 条数上限，超长会话仅保留最近 N 条以控制 CPU/内存与序列化体积
_YIELD_MESSAGES_TAIL_MAX = max(200, _env_int("YIELD_MESSAGES_TAIL_MAX", 500))

# Prepare 阶段专用线程池，避免与默认 executor 混用导致首包延迟抖动
_PREPARE_EXECUTOR = None
_PREPARE_EXECUTOR_LOCK = threading.Lock()


def _get_prepare_executor():
    global _PREPARE_EXECUTOR
    if _PREPARE_EXECUTOR is None:
        with _PREPARE_EXECUTOR_LOCK:
            if _PREPARE_EXECUTOR is None:
                from concurrent.futures import ThreadPoolExecutor
                _PREPARE_EXECUTOR = ThreadPoolExecutor(max_workers=4, thread_name_prefix="deepagent_prepare")
    return _PREPARE_EXECUTOR


def _get_thread_model_binding(thread_id: str) -> Dict[str, str]:
    """读取 thread metadata 中的模型绑定信息（带短 TTL 缓存）。"""
    if not thread_id or thread_id == "unknown" or not is_valid_thread_id_uuid(thread_id):
        return {}
    now = time.monotonic()
    cached = _THREAD_MODEL_BINDING_CACHE.get(thread_id)
    if cached and (now - float(cached[0])) < _THREAD_MODEL_BINDING_CACHE_TTL_SEC:
        return dict(cached[1] or {})
    base_url = os.environ.get("LANGGRAPH_API_URL", "http://127.0.0.1:2024").rstrip("/")
    url = f"{base_url}/threads/{thread_id}"
    try:
        with urllib.request.urlopen(url, timeout=3) as resp:
            raw = resp.read().decode("utf-8", errors="ignore")
        try:
            payload = json.loads(raw) if raw else {}
        except json.JSONDecodeError as je:
            logger.warning("_get_thread_model_binding JSON 解析失败 thread_id=%s: %s", thread_id, je)
            return {}
        metadata = payload.get("metadata") if isinstance(payload, dict) else {}
        if not isinstance(metadata, dict):
            metadata = {}
        bound_model = str(metadata.get("thread_model") or metadata.get("pinned_model") or "").strip()
        binding = {
            "thread_model": bound_model,
            "pinned_model": str(metadata.get("pinned_model") or "").strip(),
            "model_source": str(metadata.get("model_source") or "").strip(),
        }
        _THREAD_MODEL_BINDING_CACHE[thread_id] = (now, binding)
        while len(_THREAD_MODEL_BINDING_CACHE) > _THREAD_MODEL_BINDING_CACHE_MAX_SIZE:
            oldest = min(_THREAD_MODEL_BINDING_CACHE.items(), key=lambda x: x[1][0])
            _THREAD_MODEL_BINDING_CACHE.pop(oldest[0], None)
        return binding
    except Exception as e:
        logger.debug("get thread model binding failed (non-critical): %s", e)
        return {}


def _compute_queue_wait_ms(enqueued_at_raw: object) -> int:
    try:
        if isinstance(enqueued_at_raw, (int, float)):
            now_ms = int(time.time() * 1000)
            return max(0, now_ms - int(enqueued_at_raw))
        if isinstance(enqueued_at_raw, str) and enqueued_at_raw.strip():
            from datetime import datetime, timezone
            ts = datetime.fromisoformat(enqueued_at_raw.strip().replace("Z", "+00:00"))
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
            return max(0, int((datetime.now(timezone.utc) - ts).total_seconds() * 1000))
    except Exception as e:
        logger.debug("_compute_queue_wait_ms parse failed: %s", e)
        return 0
    return 0


def _estimate_cost_usd(total_tokens: int, cost_level: str) -> float:
    # 以 cost_level 做统一近似定价，优先保证预算守卫可用（后续可替换为模型级真实单价）
    per_1k = {
        "zero": 0.0,
        "low": 0.001,
        "medium": 0.005,
        "high": 0.02,
    }.get(str(cost_level or "unknown").lower(), 0.003)
    return max(0.0, (float(total_tokens or 0) / 1000.0) * per_1k)


def _record_billing_usage(
    *,
    model_id: str,
    task_type: str,
    prompt_tokens: int,
    completion_tokens: int,
    estimated_cost_usd: float,
    is_cloud_model: bool = False,
) -> None:
    try:
        from backend.config.store_namespaces import NS_BILLING_USAGE

        store = get_sqlite_store()
        if store is None:
            logger.warning("billing usage 记录跳过：store 不可用")
            return
        model_key = str(model_id or "unknown").replace("/", "_").replace(":", "_")
        key = f"model_usage:{model_key}"
        out = store.get(NS_BILLING_USAGE, key)
        current = getattr(out, "value", out) if out else {}
        value = dict(current) if isinstance(current, dict) else {}
        value["model_id"] = model_id or "unknown"
        value["task_type"] = task_type or "chat"
        value["prompt_tokens"] = int(value.get("prompt_tokens", 0) or 0) + max(0, int(prompt_tokens or 0))
        value["completion_tokens"] = int(value.get("completion_tokens", 0) or 0) + max(0, int(completion_tokens or 0))
        value["total_tokens"] = int(value.get("total_tokens", 0) or 0) + max(
            0, int(prompt_tokens or 0) + int(completion_tokens or 0)
        )
        value["estimated_cost_usd"] = round(
            float(value.get("estimated_cost_usd", 0.0) or 0.0) + max(0.0, float(estimated_cost_usd or 0.0)),
            6,
        )
        value["updated_at"] = int(time.time() * 1000)
        store.put(NS_BILLING_USAGE, key, value)
        if is_cloud_model:
            day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
            cloud_key = f"cloud_model_requests:{day}"
            cloud_out = store.get(NS_BILLING_USAGE, cloud_key)
            cloud_raw = getattr(cloud_out, "value", cloud_out) if cloud_out else {}
            cloud_value = dict(cloud_raw) if isinstance(cloud_raw, dict) else {}
            cloud_value["date"] = day
            cloud_value["count"] = int(cloud_value.get("count", 0) or 0) + 1
            cloud_value["prompt_tokens"] = int(cloud_value.get("prompt_tokens", 0) or 0) + max(0, int(prompt_tokens or 0))
            cloud_value["completion_tokens"] = int(cloud_value.get("completion_tokens", 0) or 0) + max(0, int(completion_tokens or 0))
            cloud_value["total_tokens"] = int(cloud_value.get("total_tokens", 0) or 0) + max(
                0, int(prompt_tokens or 0) + int(completion_tokens or 0)
            )
            cloud_value["estimated_cost_usd"] = round(
                float(cloud_value.get("estimated_cost_usd", 0.0) or 0.0) + max(0.0, float(estimated_cost_usd or 0.0)),
                6,
            )
            cloud_value["updated_at"] = int(time.time() * 1000)
            store.put(NS_BILLING_USAGE, cloud_key, cloud_value)
    except Exception as e:
        logger.warning("记录 billing usage 失败（计费可能漏记）: %s", e)


def _resolve_runtime_retry_count(base_retry_count: int, final_state: object) -> int:
    retry_count = max(0, int(base_retry_count or 0))
    try:
        if isinstance(final_state, dict):
            retry_count = max(retry_count, int(final_state.get("retry_count", 0) or 0))
    except Exception as e:
        logger.debug("_resolve_runtime_retry_count failed: %s", e, exc_info=True)
    return retry_count


def _resolve_model_id_with_route_prefix(configurable: Dict[str, Any] | None) -> str:
    configurable = configurable if isinstance(configurable, dict) else {}
    has_resolved = bool(configurable.get("resolved_model_id") or configurable.get("actual_model_id"))
    model_id = str(
        configurable.get("resolved_model_id")
        or configurable.get("actual_model_id")
        or configurable.get("pinned_model")
        or configurable.get("thread_model")
        or configurable.get("model")
        or ""
    )
    route_reason = str(configurable.get("model_route_reason") or "direct")
    if route_reason == "fallback" and model_id and not has_resolved:
        return f"fallback:{model_id}"
    return model_id


def _is_cloud_model_by_id(model_id: str) -> bool:
    raw = str(model_id or "").strip()
    if not raw:
        return False
    if raw.startswith("fallback:"):
        raw = raw.split(":", 1)[1].strip()
    try:
        from backend.engine.agent.model_manager import get_model_manager

        info = get_model_manager().get_model_info(raw)
        tier = str(getattr(info, "tier", "local") or "local").strip().lower()
        return tier.startswith("cloud-")
    except Exception as e:
        logger.debug("_is_cloud_model_by_id fallback: %s", e)
        return False


# ============================================================
# 生产级存储配置（使用统一路径模块）
# ============================================================
try:
    from backend.tools.base.paths import (
        get_project_root, DATA_PATH, CHECKPOINTS_DB_PATH, STORE_DB_PATH
    )
    PROJECT_ROOT = get_project_root()
    DATA_DIR = DATA_PATH
    CHECKPOINTS_DB = CHECKPOINTS_DB_PATH
    STORE_DB = STORE_DB_PATH
except ImportError:
    # 回退：直接计算路径
    PROJECT_ROOT = Path(__file__).parent.parent.parent.parent
    DATA_DIR = PROJECT_ROOT / "data"
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    CHECKPOINTS_DB = DATA_DIR / "checkpoints.db"
    STORE_DB = DATA_DIR / "store.db"

# 全局存储实例（懒加载）
_checkpointer = None
_store = None


def _normalizing_checkpointer_normalize(checkpoint: Dict[str, Any]) -> Dict[str, Any]:
    """对 checkpoint 的 channel_values[\"messages\"] 做 content 归一化。"""
    if not checkpoint:
        return checkpoint
    channel_values = checkpoint.get("channel_values")
    if not isinstance(channel_values, dict):
        return checkpoint
    messages = channel_values.get("messages")
    if messages is None:
        return checkpoint
    try:
        from backend.engine.utils.message_normalize import normalize_messages_content_to_string
        channel_values = dict(channel_values)
        channel_values["messages"] = normalize_messages_content_to_string(list(messages))
        return dict(checkpoint, channel_values=channel_values)
    except Exception as e:
        logger.debug("NormalizingCheckpointer _normalize: %s", e)
        return checkpoint


try:
    from langgraph.checkpoint.base import BaseCheckpointSaver
except ImportError:
    BaseCheckpointSaver = object  # type: ignore[misc, assignment]


class NormalizingCheckpointer(BaseCheckpointSaver):
    """包装底层 checkpointer，在 get_tuple/aget_tuple 返回前对 channel_values[\"messages\"] 做 content 归一化，避免 list content 导致上游 API 400。"""

    def __init__(self, underlying: Any):
        super().__init__()
        self._underlying = underlying

    def _normalize_checkpoint(self, checkpoint: Dict[str, Any]) -> Dict[str, Any]:
        return _normalizing_checkpointer_normalize(checkpoint)

    def get_tuple(self, config: Dict[str, Any]) -> Any:
        try:
            from langgraph.checkpoint.base import CheckpointTuple
        except ImportError:
            CheckpointTuple = None
        out = self._underlying.get_tuple(config)
        if out is None or CheckpointTuple is None:
            return out
        try:
            cp = getattr(out, "checkpoint", None) or (out[1] if isinstance(out, (list, tuple)) and len(out) > 1 else None)
            if cp is None:
                return out
            normalized_cp = self._normalize_checkpoint(cp if isinstance(cp, dict) else dict(cp))
            if normalized_cp is cp:
                return out
            return CheckpointTuple(
                config=getattr(out, "config", out[0]) if hasattr(out, "config") else out[0],
                checkpoint=normalized_cp,
                metadata=getattr(out, "metadata", out[2]) if hasattr(out, "metadata") else out[2],
                parent_config=getattr(out, "parent_config", None) if hasattr(out, "parent_config") else (out[3] if len(out) > 3 else None),
                pending_writes=getattr(out, "pending_writes", None) if hasattr(out, "pending_writes") else (out[4] if len(out) > 4 else None),
            )
        except Exception as e:
            logger.debug("NormalizingCheckpointer get_tuple: %s", e)
            return out

    async def aget_tuple(self, config: Dict[str, Any]) -> Any:
        try:
            from langgraph.checkpoint.base import CheckpointTuple
        except ImportError:
            CheckpointTuple = None
        out = await self._underlying.aget_tuple(config)
        if out is None or CheckpointTuple is None:
            return out
        try:
            cp = getattr(out, "checkpoint", None) or (out[1] if isinstance(out, (list, tuple)) and len(out) > 1 else None)
            if cp is None:
                return out
            normalized_cp = self._normalize_checkpoint(cp if isinstance(cp, dict) else dict(cp))
            if normalized_cp is cp:
                return out
            return CheckpointTuple(
                config=getattr(out, "config", out[0]) if hasattr(out, "config") else out[0],
                checkpoint=normalized_cp,
                metadata=getattr(out, "metadata", out[2]) if hasattr(out, "metadata") else out[2],
                parent_config=getattr(out, "parent_config", None) if hasattr(out, "parent_config") else (out[3] if len(out) > 3 else None),
                pending_writes=getattr(out, "pending_writes", None) if hasattr(out, "pending_writes") else (out[4] if len(out) > 4 else None),
            )
        except Exception as e:
            logger.debug("NormalizingCheckpointer aget_tuple: %s", e)
            return out

    def get(self, config: Dict[str, Any]) -> Any:
        t = self.get_tuple(config)
        return t.checkpoint if t and hasattr(t, "checkpoint") else None

    def put(self, config: Dict[str, Any], checkpoint: Any, metadata: Any, new_versions: Any) -> Any:
        if checkpoint is not None and isinstance(checkpoint, dict):
            normalized = self._normalize_checkpoint(checkpoint)
            if normalized is not checkpoint:
                checkpoint = normalized
        return self._underlying.put(config, checkpoint, metadata, new_versions)

    def put_writes(self, config: Dict[str, Any], writes: Any, task_id: str, task_path: str = "") -> None:
        return self._underlying.put_writes(config, writes, task_id, task_path)

    def list(self, config: Optional[Dict[str, Any]] = None, *, filter: Optional[Dict[str, Any]] = None, before: Any = None, limit: Optional[int] = None) -> Any:
        return self._underlying.list(config, filter=filter, before=before, limit=limit)

    def delete_thread(self, thread_id: str) -> None:
        return self._underlying.delete_thread(thread_id)

    async def aget(self, config: Dict[str, Any]) -> Any:
        t = await self.aget_tuple(config)
        return t.checkpoint if t and hasattr(t, "checkpoint") else None

    async def aput(self, config: Dict[str, Any], checkpoint: Any, metadata: Any, new_versions: Any) -> Any:
        if checkpoint is not None and isinstance(checkpoint, dict):
            normalized = self._normalize_checkpoint(checkpoint)
            if normalized is not checkpoint:
                checkpoint = normalized
        return await self._underlying.aput(config, checkpoint, metadata, new_versions)

    async def aput_writes(self, config: Dict[str, Any], writes: Any, task_id: str, task_path: str = "") -> None:
        return await self._underlying.aput_writes(config, writes, task_id, task_path)

    async def alist(self, config: Optional[Dict[str, Any]] = None, *, filter: Optional[Dict[str, Any]] = None, before: Any = None, limit: Optional[int] = None) -> Any:
        return await self._underlying.alist(config, filter=filter, before=before, limit=limit)

    async def adelete_thread(self, thread_id: str) -> None:
        return await self._underlying.adelete_thread(thread_id)
_init_lock = threading.Lock()
_store_fallback_reason: Optional[str] = None  # 非空表示 Store 已降级，健康检查可读


def get_sqlite_checkpointer():
    """获取 SQLite Checkpointer（生产级，文件持久化）
    
    ✅ 生产级特性：
    - 文件持久化，重启不丢失
    - check_same_thread=False 支持多线程
    - WAL 模式提升并发性能
    - 可配置的缓存大小和超时
    
    Returns:
        SqliteSaver: SQLite 检查点存储器
    """
    global _checkpointer
    if _checkpointer is not None:
        return _checkpointer
    with _init_lock:
        if _checkpointer is not None:
            return _checkpointer
        # 尝试多种导入方式
        SqliteSaver = None
        
        # 方式 1: langgraph_checkpoint_sqlite（新版，可选依赖）
        try:
            from langgraph_checkpoint_sqlite import SqliteSaver  # type: ignore[import-not-found]
            logger.info("使用 langgraph_checkpoint_sqlite")
        except ImportError:
            pass
        
        # 方式 2: langgraph.checkpoint.sqlite（旧版）
        if SqliteSaver is None:
            try:
                from langgraph.checkpoint.sqlite import SqliteSaver
                logger.info("使用 langgraph.checkpoint.sqlite")
            except ImportError:
                pass
        
        # 方式 3: 使用内存存储作为备选
        if SqliteSaver is None:
            try:
                from langgraph.checkpoint.memory import MemorySaver
                _checkpointer = NormalizingCheckpointer(MemorySaver())
                logger.warning("⚠️ SQLite 不可用，使用 MemorySaver（会话重启后丢失状态）")
                return _checkpointer
            except ImportError as e:
                logger.error(f"❌ MemorySaver 也不可用: {e}")
                return None
        
        # SQLite 可用，进行配置（try-finally 确保异常时连接被关闭，避免泄漏）
        conn = None
        try:
            import sqlite3
            
            # 获取可配置参数（LOW_MEMORY_MODE 时已缩小）
            try:
                from backend.engine.agent.deep_agent import Config
                sqlite_timeout = Config.SQLITE_TIMEOUT
                cache_size_kb = getattr(Config, "SQLITE_CACHE_SIZE_KB", 64000)
                mmap_mb = getattr(Config, "SQLITE_MMAP_SIZE_MB", 64)
            except ImportError:
                sqlite_timeout = 30.0
                cache_size_kb = 64000
                mmap_mb = 64
            
            # ✅ 生产级 SQLite 配置
            conn = sqlite3.connect(
                str(CHECKPOINTS_DB),
                check_same_thread=False,
                timeout=sqlite_timeout,
            )
            
            # ✅ 优化 SQLite 性能（cache_size 负值表示 KB）
            cursor = conn.cursor()
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.execute("PRAGMA synchronous=NORMAL")
            cursor.execute("PRAGMA cache_size=-%d" % max(1, cache_size_kb))
            cursor.execute("PRAGMA temp_store=FILE")
            cursor.execute("PRAGMA mmap_size=%d" % (mmap_mb * 1024 * 1024))
            cursor.execute("PRAGMA page_size=4096")
            cursor.close()
            
            _checkpointer = NormalizingCheckpointer(SqliteSaver(conn))
            conn = None  # 所有权已交给 SqliteSaver，不再在此处关闭
            logger.info(f"✅ SQLite Checkpointer 初始化完成: {CHECKPOINTS_DB}")
        except Exception as e:
            logger.error(f"❌ SQLite Checkpointer 初始化失败: {e}")
            if conn is not None:
                try:
                    conn.close()
                except Exception as e:
                    logger.debug("checkpointer conn.close: %s", e)
                conn = None
            # 降级到 MemorySaver
            try:
                from langgraph.checkpoint.memory import MemorySaver
                _checkpointer = NormalizingCheckpointer(MemorySaver())
                logger.warning("⚠️ 降级到 MemorySaver")
            except ImportError:
                _checkpointer = None
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception as e:
                    logger.debug("checkpointer finally conn.close: %s", e)
    return _checkpointer


class _MinimalFallbackStore:
    """最小降级 Store：当 SqliteStore 与 InMemoryStore 均不可用时使用，仅返回空数据，保证接口不返回 None。"""

    def list(self, namespace):
        return []

    def get(self, namespace, key):
        return None

    def put(self, namespace, key, value):
        pass

    def delete(self, namespace, key):
        pass


def get_sqlite_store():
    """获取 SQLite Store（生产级，长期记忆）
    
    ✅ 生产级特性：
    - 文件持久化，重启不丢失
    - WAL 模式提升并发性能
    - 自动创建表结构
    
    Returns:
        SqliteStore: SQLite 存储器
    """
    global _store, _store_fallback_reason
    if _store is not None:
        return _store
    with _init_lock:
        if _store is not None:
            return _store
        # 尝试多种导入方式
        SqliteStore = None
        
        # 方式 1: langgraph.store.sqlite（正确的类名是 SqliteStore，不是 SQLiteStore）
        try:
            from langgraph.store.sqlite import SqliteStore
            logger.info("使用 langgraph.store.sqlite.SqliteStore")
        except ImportError:
            pass
        
        # 方式 2: 从 base 导入
        if SqliteStore is None:
            try:
                from langgraph.store.sqlite.base import SqliteStore
                logger.info("使用 langgraph.store.sqlite.base.SqliteStore")
            except ImportError:
                pass
        
        # 方式 3: 使用内存存储作为备选
        if SqliteStore is None:
            _store_fallback_reason = "sqlite_store_unavailable"
            try:
                from langgraph.store.memory import InMemoryStore
                _store = InMemoryStore()
                logger.warning(
                    "⚠️ Store 降级: SQLite Store 不可用，使用 InMemoryStore（持久化丢失，重启后数据清空）。"
                    " 健康检查可读取 _store_fallback_reason 以发现此状态。"
                )
                return _store
            except ImportError as e:
                logger.error("❌ InMemoryStore 也不可用: %s", e)
                _store = _MinimalFallbackStore()
                logger.warning("⚠️ 使用最小降级 Store（仅空数据），协作统计等依赖 Store 的接口将返回空")
                return _store
        
        # SQLite Store 可用（try-finally 确保异常时连接被关闭，避免泄漏）
        conn = None
        try:
            import sqlite3
            # 确保 store 文件所在目录存在且可写，避免因路径未创建导致连接失败
            STORE_DB.parent.mkdir(parents=True, exist_ok=True)
            try:
                from backend.engine.agent.deep_agent import Config
                cache_size_kb = getattr(Config, "SQLITE_CACHE_SIZE_KB", 64000)
                mmap_mb = getattr(Config, "SQLITE_MMAP_SIZE_MB", 64)
                store_timeout = getattr(Config, "SQLITE_TIMEOUT", 30.0)
            except ImportError:
                cache_size_kb = 64000
                mmap_mb = 64
                store_timeout = 30.0
            conn = sqlite3.connect(
                str(STORE_DB),
                check_same_thread=False,
                isolation_level=None,
                timeout=store_timeout,
            )
            cur = conn.cursor()
            cur.execute("PRAGMA journal_mode=WAL")
            cur.execute("PRAGMA synchronous=NORMAL")
            cur.execute("PRAGMA cache_size=-%d" % max(1, cache_size_kb))
            cur.execute("PRAGMA mmap_size=%d" % (mmap_mb * 1024 * 1024))
            cur.close()
            _store = SqliteStore(conn=conn)
            _store.setup()  # 初始化表结构
            conn = None  # 所有权已交给 SqliteStore，不再在此处关闭
            logger.info(f"✅ SQLite Store 初始化完成: {STORE_DB}")
        except Exception as e:
            _store_fallback_reason = "sqlite_init_failed"
            logger.error("❌ SQLite Store 初始化失败: %s", e)
            if conn is not None:
                try:
                    conn.close()
                except Exception as close_e:
                    logger.debug("store init conn.close: %s", close_e)
                conn = None
            # 降级到 InMemoryStore
            try:
                from langgraph.store.memory import InMemoryStore
                _store = InMemoryStore()
                logger.warning(
                    "⚠️ Store 降级: 使用 InMemoryStore（持久化丢失）。原因: %s。"
                    " 健康检查可读取 main_graph._store_fallback_reason。", e
                )
            except ImportError:
                _store = _MinimalFallbackStore()
                logger.warning("⚠️ 使用最小降级 Store（仅空数据）")
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception as e:
                    logger.debug("store finally conn.close: %s", e)
    return _store


def get_store_fallback_reason() -> Optional[str]:
    """若 Store 已降级则返回原因（供健康检查使用）；否则返回 None。"""
    return _store_fallback_reason


def cleanup_storage():
    """清理存储连接（优雅关闭）。SqliteSaver/SqliteStore 若持有 conn 则由其自行管理，此处仅置空引用。"""
    global _checkpointer, _store
    with _init_lock:
        if _checkpointer is not None:
            try:
                # SqliteSaver 可能持有 conn，仅当明确暴露时关闭，避免重复关闭导致错误
                if hasattr(_checkpointer, "conn") and _checkpointer.conn is not None:
                    try:
                        _checkpointer.conn.close()
                    except Exception as e:
                        logger.debug("cleanup_storage checkpointer.conn.close: %s", e)
                _checkpointer = None
                logger.info("✅ Checkpointer 连接已关闭")
            except Exception as e:
                logger.warning(f"⚠️ 关闭 Checkpointer 时出错: {e}")

        if _store is not None:
            try:
                if hasattr(_store, "close"):
                    _store.close()
                elif hasattr(_store, "conn") and _store.conn is not None:
                    try:
                        _store.conn.close()
                    except Exception as e:
                        logger.debug("cleanup_storage store.conn.close: %s", e)
                _store = None
                logger.info("✅ Store 连接已关闭")
            except Exception as e:
                logger.warning(f"⚠️ 关闭 Store 时出错: {e}")


def create_router_graph(
    checkpointer=None,
    store=None,
    use_sqlite: bool = True,
):
    """
    创建主路由 Graph
    
    ✅ 流式输出：使用 Subgraph 机制，DeepAgent 内部所有事件自动传递
    ✅ 动态模型：通过 config.configurable.model 传递，在 LLM 创建时读取
    ✅ 生产级存储：支持手动注入 SQLite checkpointer 和 store
    
    Args:
        checkpointer: 可选，手动注入的 checkpointer（生产环境推荐）
        store: 可选，手动注入的 store（生产环境推荐）
        use_sqlite: 是否使用 SQLite 存储（默认 True）
    
    Returns:
        CompiledStateGraph: 编译后的 Graph，可直接被 LangGraph Server 使用
    """
    # 创建状态图
    workflow = StateGraph(AgentState)
    
    # ============================================================
    # 添加节点
    # ============================================================
    
    def _to_bool(raw: Any) -> bool:
        if isinstance(raw, bool):
            return raw
        if isinstance(raw, str):
            return raw.strip().lower() in {"1", "true", "yes", "on"}
        return False

    def _extract_last_human_text(messages: list[Any]) -> str:
        for msg in reversed(messages or []):
            msg_type = getattr(msg, "type", "")
            if msg_type == "human" or isinstance(msg, HumanMessage):
                content = getattr(msg, "content", "")
                if isinstance(content, str):
                    return content
                return str(content or "")
        return ""

    def _extract_last_ai_content(messages: list[Any]) -> str:
        """取最后一条 AIMessage 的文本内容，供 Plan 落盘用。"""
        for msg in reversed(messages or []):
            if getattr(msg, "type", "") == "ai" or isinstance(msg, AIMessage):
                content = getattr(msg, "content", "")
                if isinstance(content, str):
                    return content.strip()
                if isinstance(content, list):
                    parts = []
                    for block in content:
                        if isinstance(block, dict) and block.get("type") == "text":
                            parts.append(str(block.get("text", "") or ""))
                        elif isinstance(block, str):
                            parts.append(block)
                    return "\n".join(parts).strip() if parts else ""
                return str(content or "").strip()
        return ""

    def _safe_plan_filename(thread_id: str) -> str:
        """防止 path traversal：仅允许安全字符作为计划文件名。"""
        s = (thread_id or "").strip().replace("..", "_").replace("/", "_").replace("\\", "_")
        return s if s else "unknown"

    def _write_plan_to_workspace(state: dict, config: Optional[dict]) -> Optional[Path]:
        """将 Plan 阶段最后一条 AI 回复写入 .maibot/plans/<thread_id>.md，返回路径。"""
        configurable = dict((config or {}).get("configurable", {})) if isinstance(config, dict) else {}
        thread_id = str(configurable.get("thread_id") or "").strip()
        workspace_path = str(configurable.get("workspace_path") or "").strip()
        if not thread_id:
            return None
        safe_name = _safe_plan_filename(thread_id)
        try:
            root = Path(workspace_path).resolve() if workspace_path and Path(workspace_path).is_dir() else None
        except Exception as e:
            logger.debug("_persist_plan_path Path resolve: %s", e)
            root = None
        if root is None:
            try:
                from backend.tools.base.paths import get_workspace_root
                root = get_workspace_root()
            except Exception as e:
                logger.debug("_persist_plan_path get_workspace_root: %s", e)
                return None
        plan_content = _extract_last_ai_content(state.get("messages") or [])
        if not plan_content:
            return None
        plan_dir = root / ".maibot" / "plans"
        plan_dir.mkdir(parents=True, exist_ok=True)
        plan_path = plan_dir / f"{safe_name}.md"
        plan_path.write_text(plan_content, encoding="utf-8")
        logger.debug("[Plan] 计划已落盘: %s", plan_path)
        return plan_path

    def _resolve_plan_path_for_thread(thread_id: str, workspace_path: str) -> Optional[Path]:
        """按约定路径解析当前线程的计划文件（仅解析不写入），存在则返回 Path 否则 None。"""
        raw = str(thread_id or "").strip()
        workspace_path = str(workspace_path or "").strip()
        if not raw:
            return None
        safe_name = _safe_plan_filename(raw)
        try:
            root = Path(workspace_path).resolve() if workspace_path and Path(workspace_path).is_dir() else None
        except Exception as e:
            logger.debug("_resolve_plan_path Path resolve: %s", e)
            root = None
        if root is None:
            try:
                from backend.tools.base.paths import get_workspace_root
                root = get_workspace_root()
            except Exception as e:
                logger.debug("_resolve_plan_path get_workspace_root: %s", e)
                return None
        plan_path = root / ".maibot" / "plans" / f"{safe_name}.md"
        return plan_path if plan_path.is_file() else None

    def _extract_mode_from_messages(messages: list[Any]) -> str:
        mode = "agent"
        try:
            # 优先取最近一条携带 mode 的消息，避免仅看最后一条导致路由误判。
            for msg in reversed(messages or []):
                kwargs = getattr(msg, "additional_kwargs", {}) or {}
                raw_mode = str(kwargs.get("mode") or "").strip().lower()
                if raw_mode in {"agent", "ask", "plan", "debug", "review"}:
                    mode = raw_mode
                    break
        except Exception as e:
            logger.warning("_extract_mode_from_messages fallback to agent: %s", e)
            mode = "agent"
        return mode

    def _merge_configurable_overrides(config: Optional[dict], overrides: dict[str, Any]) -> dict:
        base = dict(config or {}) if isinstance(config, dict) else {}
        configurable = dict(base.get("configurable", {})) if isinstance(base.get("configurable"), dict) else {}
        configurable.update(overrides or {})
        base["configurable"] = configurable
        return base

    def _prepare_agent_config(messages, config, thread_model_binding=None):
        """准备 deepagent 运行配置，含内联规则预分析（原 pre_analysis_node 逻辑）。
        thread_model_binding: 可选，由调用方通过 asyncio.to_thread(_get_thread_model_binding, thread_id) 预取，避免阻塞事件循环。
        """
        query = ""
        if messages:
            last_msg = messages[-1]
            query = last_msg.content if hasattr(last_msg, "content") else (last_msg.get("content", "") if isinstance(last_msg, dict) else str(last_msg))
        configurable = dict(config.get("configurable", {})) if config and isinstance(config, dict) else {}
        thread_id = str(configurable.get("thread_id") or "").strip()
        requested_model = str(configurable.get("model") or configurable.get("model_id") or "").strip()
        # 仅当请求未带显式模型（为空或 "auto"）时，才从 thread metadata 填入 thread_model/pinned_model；
        # 否则以用户当前选择为准，实现「选哪个模型就走哪个通道」。
        use_binding = not requested_model or requested_model == "auto"
        if thread_id and thread_id != "unknown" and use_binding:
            binding = thread_model_binding if thread_model_binding is not None else _get_thread_model_binding(thread_id)
            bound_thread_model = str(binding.get("thread_model") or "").strip()
            if bound_thread_model and not str(configurable.get("thread_model") or "").strip():
                configurable["thread_model"] = bound_thread_model
            bound_pinned_model = str(binding.get("pinned_model") or "").strip()
            if bound_pinned_model and not str(configurable.get("pinned_model") or "").strip():
                configurable["pinned_model"] = bound_pinned_model
        elif thread_id and thread_id != "unknown" and requested_model and requested_model != "auto":
            bound = thread_model_binding if thread_model_binding is not None else _get_thread_model_binding(thread_id)
            bound_thread_model = str(bound.get("thread_model") or "").strip()
            if bound_thread_model and bound_thread_model != requested_model:
                configurable["model_route_reason"] = "explicit_model_overrides_thread"
        raw_mode = str(configurable.get("mode") or "").strip().lower()
        if raw_mode not in {"agent", "ask", "plan", "debug", "review"}:
            raw_mode = _extract_mode_from_messages(messages or [])
        mode = raw_mode if raw_mode in {"agent", "ask", "plan", "debug", "review"} else "agent"
        configurable["mode"] = mode
        # Plan 模式图级确认门控：
        # - 前端显式传 plan_confirmed=true 优先
        # - 若前端遗漏但用户消息明确“确认执行计划”，后端兜底识别
        if mode == "plan":
            forced_phase = str(configurable.get("plan_phase") or "").strip().lower()
            if forced_phase == "planning":
                plan_confirmed = False
            elif forced_phase == "execution":
                plan_confirmed = True
            else:
                plan_confirmed = _to_bool(configurable.get("plan_confirmed"))
            configurable["plan_confirmed"] = plan_confirmed
            configurable["plan_phase"] = "execution" if plan_confirmed else "planning"

        # 规则预分析（零延迟替代独立 LLM 节点）：仅补充 configurable 中缺失的字段
        if query and "task_type" not in configurable:
            low = query.lower()
            configurable["task_type"] = (
                "document_analysis"
                if any(k in low for k in ("文档", "报告", "pdf", "合同"))
                else "chat"
            )
        if "business_domain" not in configurable:
            configurable["business_domain"] = "general"
        # 插件执行面可观测：_active_plugin_agents / _active_plugin_hooks / _active_plugin_mcp_configs
        # 由 deep_agent 从 PluginLoader 注入；MCP 通过 mcp_servers.json 同步启用并接入 MCPMiddleware。

        memory_scope = resolve_memory_scope(configurable)
        configurable.setdefault("workspace_id", memory_scope["workspace_id"])
        configurable["user_id"] = memory_scope["user_id"]
        configurable.setdefault("memory_scope_mode", memory_scope["memory_scope_mode"])
        configurable.setdefault("memory_shared_enabled", memory_scope["memory_shared_enabled"])
        if "request_id" not in configurable or not str(configurable.get("request_id") or "").strip():
            configurable["request_id"] = str(uuid.uuid4())
        if "request_enqueued_at" not in configurable:
            configurable["request_enqueued_at"] = int(time.time() * 1000)
        # 透传最后一条用户文本给下游 Agent 组装阶段，用于按需激活扩展工具（deferred schema）。
        if query and not str(configurable.get("last_user_message") or "").strip():
            configurable["last_user_message"] = str(query)
        if "session_id" not in configurable:
            configurable["session_id"] = configurable.get("thread_id", "unknown")
        if "task_key" not in configurable:
            configurable["task_key"] = configurable.get("thread_id", "unknown")
        if "task_type" not in configurable:
            configurable["task_type"] = "chat"
        if "cost_tier" not in configurable:
            configurable["cost_tier"] = "medium"
        configurable["queue_wait_ms"] = _compute_queue_wait_ms(configurable.get("request_enqueued_at"))
        # 单轮搜索次数软性提示：统计上一轮 assistant 消息中 search_knowledge/web_search 调用次数
        _search_tools = {"search_knowledge", "web_search"}
        _last_round_search_count = 0
        for m in reversed(messages or []):
            _role = getattr(m, "type", None) or getattr(m, "role", None) or (m.get("type") if isinstance(m, dict) else None) or (m.get("role") if isinstance(m, dict) else None)
            if str(_role) in ("ai", "assistant"):
                _tcs = getattr(m, "tool_calls", None) or (m.get("tool_calls") if isinstance(m, dict) else None) or []
                for _tc in _tcs if isinstance(_tcs, list) else []:
                    _name = (_tc.get("name") if isinstance(_tc, dict) else None) or getattr(_tc, "name", None)
                    if _name and str(_name).strip() in _search_tools:
                        _last_round_search_count += 1
                break
        configurable["_search_call_count_last_round"] = _last_round_search_count
        # 注入当前模型 context_length，供 inject_runtime_context 写入 user_info，便于 LLM 知悉窗口与策略
        if not configurable.get("context_length"):
            try:
                from backend.engine.agent.model_manager import get_model_manager
                mgr = get_model_manager()
                resolved = mgr.get_model(config) if config else None
                if resolved:
                    mc = mgr.get_model_config(resolved)
                    if mc and mc.get("context_length"):
                        configurable["context_length"] = int(mc["context_length"])
            except Exception as e:
                logger.debug("_prepare_agent_config get_model/context_length: %s", e)
        if logger.isEnabledFor(logging.DEBUG):
            logger.debug(
                "[context_verify] _prepare_agent_config 出口: thread_id=%s, has workspace_path=%s, has editor_path=%s, open_files=%s",
                (configurable.get("thread_id") or "")[:12],
                bool(str(configurable.get("workspace_path") or "").strip()),
                bool(str(configurable.get("editor_path") or "").strip()),
                len(configurable.get("open_files") or []),
            )
        return query, mode, {**(config or {}), "configurable": configurable}, configurable

    async def _stream_agent_messages(agent, state, config_with_mode):
        """封装 astream，便于后续独立优化流式层。"""
        try:
            async for chunk in agent.astream(state, config_with_mode, stream_mode="messages"):
                yield chunk
        except asyncio.TimeoutError as e:
            logger.warning("DeepAgent astream timeout: %s", e)
            raise
        except Exception as e:
            logger.exception("DeepAgent astream failed: %s", e)
            raise

    workflow.add_node("router", router_node)
    
    # ✅ 使用 DeepAgent Graph（支持动态模型切换 + 流式输出 + 学习上下文）
    # 
    # 重要：为了支持流式输出，我们需要使用异步生成器
    # LangGraph 会自动处理子图的流式事件传递
    #
    async def deepagent_node(state, config=None):
        """DeepAgent 节点包装器 - 支持动态模型切换 + 流式输出 + 执行日志
        
        功能：
        1. 获取 Agent（延迟创建，支持模型切换）
        2. 从消息中提取模式信息（只读取，不修改消息结构）
        3. 使用 astream 进行流式调用
        4. 记录执行日志（用于 Debug 模式分析）
        
        设计原则：
        - 节点只负责调用 Agent，不注入额外的系统消息
        - 系统提示词由 create_deep_agent 的 system_prompt 参数处理
        - 上下文管理由 SummarizationMiddleware 自动处理
        """
        node_start_ts = __import__("time").perf_counter()
        messages = state.get("messages", [])
        _fixed_messages = _normalize_tool_message_ids(messages)
        _fixed_messages = _normalize_messages_system_first(_fixed_messages)
        _fixed_messages = _normalize_messages_content_to_string(_fixed_messages)
        if _fixed_messages is not messages:
            state = {**state, "messages": _fixed_messages}
            messages = _fixed_messages
        _cfg = (config or {}).get("configurable") or {}
        _debug_log_agent("deepagent_node_enter", {"message_count": len(messages), "thread_id": str(_cfg.get("thread_id") or ""), "model": str(_cfg.get("model") or _cfg.get("model_id") or "")}, "H2")
        # #endregion
        # 在事件循环外预取 thread 模型绑定，避免 _get_thread_model_binding 内同步 urlopen 阻塞
        _cfg = (config or {}).get("configurable") or {}
        _thread_id = str(_cfg.get("thread_id") or "").strip()
        _binding = await asyncio.to_thread(_get_thread_model_binding, _thread_id) if (_thread_id and _thread_id != "unknown") else {}
        query, mode, config_with_mode, configurable = _prepare_agent_config(messages, config, thread_model_binding=_binding)
        try:
            from backend.tools.utils.context import set_run_configurable
            set_run_configurable(configurable)
        except Exception as e:
            logger.debug("deepagent_node set_run_configurable: %s", e)
        # 热路径自适应降载（仅本轮 config 生效）：
        # 当检测到明显排队等待或重试信号时，优先保首包，临时收紧非核心注入。
        try:
            if _ADAPTIVE_HOTPATH_ENABLED:
                _retry_pre = int(configurable.get("retry_count", 0) or 0)
                _queue_wait_pre = int(configurable.get("queue_wait_ms") or 0)
                if _queue_wait_pre <= 0:
                    _queue_wait_pre = _compute_queue_wait_ms(configurable.get("request_enqueued_at"))
                if _retry_pre >= 1 or _queue_wait_pre >= _ADAPTIVE_HOTPATH_QUEUE_WAIT_MS:
                    configurable.setdefault("tool_extension_schema_mode", "deferred")
                    configurable.setdefault("tool_core_max", 12)
                    configurable.setdefault("enable_yaml_subagents", False)
                    configurable.setdefault("enable_heavy_layer1_blocks", False)
                    configurable.setdefault("skills_description_only", True)
                    configurable["adaptive_hotpath_active"] = True
                    configurable["adaptive_hotpath_reason"] = (
                        "retry" if _retry_pre >= 1 else "queue_wait"
                    )
                    configurable["adaptive_hotpath_queue_wait_ms"] = _queue_wait_pre
                    configurable["adaptive_hotpath_retry_count"] = _retry_pre
        except Exception as e:
            logger.debug("adaptive_hotpath config failed: %s", e, exc_info=True)

        loop_detector = LoopDetector(
            max_identical_tool_calls=int(configurable.get("max_identical_tool_calls", 3) or 3),
            max_same_error_retries=int(configurable.get("max_same_error_retries", 2) or 2),
            max_no_progress_rounds=int(configurable.get("max_no_progress_rounds", 6) or 6),
        )
        guardrails_manager = _get_guardrails_manager()
        # 注入 Token 追踪 callback，用于流式结束后发送真实 token 统计
        from backend.engine.agent.token_tracker import TokenTrackingCallback
        token_tracker = TokenTrackingCallback()
        config_with_mode.setdefault("callbacks", [])
        if isinstance(config_with_mode["callbacks"], list):
            config_with_mode["callbacks"] = list(config_with_mode["callbacks"]) + [token_tracker]
        else:
            config_with_mode["callbacks"] = [token_tracker]

        loop = asyncio.get_running_loop()
        writer = None
        _initial_ai_msg_id = None  # 本 run 的 AI 消息 id，reasoning start/content/end 与首包 partial 共用，便于前端匹配思考流
        thinking_start_sent_ts = None
        _last_task_progress_fp = ""
        _last_task_progress_emit_at = 0.0
        _end_signal_emitted = False
        def _emit_task_progress_once(
            message: str,
            *,
            phase: str = "",
            waited_ms: int | None = None,
        ) -> None:
            nonlocal _last_task_progress_fp, _last_task_progress_emit_at
            if writer is None:
                return
            now = __import__("time").perf_counter()
            fp = f"{phase}|{message}|{int(waited_ms or 0)}"
            if (
                fp == _last_task_progress_fp
                and (now - _last_task_progress_emit_at) * 1000 < _TASK_PROGRESS_DEDUP_WINDOW_MS
            ):
                return
            payload: dict[str, Any] = {"message": message}
            if phase:
                payload["phase"] = phase
            if waited_ms is not None:
                payload["waited_ms"] = waited_ms
            try:
                writer({"type": "task_progress", "data": payload})
                _last_task_progress_fp = fp
                _last_task_progress_emit_at = now
            except Exception as e:
                logger.debug("task_progress writer: %s", e)

        def _emit_stream_end_once() -> None:
            nonlocal _end_signal_emitted
            if _end_signal_emitted or writer is None:
                return
            try:
                data = {"phase": "end"}
                if _initial_ai_msg_id:
                    data["msg_id"] = _initial_ai_msg_id
                writer({"type": "reasoning", "data": data})
                _end_signal_emitted = True
                if _ENABLE_DEBUG_LOG:
                    logger.debug("reasoning phase=end emitted (stream end or error path)")
            except Exception as we:
                logger.warning("reasoning phase=end emit failed (non-fatal): %s", we)
        _stream_writer_closed = [False]  # 写入失败时置 True，后续不再写，避免连接已断时刷 log
        try:
            from langgraph.config import get_stream_writer
            _raw_writer = get_stream_writer()
            def _safe_writer(payload):
                if _stream_writer_closed[0] or _raw_writer is None:
                    return
                try:
                    _raw_writer(payload)
                except Exception as we:
                    _stream_writer_closed[0] = True
                    logger.debug("stream write failed (client likely disconnected): %s", we)
            writer = _safe_writer
            _debug_stream_enter_ts_ref = [None]
            _initial_ai_msg_id = f"ai_{int(__import__('time').time() * 1000)}"
            writer({"type": "reasoning", "data": {"phase": "start", "msg_id": _initial_ai_msg_id}})
            # #region agent log
            _debug_ingest("stream_open", {"initial_ai_msg_id": _initial_ai_msg_id}, "H1")
            # #endregion
            # P0-3 会话事件协议：每次 run 开始时下发当前会话上下文，前端可据此同步并广播 EVENTS.SESSION_CHANGED/ROLE_CHANGED/CHAT_MODE_CHANGED
            # 前端约定：threadId 为 null 时视为无效，不写存储不派发事件（见 toolStreamEvents.parseSessionContextPayload）
            # 本 run 实际使用的模型（便于前端展示「当前由哪台模型在服务」）
            try:
                cfg = (config_with_mode or {}).get("configurable") or {}
                _tid = str(cfg.get("thread_id") or "").strip()
                if not _tid:
                    logger.debug(
                        "session_context with empty thread_id (frontend will ignore); configurable keys=%s",
                        list(cfg.keys()) if cfg else None,
                    )
                _resolved_model_id = None
                try:
                    from backend.engine.agent.model_manager import get_model_manager
                    _resolved_model_id = get_model_manager().get_model_for_thread({"configurable": cfg}) or None
                except Exception as _m_err:
                    logger.debug("session_context model resolution (non-critical): %s", _m_err)
                _sc_data = {
                    "threadId": _tid or None,
                    "mode": str(cfg.get("mode") or "agent").strip(),
                    "roleId": str(cfg.get("role_id") or cfg.get("active_role_id") or "").strip() or None,
                }
                if _resolved_model_id:
                    _sc_data["modelId"] = _resolved_model_id
                writer({"type": "session_context", "data": _sc_data})
            except Exception as _sc_err:
                logger.debug("session_context emit (non-critical): %s", _sc_err)
            _emit_task_progress_once("正在准备执行环境…", phase="prepare")
            thinking_start_sent_ts = __import__("time").perf_counter()
        except Exception as we:
            logger.debug("发送 reasoning start 失败（非关键）: %s", we)
            writer = None
        # #region agent log
        if writer is None:
            _debug_log_agent("writer_is_none", {"message_count": len(messages)}, "H3")
        # #endregion

        def _render_guardrails_safe() -> str:
            try:
                return _render_guardrails_cached(guardrails_manager, query=query, limit=4)
            except Exception as _guardrails_err:
                logger.warning("GuardrailsManager.render_prompt_block failed: %s", _guardrails_err)
                return ""

        prepare_start_ts = __import__("time").perf_counter()
        agent_ready_ts = None
        logger.info("DeepAgent 等待引擎创建（get_agent）…")
        _executor = _get_prepare_executor()
        guardrails_future = loop.run_in_executor(_executor, _render_guardrails_safe)
        agent_future = loop.run_in_executor(_executor, lambda: get_agent(config_with_mode))
        try:
            last_prepare_progress_ms = 0
            while True:
                done, _pending = await asyncio.wait(
                    {agent_future, guardrails_future},
                    timeout=0.35,
                    return_when=asyncio.ALL_COMPLETED,
                )
                if len(done) == 2:
                    break
                waited_ms = int((__import__("time").perf_counter() - prepare_start_ts) * 1000)
                if waited_ms >= _PREPARE_MAX_WAIT_SECONDS * 1000:
                    raise TimeoutError(
                        "执行引擎准备超时（已等待 %d 秒）。请检查模型服务与配置后重试。"
                        % _PREPARE_MAX_WAIT_SECONDS
                    )
                should_emit = (
                    (last_prepare_progress_ms == 0 and waited_ms >= _PREPARE_PROGRESS_HINT_MS)
                    or (last_prepare_progress_ms > 0 and (waited_ms - last_prepare_progress_ms) >= _PREPARE_PROGRESS_INTERVAL_MS)
                )
                if should_emit:
                    _emit_task_progress_once(
                        f"执行引擎准备中（已等待 {waited_ms}ms）…",
                        phase="prepare",
                        waited_ms=waited_ms,
                    )
                    last_prepare_progress_ms = waited_ms
            agent = agent_future.result()
            dynamic_guardrails = guardrails_future.result()
            agent_ready_ts = __import__("time").perf_counter()
            try:
                from backend.engine.agent.model_manager import get_model_manager
                _actual_model = get_model_manager().get_model_for_thread({"configurable": config_with_mode.get("configurable") or {}})
                logger.info(
                    "DeepAgent 引擎已就绪，准备耗时 %.1fs，本 run 使用模型: %s",
                    agent_ready_ts - prepare_start_ts,
                    _actual_model or "(未解析)",
                )
            except Exception as _log_m:
                logger.info(
                    "DeepAgent 引擎已就绪，准备耗时 %.1fs",
                    agent_ready_ts - prepare_start_ts,
                )
            if dynamic_guardrails:
                configurable["guardrails_context"] = dynamic_guardrails
            _emit_task_progress_once("执行引擎已就绪，开始建立流式通道…", phase="build_ready")
        except Exception as agent_err:
            logger.exception("❌ 创建 Agent 失败: %s", agent_err)
            _user_message = (
                "无法创建对话引擎。请检查：1) 后端模型配置（backend/config/models.json）是否有启用模型；"
                "2) 本地模型服务（如 LM Studio）是否已启动并加载对应模型。"
                "若为模块缺失（No module named），请检查后端依赖安装与运行环境。"
            )
            _run_error_message = "对话引擎初始化失败，请检查后端依赖与配置。"
            if writer:
                try:
                    writer({
                        "type": "run_error",
                        "data": {"error_code": "engine_init", "message": _run_error_message},
                    })
                except Exception as _we:
                    logger.warning("run_error 推送到流失败: %s", _we)
            _emit_stream_end_once()
            yield {
                "messages": [AIMessage(content=_user_message)]
            }
            return
        logger.info("🎯 DeepAgent 开始处理，模式: %s，消息数: %s", mode, len(messages))
        # region agent log
        if _ENABLE_DEBUG_LOG:
            try:
                msg_summary = []
                for idx, m in enumerate(messages[-8:]):
                    m_type = getattr(m, "type", type(m).__name__)
                    raw_content = getattr(m, "content", "") or ""
                    row = {
                        "idx": idx,
                        "type": m_type,
                        # 记录完整内容（system/human 记全文，ai/tool 截断到 500 字符）
                        "content": raw_content if m_type in ("system", "human") else (raw_content[:500] + "..." if len(raw_content) > 500 else raw_content),
                    }
                    if m_type == "ai":
                        tcs = getattr(m, "tool_calls", None) or []
                        row["tool_calls"] = [
                            {
                                "id": tc.get("id") if isinstance(tc, dict) else getattr(tc, "id", None),
                                "name": tc.get("name") if isinstance(tc, dict) else getattr(tc, "name", None),
                            }
                            for tc in tcs
                        ]
                    if m_type == "tool":
                        row["tool_call_id"] = getattr(m, "tool_call_id", None)
                    msg_summary.append(row)
                _debug_log(
                    "H1",
                    "backend/engine/core/main_graph.py:deepagent_node:before_astream",
                    "state messages snapshot before agent.astream",
                    {
                        "mode": mode,
                        "thread_id": config_with_mode.get("configurable", {}).get("thread_id", "unknown"),
                        "message_count": len(messages),
                        "messages_tail": msg_summary,
                    },
                )
            except Exception as _log_err:
                logger.debug("执行日志记录失败（非关键）: %s", _log_err)
        # endregion

        # 首条用户消息时记录标题候选，用于 finally 中写 metadata.title
        thread_id = config_with_mode.get("configurable", {}).get("thread_id", "unknown")
        first_token_ts = None
        stream_enter_ts = None
        queue_wait_ms = 0
        retry_count = 0
        configurable = config_with_mode.get("configurable", {}) or {}
        try:
            retry_count = int(configurable.get("retry_count", 0) or 0)
            queue_wait_ms = int(configurable.get("queue_wait_ms") or 0)
            if queue_wait_ms <= 0:
                queue_wait_ms = _compute_queue_wait_ms(configurable.get("request_enqueued_at"))
        except Exception as e:
            logger.debug("queue_wait_ms/retry_count parse fallback: %s", e)
            queue_wait_ms = 0
        try:
            cfg = configurable
            source_model = cfg.get("pinned_model") or cfg.get("thread_model") or cfg.get("model") or cfg.get("model_id") or "auto"
            model_source = "auto" if source_model == "auto" else "manual"
            if thread_id and thread_id != "unknown" and not cfg.get("pinned_model"):
                cfg_snapshot = dict(cfg)
                def _bind_thread_model_async():
                    try:
                        from backend.engine.agent.model_manager import get_model_manager
                        mm = get_model_manager()
                        resolved_model = mm.get_model_for_thread({"configurable": cfg_snapshot})
                        if resolved_model:
                            _update_thread_model_binding(thread_id, resolved_model, model_source)
                    except Exception as bind_err:
                        logger.debug("thread model binding async failed (non-critical): %s", bind_err)
                loop.run_in_executor(None, _bind_thread_model_async)
        except Exception as _bind_err:
            logger.debug("thread model binding setup failed (non-critical): %s", _bind_err)
        title_candidate = None
        human_count = sum(1 for m in messages if isinstance(m, HumanMessage) or getattr(m, "type", "") == "human")
        if human_count == 1 and messages:
            first_user = next((m for m in messages if isinstance(m, HumanMessage) or getattr(m, "type", "") == "human"), None)
            if first_user:
                raw = getattr(first_user, "content", "") or ""
                title_candidate = (raw if isinstance(raw, str) else str(raw)).strip()[:80] if raw else None
        
        task_id = str(uuid.uuid4())
        resolved_model_id = ""
        try:
            from backend.engine.logging import get_execution_logger
            exec_logger = get_execution_logger()
            resolved_model_id = _resolve_model_id_with_route_prefix(configurable)
            _log_args = (
                thread_id, mode, query[:500] if query else "",
                {"queue_wait_ms": queue_wait_ms, "retry_count": retry_count},
                {"request_id": configurable.get("request_id"), "run_id": configurable.get("run_id"),
                 "task_key": configurable.get("task_key"), "model_id": resolved_model_id,
                 "session_id": configurable.get("session_id")},
            )
            _tid = task_id
            loop.run_in_executor(
                None, lambda a=_log_args, tid=_tid: exec_logger.start_task(a[0], a[1], a[2], metrics=a[3], correlation=a[4], task_id=tid)
            )
        except Exception as e:
            logger.debug("执行日志启动失败（非关键）: %s", e)
        
        # ============================================================
        # 流式输出核心逻辑（LangGraph 官方能力 + 必要 workaround）
        # ============================================================
        # 1) 官方行为：若将 agent 作为子图节点注册，外层图 stream_mode="messages"
        #    + subgraphs=True 可穿透子图得到 token 流，无需 writer。
        # 2) 本系统需动态模型切换（get_agent(config) 按 config 创建/缓存 agent），
        #    agent 在图构建时无法静态注册为单一子图，故保留函数节点 + writer。
        # 3) create_agent 内部 model 节点 trace=False，函数节点内 LLM 的 token
        #    不会被外层 stream_mode="messages" 捕获，故在节点内显式：
        #    agent.astream(stream_mode="messages") + get_stream_writer() 以
        #    custom 事件 type="messages_partial" 转发；前端转为 messages/partial。
        # ============================================================
        final_state = None
        error_message = None
        result_summary = None
        interrupted = False
        done_check_failed = False
        done_check_reason = ""

        try:
            # 注入 token 级流式 callback：DeepAgent model 节点 trace=False 导致
            # astream(stream_mode="messages") 在 LLM 完整返回后才产出，无法逐 token 流。
            # 通过 AsyncCallbackHandler.on_llm_new_token 绕过该限制，实时发送 token。
            from langchain_core.callbacks import AsyncCallbackHandler as _ACH
            from langchain_core.messages import AIMessageChunk

            class _TokenStreamHandler(_ACH):
                """将 LLM token 以短间隔微批发送给前端，降低事件风暴。"""

                def __init__(self, stream_writer, initial_msg_id=None, stream_enter_ts_ref=None):
                    super().__init__()
                    self._writer = stream_writer
                    self._initial_msg_id = initial_msg_id
                    self._stream_enter_ts_ref = stream_enter_ts_ref if stream_enter_ts_ref is not None else []
                    self._run_msg_ids: dict = {}
                    self._buffers: dict[str, dict[str, Any]] = {}
                    self._run_ordered_parts: dict[str, list] = {}  # run_key -> 按执行顺序累积的 parts（跨多轮 LLM 调用）
                    self._last_flush_ts: dict[str, float] = {}
                    self._run_start_ts: dict[str, float] = {}
                    self._first_chunk_emitted: dict[str, bool] = {}
                    self._run_token_counts: dict[str, int] = {}
                    self._run_first_token_ts: dict[str, float] = {}
                    self._run_last_token_ts: dict[str, float] = {}
                    self._reasoning_events_emitted = 0
                    self._reasoning_chars_emitted = 0
                    self._messages_partial_emitted = 0
                    self._token_callbacks_emitted = 0
                    self._stream_active_ms_total = 0
                    self._stream_tokens_per_second = 0.0

                async def on_chat_model_start(self, serialized, messages, *, run_id, **kw):
                    self._run_msg_ids[run_id] = getattr(self, "_initial_msg_id", None)
                    self._buffers[run_id] = {
                        "msg_id": getattr(self, "_initial_msg_id", None),
                        "content_parts": [],
                        "reasoning_parts": [],
                        "tool_calls": [],
                        "tool_call_chunks": [],
                    }
                    now = time.perf_counter()
                    self._last_flush_ts[run_id] = now
                    self._run_start_ts[run_id] = now
                    self._first_chunk_emitted[run_id] = False
                    self._run_token_counts[run_id] = 0
                    self._run_first_token_ts[run_id] = 0.0
                    self._run_last_token_ts[run_id] = 0.0
                    # #region agent log
                    _debug_ingest("on_chat_model_start", {"run_id": str(run_id)[:12]}, "H1")
                    # #endregion

                def _flush_run(self, run_id: str, force: bool = False) -> None:
                    if self._writer is None:
                        return
                    now = time.perf_counter()
                    if not force:
                        warmup_window = (
                            _TOKEN_STREAM_WARMUP_SECONDS > 0
                            and (now - self._run_start_ts.get(run_id, now)) < _TOKEN_STREAM_WARMUP_SECONDS
                        )
                        if _TOKEN_STREAM_BATCH_SECONDS > 0 and not warmup_window:
                            last = self._last_flush_ts.get(run_id, 0.0)
                            if (now - last) < _TOKEN_STREAM_BATCH_SECONDS:
                                return
                    buf = self._buffers.get(run_id)
                    if not buf:
                        return
                    eff_id = buf.get("msg_id") or self._run_msg_ids.get(run_id)
                    content_str = "".join(buf.get("content_parts") or [])
                    reasoning_str = "".join(buf.get("reasoning_parts") or [])
                    tc = list(buf.get("tool_calls") or [])
                    tcc = list(buf.get("tool_call_chunks") or [])
                    # 仅有极短 reasoning 时延迟一次 flush，避免前端高频抖动；结束时 force flush 不丢内容。
                    if (
                        not force
                        and not content_str
                        and not tc
                        and not tcc
                        and reasoning_str
                        and len(reasoning_str.strip()) < _REASONING_STREAM_MIN_CHARS
                    ):
                        return
                    # 按执行顺序：reasoning → tool-calls → text，追加到 run 级 ordered_parts，便于前端一步一步展示。
                    run_key = getattr(self, "_initial_msg_id", None) or eff_id
                    run_parts = self._run_ordered_parts.setdefault(run_key, [])
                    this_turn: list[dict[str, Any]] = []
                    if reasoning_str:
                        filtered_reasoning = _filter_content_leakage(reasoning_str)
                        if filtered_reasoning:
                            this_turn.append({"type": "reasoning", "text": filtered_reasoning})
                    for x in tc:
                        _g = x.get if hasattr(x, "get") and callable(x.get) else lambda k, d=None: getattr(x, k, d)
                        this_turn.append({"type": "tool-call", "id": _g("id", ""), "name": _g("name", ""), "args": _g("args", {})})
                    if content_str:
                        filtered_str = _filter_content_leakage(content_str)
                        if this_turn and (this_turn[-1] or {}).get("type") == "text":
                            this_turn[-1]["text"] = (this_turn[-1].get("text") or "") + filtered_str
                        else:
                            this_turn.append({"type": "text", "text": filtered_str})
                    run_parts.extend(this_turn)
                    if run_parts:
                        try:
                            payload = {"type": "AIMessageChunk", "id": eff_id, "content": _filter_content_leakage(content_str)}
                            if tc or tcc:
                                payload["tool_calls"] = tc
                                payload["tool_call_chunks"] = tcc
                            payload["content_parts"] = list(run_parts)
                            self._writer({"type": "messages_partial", "data": [payload]})
                            self._messages_partial_emitted += 1
                            # #region agent log
                            _debug_log_agent("messages_partial_sent", {"path": "token_handler", "content_len": len(payload.get("content") or ""), "preview": (payload.get("content") or "")[:80]}, "H1")
                            _debug_ingest("messages_partial_emitted", {"content_len": len(content_str or ""), "run_id": str(run_id)[:12]}, "H4")
                            # #endregion
                            logger.debug(
                                "messages_partial emitted run_id=%s content_len=%s",
                                run_id, len(content_str or ""),
                            )
                        except Exception as we:
                            logger.warning(
                                "stream writer messages_partial failed (run_id=%s, non-fatal): %s",
                                run_id, we,
                            )
                    # 单源：reasoning 已进入 content_parts，不再重复发送 reasoning 事件，避免前端双源拧麻花
                    buf["content_parts"] = []
                    buf["reasoning_parts"] = []
                    buf["tool_calls"] = []
                    buf["tool_call_chunks"] = []
                    # ordered_parts 不请空，保持累积
                    self._last_flush_ts[run_id] = now

                async def on_llm_new_token(self, token, *, chunk=None, run_id, **kw):
                    if chunk is None or self._writer is None:
                        return
                    self._token_callbacks_emitted += 1
                    if self._token_callbacks_emitted == 1:
                        logger.info(
                            "LLM 首 token 回调已触发 run_id=%s chunk_type=%s（若长时间无回复可检查模型是否在流式输出）",
                            run_id, type(chunk).__name__,
                        )
                    self._run_token_counts[run_id] = int(self._run_token_counts.get(run_id, 0) or 0) + 1
                    _now = time.perf_counter()
                    if (self._run_first_token_ts.get(run_id, 0.0) or 0.0) <= 0.0:
                        self._run_first_token_ts[run_id] = _now
                        # #region agent log
                        _run_start = self._run_start_ts.get(run_id) or _now
                        _ttft_ms = int((_now - _run_start) * 1000)
                        _stream_enter = self._stream_enter_ts_ref[0] if self._stream_enter_ts_ref else None
                        _ms_since_stream_open = int((_now - _stream_enter) * 1000) if _stream_enter else None
                        _debug_ingest(
                            "first_llm_token",
                            {"ttft_ms_since_run_start": _ttft_ms, "ms_since_stream_open": _ms_since_stream_open, "run_id": str(run_id)[:12]},
                            "H1",
                        )
                        # #endregion
                    self._run_last_token_ts[run_id] = _now
                    msg = getattr(chunk, "message", None)
                    # 兼容：部分运行时 chunk 即 AIMessageChunk，无 .message
                    if msg is None and (getattr(chunk, "content", None) is not None or hasattr(chunk, "additional_kwargs")):
                        msg = chunk
                    if msg is None:
                        if self._token_callbacks_emitted == 1:
                            logger.debug(
                                "TokenStreamHandler: on_llm_new_token chunk 无 .message 且非 message 对象，chunk_type=%s",
                                type(chunk).__name__,
                            )
                        return
                    msg_id = getattr(msg, "id", None)
                    if msg_id and run_id and run_id in self._run_msg_ids:
                        self._run_msg_ids[run_id] = msg_id
                    if run_id not in self._buffers:
                        self._buffers[run_id] = {
                            "msg_id": getattr(self, "_initial_msg_id", None),
                            "content_parts": [],
                            "reasoning_parts": [],
                            "tool_calls": [],
                            "tool_call_chunks": [],
                        }
                    buf = self._buffers[run_id]
                    if msg_id:
                        buf["msg_id"] = msg_id
                    content = getattr(msg, "content", "")
                    content_str = content if isinstance(content, str) else ""
                    ak = getattr(msg, "additional_kwargs", {}) or {}
                    if not isinstance(ak, dict):
                        ak = {}
                    reasoning = ak.get("reasoning_content") or ak.get("reasoning") or ak.get("thinking")
                    reasoning_str = reasoning if isinstance(reasoning, str) else ""
                    tc = getattr(msg, "tool_calls", None) or []
                    tcc = getattr(msg, "tool_call_chunks", None) or []
                    # 诊断日志：首 token 时记录 additional_kwargs 键，便于确认 35B 等模型是否提供 reasoning（ENABLE_MAIN_GRAPH_DEBUG_LOG=1）
                    if self._token_callbacks_emitted == 1 and ak:
                        logger.debug(
                            "TokenStreamHandler first token additional_kwargs keys: %s (has reasoning_content=%s)",
                            list(ak.keys()),
                            "reasoning_content" in ak,
                        )
                    if _ENABLE_DEBUG_LOG and self._token_callbacks_emitted == 1 and not (reasoning_str or "").strip():
                        _debug_log("CB", "on_llm_new_token", "first token has no reasoning_content", {"run_id": str(run_id)[:8], "ak_keys": list(ak.keys())})
                    if _ENABLE_DEBUG_LOG and (content_str or reasoning_str):
                        _debug_log("CB", "on_llm_new_token", "callback content/reasoning", {
                            "run_id": str(run_id)[:8],
                            "content": content_str[:200],
                            "reasoning": reasoning_str[:200],
                        })
                    # #region agent log
                    if self._token_callbacks_emitted == 1:
                        _debug_ingest(
                            "first_token_content",
                            {"has_reasoning": bool(reasoning_str and reasoning_str.strip()), "has_content": bool(content_str and content_str.strip()), "reasoning_len": len(reasoning_str or ""), "content_len": len(content_str or "")},
                            "H2",
                        )
                    # #endregion
                    if content_str:
                        filtered = _filter_content_leakage(content_str)
                        if filtered:
                            buf["content_parts"].append(filtered)
                    if reasoning_str and (reasoning_str.strip() or content_str or tc or tcc):
                        buf["reasoning_parts"].append(reasoning_str)
                    if tc or tcc:
                        def _sd(t):
                            g = t.get if hasattr(t, "get") and callable(t.get) else lambda k, d=None: getattr(t, k, d)
                            return {"id": g("id", ""), "name": g("name", ""), "args": g("args", {}), "index": g("index", 0)}
                        if tc:
                            buf["tool_calls"].extend([_sd(x) for x in tc])
                        if tcc:
                            buf["tool_call_chunks"].extend([_sd(x) for x in tcc])
                        self._flush_run(run_id, force=True)
                    else:
                        first_emitted = self._first_chunk_emitted.get(run_id, False)
                        # reasoning 与 content 同权：任一侧有可见内容即参与首段 force flush，保证思考流与正文同步露出
                        has_first_visible = bool(content_str.strip() or reasoning_str.strip())
                        if not first_emitted and has_first_visible:
                            self._flush_run(run_id, force=True)
                            self._first_chunk_emitted[run_id] = True
                        else:
                            self._flush_run(run_id, force=False)

                async def on_llm_end(self, *a, run_id, **kw):
                    _start = self._run_start_ts.get(run_id, 0.0) or 0.0
                    _first = self._run_first_token_ts.get(run_id, 0.0) or 0.0
                    _last = self._run_last_token_ts.get(run_id, 0.0) or 0.0
                    _count = int(self._run_token_counts.get(run_id, 0) or 0)
                    if _start > 0 and _last > 0 and _last >= _start:
                        self._stream_active_ms_total += int((_last - _start) * 1000)
                    if _count > 0 and _first > 0 and _last > _first:
                        _dur = max(_last - _first, 1e-6)
                        self._stream_tokens_per_second = max(self._stream_tokens_per_second, float(_count) / _dur)
                    self._flush_run(run_id, force=True)
                    self._run_msg_ids.pop(run_id, None)
                    self._buffers.pop(run_id, None)
                    self._last_flush_ts.pop(run_id, None)
                    self._run_start_ts.pop(run_id, None)
                    self._first_chunk_emitted.pop(run_id, None)
                    self._run_token_counts.pop(run_id, None)
                    self._run_first_token_ts.pop(run_id, None)
                    self._run_last_token_ts.pop(run_id, None)

                def get_stream_stats(self) -> dict[str, int]:
                    return {
                        "reasoning_events_emitted": int(self._reasoning_events_emitted),
                        "reasoning_chars_emitted": int(self._reasoning_chars_emitted),
                        "messages_partial_emitted": int(self._messages_partial_emitted),
                        "token_callbacks_emitted": int(self._token_callbacks_emitted),
                        "stream_active_ms": int(self._stream_active_ms_total),
                        "stream_tokens_per_second_peak": int(self._stream_tokens_per_second),
                    }

                def has_emitted_messages_partial(self) -> bool:
                    """是否已通过 callback 发送过至少一次 messages_partial（用于 fallback 判断）。"""
                    return self._messages_partial_emitted > 0

                def clear_run_ordered_parts(self, run_key: str) -> None:
                    """流结束后清理 run 级 ordered_parts，避免内存泄漏。"""
                    self._run_ordered_parts.pop(run_key, None)

            # 使用已生成的 _initial_ai_msg_id（与 reasoning start 一致），确保首包 partial 与 reasoning 的 msg_id 一致
            if _initial_ai_msg_id is None and writer:
                _initial_ai_msg_id = f"ai_{int(__import__('time').time() * 1000)}"
            _token_handler = None
            if writer:
                _token_handler = _TokenStreamHandler(writer, initial_msg_id=_initial_ai_msg_id, stream_enter_ts_ref=_debug_stream_enter_ts_ref)
                config_with_mode.setdefault("callbacks", [])
                if isinstance(config_with_mode["callbacks"], list):
                    config_with_mode["callbacks"] = list(config_with_mode["callbacks"]) + [_token_handler]
                else:
                    # 不替换，避免丢失 StreamMessagesHandler 等；向现有 CallbackManager 追加
                    mgr = config_with_mode["callbacks"]
                    if hasattr(mgr, "add_handler") and callable(getattr(mgr, "add_handler")):
                        mgr.add_handler(_token_handler, inherit=True)
                    else:
                        config_with_mode["callbacks"] = [_token_handler]
            # 流式超时：优先用模型配置的 api_timeout（9B 等慢速模型可配 300+），否则 DeepAgent 或默认 180
            stream_timeout_seconds = _DEFAULT_STREAM_TIMEOUT_SECONDS
            try:
                from backend.engine.agent.model_manager import get_model_manager
                mgr = get_model_manager()
                task_type = str((config_with_mode.get("configurable") or {}).get("task_type") or "default")
                if task_type == "doc":
                    stream_timeout_seconds = int(getattr(mgr._config, "api_timeout_doc", 300) or 300)
                elif task_type == "analysis":
                    stream_timeout_seconds = int(getattr(mgr._config, "api_timeout_analysis", 600) or 600)
                else:
                    stream_timeout_seconds = int(getattr(mgr._config, "api_timeout", 180) or 180)
                from backend.engine.agent.deep_agent import Config as DeepAgentConfig
                env_override = int(getattr(DeepAgentConfig, "DEEPAGENT_STREAM_TIMEOUT_SECONDS", 0) or 0)
                if env_override > 0:
                    stream_timeout_seconds = env_override
            except Exception as e:
                logger.debug("stream_timeout_seconds config: %s", e)
            stream_timeout_seconds = max(60, min(1200, stream_timeout_seconds))
            accumulated_messages = []  # 收集最终完整消息
            current_ai_msg_id = _initial_ai_msg_id  # 与首包 partial/reasoning 一致，便于前端思考流匹配
            current_ai_content_parts: list[str] = []
            current_ai_tool_calls = []
            _subagent_start_emitted: set = set()  # 每个 task tool_call_id 只发一次 subagent_start
            saw_reasoning_output = False

            def _find_tool_call(acc: list, tool_call_id: str):
                """从累积消息中查找对应 tool_call_id 的 tool_call 字典（用于判断是否为 task）。"""
                for m in reversed(acc):
                    if not isinstance(m, AIMessage):
                        continue
                    for tc in (getattr(m, "tool_calls", None) or []):
                        tc_id = tc.get("id") if isinstance(tc, dict) else getattr(tc, "id", None)
                        if tc_id == tool_call_id:
                            return tc
                return None
            reasoning_chars_total = 0

            def _loop_guidance_text(signal: "LoopSignal") -> str:
                guidance = ""
                if str(signal.suggested_strategy) in {"switch_strategy", "escalate_human"}:
                    try:
                        guidance = loop_detector.generate_escape_plan()
                    except Exception as e:
                        logger.debug("generate_escape_plan: %s", e)
                        guidance = ""
                base = (
                    "检测到可能的循环执行。"
                    f"原因: {signal.reason or 'unknown'}。"
                    f"建议策略: {signal.suggested_strategy}。"
                )
                if guidance:
                    return f"{base}\n{guidance}"
                return base + "请停止重复同一调用，改为参数变更、工具切换或策略切换。"

            should_abort_stream = False
            stream_enter_ts = __import__("time").perf_counter()
            if _debug_stream_enter_ts_ref is not None:
                _debug_stream_enter_ts_ref[0] = stream_enter_ts
            _seen_visible_payload = False
            _first_visible_hint_sent = False
            _first_token_progress_sent = False
            _last_first_visible_progress_ms = 0
            _first_astream_chunk_logged = False
            _emit_task_progress_once("流式通道已建立，等待模型首个输出…", phase="stream_open")
            logger.info(
                "DeepAgent 流已建立，stream_timeout=%ss；若长时间无首 token 请检查：1) LM Studio 是否在推理 2) 后端 DEBUG 日志 [StreamingMiddleware] 是否注入 callbacks 3) 设置 LLM_DEBUG=1 查看 delta",
                stream_timeout_seconds,
            )
            # 首发空 partial 使前端立即创建本条 AI 消息，后续 reasoning 的 msg_id 可匹配并展示思考流
            if writer:
                try:
                    writer({"type": "messages_partial", "data": [{"type": "AIMessageChunk", "id": _initial_ai_msg_id, "content": ""}]})
                except Exception as _iw:
                    logger.debug("初始 messages_partial 发送失败（非关键）: %s", _iw)

            _first_chunk_seen = [False]

            async def _stream_heartbeat():
                """等待首包期间每 15 秒推送一次进度，避免长时间无任何提示"""
                interval = 15
                n = max(1, (stream_timeout_seconds + interval - 1) // interval)
                for _ in range(n):
                    await asyncio.sleep(interval)
                    if _first_chunk_seen[0]:
                        return
                    if writer:
                        waited_ms = int((__import__("time").perf_counter() - stream_enter_ts) * 1000)
                        _emit_task_progress_once(
                            "模型正在推理中，请稍候…（若长时间无响应可检查 LM Studio 是否卡住）",
                            phase="first_visible_wait",
                            waited_ms=waited_ms,
                        )

            _heartbeat_task = asyncio.create_task(_stream_heartbeat())
            async with asyncio.timeout(max(30, stream_timeout_seconds)):
                async for chunk in _stream_agent_messages(agent, state, config_with_mode):
                    if not _first_astream_chunk_logged:
                        _first_chunk_seen[0] = True
                        _first_astream_chunk_logged = True
                        _first_astream_ms = int((__import__("time").perf_counter() - stream_enter_ts) * 1000)
                        logger.info(
                            "DeepAgent astream 首 chunk 已收到（距建立流 %.1fs）",
                            __import__("time").perf_counter() - stream_enter_ts,
                        )
                        # #region agent log
                        _debug_ingest("first_astream_chunk", {"ms_since_stream_enter": _first_astream_ms}, "H1")
                        # #endregion
                    if writer is not None and not _seen_visible_payload:
                        waited_ms = int((__import__("time").perf_counter() - stream_enter_ts) * 1000)
                        if (not _first_visible_hint_sent) and waited_ms >= _FIRST_VISIBLE_PAYLOAD_TIMEOUT_MS:
                            _emit_task_progress_once(
                                "模型正在推理中，已进入生成阶段…",
                                phase="first_visible_wait",
                                waited_ms=waited_ms,
                            )
                            _first_visible_hint_sent = True
                            _last_first_visible_progress_ms = waited_ms
                        elif (
                            _first_visible_hint_sent
                            and waited_ms - _last_first_visible_progress_ms >= _FIRST_VISIBLE_PROGRESS_INTERVAL_MS
                        ):
                            # 首包前周期性心跳，避免“卡住无反馈”体感。
                            _emit_task_progress_once(
                                f"模型仍在推理中（已等待 {waited_ms}ms）…",
                                phase="first_visible_wait",
                                waited_ms=waited_ms,
                            )
                            _last_first_visible_progress_ms = waited_ms
                    if isinstance(chunk, tuple) and len(chunk) == 2:
                        msg, metadata = chunk
                        msg_type = getattr(msg, "type", "")

                        if isinstance(msg, AIMessageChunk):
                            # Token 级 chunk - 通过 custom stream 发送给前端
                            msg_id = getattr(msg, "id", None)
                            content = getattr(msg, "content", "")
                            additional_kwargs = getattr(msg, "additional_kwargs", {}) or {}
                            reasoning_content = ""
                            if isinstance(additional_kwargs, dict):
                                maybe_reasoning = (
                                    additional_kwargs.get("reasoning_content")
                                    or additional_kwargs.get("reasoning")
                                    or additional_kwargs.get("thinking")
                                )
                                if isinstance(maybe_reasoning, str):
                                    reasoning_content = maybe_reasoning
                                    if reasoning_content:
                                        saw_reasoning_output = True
                                        reasoning_chars_total += len(reasoning_content)
                            tool_calls = getattr(msg, "tool_calls", [])
                            tool_call_chunks = getattr(msg, "tool_call_chunks", [])
                            if (
                                (isinstance(content, str) and content.strip())
                                or (isinstance(reasoning_content, str) and reasoning_content.strip())
                                or bool(tool_calls)
                                or bool(tool_call_chunks)
                            ):
                                _seen_visible_payload = True

                            if tool_calls:
                                for tc in (tool_calls or []):
                                    tc_name = tc.get("name") if isinstance(tc, dict) else getattr(tc, "name", "")
                                    tc_args = tc.get("args") if isinstance(tc, dict) else getattr(tc, "args", {})
                                    signal = loop_detector.observe_tool_call(str(tc_name or ""), tc_args)
                                    if signal.is_looping:
                                        configurable["loop_escape_strategy"] = signal.suggested_strategy
                                        accumulated_messages.append(
                                            SystemMessage(
                                                content=_loop_guidance_text(signal)
                                            )
                                        )
                                        try:
                                            guardrails_manager.add_guardrail_from_failure(
                                                error_message=signal.reason,
                                                task_context=query or task_id or "unknown_task",
                                                strategy_hint=signal.suggested_strategy,
                                            )
                                        except Exception as _gr_err:
                                            logger.debug("guardrail 记录失败: %s", _gr_err)
                                        if writer:
                                            try:
                                                writer(
                                                    {
                                                        "type": "loop_detected",
                                                        "data": signal.to_dict(),
                                                    }
                                                )
                                            except Exception as e:
                                                logger.debug("writer loop_detected: %s", e)
                                        if signal.suggested_strategy == "escalate_human":
                                            error_message = (
                                                "检测到重复失败，已触发人工升级。"
                                                f" reason={signal.reason or 'unknown'}"
                                            )
                                            should_abort_stream = True
                                            logger.warning(
                                                "LoopDetector 触发中止: reason=%s suggested_strategy=%s status=%s",
                                                signal.reason or "unknown",
                                                signal.suggested_strategy,
                                                loop_detector.status(),
                                            )
                                            break
                                if _ENABLE_DEBUG_LOG:
                                    _debug_log(
                                        "H4",
                                        "backend/engine/core/main_graph.py:deepagent_node:ai_chunk_tool_calls",
                                        "ai chunk tool_calls observed",
                                        {
                                            "msg_id": msg_id,
                                            "tool_calls": [
                                                {
                                                    "id": tc.get("id") if isinstance(tc, dict) else getattr(tc, "id", None),
                                                    "name": tc.get("name") if isinstance(tc, dict) else getattr(tc, "name", None),
                                                }
                                                for tc in (tool_calls or [])
                                            ],
                                        },
                                    )

                            if msg_id and msg_id != current_ai_msg_id:
                                if current_ai_msg_id and (current_ai_content_parts or current_ai_tool_calls):
                                    accumulated_messages.append(
                                        AIMessage(content="".join(current_ai_content_parts), id=current_ai_msg_id, tool_calls=current_ai_tool_calls)
                                    )
                                current_ai_msg_id = msg_id
                                current_ai_content_parts = [content] if isinstance(content, str) and content else []
                                current_ai_tool_calls = list(tool_calls) if tool_calls else []
                            else:
                                if isinstance(content, str) and content:
                                    current_ai_content_parts.append(content)
                                if tool_calls:
                                    current_ai_tool_calls.extend(tool_calls)

                            content_str = content if isinstance(content, str) else (str(content) if content else "")
                            if first_token_ts is None and (content_str.strip() or reasoning_content.strip()):
                                first_token_ts = __import__("time").perf_counter()
                                if not _first_token_progress_sent:
                                    _emit_task_progress_once("已收到首个输出，持续生成中…", phase="first_token")
                                    _first_token_progress_sent = True

                            # 仅 AIMessageChunk 经 writer 发给前端；SystemMessage/HumanMessage 不发送。
                            # 当 _TokenStreamHandler 未发送过任何 messages_partial 时 fallback 到 chunk 路径。
                            _effectively_has_realtime = _token_handler is not None and _token_handler.has_emitted_messages_partial()
                            if writer and not _effectively_has_realtime:
                                def _tc_dict(tc):
                                    if hasattr(tc, "get") and callable(getattr(tc, "get")):
                                        return {
                                            "id": tc.get("id", ""),
                                            "name": tc.get("name", ""),
                                            "args": tc.get("args", {}),
                                            "index": tc.get("index", 0),
                                        }
                                    return {
                                        "id": getattr(tc, "id", ""),
                                        "name": getattr(tc, "name", ""),
                                        "args": getattr(tc, "args", {}),
                                        "index": getattr(tc, "index", 0),
                                    }

                                def _tcc_dict(tc):
                                    if hasattr(tc, "get") and callable(getattr(tc, "get")):
                                        return {
                                            "id": tc.get("id", ""),
                                            "name": tc.get("name", ""),
                                            "args": tc.get("args", ""),
                                            "index": tc.get("index", 1),
                                        }
                                    return {
                                        "id": getattr(tc, "id", ""),
                                        "name": getattr(tc, "name", ""),
                                        "args": getattr(tc, "args", ""),
                                        "index": getattr(tc, "index", 1),
                                    }

                                payload_chunk = {
                                    "type": "AIMessageChunk",
                                    "id": _initial_ai_msg_id or msg_id or current_ai_msg_id,
                                    "content": _filter_content_leakage(content_str),
                                    "tool_calls": [_tc_dict(tc) for tc in (tool_calls or [])],
                                    "tool_call_chunks": [_tcc_dict(tc) for tc in (tool_call_chunks or [])],
                                }
                                # 按执行顺序：reasoning → tool-calls → text，与 TokenStreamHandler 一致，单源一步一步展示。
                                _text_so_far = "".join(current_ai_content_parts)
                                _op = []
                                if reasoning_content:
                                    _filtered_r = _filter_content_leakage(reasoning_content)
                                    if _filtered_r:
                                        _op.append({"type": "reasoning", "text": _filtered_r})
                                for _t in (current_ai_tool_calls or []):
                                    _d = _tc_dict(_t)
                                    _op.append({"type": "tool-call", "id": _d.get("id", ""), "name": _d.get("name", ""), "args": _d.get("args", {})})
                                if _text_so_far:
                                    _op.append({"type": "text", "text": _filter_content_leakage(_text_so_far)})
                                if _op:
                                    payload_chunk["content_parts"] = _op
                                chunk_data = {"type": "messages_partial", "data": [payload_chunk]}
                                try:
                                    writer(chunk_data)
                                    # #region agent log
                                    _sent = (chunk_data.get("data") or [{}])[0]
                                    _debug_log_agent("messages_partial_sent", {"path": "chunk_fallback", "content_len": len(_sent.get("content") or ""), "preview": (_sent.get("content") or "")[:80]}, "H1")
                                    # #endregion
                                except Exception as write_err:
                                    logger.debug("stream writer 发送 messages_partial 失败（非关键）: %s", write_err)
                                # 单源：reasoning 已进入 content_parts（_op），不再单独发 reasoning 事件
                            # 补发 subagent_start（不依赖 _has_realtime_handler，确保前端 TaskToolUI/useAgentProgress 可追踪）
                            if writer:
                                for tc in (tool_calls or []):
                                    tc_id = tc.get("id") if isinstance(tc, dict) else getattr(tc, "id", None)
                                    tc_name = tc.get("name") if isinstance(tc, dict) else getattr(tc, "name", "")
                                    tc_args = tc.get("args") if isinstance(tc, dict) else getattr(tc, "args", {}) or {}
                                    if not isinstance(tc_args, dict):
                                        tc_args = {}
                                    if tc_name == "task" and tc_id and tc_id not in _subagent_start_emitted:
                                        _subagent_start_emitted.add(tc_id)
                                        try:
                                            writer({
                                                "type": "subagent_start",
                                                "data": {
                                                    "tool_call_id": tc_id,
                                                    "subagent_type": (tc_args.get("subagent_type") or "general-purpose")[:64],
                                                    "description": (tc_args.get("description") or "")[:80],
                                                },
                                            })
                                        except Exception as e:
                                            logger.debug("writer subagent_start: %s", e)
                                    if tc_name != "task":
                                        step_label = _get_tool_step_label(tc_name, tc_args)
                                        try:
                                            writer({
                                                "type": "task_progress",
                                                "data": {"phase": "tool_call", "step": step_label, "tool": tc_name, "tool_call_id": tc_id},
                                            })
                                        except Exception as e:
                                            logger.debug("writer task_progress tool_call: %s", e)
                                    # write_todos：规划即展示，见到 tool_call 即推送 todos 到前端
                                    if tc_name == "write_todos" and tc_args:
                                        todos_raw = tc_args.get("todos") if isinstance(tc_args, dict) else []
                                        if isinstance(todos_raw, list) and len(todos_raw) > 0:
                                            todos_payload = []
                                            for t in todos_raw:
                                                if not isinstance(t, dict):
                                                    continue
                                                content_val = t.get("content") or t.get("title") or ""
                                                status_val = t.get("status") or "pending"
                                                todos_payload.append({"id": t.get("id"), "content": content_val, "status": status_val})
                                            if todos_payload:
                                                try:
                                                    writer({"type": "task_progress", "data": {"todos": todos_payload, "tool_call_id": tc_id}})
                                                except Exception as e:
                                                    logger.debug("writer task_progress write_todos: %s", e)

                        elif msg_type == "ai":
                            accumulated_messages.append(msg)
                            _seen_visible_payload = True
                            raw_content = getattr(msg, "content", None)
                            if raw_content is None:
                                raw_content = ""
                            ai_text = (
                                " ".join(str(x) for x in raw_content).strip()
                                if isinstance(raw_content, list)
                                else str(raw_content).strip()
                            )
                            # Fallback：仅 AIMessage 内容经 writer 发给前端；callback 未发过时补发
                            if writer and not (_token_handler and _token_handler.has_emitted_messages_partial()) and ai_text:
                                try:
                                    _out = _filter_content_leakage(ai_text)
                                    writer({
                                        "type": "messages_partial",
                                        "data": [{
                                            "type": "AIMessageChunk",
                                            "id": _initial_ai_msg_id,
                                            "content": _out,
                                            "tool_calls": [],
                                            "tool_call_chunks": [],
                                        }],
                                    })
                                    # #region agent log
                                    _debug_log_agent("messages_partial_sent", {"path": "chunk_fallback_ai_full", "content_len": len(_out), "preview": (_out or "")[:80]}, "H5")
                                    # #endregion
                                except Exception as write_err:
                                    logger.debug("stream writer fallback AIMessage 失败: %s", write_err)
                            if not should_abort_stream:
                                progressed = bool(ai_text) or bool(getattr(msg, "tool_calls", None))
                                progress_signal = loop_detector.observe_round_progress(progressed)
                                if progress_signal.is_looping:
                                    configurable["loop_escape_strategy"] = progress_signal.suggested_strategy
                                    accumulated_messages.append(
                                        SystemMessage(content=_loop_guidance_text(progress_signal))
                                    )
                                    try:
                                        guardrails_manager.add_guardrail_from_failure(
                                            error_message=progress_signal.reason,
                                            task_context=query or task_id or "unknown_task",
                                            strategy_hint=progress_signal.suggested_strategy,
                                        )
                                    except Exception as e:
                                        logger.debug("add_guardrail_from_failure: %s", e)
                                    if progress_signal.suggested_strategy == "escalate_human":
                                        error_message = (
                                            "检测到连续无进展，已触发人工升级。"
                                            f" reason={progress_signal.reason or 'unknown'}"
                                        )
                                        should_abort_stream = True
                                        logger.warning(
                                            "LoopDetector 触发中止(无进展): reason=%s suggested_strategy=%s status=%s",
                                            progress_signal.reason or "unknown",
                                            progress_signal.suggested_strategy,
                                            loop_detector.status(),
                                        )
                                        break
                            if _ENABLE_DEBUG_LOG:
                                try:
                                    _debug_log(
                                        "H14",
                                        "backend/engine/core/main_graph.py:deepagent_node:ai_full_message",
                                        "full ai message observed",
                                        {
                                            "has_tool_calls": bool(getattr(msg, "tool_calls", None)),
                                            "tool_calls": [
                                                {
                                                    "id": tc.get("id") if isinstance(tc, dict) else getattr(tc, "id", None),
                                                    "name": tc.get("name") if isinstance(tc, dict) else getattr(tc, "name", None),
                                                }
                                                for tc in (getattr(msg, "tool_calls", None) or [])
                                            ],
                                        },
                                    )
                                except Exception as e:
                                    logger.debug("_debug_log ai_full_message: %s", e)
                            if writer:
                                ai_tool_calls = getattr(msg, "tool_calls", None) or []
                                for tc in ai_tool_calls:
                                    tc_id = tc.get("id") if isinstance(tc, dict) else getattr(tc, "id", None)
                                    tc_name = tc.get("name") if isinstance(tc, dict) else getattr(tc, "name", "")
                                    if tc_name != "task" or not tc_id or tc_id in _subagent_start_emitted:
                                        continue
                                    _subagent_start_emitted.add(tc_id)
                                    tc_args = (tc.get("args") if isinstance(tc, dict) else getattr(tc, "args", {})) or {}
                                    if not isinstance(tc_args, dict):
                                        tc_args = {}
                                    try:
                                        writer({
                                            "type": "subagent_start",
                                            "data": {
                                                "tool_call_id": tc_id,
                                                "subagent_type": (tc_args.get("subagent_type") or "general-purpose")[:64],
                                                "description": (tc_args.get("description") or "")[:80],
                                            },
                                        })
                                    except Exception as e:
                                        logger.debug("writer subagent_start ai: %s", e)
                            current_ai_msg_id = None
                            current_ai_content_parts = []
                            current_ai_tool_calls = []

                        elif msg_type == "tool":
                            accumulated_messages.append(msg)
                            _seen_visible_payload = True
                            loop_detector.observe_round_progress(True)
                            # 补发 subagent_end / task_progress / tool_result，供前端 Cursor 式展示「执行了什么、结果如何」
                            if writer:
                                tcid = getattr(msg, "tool_call_id", None) or ""
                                if tcid:
                                    parent_tc = _find_tool_call(accumulated_messages, tcid)
                                    if parent_tc:
                                        tc_name = parent_tc.get("name") if isinstance(parent_tc, dict) else getattr(parent_tc, "name", "")
                                        # 通用：任意工具完成时推送 tool_result，前端可即时展示结果摘要（与 Cursor 一致）
                                        try:
                                            content_raw = getattr(msg, "content", None)
                                            content_str = (
                                                content_raw
                                                if isinstance(content_raw, str)
                                                else str(content_raw) if content_raw is not None else ""
                                            ) or ""
                                            preview = _format_tool_result_preview(tc_name, content_str, max_chars=500)
                                            writer({
                                                "type": "tool_result",
                                                "data": {
                                                    "tool_call_id": tcid,
                                                    "tool": tc_name,
                                                    "result_preview": preview,
                                                },
                                            })
                                            step = sum(1 for _m in accumulated_messages if isinstance(_m, ToolMessage))
                                            logger.info(
                                                "tool_step_done step=%s tool=%s tool_call_id=%s result_len=%s",
                                                step, tc_name, tcid, len(content_str),
                                            )
                                        except Exception as e:
                                            logger.debug("writer tool_result task_progress: %s", e)
                                        if tc_name == "task":
                                            content = getattr(msg, "content", None)
                                            if content is None:
                                                content = ""
                                            summary = _extract_subagent_summary(content)
                                            try:
                                                writer({
                                                    "type": "subagent_end",
                                                    "data": {
                                                        "tool_call_id": tcid,
                                                        "summary": summary,
                                                    },
                                                })
                                            except Exception as e:
                                                logger.debug("writer subagent_end: %s", e)
                                        elif tc_name == "write_todos":
                                            # 推送完整 todo 列表到前端，供 Composer 上方 Cursor 风格任务列表展示（从 tool_call args 取，ToolMessage.content 为人类可读字符串非 JSON）
                                            args = parent_tc.get("args") if isinstance(parent_tc, dict) else getattr(parent_tc, "args", None)
                                            todos_raw = (args or {}).get("todos")
                                            if isinstance(todos_raw, list) and len(todos_raw) > 0:
                                                todos_payload = []
                                                for t in todos_raw:
                                                    if not isinstance(t, dict):
                                                        continue
                                                    content_val = t.get("content") or t.get("title") or ""
                                                    status_val = t.get("status") or "pending"
                                                    todos_payload.append({"id": t.get("id"), "content": content_val, "status": status_val})
                                                if todos_payload:
                                                    try:
                                                        writer({"type": "task_progress", "data": {"todos": todos_payload, "tool_call_id": tcid}})
                                                    except Exception as e:
                                                        logger.debug("writer task_progress write_todos tool: %s", e)
                    else:
                        if isinstance(chunk, dict) and "messages" in chunk:
                            final_state = chunk
                    if should_abort_stream:
                        break

            # 当 loop_detector 触发 abort 时，将错误说明写入会话历史
            if should_abort_stream and error_message:
                accumulated_messages.append(AIMessage(content=error_message))
                logger.info(
                    "流结束(loop_abort): error_message=%s loop_detector_status=%s",
                    error_message[:200] if error_message else "",
                    loop_detector.status(),
                )
                logger.info("run_stop reason=loop_abort thread_id=%s mode=%s", thread_id, mode)
            elif not should_abort_stream:
                logger.info("流结束(正常) DeepAgent astream 完成")

            # 处理最后一个累积中的 AI 消息（含仅 tool_calls 无 content 的情况）
            if current_ai_msg_id and (current_ai_content_parts or current_ai_tool_calls):
                accumulated_messages.append(AIMessage(
                    content="".join(current_ai_content_parts),
                    id=current_ai_msg_id,
                    tool_calls=current_ai_tool_calls,
                ))

            # 某些推理模型可能只返回 reasoning_content 而不返回最终 content。
            # 避免用户一直等待，明确告知当前轮次未产生最终答复。
            if not accumulated_messages and saw_reasoning_output:
                accumulated_messages.append(
                    AIMessage(
                        content=(
                            "本轮模型只返回了思考过程，尚未产出最终答复。"
                            "请重试，或在模型设置中关闭 thinking 模式后再试。"
                            f"\n\n已接收思考片段长度约 {reasoning_chars_total} 字符。"
                        )
                    )
                )

            # 完成验证：astream 正常结束后做轻量 done_check
            done_check_failed = False
            done_check_reason = ""
            if accumulated_messages and not error_message:
                try:
                    from backend.engine.middleware.done_verifier import DoneVerifier

                    last_ai_text = ""
                    for _msg in reversed(accumulated_messages):
                        if isinstance(_msg, AIMessage):
                            raw = getattr(_msg, "content", "") or ""
                            if isinstance(raw, list):
                                last_ai_text = " ".join(str(x) for x in raw).strip()
                            else:
                                last_ai_text = str(raw).strip()
                            if last_ai_text:
                                break
                    done_signal = DoneVerifier().check(
                        mode=mode,
                        query=query,
                        result_content=last_ai_text,
                        configurable=configurable,
                    )
                    if not done_signal.passed:
                        done_check_failed = True
                        done_check_reason = str(done_signal.reason or "任务完成验证未通过")
                        configurable["done_check_failed"] = True
                        accumulated_messages.append(
                            SystemMessage(
                                content=(
                                    f"任务验证未通过。原因: {done_check_reason}。"
                                    f"建议: {str(done_signal.suggestion or '请补齐验收标准后再宣称完成。')}"
                                )
                            )
                        )
                except Exception as _done_err:
                    logger.debug("done_check 执行失败（非关键）: %s", _done_err)
                if not should_abort_stream:
                    if done_check_failed:
                        logger.info(
                            "run_stop reason=done_check_failed thread_id=%s mode=%s detail=%s",
                            thread_id, mode, (done_check_reason or "")[:200],
                        )
                    else:
                        logger.info("run_stop reason=normal thread_id=%s mode=%s", thread_id, mode)

            # yield 最终状态；超长会话仅保留最近 N 条以控制 CPU/内存，再规范化 ToolMessage.tool_call_id。
            # 契约：messages 中每条 ToolMessage 必须带完整 content（工具真实返回），不得省略或截断，前端 merge 依赖此写入 part.result。
            if accumulated_messages:
                to_yield = accumulated_messages[-_YIELD_MESSAGES_TAIL_MAX:] if len(accumulated_messages) > _YIELD_MESSAGES_TAIL_MAX else accumulated_messages
                if len(to_yield) < len(accumulated_messages):
                    logger.debug("yield_final_state trimmed messages %d -> %d", len(accumulated_messages), len(to_yield))
                # 可选 DEV 校验：三处 id 同源（content_parts part.id / tool_calls[].id / ToolMessage.tool_call_id）
                if _ENABLE_DEBUG_LOG:
                    _last_ai_ids = set()
                    for _m in to_yield:
                        if isinstance(_m, AIMessage):
                            _tcs = getattr(_m, "tool_calls", None) or []
                            _last_ai_ids = {(_tc.get("id") if isinstance(_tc, dict) else getattr(_tc, "id", None)) for _tc in _tcs if (_tc.get("id") if isinstance(_tc, dict) else getattr(_tc, "id", None))}
                        elif isinstance(_m, ToolMessage):
                            _tid = getattr(_m, "tool_call_id", None) or ""
                            if _tid and _last_ai_ids and _tid not in _last_ai_ids:
                                logger.warning(
                                    "[id_consistency] ToolMessage.tool_call_id=%s 不在上一轮 AI tool_calls id 集合 %s 中，可能导致前端 merge/证据区错位",
                                    _tid[:32] if _tid else "", list(_last_ai_ids)[:5],
                                )
                # 写入 checkpoint 前将 content 归一化为 string，避免下一轮加载到 list 导致上游 API 400
                final_state = {"messages": _normalize_messages_content_to_string(_normalize_tool_message_ids(to_yield))}
                # #region agent log
                _debug_log_agent("yield_final_state", {"accumulated_count": len(to_yield)}, "H5")
                # #endregion
                yield final_state
            elif final_state:
                raw_msgs = final_state.get("messages") or []
                to_yield = raw_msgs[-_YIELD_MESSAGES_TAIL_MAX:] if len(raw_msgs) > _YIELD_MESSAGES_TAIL_MAX else raw_msgs
                final_state = {"messages": _normalize_messages_content_to_string(_normalize_tool_message_ids(to_yield))}
                # #region agent log
                _debug_log_agent("yield_final_state", {"from_final_state": True, "count": len(final_state["messages"])}, "H5")
                # #endregion
                yield final_state
            else:
                logger.warning("DeepAgent astream 完成但无消息输出")
                # #region agent log
                _debug_log_agent("yield_empty", {}, "H5")
                # #endregion
                yield {"messages": []}

        except Exception as e:
            exc_name = e.__class__.__name__.lower()
            if "interrupt" in exc_name:
                interrupted = True
                logger.info("DeepAgent 执行中断（等待人工输入/审核）")
                logger.info("run_stop reason=interrupt thread_id=%s mode=%s", thread_id, mode)
                # 通知前端流已暂停，便于清除 isStreamingRef 允许第二次输入
                try:
                    from langgraph.config import get_stream_writer
                    _w = get_stream_writer()
                    if _w:
                        _w({"type": "stream_paused", "data": {"reason": "human_checkpoint", "thread_id": thread_id}})
                except Exception as _we:
                    logger.debug("stream_paused on interrupt (non-critical): %s", _we)
                raise
            error_message = str(e)
            loop_signal = loop_detector.observe_error(error_message)
            if loop_signal.is_looping:
                configurable["loop_escape_strategy"] = loop_signal.suggested_strategy
                try:
                    guardrails_manager.add_guardrail_from_failure(
                        error_message=error_message,
                        task_context=query or task_id or "unknown_task",
                        strategy_hint=str(configurable.get("loop_escape_strategy", "retry_with_variation")),
                    )
                except Exception as _gr_err:
                    logger.debug("guardrail 记录失败: %s", _gr_err)
            # region agent log
            _debug_log(
                "H5",
                "backend/engine/core/main_graph.py:deepagent_node:exception",
                "deepagent_node exception",
                {"error": error_message, "exc_name": exc_name, "mode": mode},
            )
            _debug_log_agent("deepagent_node_exception", {"exc_name": exc_name, "error_message": error_message[:200], "mode": mode}, "H4")
            # endregion
            logger.error("❌ DeepAgent 执行失败: %s", e)
            logger.info(
                "run_stop reason=exception thread_id=%s mode=%s error=%s",
                thread_id, mode, (error_message or "")[:200],
            )

            import traceback
            error_traceback = traceback.format_exc()
            logger.error("错误详情:\n%s", error_traceback)
            
            # 构建用户可读的错误提示
            # 注意：TimeoutError() 的 str() 是空字符串，需用 class name 判断
            hint = ""
            _lower = error_message.lower()
            _is_timeout = (
                "timeout" in exc_name or "timeout" in _lower or "timed out" in _lower
                or "asyncio.timeout" in _lower or "read timed out" in _lower or "connect timed out" in _lower
            )
            _is_conn_err = (
                "connection" in _lower or "refused" in _lower or "econnrefused" in _lower
                or "econnreset" in _lower or "econnaborted" in _lower or "connection reset" in _lower
                or "network" in _lower and ("error" in _lower or "unavailable" in _lower or "failed" in _lower)
                or "failed to fetch" in _lower
            )
            _is_model_crash = "crashed" in _lower or "exit code" in _lower or "unloaded" in _lower or "failed to load" in _lower
            _is_model_not_found = (
                "404" in _lower or "not found" in _lower or "does not exist" in _lower
                or "model" in _lower and ("unavailable" in _lower or "invalid" in _lower or "unknown" in _lower)
            )
            _is_gateway_err = "502" in error_message or "bad gateway" in _lower
            if _is_gateway_err:
                logger.warning(
                    "推理服务返回 502（Bad Gateway），请检查 LM Studio/推理服务是否已启动且已加载模型: thread_id=%s error=%s",
                    thread_id, error_message[:200],
                )
            # 优先按异常类型/错误码判断（LangChain/OpenAI 等可能暴露 code/type），再 fallback 到消息子串
            _is_context_exceeded = False
            _err_code = getattr(e, "code", None) or getattr(e, "type", None)
            if _err_code and isinstance(_err_code, str):
                _code_lower = str(_err_code).lower()
                if "context" in _code_lower and ("length" in _code_lower or "exceeded" in _code_lower):
                    _is_context_exceeded = True
            if not _is_context_exceeded and "context_length_exceeded" in exc_name:
                _is_context_exceeded = True
            if not _is_context_exceeded:
                _is_context_exceeded = (
                    "context" in _lower and ("exceeded" in _lower or "limit" in _lower or "length" in _lower or "size" in _lower)
                ) or "maximum context length" in _lower
            # 本次 run 请求的模型（用于错误提示，避免显示默认/缓存模型）
            _cfg = (config_with_mode or {}).get("configurable") or {}
            _requested_model = str(_cfg.get("model") or _cfg.get("model_id") or _cfg.get("thread_model") or _cfg.get("pinned_model") or "").strip() or None
            if _is_model_not_found:
                try:
                    from backend.engine.agent.model_manager import get_model_manager
                    diag = get_model_manager().get_model_endpoint_diagnostics(config_with_mode)
                    model_id_diag = _requested_model or (diag.get("model_id", "unknown") if diag else "unknown")
                    active_url = (diag.get("runtime_url") or diag.get("configured_url") or "unknown").rstrip("/") if diag else "unknown"
                    _models_url = f"{active_url}/models" if active_url != "unknown" else "http://localhost:1234/v1/models"
                    hint = (
                        f"\n\n**模型未找到或不可用**（当前配置：{model_id_diag}，端点：{active_url}）。\n"
                        "请检查：1) LM Studio 中是否已加载该模型；2) models.json 中该模型的 id 或 lm_studio_id 是否与 LM Studio 显示的模型名一致。\n"
                        "可在设置中点击「刷新模型」同步 LM Studio 列表，或为 local 模型配置 lm_studio_id 与 LM Studio 返回的 id 一致。\n"
                        f"可在浏览器或 curl 访问 {_models_url} 查看当前已加载的模型 id，将其中对应模型的 id 填入 backend/config/models.json 中该模型的 lm_studio_id。"
                    )
                except Exception as e:
                    logger.debug("run_error hint model_not_found diag: %s", e)
                    hint = (
                        "\n\n**模型未找到或不可用**。请在 LM Studio 中确认已加载对应模型，且配置中的模型 id 与 LM Studio 一致（可为模型配置 lm_studio_id）。"
                        " 可在浏览器访问 http://localhost:1234/v1/models 查看已加载的模型 id，填入 backend/config/models.json 的 lm_studio_id。"
                    )
            elif _is_timeout:
                model_hint = ""
                try:
                    from backend.engine.agent.model_manager import get_model_manager
                    diag = get_model_manager().get_model_endpoint_diagnostics(config_with_mode)
                    model_id = _requested_model or (diag.get("model_id") if diag else None) or "unknown"
                    active_url = (diag.get("runtime_url") or diag.get("configured_url") or "unknown").rstrip("/") if diag else "unknown"
                    model_hint = f"（当前模型：{model_id}，端点：{active_url}）"
                except Exception as e:
                    logger.debug("run_error timeout diag: %s", e)
                    if _requested_model:
                        model_hint = f"（当前模型：{_requested_model}）"
                hint = (
                    f"\n\n**模型响应超时**{model_hint}。可能原因：\n"
                    "1. 模型在 LM Studio 中已卸载或崩溃，请在 LM Studio 中重新加载模型\n"
                    "2. 模型推理时间过长（30B+ 模型在低配机器上可能需要数分钟）\n"
                    "3. 系统内存不足导致模型崩溃\n\n"
                    "建议：在 LM Studio 中确认模型已加载并能正常响应后重试。"
                )
                error_message = f"模型响应超时（等待超过 {stream_timeout_seconds} 秒）"
            if _is_model_not_found and not error_message.startswith("模型未找到"):
                error_message = "模型未找到或不可用（请检查 LM Studio 已加载模型且 id/lm_studio_id 与配置一致）"
            elif _is_model_crash:
                hint = (
                    "\n\n**模型崩溃**。请在 LM Studio 中重新加载模型后重试。\n"
                    "若持续崩溃，可能是系统内存不足，建议切换到更小的模型。"
                )
            elif _is_context_exceeded:
                hint = (
                    "\n\n**对话上下文已超长**。当前会话历史 + 本轮输入超过了模型可接受长度。\n"
                    "建议：1) 新开一个会话继续；2) 或清除部分历史消息后再试；3) 可设置 SUMMARIZATION_TRIGGER_RATIO=0.6 更早压缩（当前默认 0.75）。"
                )
                error_message = (
                    "对话上下文已超长（Context size has been exceeded），请新开会话或清除历史后重试。"
                    " 可设置环境变量 SUMMARIZATION_TRIGGER_RATIO=0.6 使系统更早自动压缩历史。"
                )
            if _is_conn_err and not hint:
                hint = "\n\n若为连接错误，请确认：1) LM Studio 已启动；2) 已加载对应模型；3) 端口配置正确（默认 1234）。"
                try:
                    from backend.engine.agent.model_manager import get_model_manager
                    diag = get_model_manager().get_model_endpoint_diagnostics(config_with_mode)
                    model_id = _requested_model or (diag.get("model_id") if diag else None) or "unknown"
                    active_url = (diag.get("runtime_url") or diag.get("configured_url") or "unknown").rstrip("/") if diag else "unknown"
                    hint += f"\n当前模型: {model_id}，端点: {active_url}"
                except Exception as e:
                    logger.debug("run_error conn_err diag: %s", e)
                    if _requested_model:
                        hint += f"\n当前模型: {_requested_model}"

            if _is_model_not_found:
                error_code = "model_not_found"
            elif _is_timeout:
                error_code = "timeout"
            elif _is_conn_err:
                error_code = "connection"
            elif _is_model_crash:
                error_code = "model_crash"
            elif _is_context_exceeded:
                error_code = "context_exceeded"
            elif _is_gateway_err:
                error_code = "502"
                if not hint:
                    hint = "\n\n推理服务返回 502（网关错误）。请确认：1) LM Studio 或本地推理服务已启动；2) 已加载对应模型；3) 端口与设置中的 Base URL 一致。"
                # 供前端 toast 展示的可操作说明（run_error.message）
                error_message = "推理服务返回 502。请确认 LM Studio 或本地推理服务已启动、已加载模型，端口默认 1234 或与设置一致。"
            elif "资源包" in error_message or "不支持该模型" in error_message:
                error_code = "400"
                logger.info("上游云端 API 返回 400（资源包/订阅限制）: %s", error_message[:500])
                if not hint:
                    hint = "\n\n**该错误来自云端服务商**：当前账号或资源包不支持所选模型（如 Qwen3-Coder-Next）。请在云端控制台升级资源包或改用已支持的模型，非本应用配置问题。"
                error_message = "云端服务商返回：当前资源包不支持该模型，请升级资源包或更换模型。"
            elif "400" in error_message or "no schema matches" in _lower or ("validation" in _lower and "body" in _lower):
                error_code = "400"
                _full_400 = error_message[:8000] + ("…" if len(error_message) > 8000 else "")
                logger.warning(
                    "上游 API 返回 400/校验错误（No schema matches），完整响应: %s",
                    _full_400,
                )
                logger.info("若需记录本次请求体形状便于对照 OpenAI 规范排查，请设置环境变量 DEBUG_400_REQUEST=1 后重试。")
                if not hint:
                    hint = "\n\n请求体格式与上游 API 不兼容（常见原因：messages 中 content 需为字符串、或含不支持的字段）。请检查后端日志中「上游 API 返回 400」的完整响应；设置 DEBUG_400_REQUEST=1 可记录请求体形状。"
            elif "401" in error_message or "无效的令牌" in error_message or "new_api_error" in _lower or ("invalid" in _lower and "token" in _lower):
                error_code = "401"
                logger.warning("上游云端 API 返回 401（无效的令牌），请检查对应 api_key_env 环境变量或配置: %s", error_message[:300])
                if not hint:
                    hint = (
                        "\n\n**云端 API 认证失败（401 无效的令牌）**。\n"
                        "请在后端配置的云端端点中设置正确的 API Key：\n"
                        "1) 在 backend/config/models.json 的 cloud_endpoints 里为对应端点配置 api_key_env（如 CLOUD_QWEN_API_KEY）；\n"
                        "2) 在启动后端的同一环境中设置该环境变量为有效令牌后重启后端。"
                    )
                error_message = "云端 API 认证失败（无效的令牌）。请在设置中配置对应云端的 API Key 或检查后端环境变量后重试。"
            else:
                error_code = "unknown"

            user_content = f"执行过程中发生错误：{error_message}\n\n请检查错误信息并重试，或提供更多上下文帮助我理解您的需求。{hint}"
            # 截断过长错误内容，避免超大 payload 导致前端/序列化问题
            _max_error_content_chars = 32000
            if len(user_content) > _max_error_content_chars:
                user_content = user_content[:_max_error_content_chars] + "\n\n[内容已截断]"
            error_ai_message = AIMessage(content=user_content)

            # 仅推送 run_error 供前端结构化处理（如 toast）；error_code/message 统一为 str，与前端 parseRunErrorPayload 契约一致
            if writer:
                try:
                    writer({"type": "run_error", "data": {"error_code": str(error_code or ""), "message": str(error_message or "")}})
                except Exception as _we:
                    logger.warning("run_error 推送到流失败，前端可能未收到结构化错误: %s", _we)

            # 返回包含错误消息的状态：LangGraph 会将其以 messages 事件下发，前端只显示一条
            yield {
                "messages": [error_ai_message]
            }
            
            # 不再 raise，让 LangGraph 正常保存状态
            return
        
        finally:
            try:
                _heartbeat_task.cancel()
                await _heartbeat_task
            except (asyncio.CancelledError, NameError):
                pass
            if _token_handler and _initial_ai_msg_id:
                _token_handler.clear_run_ordered_parts(_initial_ai_msg_id)
            _emit_stream_end_once()
            # ✅ 完成执行日志记录
            if task_id:
                try:
                    from backend.engine.logging import get_execution_logger
                    exec_logger = get_execution_logger()
                    
                    result_summary = None
                    if final_state and isinstance(final_state, dict):
                        msgs = final_state.get("messages", [])
                        if msgs:
                            last_ai_msg = msgs[-1]
                            content = getattr(last_ai_msg, 'content', str(last_ai_msg))
                            result_summary = {"content": content[:_TOOL_RESULT_SUMMARY_MAX_CHARS] if content else ""}
                    runtime_retry_count = _resolve_runtime_retry_count(retry_count, final_state)
                    cost_tier_for_log = str(configurable.get("cost_tier", "medium") or "medium")
                    token_totals = (
                        token_tracker.get_totals()
                        if token_tracker.has_usage()
                        else {"total_tokens": 0, "prompt_tokens": 0, "completion_tokens": 0, "call_count": 0}
                    )
                    estimated_cost_usd = _estimate_cost_usd(
                        int(token_totals.get("total_tokens", 0) or 0),
                        cost_tier_for_log,
                    )
                    resolved_model_id = _resolve_model_id_with_route_prefix(configurable)
                    _billing_kw = {
                        "model_id": resolved_model_id,
                        "task_type": str(configurable.get("task_type") or "chat"),
                        "prompt_tokens": int(token_totals.get("prompt_tokens", 0) or 0),
                        "completion_tokens": int(token_totals.get("completion_tokens", 0) or 0),
                        "estimated_cost_usd": estimated_cost_usd,
                        "is_cloud_model": _is_cloud_model_by_id(resolved_model_id),
                    }
                    try:
                        loop = asyncio.get_running_loop()
                        loop.run_in_executor(None, lambda: _record_billing_usage(**_billing_kw))
                    except Exception as e:
                        logger.warning("run_in_executor billing fallback sync: %s", e)
                        _record_billing_usage(**_billing_kw)
                    exec_logger.complete_task(
                        task_id,
                        final_result=result_summary,
                        error=error_message,
                        metrics={
                            "ttft_ms": int(((first_token_ts or __import__("time").perf_counter()) - node_start_ts) * 1000)
                            if first_token_ts
                            else 0,
                            "queue_wait_ms": queue_wait_ms,
                            "retry_count": runtime_retry_count,
                            "estimated_cost_usd": estimated_cost_usd,
                        },
                    )
                except Exception as log_error:
                    logger.debug(f"执行日志完成失败: {log_error}")
            
            # ✅ 发送上下文统计（优先使用真实 LLM usage，否则回退到估算）
            try:
                from backend.engine.utils.token_utils import (
                    DEFAULT_SYSTEM_PROMPT_TOKENS,
                    estimate_tokens,
                )
                if not writer:
                    raise RuntimeError("stream writer unavailable")

                limit = _DEFAULT_CONTEXT_LENGTH
                try:
                    from backend.engine.agent.model_manager import get_model_manager
                    manager = get_model_manager()
                    model_config = manager.get_model_config(manager.get_current_model())
                    if model_config and "context_length" in model_config:
                        limit = model_config["context_length"]
                except Exception as e:
                    logger.debug("get_model_config context_length: %s", e)
                limit = max(int(limit) if limit is not None else _DEFAULT_CONTEXT_LENGTH, 1)
                cfg_stats = config_with_mode.get("configurable", {}) or {}
                request_id = str(cfg_stats.get("request_id") or "")
                session_id = str(cfg_stats.get("session_id") or "")
                task_type = str(cfg_stats.get("task_type") or "chat")
                cost_tier = str(cfg_stats.get("cost_tier") or "medium")
                runtime_retry_count = _resolve_runtime_retry_count(retry_count, final_state)
                model_id_for_stats = _resolve_model_id_with_route_prefix(cfg_stats)
                def _emit_runtime_stats_bundle(context_data: dict, execution_data: dict) -> None:
                    writer(
                        {
                            "type": "runtime_stats",
                            "data": {"context_stats": context_data, "execution_metrics": execution_data},
                        }
                    )
                    # 兼容旧前端事件面：默认关闭，按环境变量显式开启。
                    if _EMIT_LEGACY_STATS_EVENTS:
                        writer({"type": "context_stats", "data": context_data})
                        writer({"type": "execution_metrics", "data": execution_data})
                now_perf = __import__("time").perf_counter()
                pre_agent_ms = int(max(0.0, (prepare_start_ts - node_start_ts)) * 1000)
                agent_build_ms = int(max(0.0, ((agent_ready_ts or now_perf) - prepare_start_ts)) * 1000)
                pre_stream_ms = int(max(0.0, ((stream_enter_ts or now_perf) - (agent_ready_ts or prepare_start_ts))) * 1000)
                lmstudio_gap_overhead_ms = int(max(0, pre_agent_ms + agent_build_ms + pre_stream_ms))
                stream_to_first_token_ms = (
                    int(max(0.0, (first_token_ts - (stream_enter_ts or node_start_ts))) * 1000)
                    if first_token_ts
                    else 0
                )
                thinking_start_ack_ms = (
                    int(max(0.0, (thinking_start_sent_ts - node_start_ts)) * 1000)
                    if thinking_start_sent_ts
                    else 0
                )
                stream_stats = _token_handler.get_stream_stats() if _token_handler else {}
                budget_usd = 0.0
                try:
                    from backend.engine.agent.model_manager import get_model_manager
                    budget_usd = float((get_model_manager().get_escalation_policy() or {}).get("max_budget_per_task_usd", 0.0) or 0.0)
                except Exception as e:
                    logger.debug("escalation_policy budget_usd fallback: %s", e)
                    budget_usd = 0.0

                if token_tracker.has_usage():
                    totals = token_tracker.get_totals()
                    total_tokens = totals["total_tokens"]
                    estimated_cost_usd = _estimate_cost_usd(total_tokens, cost_tier)
                    percentage = min((total_tokens / limit) * 100, 100)
                    context_data = {
                        "total_tokens": total_tokens,
                        "model_limit": limit,
                        "fromEstimate": False,
                        "prompt_tokens": totals["prompt_tokens"],
                        "completion_tokens": totals["completion_tokens"],
                        "llm_call_count": totals["call_count"],
                        "components": [
                            {"name": "prompt_tokens", "tokens": totals["prompt_tokens"], "percentage": (totals["prompt_tokens"] / limit) * 100},
                            {"name": "completion_tokens", "tokens": totals["completion_tokens"], "percentage": (totals["completion_tokens"] / limit) * 100},
                        ],
                        "timestamp": int(__import__('time').time() * 1000),
                    }
                    execution_data = {
                        "ttft_ms": int(((first_token_ts or __import__("time").perf_counter()) - node_start_ts) * 1000)
                        if first_token_ts
                        else 0,
                        "thinking_start_ack_ms": thinking_start_ack_ms,
                        "pre_agent_ms": pre_agent_ms,
                        "agent_build_ms": agent_build_ms,
                        "pre_stream_ms": pre_stream_ms,
                        "lmstudio_gap_overhead_ms": lmstudio_gap_overhead_ms,
                        "stream_to_first_token_ms": stream_to_first_token_ms,
                        "queue_wait_ms": queue_wait_ms,
                        "total_ms": int((__import__("time").perf_counter() - node_start_ts) * 1000),
                        "retry_count": runtime_retry_count,
                        "request_id": request_id,
                        "session_id": session_id,
                        "task_type": task_type,
                        "model_id": model_id_for_stats,
                        "estimated_cost_usd": round(estimated_cost_usd, 6),
                        "budget_usd": round(budget_usd, 6),
                        "budget_exceeded": bool(budget_usd > 0 and estimated_cost_usd > budget_usd),
                        "adaptive_hotpath_active": bool(cfg_stats.get("adaptive_hotpath_active", False)),
                        "adaptive_hotpath_reason": str(cfg_stats.get("adaptive_hotpath_reason", "") or ""),
                        "adaptive_hotpath_queue_wait_ms": int(cfg_stats.get("adaptive_hotpath_queue_wait_ms", 0) or 0),
                        "adaptive_hotpath_retry_count": int(cfg_stats.get("adaptive_hotpath_retry_count", 0) or 0),
                        **stream_stats,
                    }
                    _emit_runtime_stats_bundle(context_data, execution_data)
                else:
                    system_tokens = DEFAULT_SYSTEM_PROMPT_TOKENS
                    history_tokens = 0
                    tool_tokens = 0
                    if final_state and isinstance(final_state, dict):
                        msgs = final_state.get("messages", [])
                        if isinstance(msgs, list) and len(msgs) > _CONTEXT_STATS_MAX_HISTORY_MSGS:
                            msgs = msgs[-_CONTEXT_STATS_MAX_HISTORY_MSGS:]
                        for msg in msgs:
                            content = getattr(msg, 'content', '') or ''
                            if not isinstance(content, str):
                                continue
                            if len(content) > _CONTEXT_STATS_MAX_MSG_CHARS:
                                head = content[:_CONTEXT_STATS_MAX_MSG_CHARS]
                                # 长文本按“截断估算 + 线性外推”近似，避免收尾阶段高开销。
                                msg_tokens = estimate_tokens(head) + max(0, (len(content) - _CONTEXT_STATS_MAX_MSG_CHARS) // 4)
                            else:
                                msg_tokens = estimate_tokens(content)
                            msg_type = getattr(msg, 'type', '')
                            if msg_type == 'tool':
                                tool_tokens += msg_tokens
                            else:
                                history_tokens += msg_tokens
                    total_tokens = system_tokens + history_tokens + tool_tokens
                    estimated_cost_usd = _estimate_cost_usd(total_tokens, cost_tier)
                    percentage = min((total_tokens / limit) * 100, 100)
                    context_data = {
                        "total_tokens": total_tokens,
                        "model_limit": limit,
                        "fromEstimate": True,
                        "components": [
                            {"name": "system_prompt", "tokens": system_tokens, "percentage": (system_tokens / limit) * 100},
                            {"name": "history", "tokens": history_tokens, "percentage": (history_tokens / limit) * 100},
                            {"name": "tools", "tokens": tool_tokens, "percentage": (tool_tokens / limit) * 100},
                        ],
                        "timestamp": int(__import__('time').time() * 1000),
                    }
                    execution_data = {
                        "ttft_ms": int(((first_token_ts or __import__("time").perf_counter()) - node_start_ts) * 1000)
                        if first_token_ts
                        else 0,
                        "thinking_start_ack_ms": thinking_start_ack_ms,
                        "pre_agent_ms": pre_agent_ms,
                        "agent_build_ms": agent_build_ms,
                        "pre_stream_ms": pre_stream_ms,
                        "lmstudio_gap_overhead_ms": lmstudio_gap_overhead_ms,
                        "stream_to_first_token_ms": stream_to_first_token_ms,
                        "queue_wait_ms": queue_wait_ms,
                        "total_ms": int((__import__("time").perf_counter() - node_start_ts) * 1000),
                        "retry_count": runtime_retry_count,
                        "request_id": request_id,
                        "session_id": session_id,
                        "task_type": task_type,
                        "model_id": model_id_for_stats,
                        "estimated_cost_usd": round(estimated_cost_usd, 6),
                        "budget_usd": round(budget_usd, 6),
                        "budget_exceeded": bool(budget_usd > 0 and estimated_cost_usd > budget_usd),
                        "adaptive_hotpath_active": bool(cfg_stats.get("adaptive_hotpath_active", False)),
                        "adaptive_hotpath_reason": str(cfg_stats.get("adaptive_hotpath_reason", "") or ""),
                        "adaptive_hotpath_queue_wait_ms": int(cfg_stats.get("adaptive_hotpath_queue_wait_ms", 0) or 0),
                        "adaptive_hotpath_retry_count": int(cfg_stats.get("adaptive_hotpath_retry_count", 0) or 0),
                        **stream_stats,
                    }
                    _emit_runtime_stats_bundle(context_data, execution_data)
            except Exception as stats_error:
                logger.debug(f"发送上下文统计失败: {stats_error}")
            
            # ✅ 学习系统集成（任务完成后学习，传入 configurable 供 task_type/workspace_domain）
            try:
                from backend.engine.agent.deep_agent import Config
                should_learn = bool(final_state) or bool(error_message)
                if Config.ENABLE_SELF_LEARNING and should_learn and not interrupted:
                    from backend.tools.base.learning_middleware import (
                        learn_from_success,
                        learn_from_failure,
                        enqueue_execution_memory_reflection,
                    )
                    configurable = config_with_mode.get("configurable") or {}
                    workspace_domain = (
                        configurable.get("skill_profile")
                        or configurable.get("business_domain")
                        or configurable.get("workspace_domain")
                    )
                    langgraph_user_id = (
                        configurable.get("langgraph_user_id")
                        or configurable.get("user_id")
                        or thread_id
                        or "system"
                    )
                    
                    if error_message or done_check_failed:
                        loop_strategy = str(configurable.get("loop_escape_strategy", "retry_with_variation"))
                        failure_message = error_message or f"done_check_failed: {done_check_reason or 'validation_failed'}"
                        learn_from_failure(
                            task_id or "unknown",
                            mode,
                            failure_message,
                            query,
                            workspace_domain=workspace_domain,
                            failed_attempt=f"mode={mode}|loop_strategy={loop_strategy}",
                            recovery_hint=(
                                f"{loop_strategy};补齐验收项并确保结果直接响应任务目标"
                                if done_check_failed and not error_message
                                else loop_strategy
                            ),
                        )
                    else:
                        loop_detector.register_success()
                        result_str = ""
                        if result_summary:
                            result_str = result_summary.get("content", "")
                        learn_from_success(
                            task_id or "unknown",
                            mode,
                            query,
                            result_str,
                            entities_used=None,
                            workspace_domain=workspace_domain,
                        )
                        # 执行经验回放沉淀：成功任务异步提取 procedural memory
                        try:
                            enqueue_execution_memory_reflection(
                                user_id=str(langgraph_user_id),
                                task_id=task_id or "unknown",
                                task_type=mode or "agent",
                                query=query or "",
                                result_summary=result_str or "",
                                workspace_domain=str(workspace_domain or "general"),
                                store=get_sqlite_store(),
                            )
                        except Exception as replay_err:
                            logger.debug("执行经验回放入库失败（非关键）: %s", replay_err)
            except Exception as learn_error:
                logger.debug(f"学习系统调用失败（非关键）: {learn_error}")
            
            # ✅ 用户记忆抽取：对话结束后沉淀「关于用户」的事实与偏好，供 search_memory 检索（需 Store 持久化）
            try:
                _store = get_sqlite_store()
                if _store is not None:
                    configurable = config_with_mode.get("configurable") or {}
                    langgraph_user_id = (
                        configurable.get("langgraph_user_id")
                        or configurable.get("user_id")
                        or thread_id
                        or "system"
                    )
                    final_msgs = (final_state or {}).get("messages", []) or []
                    snapshot = []
                    try:
                        _max_snapshot = int(os.environ.get("USER_MEMORY_EXTRACTION_MAX_MESSAGES", "12") or "12")
                    except (TypeError, ValueError):
                        _max_snapshot = 12
                    _max_snapshot = max(2, min(_max_snapshot, 30))
                    _max_content = 2000
                    for m in final_msgs[-_max_snapshot * 2 :]:
                        if len(snapshot) >= _max_snapshot:
                            break
                        role = None
                        content = (getattr(m, "content", None) or "") if hasattr(m, "content") else ""
                        if isinstance(content, list):
                            content = " ".join(str(c) for c in content)[:_max_content]
                        else:
                            content = str(content or "")[:_max_content]
                        if not content.strip():
                            continue
                        if isinstance(m, HumanMessage) or getattr(m, "type", "") == "human":
                            role = "user"
                        elif isinstance(m, AIMessage) or getattr(m, "type", "") == "ai":
                            role = "assistant"
                        if role:
                            snapshot.append({"role": role, "content": content})
                    has_user = any(s.get("role") == "user" for s in snapshot)
                    if len(snapshot) >= 2 and has_user:
                        from backend.tools.base.learning_middleware import enqueue_user_memory_reflection
                        enqueue_user_memory_reflection(
                            user_id=str(langgraph_user_id),
                            messages_snapshot=snapshot,
                            store=_store,
                        )
                # _store is None 时跳过，避免无效 LLM 调用
            except Exception as user_mem_err:
                logger.debug("用户记忆抽取入队失败（非关键）: %s", user_mem_err)
            
            # ✅ 首条用户消息后写 metadata.title（放入 executor 避免阻塞事件循环）
            if title_candidate and thread_id and thread_id != "unknown":
                try:
                    loop = asyncio.get_running_loop()
                    loop.run_in_executor(None, lambda: _update_thread_title(thread_id, title_candidate))
                except Exception as title_err:
                    logger.debug("thread title update (non-critical): %s", title_err)
            
            # ✅ 任务 thread 执行完成后回写 task_status（Task = Thread）
            if thread_id and thread_id != "unknown":
                try:
                    from backend.engine.tasks.task_service import update_task_status_sync
                    cfg_eval = dict(config_with_mode.get("configurable", {}) or {})
                    final_state_snapshot = final_state if isinstance(final_state, dict) else {}
                    error_snapshot = str(error_message or "")
                    interrupted_snapshot = bool(interrupted)
                    mode_snapshot = str(mode or "agent")
                    task_id_snapshot = str(task_id or "")
                    result_summary_for_task = None
                    msgs = final_state_snapshot.get("messages", []) or []
                    for msg in reversed(msgs):
                        if isinstance(msg, AIMessage):
                            raw = getattr(msg, "content", "") or ""
                            if isinstance(raw, list):
                                content = " ".join(str(c) for c in raw).strip() if raw else ""
                            else:
                                content = str(raw) if raw else ""
                            result_summary_for_task = {"content": (content[:_TOOL_RESULT_SUMMARY_MAX_CHARS] if content else "")}
                            break
                    task_status = "waiting_human" if interrupted_snapshot else ("failed" if error_snapshot else "completed")
                    await asyncio.to_thread(
                        update_task_status_sync,
                        thread_id,
                        task_status,
                        result_summary=result_summary_for_task,
                        error=error_snapshot or None,
                    )

                    def _finalize_task_status_background():
                        try:
                            # 自动评估（LangSmith 可用时上报 feedback；不可用时仅落本地评估日志）
                            try:
                                from backend.engine.observability.langsmith_eval import auto_evaluate_task
                                auto_evaluate_task(
                                    thread_id=thread_id,
                                    mode=mode_snapshot,
                                    task_status=task_status,
                                    result_summary=result_summary_for_task,
                                    error=error_snapshot or None,
                                    request_id=str(cfg_eval.get("request_id") or ""),
                                    task_id=task_id_snapshot,
                                    model_id=str(
                                        cfg_eval.get("pinned_model")
                                        or cfg_eval.get("thread_model")
                                        or cfg_eval.get("model")
                                        or ""
                                    ),
                                    session_id=str(cfg_eval.get("session_id") or ""),
                                    run_id=str(cfg_eval.get("run_id") or ""),
                                )
                            except Exception as eval_err:
                                logger.debug("langsmith auto-eval (non-critical): %s", eval_err)
                            # 同步看板任务：将 status=running 且 thread_id 匹配的任务更新为 completed/failed 及 result
                            try:
                                task_bidding_mod = __import__(
                                    "backend.engine.tasks.task_bidding",
                                    fromlist=["sync_board_task_by_thread_id"],
                                )
                                sync_board_task_by_thread_id = getattr(
                                    task_bidding_mod, "sync_board_task_by_thread_id", None
                                )
                                result_str = (result_summary_for_task.get("content", "") or "") if result_summary_for_task else (error_snapshot or "")
                                if callable(sync_board_task_by_thread_id):
                                    sync_board_task_by_thread_id(thread_id, task_status, result_str)
                            except Exception as board_sync_err:
                                logger.debug("board task sync (non-critical): %s", board_sync_err)
                        except Exception as task_upd_err:
                            logger.debug("task status update (non-critical): %s", task_upd_err)

                    loop = asyncio.get_running_loop()
                    loop.run_in_executor(None, _finalize_task_status_background)
                except Exception as task_upd_err:
                    logger.debug("task status update (non-critical): %s", task_upd_err)
    
    async def deepagent_plan_node(state, config=None):
        """Plan 规划阶段节点（图级显式分支）。"""
        planning_config = _merge_configurable_overrides(
            config,
            {
                "mode": "plan",
                "plan_phase": "planning",
                "plan_confirmed": False,
            },
        )
        async for chunk in deepagent_node(state, planning_config):
            yield chunk
        # Plan 阶段完成后图级中断：等待人工确认再执行。
        try:
            from langgraph.types import interrupt, NodeInterrupt

            configurable = dict((config or {}).get("configurable", {})) if isinstance(config, dict) else {}
            thread_id = str(configurable.get("thread_id") or "").strip()
            user_goal = _extract_last_human_text(state.get("messages") or [])[:300]
            if thread_id:
                try:
                    from backend.engine.tasks.task_bidding import sync_board_task_by_thread_id

                    sync_board_task_by_thread_id(thread_id, "awaiting_plan_confirm", "计划已生成，等待确认执行")
                except Exception as e:
                    logger.debug("sync_board_task_by_thread_id awaiting_plan_confirm: %s", e)

            # 通知前端流已暂停（等待用户确认），便于前端清除 isStreamingRef 允许第二次输入
            try:
                from langgraph.config import get_stream_writer
                _writer = get_stream_writer()
                if _writer:
                    _writer({"type": "stream_paused", "data": {"reason": "plan_confirmation", "thread_id": thread_id}})
            except Exception as _w_err:
                logger.debug("stream_paused emit (non-critical): %s", _w_err)

            resume_payload = interrupt(
                {
                    "type": "plan_confirmation",
                    "checkpoint_id": "plan_confirmation",
                    "summary": "计划阶段已完成，请确认是否进入执行阶段。",
                    "context": user_goal,
                    "options": ["approve", "reject", "revise"],
                }
            )
            decision = ""
            if isinstance(resume_payload, str):
                decision = resume_payload.strip().lower()
            elif isinstance(resume_payload, dict):
                decision = str(
                    resume_payload.get("decision")
                    or resume_payload.get("response")
                    or ""
                ).strip().lower()
            approved = decision in {"approve", "approved", "confirm", "confirmed", "yes", "execute"}
            if not approved:
                if thread_id:
                    try:
                        from backend.engine.tasks.task_bidding import sync_board_task_by_thread_id

                        sync_board_task_by_thread_id(thread_id, "awaiting_plan_confirm", "计划待确认，尚未执行")
                    except Exception as e:
                        logger.debug("sync_board_task_by_thread_id not_approved: %s", e)
                return

            plan_path = _write_plan_to_workspace(state, config)
            execute_overrides = {
                "mode": "plan",
                "plan_phase": "execution",
                "plan_confirmed": True,
            }
            if plan_path:
                execute_overrides["plan_file_path"] = str(plan_path)
            execute_config = _merge_configurable_overrides(config, execute_overrides)
            if thread_id:
                try:
                    from backend.engine.tasks.task_bidding import sync_board_task_by_thread_id

                    sync_board_task_by_thread_id(thread_id, "running", "计划已确认，进入执行阶段")
                except Exception as e:
                    logger.debug("sync_board_task_by_thread_id running: %s", e)
            async for chunk in deepagent_node(state, execute_config):
                yield chunk
        except NodeInterrupt:
            raise
        except Exception as e:
            logger.debug("Plan 图级确认中断失败，回退原行为: %s", e)

    async def deepagent_execute_node(state, config=None):
        """执行阶段节点（Agent/Ask/Debug/Review + Plan 确认后）。"""
        messages = state.get("messages") or []
        mode = _extract_mode_from_messages(messages)
        execute_config = config
        configurable = dict((config or {}).get("configurable", {})) if isinstance(config, dict) else {}
        last_text = (_extract_last_human_text(messages) or "").strip()
        has_plan_file_path = bool(str((configurable or {}).get("plan_file_path") or "").strip())

        if mode == "plan":
            execute_config = _merge_configurable_overrides(
                config,
                {
                    "mode": "plan",
                    "plan_phase": "execution",
                    "plan_confirmed": True,
                },
            )
            if not has_plan_file_path:
                plan_path = _resolve_plan_path_for_thread(
                    configurable.get("thread_id") or configurable.get("session_id"),
                    configurable.get("workspace_path"),
                )
                if plan_path:
                    execute_config = _merge_configurable_overrides(execute_config, {"plan_file_path": str(plan_path)})
        else:
            execute_config = config

        # 路径 B 回退：不论 mode，最后一条人类消息含「确认执行」且 execute 仍无 plan_file_path 时解析并注入
        cfg_after = (execute_config or {}).get("configurable") or {}
        still_no_plan_path = not bool(str(cfg_after.get("plan_file_path") or "").strip())
        if still_no_plan_path and last_text and "确认执行" in last_text:
            plan_path = _resolve_plan_path_for_thread(
                configurable.get("thread_id") or configurable.get("session_id"),
                configurable.get("workspace_path"),
            )
            if plan_path:
                execute_config = _merge_configurable_overrides(
                    execute_config,
                    {
                        "plan_phase": "execution",
                        "plan_confirmed": True,
                        "plan_file_path": str(plan_path),
                    },
                )

        async for chunk in deepagent_node(state, execute_config):
            yield chunk

    workflow.add_node("deepagent_plan", deepagent_plan_node)
    workflow.add_node("deepagent_execute", deepagent_execute_node)
    """
    deepagent 节点（异步流式）：
    - 使用异步生成器支持流式输出
    - 每个 LLM token 和工具调用都会实时传递到前端
    - 支持动态模型切换（通过 config.configurable.model）
    
    ✅ 流式输出机制：
    - agent.astream() 返回异步生成器
    - 每个事件包含：节点名称、状态更新、消息等
    - 父图自动将事件传递给 LangGraph Server
    - Server 通过 SSE 推送给前端
    
    ✅ 动态模型选择：
    - 前端通过 config.configurable.model 传递模型名称
    - get_agent() 检查模型是否变化，必要时重建 Agent
    - 无需重启服务
    """
    
    workflow.add_node("editor_tool", editor_tool_node)
    """
    editor_tool 节点：
    - 直接调用工具（read_file, write_file, format_code 等）
    - 无 LLM 推理，快速响应
    - 适用于确定性操作
    """
    
    workflow.add_node("error", error_node)
    """
    error 节点：
    - 处理无法路由或执行失败的请求
    - 返回友好的错误信息
    """
    
    # ============================================================
    # 设置入口点
    # ============================================================
    
    workflow.set_entry_point("router")
    
    # ============================================================
    # 添加条件路由
    # ============================================================
    
    def _route_decision_with_plan_phase(state: AgentState):
        """主路由 + Plan 图级阶段分流。"""
        # #region agent log
        _msgs = state.get("messages") or []
        _debug_log_agent("route_decision_enter", {"message_count": len(_msgs), "last_msg_type": type(_msgs[-1]).__name__ if _msgs else "none"}, "H1")
        # #endregion
        base = None
        if _ROUTER_INLINE_FASTPATH:
            try:
                messages = state.get("messages") or []
                last_message = messages[-1] if messages else None
                kwargs = getattr(last_message, "additional_kwargs", {}) or {}
                source = str(kwargs.get("source", "chatarea") or "chatarea")
                request_type = str(kwargs.get("request_type", "agent_chat") or "agent_chat")
                if source == "chatarea" and request_type == "agent_chat":
                    base = "deepagent"
            except Exception as e:
                logger.debug("router inline fastpath fallback: %s", e)
                base = None
        if base is None:
            base = route_decision(state)
        # #region agent log
        _debug_log_agent("route_decision_result", {"base": base, "message_count": len(state.get("messages") or [])}, "H1")
        # #endregion
        if base != "deepagent":
            return base

        mode = extract_mode_from_messages(state.get("messages") or [])

        if mode != "plan":
            return "deepagent_execute"

        # Plan 模式统一走 planning 节点，由图级 interrupt 做确认与恢复。
        return "deepagent_plan"

    workflow.add_conditional_edges(
        "router",
        _route_decision_with_plan_phase,
        {
            "deepagent_plan": "deepagent_plan",        # plan 未确认：规划分支
            "deepagent_execute": "deepagent_execute",  # plan 确认或非 plan：执行分支
            "editor_tool": "editor_tool",              # editor + tool_command 或 file_sync
            "error": "error",                          # 无法路由
        }
    )
    
    # ============================================================
    # 设置终点
    # ============================================================
    
    workflow.add_edge("deepagent_plan", END)
    workflow.add_edge("deepagent_execute", END)
    workflow.add_edge("editor_tool", END)
    workflow.add_edge("error", END)

    # P3 预留：若需 Plan 模式「用户确认后再执行」，可在此为 mode=plan 增加分支子图，
    # 子图内对 deepagent 使用 interrupt_after，输出计划后中断，用户确认后恢复。见 docs/operations.md。
    
    # ============================================================
    # 编译 Graph（存储配置）
    # ============================================================
    # LangGraph Server 模式（use_sqlite=False）：checkpointer/store 由 langgraph.json 注入，不在此处传入
    # 独立模式（use_sqlite=True）：使用 get_sqlite_checkpointer/store 本地持久化
    final_checkpointer = checkpointer
    final_store = store
    
    if use_sqlite and final_checkpointer is None:
        final_checkpointer = get_sqlite_checkpointer()
    
    if use_sqlite and final_store is None:
        final_store = get_sqlite_store()
    if final_store is not None:
        try:
            from backend.tools.base.task_board_tools import set_store_getter
            set_store_getter(get_sqlite_store)
        except Exception as e:
            logger.debug("task_board set_store_getter (non-critical): %s", e)
    
    # 编译时注入存储
    compile_kwargs = {}
    if final_checkpointer is not None:
        compile_kwargs["checkpointer"] = final_checkpointer
    if final_store is not None:
        compile_kwargs["store"] = final_store
    
    compiled_graph = workflow.compile(**compile_kwargs)
    
    # ✅ 设置合理的 recursion_limit
    # 默认值 25 太低，复杂任务容易触发
    # SubAgent 的每次调用都会消耗 recursion_limit
    compiled_graph = compiled_graph.with_config({"recursion_limit": _GRAPH_RECURSION_LIMIT})
    
    logger.info("=" * 80)
    logger.info("✅ 主路由 Graph 创建完成")
    logger.info("=" * 80)
    logger.info("架构:")
    logger.info("  router → [deepagent | editor_tool | error] → END")
    logger.info("")
    logger.info("✅ 动态模型选择:")
    logger.info("  - 前端通过 config.configurable.model 传递")
    logger.info("  - LangGraph 将 config 传递给节点，get_agent(config) 按 model 创建/缓存 Agent")
    logger.info("  - 流式：deepagent 节点内 agent.astream(stream_mode='messages') + get_stream_writer() 转发 token")
    logger.info("")
    logger.info("✅ 生产级存储配置:")
    logger.info(f"  - Checkpointer: {'SQLite (' + str(CHECKPOINTS_DB) + ')' if final_checkpointer else '无（内存模式）'}")
    logger.info(f"  - Store: {'SQLite (' + str(STORE_DB) + ')' if final_store else '无（内存模式）'}")
    logger.info("=" * 80)
    
    return compiled_graph


# ============================================================
# 创建并导出 graph 实例
# ============================================================

# 检测运行环境
# LangGraph API 会设置这些环境变量
_IS_LANGGRAPH_API = (
    os.getenv("LANGGRAPH_API", "").lower() in ("1", "true", "yes") or
    os.getenv("LANGGRAPH_DEV", "").lower() in ("1", "true", "yes") or
    # langgraph dev/up 会设置这个变量
    "langgraph_api" in sys.modules or
    "langgraph_runtime_inmem" in sys.modules
)

# LangGraph Server 会从这里加载 graph
# ⚠️ 重要：LangGraph API 会自动管理持久化，不允许自定义 checkpointer 和 store
# 如果提供了自定义存储，会抛出 ValueError
if _IS_LANGGRAPH_API:
    # LangGraph API 模式：不使用自定义存储（由平台管理）
    # 注意：此模式下 checkpoint 由平台写入，无法做 messages content 归一化；若出现工具调用后 400，可改用独立运行（不设 LANGGRAPH_API/LANGGRAPH_DEV）以使用 NormalizingCheckpointer。
    logger.info("🌐 检测到 LangGraph API 模式，使用平台管理的持久化")
    logger.info("   持久化由 LangGraph API 自动处理，无需自定义 checkpointer/store")
    graph = create_router_graph(use_sqlite=False)  # 不使用自定义存储
else:
    # 独立运行模式：使用 SQLite 持久化存储
    logger.info("🔧 独立运行模式，使用 SQLite 持久化存储")
    graph = create_router_graph(use_sqlite=True)


def create_graph_with_memory():
    """创建带有完整内存管理的 Graph（生产环境推荐）
    
    此函数确保：
    1. 使用 SQLite 文件持久化（重启不丢失）
    2. 正确初始化 checkpointer 和 store
    3. 支持 TTL 自动清理过期数据
    
    Returns:
        CompiledStateGraph: 带有持久化存储的 Graph
    """
    return create_router_graph(
        checkpointer=get_sqlite_checkpointer(),
        store=get_sqlite_store(),
        use_sqlite=True,
    )


__all__ = [
    "graph",
    "create_router_graph",
    "create_graph_with_memory",
    "get_sqlite_checkpointer",
    "get_sqlite_store",
    "cleanup_storage",
    "CHECKPOINTS_DB",
    "STORE_DB",
]
