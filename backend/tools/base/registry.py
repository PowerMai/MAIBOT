"""
✅ 补充工具注册表 - Claude 极简设计

=== 设计哲学：给 AI 一台电脑 ===
参照 Claude Agent SDK，核心工具极简化：
- 对话框 = 控制中心（用户用自然语言表达意图）
- Agent 用核心工具组合实现任何功能
- 不需要专门的"系统管理工具"

=== 核心工具（DeepAgent FilesystemMiddleware 提供） ===
- ls, read_file, write_file, edit_file, glob, grep
（注意：FilesystemMiddleware 不提供 execute，使用 python_run 或 shell_run）

=== 本注册表补充工具（极简） ===
- python_run: 万能执行器（可以调用任何 Python 库）
- shell_run: 系统命令
- search_knowledge: 知识检索（唯一的"高级"工具）

=== 系统功能通过对话 + python_run 实现 ===
- 查看状态 → python_run 执行代码读取状态
- 学习文档 → python_run 调用 KnowledgeLearner
- 创建 Skill → write_file 创建 SKILL.md
- 导出数据 → python_run 调用 export_for_finetuning()
"""

import hashlib
import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import List, Any, Optional
from langchain_core.tools import Tool, tool

from .streaming import get_tool_stream_writer, emit_tool_event

logger = logging.getLogger(__name__)

try:
    from langsmith import traceable  # type: ignore
except Exception:  # pragma: no cover
    def traceable(*_args, **_kwargs):  # type: ignore
        def _decorator(func):
            return func
        return _decorator


class CoreToolsRegistry:
    """
    补充工具注册表
    
    只注册 DeepAgent FilesystemMiddleware 不提供的工具（项目记忆与用户上下文由 deep_agent 注入）
    
    优化：延迟导入
    - 工具工厂在初始化时注册，但实际导入推迟到首次使用
    - 减少启动时间和内存占用
    """
    
    def __init__(self):
        self.tools = {}
        self._tool_factories = {}  # 延迟导入工厂
        self._loaded_tools = set()  # 已加载的工具
        self._register_all_tools()

    def _register_disabled_tool(self, name: str, reason: str):
        """注册降级占位工具，避免运行时出现 Tool not found。"""
        @tool(name)
        def _disabled_tool(query: str = "") -> str:
            return json.dumps(
                {
                    "ok": False,
                    "tool": name,
                    "error": "tool_disabled",
                    "reason": reason,
                    "query": query,
                    "action": "请启用对应环境变量或安装依赖后重试",
                },
                ensure_ascii=False,
            )

        self.tools[name] = _disabled_tool
    
    def _register_all_tools(self):
        """注册补充工具（DeepAgent 不提供的）"""
        
        print("=" * 70)
        print("🔧 Registering Additional Tools (DeepAgent provides core file ops)")
        print("=" * 70)
        
        # ============================================================
        # DeepAgent 已提供的工具（不需要注册）
        # ============================================================
        print("\n📁 DeepAgent FilesystemMiddleware provides:")
        print("  ℹ️  ls, read_file, write_file, edit_file, glob, grep")
        print("  ℹ️  (No execute - use python_run or shell_run instead)")
        
        print("\n🧠 项目记忆与用户上下文（deep_agent 提供，非 MemoryMiddleware）：")
        print("  ℹ️  project_memory: _load_memory_content(.maibot/MAIBOT.md, .maibot/rules/*.md)")
        print("  ℹ️  inject_user_context: @dynamic_prompt 从 config.configurable 注入")
        
        # ============================================================
        # 代码执行工具（增强版）
        # ============================================================
        print("\n⚙️  Code Execution Tools (enhanced):")
        
        try:
            from .code_execution import execute_python_code, execute_python_internal
            self.tools['python_run'] = execute_python_code
            self.tools['python_internal'] = execute_python_internal
            print("  ✅ python_run - Execute Python code (with auto-imports)")
            print("  ✅ python_internal - Fast internal execution (Cursor-style)")
        except ImportError as e:
            print(f"  ❌ python_run - {e}")
        
        # Shell 命令执行工具（Claude Code Bash 风格）
        @tool
        @traceable(name="shell_run", run_type="tool")
        def shell_run(command: str, working_directory: str = None, timeout: Optional[int] = None) -> str:
            """Run shell commands and return combined stdout/stderr.

            Purpose:
            - 执行系统级命令（git/npm/pip/docker/python 等）并返回结果。

            When to use:
            - 需要调用 CLI 工具完成安装、构建、测试、脚本执行。
            - 需要采集命令输出作为后续判断依据。

            Avoid when:
            - 文件内容读写：用 read_file/write_file/edit_file，不用 cat/sed/awk/echo 重定向。
            - 数据处理与解析：用 python_run（支持 pandas、openpyxl 等）。

            Parameters:
            - command: shell 命令字符串（可包含多个子命令）；多命令用 && 连接。
            - working_directory: 可选，工作目录（默认项目/工作区根）。
            - timeout: 超时秒数（可选）。

            Returns:
            - 成功返回 `✅` + 输出；失败返回 `❌` + exit code 与错误信息。

            Examples:
            - `git status`
            - `python scripts/health_check.py`
            """
            import subprocess
            from .code_execution import (
                detect_shell_bypass_risk,
                is_shell_command_blocked,
                normalize_shell_timeout,
                resolve_shell_working_directory,
                _get_default_tool_timeout,
            )
            
            try:
                # 命令策略检查（可通过 .maibot/settings.json.execution_policy.shell 配置）
                blocked, reason = is_shell_command_blocked(command)
                if blocked:
                    return f"⛔ 已被执行策略拦截\n{reason}"
                bypass_reason = detect_shell_bypass_risk(command)
                if bypass_reason:
                    return f"⛔ 已被执行策略拦截\n{bypass_reason}"
                resolved_timeout = int(timeout if timeout is not None else _get_default_tool_timeout())
                safe_timeout = normalize_shell_timeout(resolved_timeout)
                cwd_path, wd_err = resolve_shell_working_directory(working_directory)
                if wd_err:
                    return f"⛔ 已被执行策略拦截\n{wd_err}"
                cwd = str(cwd_path)

                stream_writer = get_tool_stream_writer()
                if stream_writer:
                    emit_tool_event(stream_writer, "shell_start", command=command)

                # 执行命令
                result = subprocess.run(
                    command,
                    shell=True,
                    cwd=cwd,
                    capture_output=True,
                    text=True,
                    timeout=safe_timeout,
                )

                output_parts = []
                if result.stdout:
                    output_parts.append(result.stdout)
                if result.stderr:
                    output_parts.append(f"[stderr] {result.stderr}")

                output = "\n".join(output_parts) if output_parts else "(no output)"

                if stream_writer:
                    if output:
                        emit_tool_event(stream_writer, "shell_output", data=output)
                    emit_tool_event(stream_writer, "shell_complete", returncode=result.returncode)

                if result.returncode == 0:
                    return f"✅ 成功 (exit: 0)\n{output}"
                else:
                    return f"❌ 失败 (exit: {result.returncode})\n{output}"

            except subprocess.TimeoutExpired:
                stream_writer = get_tool_stream_writer()
                if stream_writer:
                    emit_tool_event(stream_writer, "shell_complete", returncode=-1)
                return f"❌ 超时（>{safe_timeout}s）"
            except Exception as e:
                stream_writer = get_tool_stream_writer()
                if stream_writer:
                    emit_tool_event(stream_writer, "shell_complete", returncode=-1)
                return f"❌ 执行失败: {str(e)}"
        
        self.tools['shell_run'] = shell_run
        print("  ✅ shell_run - Execute shell commands (git, npm, pip, etc.)")

        # ============================================================
        # 二进制文件写入（DOCX/PDF/Excel 等 AI 生成后写回工作区）
        # ============================================================
        @tool
        @traceable(name="write_file_binary", run_type="tool")
        def write_file_binary(file_path: str, content: str) -> str:
            """Write binary content to a file (base64-encoded).

            Use when:
            - 需要写入非文本文件：docx、xlsx、pdf、pptx、图片等。
            - AI 生成或修改了二进制内容（如 python-docx/openpyxl 产出）后保存到工作区。

            Parameters:
            - file_path: 工作区相对路径或绝对路径（如 report.docx、output/数据.xlsx）。
            - content: Base64 编码的二进制内容（与 read_file 对二进制返回的 content 一致）。

            Returns:
            - 成功返回路径与大小；失败返回错误信息。
            """
            try:
                from backend.api.common import resolve_write_path, sync_write_binary
                from fastapi import HTTPException
                path = resolve_write_path(file_path)
                size = sync_write_binary(path, content)
                return json.dumps({"ok": True, "path": str(path), "size": size}, ensure_ascii=False)
            except HTTPException as e:
                return json.dumps({"ok": False, "error": e.detail or str(e)}, ensure_ascii=False)
            except Exception as e:
                return json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False)

        self.tools["write_file_binary"] = write_file_binary
        print("  ✅ write_file_binary - Write binary file (docx/xlsx/pdf/pptx, base64)")

        # ============================================================
        # 思考/交互工具（Claude 风格）
        # ============================================================
        print("\n🧠 Thinking Tools (Claude-style):")
        
        try:
            from .reflection import think_tool, ask_user
            self.tools['think_tool'] = think_tool
            self.tools['ask_user'] = ask_user
            print("  ✅ think_tool - Step-by-step reasoning")
            print("  ✅ ask_user - Ask user and wait for response")
        except ImportError as e:
            print(f"  ❌ Thinking tools - {e}")

        # Plan 模式切换工具（Claude Code Enter/ExitPlanMode 对齐）
        @tool
        def enter_plan_mode() -> str:
            """Request switching current session into Plan mode.

            Use when:
            - 任务存在明显架构权衡、需求歧义或高风险改动，先规划后执行更稳妥。

            Returns:
            - JSON 指令，提示前端/编排层切换到 plan 模式并先输出结构化计划。
            """
            return json.dumps(
                {
                    "ok": True,
                    "action": "enter_plan_mode",
                    "target_mode": "plan",
                    "instruction": "先做研究与规划，等待用户确认后再执行。",
                },
                ensure_ascii=False,
            )

        @tool
        def exit_plan_mode(confirmed: bool = False) -> str:
            """Request leaving Plan mode.

            Args:
            - confirmed: 是否已得到用户确认执行计划。

            Returns:
            - JSON 指令；confirmed=true 时建议切回 agent 并进入执行阶段。
            """
            return json.dumps(
                {
                    "ok": True,
                    "action": "exit_plan_mode",
                    "target_mode": "agent" if bool(confirmed) else "plan",
                    "plan_confirmed": bool(confirmed),
                    "instruction": (
                        "计划已确认，切回 Agent 执行。"
                        if bool(confirmed)
                        else "保持 Plan 模式，继续完善方案并请求确认。"
                    ),
                },
                ensure_ascii=False,
            )

        self.tools['enter_plan_mode'] = enter_plan_mode
        self.tools['exit_plan_mode'] = exit_plan_mode
        print("  ✅ enter_plan_mode - Request switching to plan mode")
        print("  ✅ exit_plan_mode - Request leaving plan mode")

        # 结构化审查工具（LangChain 官方 structured output）
        @tool
        def critic_review(draft: str, evidence: str = "") -> str:
            """Run structured evidence-and-calculation critique.

            Use when:
            - 需要审查结论是否有证据支撑，或计算是否可验证。
            - 需要输出可执行的修订建议而非自由文本点评。

            Avoid when:
            - 任务目标是语气润色或文风优化。
            - 尚未准备可审查的草稿内容。

            Strategy:
            - 优先提供 evidence(JSON, source_id/excerpt) 以提升审查精度。
            - 重点关注 unsupported_claims / unverified_calculations 两类风险。
            """
            try:
                from typing import Literal
                from pydantic import BaseModel, Field
                from langchain_core.prompts import ChatPromptTemplate
                from backend.engine.agent.model_manager import get_model_manager

                class CriticResult(BaseModel):
                    unsupported_claims: list[str] = Field(default_factory=list)
                    unverified_calculations: list[str] = Field(default_factory=list)
                    overall_quality: Literal["pass", "revise", "reject"] = "revise"

                llm = get_model_manager().create_llm(task_type="analysis").with_structured_output(CriticResult)
                prompt = ChatPromptTemplate.from_messages([
                    ("system",
                     "你是严格审查器。只做证据与计算审查，不做风格润色。"
                     "若结论含数值但无可复现计算痕迹，必须写入 unverified_calculations。"
                     "输出 JSON 包含 unsupported_claims（列表）、unverified_calculations（列表）、overall_quality（pass/revise/reject）。"),
                    ("human", "## 待审查草稿\n{draft}\n\n## 现有证据\n{evidence}"),
                ])
                chain = prompt | llm
                result = chain.invoke({"draft": draft[:6000], "evidence": evidence[:6000]})
                return json.dumps(result.model_dump(), ensure_ascii=False)
            except Exception as e:
                logger.warning("critic_review fallback: %s", e)
                return json.dumps(
                    {
                        "unsupported_claims": [],
                        "unverified_calculations": [],
                        "overall_quality": "revise",
                    },
                    ensure_ascii=False,
                )

        self.tools['critic_review'] = critic_review
        print("  ✅ critic_review - Structured evidence/calculation review")
        
        # ============================================================
        # 批量文件读取（效率优化）
        # ============================================================
        print("\n📚 Batch File Operations (efficiency):")
        
        try:
            from .file_ops import BatchReadFilesTool
            self.tools['batch_read_files'] = BatchReadFilesTool()
            print("  ✅ batch_read_files - Read multiple files in one call")
        except ImportError as e:
            print(f"  ⚠️  batch_read_files - {e}")
        
        # ============================================================
        # 网络搜索和网页获取（可选）
        # ============================================================
        print("\n🌐 Web Tools (search + fetch):")
        
        ddg_search = None
        try:
            from langchain_community.tools import DuckDuckGoSearchRun
            ddg_search = DuckDuckGoSearchRun()
            print("  ✅ duckduckgo backend available")
        except ImportError as e:
            print(f"  ⚠️  duckduckgo backend unavailable - {e}")
        
        # WebFetch 工具（使用 WebBaseLoader，带超时与一次重试）
        try:
            from langchain_community.document_loaders import WebBaseLoader
            from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeoutError

            _WEB_FETCH_TIMEOUT = 25
            _WEB_FETCH_EXECUTOR = ThreadPoolExecutor(max_workers=2, thread_name_prefix="web_fetch")

            def _web_fetch_once(url: str) -> str:
                loader = WebBaseLoader(
                    web_paths=[url],
                    requests_per_second=2,
                )
                docs = loader.load()
                if docs:
                    content = docs[0].page_content
                    if len(content) > 15000:
                        content = content[:15000] + "\n\n... (内容已截断，共 {} 字符)".format(len(docs[0].page_content))
                    return content
                return "无法获取网页内容（页面无正文）"

            _web_fetch_desc = (
                "Fetch a webpage and return cleaned readable text. "
                "Use when: 需要阅读网页文档、API 说明、博客/公告正文。 "
                "Avoid when: 仅需搜索结果列表（优先 web_search）。 "
                "单次请求超时 {}s，失败时自动重试一次。"
            ).format(_WEB_FETCH_TIMEOUT)
            @tool(description=_web_fetch_desc)
            def web_fetch(url: str) -> str:
                """Fetch webpage and return cleaned text. Timeout {}s.""".format(_WEB_FETCH_TIMEOUT)
                last_error = None
                for attempt in range(2):
                    try:
                        future = _WEB_FETCH_EXECUTOR.submit(_web_fetch_once, url)
                        out = future.result(timeout=_WEB_FETCH_TIMEOUT)
                        return out
                    except FuturesTimeoutError:
                        last_error = "请求超时（{}秒）".format(_WEB_FETCH_TIMEOUT)
                    except Exception as e:
                        last_error = str(e)
                return "获取网页失败: URL={} | 错误: {}".format(url[:80], last_error or "未知错误")

            self.tools['web_fetch'] = web_fetch
            print("  ✅ web_fetch - Fetch webpage content (WebBaseLoader, timeout={}s, 1 retry)".format(_WEB_FETCH_TIMEOUT))
        except ImportError as e:
            print(f"  ⚠️  web_fetch - {e}")
        
        # Tavily 搜索后端（高质量 Agent 搜索，需 TAVILY_API_KEY）
        import os
        tavily_search = None
        if os.getenv("TAVILY_API_KEY"):
            try:
                from langchain_tavily import TavilySearch
                tavily_search = TavilySearch(max_results=5, search_depth="basic")
                print("  ✅ tavily backend available (TAVILY_API_KEY)")
            except ImportError as e:
                print(f"  ⚠️  tavily backend unavailable - {e}")
        else:
            print("  ℹ️  tavily backend disabled (set TAVILY_API_KEY)")

        def _persist_web_result(query: str, payload: dict) -> None:
            """异步将 web 搜索结果写入 knowledge_base/learned/web_cache/，供 scan_and_learn 索引。"""
            try:
                root = Path(__file__).resolve().parent.parent.parent.parent
                cache_dir = root / "knowledge_base" / "learned" / "web_cache"
                cache_dir.mkdir(parents=True, exist_ok=True)
                h = hashlib.sha256(query.encode("utf-8")).hexdigest()[:16]
                path = cache_dir / f"{h}.md"
                ts = time.strftime("%Y-%m-%d %H:%M", time.gmtime())
                lines = [f"# Web cache: {query[:80]}", f"\n> 时间: {ts}\n"]
                for i, r in enumerate((payload.get("results") or [])[:10], 1):
                    if isinstance(r, dict):
                        sid = r.get("source_id") or r.get("url") or ""
                        exc = (r.get("excerpt") or "")[:500]
                        title = (r.get("title") or "")[:100]
                        lines.append(f"\n## {i}. {title}\n- 来源: {sid}\n\n{exc}")
                path.write_text("\n".join(lines), encoding="utf-8")
                # TTL：删除超过 7 天的缓存文件
                import time as _time
                _ttl = 7 * 24 * 3600
                _now = _time.time()
                for _f in cache_dir.glob("*.md"):
                    try:
                        if _now - _f.stat().st_mtime > _ttl:
                            _f.unlink()
                    except Exception:
                        pass
                existing = sorted(cache_dir.glob("*.md"), key=lambda f: f.stat().st_mtime)
                if len(existing) > 100:
                    for old in existing[: len(existing) - 100]:
                        try:
                            old.unlink()
                        except Exception:
                            pass
            except Exception as e:
                logger.debug("persist_web_result: %s", e)

        @tool
        def web_search(query: str) -> str:
            """Search the web with citation-friendly normalized output.

            Use when:
            - 需要快速获取外部资料候选来源与摘要。
            - 需要可引用的 source_id(URL) + excerpt 结果。

            Avoid when:
            - 目标信息已在本地知识库中（优先 search_knowledge）。
            - 查询语句过于笼统，无法形成有效检索意图。

            Strategy:
            - Tavily first, DuckDuckGo fallback.
            - 每条结果尽量返回 source_id(URL) + excerpt(摘要) 便于证据链。
            """
            out = None
            try:
                if tavily_search is not None:
                    result = tavily_search.invoke({"query": query})
                    items = []
                    if isinstance(result, list):
                        for r in result[:8]:
                            if isinstance(r, dict):
                                items.append({
                                    "source_id": r.get("url") or r.get("source") or "tavily",
                                    "excerpt": (r.get("content") or r.get("snippet") or str(r))[:320],
                                    "title": r.get("title", ""),
                                })
                    out = {"query": query, "results": items}
                    if items:
                        threading.Thread(target=_persist_web_result, args=(query, out), daemon=True).start()
                        return json.dumps(out, ensure_ascii=False)
                    # items 为空时不 return，继续执行 DDG fallback
            except Exception:
                pass
            try:
                if ddg_search is not None:
                    raw = ddg_search.invoke(query)
                    out = {
                        "query": query,
                        "results": [{"source_id": "duckduckgo", "excerpt": str(raw)[:600]}],
                    }
                    threading.Thread(target=_persist_web_result, args=(query, out), daemon=True).start()
                    return json.dumps(out, ensure_ascii=False)
            except Exception as e:
                return json.dumps({"query": query, "results": [], "error": str(e)}, ensure_ascii=False)
            return json.dumps({"query": query, "results": [], "error": "no web search backend configured"}, ensure_ascii=False)

        self.tools['web_search'] = web_search
        print("  ✅ web_search - Unified web search (Tavily first, DDG fallback)")

        @tool
        def web_crawl_batch(urls: str, extract_mode: str = "article") -> str:
            """Batch fetch webpages and return normalized content.

            Use when:
            - 需要一次性抓取多个 URL 的正文，用于对比、摘要或入库。
            - 已通过 web_search 得到候选链接，需批量拉取全文。

            Parameters:
            - urls: JSON 字符串数组，如 `["https://a.com", "https://b.com"]`，最多 20 条。
            - extract_mode: "article"（默认，全文）或 "summary"（截断约 1200 字）。

            Returns:
            - JSON：ok、count、extract_mode、results（每项含 url、ok、content）。
            """
            try:
                parsed_urls = json.loads(urls) if isinstance(urls, str) else urls
                if not isinstance(parsed_urls, list):
                    return json.dumps({"ok": False, "error": "urls must be a json list"}, ensure_ascii=False)
                unique_urls = []
                seen = set()
                for item in parsed_urls:
                    u = str(item or "").strip()
                    if not u or u in seen:
                        continue
                    seen.add(u)
                    unique_urls.append(u)
                results = []
                for u in unique_urls[:20]:
                    content = web_fetch.invoke({"url": u})
                    text = str(content or "")
                    if extract_mode == "summary" and len(text) > 1200:
                        text = text[:1200] + "...(truncated)"
                    results.append({"url": u, "ok": bool(text), "content": text})
                return json.dumps(
                    {"ok": True, "count": len(results), "extract_mode": extract_mode, "results": results},
                    ensure_ascii=False,
                )
            except Exception as e:
                return json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False)

        @tool
        def content_extract(text: str, hint_schema: str = "{}", domain: str = "general") -> str:
            """Extract structured fields from text with schema hint.

            Use when:
            - 需要从非结构化文本中抽取实体、关系或指定字段。
            - 需要与本体/领域 schema 对齐的结构化输出。

            Parameters:
            - text: 待抽取的原文。
            - hint_schema: 可选 JSON 对象字符串，提示期望字段或结构。
            - domain: 领域标识，如 "general"、"bidding"，用于选择抽取策略。

            Returns:
            - JSON：ok、mode（ontology_extract 或 fallback）、result/data。
            """
            try:
                from backend.tools.ontology.ontology_tools import ontology_extract

                payload = ontology_extract.invoke(
                    {
                        "domain": domain,
                        "source_id": "content_extract",
                        "text": text,
                    }
                )
                result = {"ok": True, "mode": "ontology_extract", "schema_hint": hint_schema, "result": payload}
                return json.dumps(result, ensure_ascii=False)
            except Exception:
                try:
                    schema_obj = json.loads(hint_schema) if hint_schema else {}
                except Exception:
                    schema_obj = {}
                fallback = {
                    "domain": domain,
                    "summary": text[:500],
                    "schema_hint_keys": list(schema_obj.keys()) if isinstance(schema_obj, dict) else [],
                }
                return json.dumps({"ok": True, "mode": "fallback", "data": fallback}, ensure_ascii=False)

        @tool
        def template_render(template_name: str, data: str) -> str:
            """Render text template with JSON payload.

            Use when:
            - 需要根据 knowledge_base/skills/knowledge_engineering/templates/ 下的 Jinja2 模板生成文本。
            - 已有结构化 data，需填充到固定格式（报告、邮件、文档片段）。

            Parameters:
            - template_name: 模板文件名（不含 .j2），如 "report_summary"。
            - data: JSON 对象字符串，作为模板变量传入。

            Returns:
            - JSON：ok、template、rendered；失败时 error、path。
            """
            try:
                payload = json.loads(data) if isinstance(data, str) else data
                if not isinstance(payload, dict):
                    return json.dumps({"ok": False, "error": "data must be json object"}, ensure_ascii=False)
                from pathlib import Path
                from backend.tools.base.paths import get_project_root

                template_path = (
                    get_project_root()
                    / "knowledge_base"
                    / "skills"
                    / "knowledge_engineering"
                    / "templates"
                    / f"{template_name}.j2"
                )
                if not template_path.exists():
                    return json.dumps({"ok": False, "error": "template_not_found", "path": str(template_path)}, ensure_ascii=False)
                source = template_path.read_text(encoding="utf-8")
                try:
                    from jinja2 import Template  # type: ignore

                    rendered = Template(source).render(**payload)
                except Exception:
                    rendered = source.format(**payload)
                return json.dumps({"ok": True, "template": template_name, "rendered": rendered}, ensure_ascii=False)
            except Exception as e:
                return json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False)

        self.tools["web_crawl_batch"] = web_crawl_batch
        self.tools["content_extract"] = content_extract
        self.tools["template_render"] = template_render
        print("  ✅ web_crawl_batch - Batch crawl and normalize webpages")
        print("  ✅ content_extract - Structured extraction with schema hint")
        print("  ✅ template_render - Render template with JSON payload")

        @tool
        def analyze_image(path: str) -> str:
            """Analyze image metadata from local file path.

            Use when:
            - 需要快速获取图片基础信息（格式、尺寸、色彩通道）。
            - 需要在不调用云端视觉模型前做本地预检查。

            Parameters:
            - path: 本地图片绝对路径，或工作区相对路径。
            """
            try:
                from pathlib import Path
                from backend.tools.base.paths import get_project_root, get_workspace_root

                raw = (path or "").strip()
                if not raw:
                    return json.dumps({"ok": False, "error": "path is required"}, ensure_ascii=False)
                p = Path(raw)
                if not p.is_absolute():
                    p = get_workspace_root() / raw
                p = p.resolve()
                if not p.exists() or not p.is_file():
                    return json.dumps({"ok": False, "error": "file not found"}, ensure_ascii=False)

                # 仅允许项目根或工作区下路径，不允许用户主目录等（符合最小权限）
                allowed = False
                for base in (get_project_root(), get_workspace_root()):
                    try:
                        p.relative_to(base)
                        allowed = True
                        break
                    except Exception:
                        continue
                if not allowed:
                    return json.dumps({"ok": False, "error": "path not allowed"}, ensure_ascii=False)

                data = p.read_bytes()
                result = {
                    "ok": True,
                    "path": str(p),
                    "byte_size": len(data),
                }
                try:
                    from PIL import Image, ImageStat  # type: ignore

                    img = Image.open(p)
                    try:
                        result.update({
                            "format": img.format,
                            "mode": img.mode,
                            "width": img.size[0],
                            "height": img.size[1],
                            "has_alpha": "A" in (img.getbands() or ()),
                        })
                        try:
                            stat = ImageStat.Stat(img.convert("RGB"))
                            result["mean_rgb"] = [round(float(x), 2) for x in (stat.mean or [0, 0, 0])[:3]]
                        except Exception:
                            pass
                    finally:
                        img.close()
                except Exception:
                    result["note"] = "Pillow unavailable or unsupported image; only byte_size returned"
                return json.dumps(result, ensure_ascii=False)
            except Exception as e:
                return json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False)

        self.tools['analyze_image'] = analyze_image
        print("  ✅ analyze_image - Local image metadata analyzer")
        
        # ============================================================
        # langmem 记忆工具（语义搜索）
        # 功能：manage_memory（保存）、search_memory（搜索）
        # 比 Claude memory_tool 更强（语义搜索 vs 文件操作）
        # ============================================================
        import os
        enable_langmem = os.getenv("ENABLE_LANGMEM", "true").lower() == "true"
        
        if enable_langmem:
            print("\n🧠 Memory Tools (langmem - semantic search):")
            try:
                from .memory_tools import get_memory_tools, is_langmem_available
                if is_langmem_available():
                    memory_tools = get_memory_tools()
                    for mem_tool in memory_tools:
                        self.tools[mem_tool.name] = mem_tool
                        print(f"  ✅ {mem_tool.name} - {mem_tool.description[:50]}...")
                else:
                    print("  ⚠️  langmem 未安装")
                    self._register_disabled_tool("manage_memory", "langmem 未安装")
                    self._register_disabled_tool("search_memory", "langmem 未安装")
            except ImportError as e:
                print(f"  ⚠️  Memory tools - {e}")
                self._register_disabled_tool("manage_memory", f"memory tools import failed: {e}")
                self._register_disabled_tool("search_memory", f"memory tools import failed: {e}")
        else:
            print("\n🧠 Memory Tools: DISABLED (ENABLE_LANGMEM=false)")
            self._register_disabled_tool("manage_memory", "ENABLE_LANGMEM=false")
            self._register_disabled_tool("search_memory", "ENABLE_LANGMEM=false")
        
        # ============================================================
        # 学习经验检索工具（从历史任务中学习）
        # ============================================================
        enable_learning = os.getenv("ENABLE_SELF_LEARNING", "false").lower() == "true"
        
        if enable_learning:
            print("\n📚 Learning Tools (Experience Retrieval):")
            try:
                from .learning_middleware import get_learning_tool
                learning_tool = get_learning_tool()
                self.tools['search_learning_experience'] = learning_tool
                print("  ✅ search_learning_experience - Retrieve historical learning")
            except ImportError as e:
                print(f"  ⚠️  Learning tools - {e}")
                self._register_disabled_tool("search_learning_experience", f"learning tools import failed: {e}")
        else:
            print("\n📚 Learning Tools: DISABLED (ENABLE_SELF_LEARNING=false)")
            self._register_disabled_tool("search_learning_experience", "ENABLE_SELF_LEARNING=false")
        
        # ============================================================
        # 统一检索工具（知识库 + 本体）
        # ✅ 内存优化：工具本身轻量级，向量库在查询时懒加载
        # ============================================================
        enable_kb = os.getenv("ENABLE_KNOWLEDGE_RETRIEVER", "true").lower() == "true"
        
        if enable_kb:
            print("\n🔍 Unified Retrieval (Knowledge + Memory + Ontology):")
            try:
                from .embedding_tools import get_knowledge_retriever_tool
                retriever_tool = get_knowledge_retriever_tool()
                if retriever_tool:
                    @tool
                    def search_knowledge(query: str) -> str:
                        """Search indexed knowledge and return citation-friendly snippets.

                        Purpose:
                        - 从知识库召回可引用片段，支撑事实与结论。

                        When to use:
                        - 需要跨文档快速定位规则、术语、流程或证据。
                        - 需要 `source_id + excerpt` 形式结果用于审查链路。

                        Parameters:
                        - query: 简短、具体、可检索的查询语句。

                        Returns:
                        - 返回检索文本；优先包含 `source_id` 与 `excerpt`。

                        Examples:
                        - `招投标 废标条款 格式要求`
                        - `合同 违约责任 付款节点`
                        """
                        raw = retriever_tool.invoke(query)
                        text = str(raw)
                        if "source_id" in text and "excerpt" in text:
                            return text
                        return json.dumps(
                            {
                                "query": query,
                                "source_id": "search_knowledge",
                                "excerpt": text[:300],
                                "raw": text,
                            },
                            ensure_ascii=False,
                        )

                    self.tools['search_knowledge'] = search_knowledge
                    print("  ✅ search_knowledge - Unified retrieval (向量库懒加载)")
                else:
                    # 降级版本：使用知识图谱 + 文件搜索
                    self._register_fallback_search()
            except ImportError as e:
                print(f"  ⚠️  search_knowledge - {e}")
                self._register_fallback_search()
        else:
            print("\n🔍 Unified Retrieval: DISABLED (ENABLE_KNOWLEDGE_RETRIEVER=false)")
            print("  ℹ️  Set ENABLE_KNOWLEDGE_RETRIEVER=true to enable knowledge retrieval")
            self._register_disabled_tool("search_knowledge", "ENABLE_KNOWLEDGE_RETRIEVER=false")

        # ============================================================
        # Ontology 工具（结构化知识层）
        # ============================================================
        print("\n🗺️  Ontology Tools:")
        try:
            from backend.tools import ontology as _ontology_module  # noqa: F401
            # 外部本体：少工具原则，单工具 ontology_import（action: search_lov | import_wikidata | import_owl | import_schema_org | merge_into_kg | list_candidates）
            self.tools["ontology_import"] = _ontology_module.ontology_import_tool
            print("  ✅ ontology backends + ontology_import (unified external import)")
        except Exception as e:
            print(f"  ⚠️  Ontology tools - {e}")
        
        # ============================================================
        # 知识图谱工具（推理型知识库核心）
        # ✅ 内存优化：知识图谱使用 JSON 文件存储，不常驻内存
        # ============================================================
        enable_kg = os.getenv("ENABLE_KNOWLEDGE_GRAPH", "true").lower() == "true"
        
        if enable_kg:
            print("\n🧠 Knowledge Graph Tools (Reasoning KB Core):")
            try:
                from .embedding_tools import (
                    extract_entities_from_text,
                    extract_relations_from_text,
                    query_knowledge_graph,
                    get_knowledge_graph_stats,
                )
                
                # 知识图谱统一工具（少工具原则：extract + query 合为 knowledge_graph）
                @tool
                def knowledge_graph(action: str, text: str = "", source: str = "", query: str = "") -> str:
                    """知识图谱抽取与查询（单工具双 action）。非结构化文本→实体关系，或按词查图谱上下文。

                    Use when:
                    - extract: 需要把非结构化文本转换为实体-关系数据，为后续检索或审查准备结构化上下文。
                    - query: 需要查找术语/标准/条款的关联实体与关系网络，或基于图谱扩展检索词。
                    Avoid when:
                    - 文本过短、信息密度极低；或问题仅依赖单一文档无跨实体需求。

                    Actions:
                    - extract: 传 text、source（可选）。
                    - query: 传 query（具体实体词如标准号、条款名、组织名）。
                    """
                    import json
                    act = (action or "").strip().lower()
                    if act == "extract":
                        entities = extract_entities_from_text(text, source)
                        relations = extract_relations_from_text(text, source)
                        return json.dumps({
                            "entities": entities[:20],
                            "relations": relations[:20],
                            "stats": get_knowledge_graph_stats(),
                        }, ensure_ascii=False, indent=2)
                    if act == "query":
                        result = query_knowledge_graph(query or text)
                        return json.dumps(result, ensure_ascii=False, indent=2)
                    return json.dumps({"status": "error", "reason": f"action 应为 extract 或 query，当前: {action}"}, ensure_ascii=False)
                
                self.tools["knowledge_graph"] = knowledge_graph
                print("  ✅ knowledge_graph - Extract entities/relations or query KG (unified)")
                
            except ImportError as e:
                print(f"  ⚠️  Knowledge Graph tools - {e}")
        else:
            print("\n🧠 Knowledge Graph Tools: DISABLED (ENABLE_KNOWLEDGE_GRAPH=false)")
            print("  ℹ️  Set ENABLE_KNOWLEDGE_GRAPH=true to enable knowledge graph tools")
        
        # ============================================================
        # 失败重试工具（记录和学习）
        # ============================================================
        print("\n📊 Failure Recovery Tools:")
        
        try:
            from .embedding_tools import get_failure_recovery, ExecutionContext, ExecutionStatus
            
            @tool
            def record_failure(task_id: str, query: str, error: str) -> str:
                """Record execution failures for retry and learning loops.

                Use when:
                - 任务失败且需要沉淀可复用的恢复经验。
                - 需要归档错误类型并生成改进建议。

                Avoid when:
                - 任务已成功完成。
                - 错误信息为空或无法复现关键上下文。

                Strategy:
                - 使用稳定 task_id + 原始 query + 真实 error 组合记录。
                - 后续结合 search_learning_experience 做相似故障回放。
                """
                import json
                recovery = get_failure_recovery()
                ctx = ExecutionContext(
                    task_id=task_id,
                    status=ExecutionStatus.FAILED,
                    query=query,
                    retrieved_docs=[],
                    error=error,
                )
                context_id = recovery.record(ctx)
                
                return json.dumps({
                    "context_id": context_id,
                    "error_type": ctx.error_type,
                    "suggestions": ctx.suggestions,
                }, ensure_ascii=False, indent=2)
            
            print("  ✅ failure recovery backend available (use via python_run)")
            
        except ImportError as e:
            print(f"  ⚠️  Failure recovery tools - {e}")
        
        # ============================================================
        # 自我学习工具（知识图谱动态增强）
        # 注意：这些工具用于高级学习场景，需要显式启用
        # ============================================================
        if enable_learning:
            print("\n📚 Self-Learning Tools (KG Dynamic Enhancement):")
            try:
                from .learning_middleware import (
                    learn_from_task_start,
                    learn_from_document,
                    learn_from_success,
                    learn_from_failure,
                    feedback_knowledge,
                    get_learning_manager,
                )
                
                @tool
                def learn_from_doc(text: str, source: str = "") -> str:
                    """Learn from document text and update knowledge structures.

                    Use when:
                    - 需要把新文档内容沉淀为可复用知识。
                    - 需要持续增强领域实体与关系覆盖率。

                    Avoid when:
                    - 文档尚未清洗（包含大量 OCR 噪声或重复模板）。
                    - 当前任务只需一次性回答，不需要知识沉淀。

                    Strategy:
                    - 传入可追踪 source（文件名/来源ID）。
                    - 先抽取再入库，优先高置信度结构化信息。
                    """
                    import json
                    import uuid
                    result = learn_from_document(
                        task_id=str(uuid.uuid4())[:8],
                        document_text=text,
                        document_source=source,
                    )
                    return json.dumps(result, ensure_ascii=False)
                
                print("  ✅ learn_from_doc backend available (use via python_run)")
                self.tools['learn_from_doc'] = learn_from_doc
                
                @tool
                def report_task_result(
                    task_type: str,
                    success: bool,
                    summary: str,
                    error: str = "",
                ) -> str:
                    """Report task outcomes to drive self-learning updates.

                    Use when:
                    - 任务结束后需要沉淀成功模式或失败教训。
                    - 需要让学习系统更新任务类型的经验分布。

                    Avoid when:
                    - 任务仍在进行中，结果尚不确定。
                    - summary 过短且无法表达关键决策路径。

                    Strategy:
                    - 成功任务记录输入/输出摘要，失败任务补充 error 根因。
                    - 按 task_type 聚合，便于后续检索相似路径。
                    """
                    import json
                    import uuid
                    task_id = str(uuid.uuid4())[:8]
                    
                    if success:
                        result = learn_from_success(
                            task_id=task_id,
                            task_type=task_type,
                            input_summary=summary,
                            output_summary=summary,
                        )
                    else:
                        result = learn_from_failure(
                            task_id=task_id,
                            task_type=task_type,
                            error_message=error,
                            input_summary=summary,
                        )
                    
                    return json.dumps(result, ensure_ascii=False)
                
                print("  ✅ report_task_result backend available (use via python_run)")
                self.tools['report_task_result'] = report_task_result
                
                @tool
                def get_learning_stats() -> str:
                    """Get aggregated statistics from the learning subsystem.

                    Use when:
                    - 需要评估学习系统是否持续积累有效知识。
                    - 需要查看实体/关系及成功失败模式的总体趋势。

                    Avoid when:
                    - 只关心单次任务细节，不需要全局统计。
                    - 学习系统未启用时期待完整统计。

                    Strategy:
                    - 将统计结果用于识别薄弱 task_type 与数据缺口。
                    - 与技能反馈数据结合，优先修复低分高频能力。
                    """
                    import json
                    manager = get_learning_manager()
                    stats = manager.get_learning_stats()
                    return json.dumps(stats, ensure_ascii=False, indent=2)
                
                print("  ✅ get_learning_stats backend available (use via python_run)")
                self.tools['get_learning_stats'] = get_learning_stats
                
                @tool
                def get_similar_paths(task_type: str) -> str:
                    """Retrieve successful historical reasoning paths by task type.

                    Use when:
                    - 需要参考历史成功案例来规划当前任务。
                    - 需要为复杂任务选择更稳妥的执行路径。

                    Avoid when:
                    - task_type 不明确或拼写不稳定。
                    - 任务为全新场景且无可比历史数据。

                    Strategy:
                    - 使用规范化 task_type（如 bidding_analysis）。
                    - 先看路径骨架，再结合当前上下文做最小改造。
                    """
                    import json
                    manager = get_learning_manager()
                    paths = manager.get_similar_paths(task_type, limit=5)
                    return json.dumps(paths, ensure_ascii=False, indent=2)
                
                print("  ✅ get_similar_paths backend available (use via python_run)")
                self.tools['get_similar_paths'] = get_similar_paths
                
            except ImportError as e:
                print(f"  ⚠️  Self-learning tools - {e}")
        else:
            print("\n📚 Self-Learning Tools: SKIPPED (ENABLE_SELF_LEARNING=false)")
        
        # ============================================================
        # 图表生成工具
        # ============================================================
        print("\n📊 Chart Generation Tools:")
        
        try:
            from .chart_tools import create_chart, CHART_TOOLS
            
            self.tools['create_chart'] = create_chart
            print("  ✅ create_chart - Generate charts:")
            print("      基础: line, bar, pie, scatter, heatmap, gantt")
            print("      高级: network(拓扑图), flowchart(流程图), mindmap(思维导图), architecture(架构图)")
            
        except ImportError as e:
            print(f"  ⚠️  Chart tools - {e}")

        # ============================================================
        # 文档生成工具（PPT/PDF/Word）
        # ============================================================
        print("\n📄 Document Generation Tools:")
        try:
            from .document_generation import generate_ppt, generate_pdf, generate_word
            self.tools['generate_ppt'] = generate_ppt
            self.tools['generate_pdf'] = generate_pdf
            self.tools['generate_word'] = generate_word
            print("  ✅ generate_ppt - PowerPoint (.pptx), optional image_path/image_url per slide")
            print("  ✅ generate_pdf - PDF document")
            print("  ✅ generate_word - Word (.docx)")
        except ImportError as e:
            print(f"  ⚠️  Document generation tools - {e}")

        # ============================================================
        # 图片生成工具（配图 / PPT 插图）
        # ============================================================
        print("\n🖼️  Image Generation Tools:")
        try:
            from .image_generation import generate_image, generate_video
            self.tools['generate_image'] = generate_image
            self.tools['generate_video'] = generate_video
            print("  ✅ generate_image - Text-to-image (requires IMAGE_GENERATION_* or OPENAI config)")
            print("  ✅ generate_video - Placeholder (video API not configured)")
        except ImportError as e:
            print(f"  ⚠️  generate_image/generate_video - {e}")

        # ============================================================
        # 输出验证工具（知识与本体）
        # ============================================================
        print("\n✅ Validation Tools:")
        try:
            from .verify_tools import verify_output, verify_knowledge_entry, verify_ontology_entity

            self.tools["verify_output"] = verify_output
            self.tools["verify_knowledge_entry"] = verify_knowledge_entry
            self.tools["verify_ontology_entity"] = verify_ontology_entity
            print("  ✅ verify_output - Validate output with JSON schema")
            print("  ✅ verify_knowledge_entry - Validate knowledge entry fields")
            print("  ✅ verify_ontology_entity - Validate ontology entity by domain schema")
        except Exception as e:
            print(f"  ⚠️  Validation tools - {e}")
        
        # ============================================================
        # Skills 辅助工具（发现 + 匹配 + 执行，不写死具体业务）
        # 
        # 能力由前端业务场景(skill_profile)加载，BUNDLE.md 内联 + 自定义工具注册
        # 本注册表提供：list_skills、match_skills、run_skill_script
        # 降级：ls("knowledge_base/skills/")、read_file(SKILL.md)、shell_run/python_run
        # ============================================================
        print("\n📖 Skills Tools (list_skills + match_skills + run_skill_script):")
        
        try:
            from backend.tools.skills_tool import SKILLS_TOOLS
            
            for skill_tool in SKILLS_TOOLS:
                self.tools[skill_tool.name] = skill_tool
                print(f"  ✅ {skill_tool.name} - {skill_tool.description[:50]}...")
        except ImportError as e:
            print(f"  ⚠️  Skills tools - {e}")
            print("  ℹ️  Fallback: ls('knowledge_base/skills/') + read_file()")
        
        # ============================================================
        # 注意：专业文档生成不需要专用工具
        # Claude 设计哲学：通过 python_run + SKILL.md 工作流实现
        # LLM 可以用 python_run 调用 docx/matplotlib/html 等库
        # ============================================================
        
        # ============================================================
        # 注意：DocMap 和 Workflow 不作为工具暴露
        # 业界顶级做法：嵌入 prompt，而非让 LLM 调用工具查询元数据
        # ============================================================
        print("\n🗺️  DocMap & Workflow: Embedded in prompts (not as tools)")
        
        print("\n" + "=" * 70)
        print(f"✅ Additional Tools Registered: {len(self.tools)}")
        print(f"Tools: {', '.join(self.tools.keys())}")
        print("=" * 70 + "\n")
    
    def _register_fallback_search(self):
        """注册降级版搜索工具（当 Embedding 不可用时）"""
        try:
            from .knowledge_graph import get_knowledge_graph, get_extractor
            from pathlib import Path
            import json
            from backend.tools.base.paths import KB_PATH

            kg = get_knowledge_graph()
            
            @tool
            def search_knowledge(query: str) -> str:
                """Fallback knowledge search via KG expansion and file indexing.

                Purpose:
                - 在向量检索不可用时提供可用的知识检索兜底。

                When to use:
                - 语义检索失效，但仍需快速找到候选知识片段。

                Parameters:
                - query: 查询词或问题。

                Returns:
                - JSON，每条结果含 source_id（来源路径/标识）与 excerpt（摘录），便于与主路径统一引用格式。

                Examples:
                - `评分标准 细则`
                - `合同争议解决 条款`
                """
                results = []
                query_terms = query.lower().split()

                # 1. 知识图谱扩展
                kg_context = {}
                if kg:
                    expansion = kg.expand_query(query)
                    kg_context = {
                        "entities": expansion.get("matched_entities", [])[:5],
                        "relations": expansion.get("related_relations", [])[:5],
                        "expanded_terms": expansion.get("expanded_terms", [])[:10],
                    }

                # 2. 文件索引搜索（统一使用 source_id / excerpt 便于引用）
                index_file = KB_PATH / "global" / "domain" / "00_KB_INDEX.md"
                if index_file.exists():
                    content = index_file.read_text(encoding="utf-8")
                    for line in content.split("\n"):
                        if any(term in line.lower() for term in query_terms):
                            results.append({
                                "source_id": str(index_file),
                                "excerpt": line.strip()[:500],
                                "type": "index",
                            })

                # 3. 知识库目录扫描
                for domain in ["bidding", "contracts", "reports"]:
                    domain_path = KB_PATH / "global" / "domain" / domain
                    if domain_path.exists():
                        for md_file in domain_path.rglob("*.md"):
                            if md_file.name.startswith("0"):
                                try:
                                    content = md_file.read_text(encoding="utf-8")[:500]
                                    if any(term in content.lower() for term in query_terms):
                                        results.append({
                                            "source_id": str(md_file),
                                            "excerpt": (content[:200] + "...") if len(content) > 200 else content,
                                            "type": "guide",
                                        })
                                except Exception as e:
                                    logger.debug("读取知识库索引文件失败: %s (%s)", md_file, e)

                return json.dumps({
                    "query": query,
                    "status": "found" if results else "not_found",
                    "mode": "fallback (no embedding)",
                    "kg_context": kg_context,
                    "results": results[:8],
                    "suggestion": "使用 read_file 读取具体文件获取详细内容",
                }, ensure_ascii=False, indent=2)
            
            self.tools['search_knowledge'] = search_knowledge
            print("  ✅ search_knowledge - Fallback mode (KG + file index)")
            
        except Exception as e:
            print(f"  ⚠️  search_knowledge fallback - {e}")
    
    def get_tool(self, name: str) -> Any:
        """
        根据名称获取工具（支持延迟加载）
        
        优化：如果工具尚未加载但有工厂函数，则延迟加载
        """
        # 检查是否需要延迟加载
        if name not in self.tools and name in self._tool_factories:
            try:
                self.tools[name] = self._tool_factories[name]()
                self._loaded_tools.add(name)
            except Exception as e:
                raise ValueError(f"Failed to load tool '{name}': {e}")
        
        if name not in self.tools:
            raise ValueError(
                f"Tool '{name}' not found. Available: {list(self.tools.keys())}"
            )
        return self.tools[name]
    
    def get_all_tools(self) -> List[Tool]:
        """获取所有工具列表"""
        return list(self.tools.values())
    
    def get_tool_names(self) -> List[str]:
        """获取所有工具名称（包括延迟加载的）"""
        all_names = set(self.tools.keys()) | set(self._tool_factories.keys())
        return list(all_names)
    
    def get_loading_stats(self) -> dict:
        """获取工具加载统计"""
        return {
            "loaded": len(self._loaded_tools),
            "deferred": len(self._tool_factories) - len(self._loaded_tools),
            "total": len(self.tools) + len(self._tool_factories) - len(self._loaded_tools),
            "loaded_tools": list(self._loaded_tools),
        }


# 全局实例
_core_tools_registry = None


def get_core_tools_registry() -> CoreToolsRegistry:
    """获取工具注册表（懒加载）"""
    global _core_tools_registry
    if _core_tools_registry is None:
        _core_tools_registry = CoreToolsRegistry()
    return _core_tools_registry


def get_all_core_tools() -> List[Tool]:
    """获取所有补充工具"""
    return get_core_tools_registry().get_all_tools()


def get_core_tool_by_name(name: str) -> Any:
    """根据名称获取工具"""
    return get_core_tools_registry().get_tool(name)


def get_core_tool_names() -> List[str]:
    """获取所有工具名称"""
    return get_core_tools_registry().get_tool_names()
