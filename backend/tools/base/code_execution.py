"""
Python 代码执行工具 - Cursor/Claude 风格

设计原则：
1. 简洁：不过度封装，利用 Python 原生能力
2. 实用：只预导入真正常用的模块
3. 安全：基本的超时和输出限制
4. 透明：错误信息直接返回，不过度包装
5. 智能安装：检测缺失库，自动安装常用库，询问用户安装其他库

库安装策略（Cursor 风格）：
- 白名单库（数据分析、文档处理等）：自动安装
- 其他库：返回错误信息，由 LLM 决定是否使用 pip 安装
"""

import asyncio
import sys
import io
import os
import time
import traceback
import importlib
import subprocess
import re
import json
from contextlib import redirect_stderr, redirect_stdout
from types import MappingProxyType
from pathlib import Path
from typing import Any, Dict, Optional, Callable, List, Tuple
from langchain_core.tools import tool
import threading

from .streaming import get_tool_stream_writer, emit_tool_event
from .paths import get_workspace_root

import logging

logger = logging.getLogger(__name__)

def _get_default_tool_timeout() -> int:
    """统一工具超时默认值（优先读取 Config，其次环境变量）。"""
    try:
        from backend.engine.agent.deep_agent import Config
        val = int(getattr(Config, "TOOL_DEFAULT_TIMEOUT", 60) or 60)
    except Exception:
        val = int(os.environ.get("TOOL_DEFAULT_TIMEOUT", "60") or 60)
    return max(1, val)


# 禁止在 python_run 内 import 的模块（安全沙箱）；代码中 import 这些会触发 ImportError，可用 CORE_MODULES/COMMON_LIBRARIES 替代
_BLOCKED_IMPORT_MODULES = frozenset({
    "subprocess", "pty", "socket", "multiprocessing", "importlib",
    "os", "sys", "ctypes", "signal", "shutil", "tempfile", "urllib",
})


def _guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
    base = str(name or "").split(".", 1)[0].strip().lower()
    if base in _BLOCKED_IMPORT_MODULES:
        raise ImportError(f"禁止导入模块: {base}")
    return __import__(name, globals, locals, fromlist, level)


def _normalize_shell_text(text: str, compact: bool = False) -> str:
    lowered = str(text or "").lower()
    lowered = lowered.replace("\\\n", " ")
    lowered = lowered.replace("\\", "")
    lowered = re.sub(r"[\"'`]", "", lowered)
    lowered = re.sub(r"\s+", " ", lowered).strip()
    if compact:
        lowered = lowered.replace(" ", "")
    return lowered


def detect_shell_bypass_risk(command: str) -> Optional[str]:
    text = str(command or "")
    lowered = text.lower()
    compact = _normalize_shell_text(text, compact=True)
    if "\x00" in text:
        return "命令包含 NUL 字符"
    if re.search(r"\$\([^\)]{1,400}\)", text):
        return "检测到命令替换语法 $()"
    if re.search(r"`[^`]{1,400}`", text):
        return "检测到反引号命令替换语法"
    if "base64" in lowered and (" -d" in lowered or "--decode" in lowered or "base64-d" in compact):
        sinks = ("|sh", "|bash", "|zsh", "|python", "|perl", "eval")
        if any(s in compact for s in sinks):
            return "检测到 base64 解码并执行链路"
    return None


# 不暴露 getattr/hasattr，防止通过 getattr(os, 'system') 等绕过命令注入检测
SAFE_BUILTINS = {
    "abs": abs,
    "all": all,
    "any": any,
    "bool": bool,
    "dict": dict,
    "enumerate": enumerate,
    "filter": filter,
    "float": float,
    "int": int,
    "isinstance": isinstance,
    "len": len,
    "list": list,
    "map": map,
    "max": max,
    "min": min,
    "print": print,
    "range": range,
    "reversed": reversed,
    "round": round,
    "slice": slice,
    "set": set,
    "sorted": sorted,
    "str": str,
    "sum": sum,
    "tuple": tuple,
    "zip": zip,
    "Exception": Exception,
    "ValueError": ValueError,
    "TypeError": TypeError,
    "__import__": _guarded_import,
}

try:
    from langsmith import traceable  # type: ignore
except Exception:  # pragma: no cover
    def traceable(*_args, **_kwargs):  # type: ignore
        def _decorator(func):
            return func
        return _decorator

# ============================================================
# 库安装策略
# ============================================================

# 白名单：可以自动安装的安全库（数据分析、文档处理、常用工具）
AUTO_INSTALL_WHITELIST = {
    # 数据分析
    'pandas', 'numpy', 'scipy', 'statsmodels',
    # 可视化
    'matplotlib', 'seaborn', 'plotly',
    # 文档处理
    'python-docx', 'openpyxl', 'xlrd', 'PyPDF2', 'pdfplumber', 'python-pptx',
    # 外部知识 / 模板
    'wikibase-rest-api-client', 'mediawikiapi', 'wikipedia', 'arxiv', 'networkx', 'jinja2', 'markdown', 'pillow',
    # 网络请求
    'requests', 'httpx', 'aiohttp',
    # 解析
    'beautifulsoup4', 'lxml', 'pyyaml', 'toml',
    # 工具
    'tqdm', 'tabulate', 'rich',
    # 日期时间
    'python-dateutil', 'pytz',
}

# 包名映射（import 名 -> pip 包名）
PACKAGE_NAME_MAP = {
    'docx': 'python-docx',
    'bs4': 'beautifulsoup4',
    'yaml': 'pyyaml',
    'PIL': 'pillow',
    'cv2': 'opencv-python',
    'sklearn': 'scikit-learn',
    'dateutil': 'python-dateutil',
}


def get_pip_package_name(import_name: str) -> str:
    """获取 pip 包名"""
    return PACKAGE_NAME_MAP.get(import_name, import_name)


def detect_missing_imports(code: str) -> List[str]:
    """检测代码中可能缺失的导入"""
    # 简单的 import 检测
    import_pattern = r'^(?:from\s+(\w+)|import\s+(\w+))'
    imports = set()
    
    for line in code.split('\n'):
        line = line.strip()
        match = re.match(import_pattern, line)
        if match:
            module = match.group(1) or match.group(2)
            if module:
                imports.add(module.split('.')[0])
    
    # 检测哪些模块不可用
    missing = []
    for module in imports:
        try:
            importlib.import_module(module)
        except ImportError:
            missing.append(module)
    
    return missing


def try_install_package(package: str, timeout: int = 60) -> Tuple[bool, str]:
    """尝试安装包"""
    pip_name = get_pip_package_name(package)
    
    try:
        result = subprocess.run(
            [sys.executable, '-m', 'pip', 'install', '-q', pip_name],
            capture_output=True,
            text=True,
            timeout=timeout
        )
        
        if result.returncode == 0:
            # 重新导入以验证
            importlib.invalidate_caches()
            importlib.import_module(package)
            return True, f"✅ 已安装 {pip_name}"
        else:
            return False, f"❌ 安装失败: {result.stderr[:200]}"
            
    except subprocess.TimeoutExpired:
        return False, f"❌ 安装超时（>{timeout}s）"
    except Exception as e:
        return False, f"❌ 安装错误: {e}"


def auto_install_missing(missing: List[str]) -> Tuple[List[str], List[str], str]:
    """
    自动安装缺失的白名单库
    
    Returns:
        (installed, not_installed, message)
    """
    installed = []
    not_installed = []
    messages = []
    
    for module in missing:
        pip_name = get_pip_package_name(module)
        
        if pip_name in AUTO_INSTALL_WHITELIST:
            # 白名单库：自动安装
            success, msg = try_install_package(module)
            if success:
                installed.append(module)
                messages.append(msg)
            else:
                not_installed.append(module)
                messages.append(msg)
        else:
            # 非白名单：不自动安装
            not_installed.append(module)
            messages.append(f"⚠️ {module} 不在自动安装白名单中")
    
    return installed, not_installed, "\n".join(messages)


# ============================================================
# 核心常用模块（真正常用的，不是全部）
# ============================================================
# 不注入 os/shutil，防止 getattr(os,'system') 等沙箱逃逸；文件操作通过受控 API
# python_run 可用标准库：以下模块在每次执行前注入，可直接使用；禁止通过 __import__ 导入的见 _BLOCKED_IMPORT_MODULES
CORE_MODULES = [
    # 必备
    'json', 're', 'math', 'datetime', 'time',
    # 数据结构
    'collections', 'itertools', 'functools',
    # 不注入 pathlib/glob，避免 Path.write_text/glob.glob 绕过沙箱
    # 编码
    'base64', 'hashlib',
    # 数据格式
    'csv', 'io',
    # 类型
    'typing', 'copy',
    # 其他常用
    'random', 'uuid', 'dataclasses', 'statistics',
]

# 常用第三方库（启动时检测可用性）
# 注意：matplotlib 会在初始化时创建配置目录，触发阻塞操作
# 因此不在启动时预导入，而是在代码实际使用时按需导入
COMMON_LIBRARIES = {
    'pandas': 'pd',
    'numpy': 'np', 
    # 'matplotlib.pyplot': 'plt',  # 移除：会触发阻塞操作，改为按需导入
    'requests': None,
    'openpyxl': None,
    'bs4': None,
    'yaml': None,
    'docx': None,  # python-docx for creating DOCX files
}

# 延迟导入的库（在代码中使用时才导入，避免阻塞）
LAZY_IMPORT_LIBRARIES = {
    'matplotlib.pyplot': 'plt',
    'matplotlib': None,
    'seaborn': 'sns',
}


DEFAULT_EXECUTION_POLICY: Dict[str, Any] = {
    "python": {
        "max_timeout": 120,
        "blocked_patterns": [
            "os.system(",
            "subprocess.Popen(",
            "subprocess.run(",
            "pty.spawn(",
            "exec(",
            "eval(",
            "compile(",
        ],
    },
    "shell": {
        "max_timeout": 60,
        "allow_outside_workspace": False,
        "blocked_patterns": [
            "rm -rf /",
            "mkfs",
            "shutdown",
            "reboot",
            "curl | sh",
            "wget | sh",
            ":(){:|:&};:",
        ],
        "allow_commands": [],
    },
    # 文件写入：写入工作区需确认权限；此处为说明与后续扩展预留
    "file_write": {
        "note": "写入工作区时可能弹出权限确认，请点击允许以继续。",
    },
}


_execution_policy_cache: Dict[str, Tuple[float, Dict[str, Any]]] = {}
_execution_policy_cache_lock = threading.Lock()


def load_execution_policy() -> Dict[str, Any]:
    """
    从 `.maibot/settings.json` 读取执行策略（mtime 缓存，避免每次调用读盘）。
    约定字段：settings.execution_policy
    """
    try:
        ws = get_workspace_root()
        p = ws / ".maibot" / "settings.json"
        key = str(p)
        mtime: float = 0.0
        if p.exists():
            try:
                mtime = p.stat().st_mtime
            except OSError:
                pass
        with _execution_policy_cache_lock:
            cached = _execution_policy_cache.get(key)
            if cached and cached[0] == mtime:
                return dict(cached[1])
        if not p.exists():
            with _execution_policy_cache_lock:
                _execution_policy_cache[key] = (0.0, dict(DEFAULT_EXECUTION_POLICY))
            return DEFAULT_EXECUTION_POLICY
        data = json.loads(p.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return DEFAULT_EXECUTION_POLICY
        custom = data.get("execution_policy")
        if not isinstance(custom, dict):
            return DEFAULT_EXECUTION_POLICY
        merged = {
            "python": dict(DEFAULT_EXECUTION_POLICY.get("python", {})),
            "shell": dict(DEFAULT_EXECUTION_POLICY.get("shell", {})),
            "file_write": dict(DEFAULT_EXECUTION_POLICY.get("file_write", {})),
        }
        for k in ("python", "shell"):
            if isinstance(custom.get(k), dict):
                merged[k].update(custom[k])
        if isinstance(custom.get("file_write"), dict):
            merged["file_write"].update(custom["file_write"])
        with _execution_policy_cache_lock:
            _execution_policy_cache[key] = (mtime, merged)
        return merged
    except Exception:
        return DEFAULT_EXECUTION_POLICY


def is_shell_command_blocked(command: str) -> Tuple[bool, str]:
    policy = load_execution_policy().get("shell", {})
    cmd = (command or "").strip()
    if not cmd:
        return True, "空命令"
    lowered = cmd.lower()
    normalized = _normalize_shell_text(cmd, compact=False)
    compact = _normalize_shell_text(cmd, compact=True)
    bypass_reason = detect_shell_bypass_risk(cmd)
    if bypass_reason:
        return True, bypass_reason
    blocked_patterns = policy.get("blocked_patterns", []) or []
    for p in blocked_patterns:
        token = str(p or "").strip().lower()
        if not token:
            continue
        token_norm = _normalize_shell_text(token, compact=False)
        token_compact = _normalize_shell_text(token, compact=True)
        if (token in lowered) or (token_norm and token_norm in normalized) or (token_compact and token_compact in compact):
            return True, f"命中禁止命令片段: {p}"
    allow_commands = policy.get("allow_commands", []) or []
    if allow_commands:
        ok = any(lowered.startswith(str(x or "").strip().lower()) for x in allow_commands if str(x or "").strip())
        if not ok:
            return True, "未在 allow_commands 白名单中"
    return False, ""


def normalize_shell_timeout(timeout: int) -> int:
    policy = load_execution_policy().get("shell", {})
    max_timeout = int(policy.get("max_timeout", 60) or 60)
    return max(1, min(int(timeout or max_timeout), max_timeout))


def resolve_shell_working_directory(working_directory: Optional[str]) -> Tuple[Path, Optional[str]]:
    policy = load_execution_policy().get("shell", {})
    allow_outside = bool(policy.get("allow_outside_workspace", False))
    ws = get_workspace_root().resolve()
    raw = (working_directory or "").strip()
    target = Path(raw).expanduser().resolve() if raw else ws
    if allow_outside:
        return target, None
    # 默认只允许在 workspace 内执行
    if target == ws or ws in target.parents:
        return target, None
    return ws, f"工作目录越界：{target} 不在 workspace 内，已阻止"


def _validate_open_write_paths(code: str) -> Tuple[bool, str]:
    """校验 open(..., write-mode) 的目标路径必须在 workspace 内。

    仅允许字面量路径；动态路径在 write-mode 下直接阻止，避免绕过工作区边界。
    """
    ws = get_workspace_root().resolve()
    # open("path", "w") / open('path', 'a+') / open("/abs", "xb") ...
    literal_open_pattern = re.compile(
        r"open\s*\(\s*(['\"])(?P<path>.+?)\1\s*,\s*(['\"])(?P<mode>[^'\"]+)\3",
        re.IGNORECASE,
    )
    for m in literal_open_pattern.finditer(code or ""):
        mode = str(m.group("mode") or "").lower()
        if not any(ch in mode for ch in ("w", "a", "x", "+")):
            continue
        raw_path = str(m.group("path") or "").strip()
        if not raw_path:
            return False, "open() 写入模式路径不能为空"
        p = Path(raw_path)
        if not p.is_absolute():
            p = ws / p
        try:
            resolved = p.resolve()
        except Exception as e:
            return False, f"open() 写入路径解析失败: {e}"
        if resolved != ws and ws not in resolved.parents:
            return False, f"open() 写入路径越界: {resolved}"

    # write-mode 但路径不是字面量，拒绝执行
    dynamic_open_write_pattern = re.compile(
        r"open\s*\(\s*(?!['\"]).+?,\s*['\"][^'\"]*[wax\+][^'\"]*['\"]",
        re.IGNORECASE,
    )
    if dynamic_open_write_pattern.search(code or ""):
        return False, "open() 写入模式仅允许使用工作区内的字面量路径"
    return True, ""


class PythonExecutor:
    """简洁的 Python 执行器"""
    
    _available_libs: Dict[str, bool] = {}
    _initialized: bool = False
    _init_lock = threading.Lock()
    
    @classmethod
    def _init_once(cls):
        """一次性初始化：检测可用库（双重检查锁，避免并发竞态）"""
        if cls._initialized:
            return
        with cls._init_lock:
            if cls._initialized:
                return
            for lib in COMMON_LIBRARIES:
                try:
                    importlib.import_module(lib)
                    cls._available_libs[lib] = True
                except ImportError:
                    cls._available_libs[lib] = False
                except Exception as e:
                    logger.warning(f"跳过库 {lib} 的预加载: {e}")
                    cls._available_libs[lib] = False
            cls._initialized = True
    
    @classmethod
    def _prepare_globals(cls) -> Dict[str, Any]:
        """准备执行环境"""
        cls._init_once()
        
        # 为每次执行提供只读 builtins 视图，防止代码在运行时篡改。
        exec_globals = {"__builtins__": MappingProxyType(dict(SAFE_BUILTINS))}
        
        # 导入核心模块
        for mod in CORE_MODULES:
            try:
                exec_globals[mod] = importlib.import_module(mod)
            except ImportError:
                pass
        
        # 导入可用的第三方库
        for lib, alias in COMMON_LIBRARIES.items():
            if cls._available_libs.get(lib):
                try:
                    module = importlib.import_module(lib)
                    exec_globals[lib] = module
                    if alias:
                        exec_globals[alias] = module
                except ImportError:
                    pass
        
        # 常用快捷方式
        if 'datetime' in exec_globals:
            exec_globals['date'] = exec_globals['datetime'].date
            exec_globals['timedelta'] = exec_globals['datetime'].timedelta
        # 注入辅助函数
        cls._inject_helpers(exec_globals)
        
        return exec_globals
    
    @classmethod
    def _inject_helpers(cls, exec_globals: Dict[str, Any]):
        """注入辅助函数"""
        
        # 简单的辅助函数
        def print_json(obj, **kwargs):
            """格式化打印 JSON"""
            import json
            print(json.dumps(obj, ensure_ascii=False, indent=2, default=str, **kwargs))
        
        exec_globals['print_json'] = print_json
    
    @classmethod
    async def execute(
        cls,
        code: str,
        timeout: int = 60,
        stream_writer: Optional[Callable] = None,
        auto_install: bool = True,
    ) -> Dict[str, Any]:
        """执行 Python 代码
        
        Args:
            code: Python 代码
            timeout: 超时时间
            stream_writer: 流式输出写入器
            auto_install: 是否自动安装白名单库
        """
        start = time.time()
        policy = load_execution_policy().get("python", {})
        max_timeout = int(policy.get("max_timeout", 120) or 120)
        timeout = max(1, min(int(timeout or max_timeout), max_timeout))
        blocked_patterns = [str(x or "").strip() for x in (policy.get("blocked_patterns", []) or []) if str(x or "").strip()]
        lowered = (code or "").lower()
        for p in blocked_patterns:
            if p.lower() in lowered:
                duration = time.time() - start
                emit_tool_event(stream_writer, "python_complete", status="blocked", duration=duration)
                return {
                    "status": "blocked",
                    "error": f"执行策略阻止了该 Python 代码片段: {p}",
                    "duration": duration,
                }
        ok, reason = _validate_open_write_paths(code or "")
        if not ok:
            duration = time.time() - start
            emit_tool_event(stream_writer, "python_complete", status="blocked", duration=duration)
            return {
                "status": "blocked",
                "error": f"执行策略阻止 open() 写入: {reason}",
                "duration": duration,
            }
        
        emit_tool_event(stream_writer, "python_start", lines=len(code.split('\n')))
        
        # 检测并自动安装缺失的库
        install_messages = []
        if auto_install:
            missing = detect_missing_imports(code)
            if missing:
                emit_tool_event(stream_writer, "python_installing", packages=missing)
                installed, not_installed, msg = auto_install_missing(missing)
                if installed:
                    install_messages.append(f"📦 已自动安装: {', '.join(installed)}")
                    # 重新初始化以包含新安装的库
                    cls._initialized = False
                if not_installed:
                    # 非白名单库，返回提示
                    return {
                        "status": "missing_packages",
                        "missing": not_installed,
                        "message": f"缺少库: {', '.join(not_installed)}\n如需安装，请使用: pip install {' '.join(get_pip_package_name(p) for p in not_installed)}",
                        "duration": time.time() - start,
                    }
        
        try:
            # 捕获输出
            stdout_buf = io.StringIO()
            stderr_buf = io.StringIO()
            
            def run():
                """在线程中执行代码（避免阻塞事件循环）"""
                # 在线程中准备全局环境（某些库如 matplotlib 导入时会阻塞）
                exec_globals = cls._prepare_globals()
                exec_locals = {}
                
                with redirect_stdout(stdout_buf), redirect_stderr(stderr_buf):
                    exec(code, exec_globals, exec_locals)
                return exec_locals.get('result')
            
            # 异步执行（避免阻塞）
            result = await asyncio.wait_for(
                asyncio.to_thread(run),
                timeout=timeout
            )
            
            output = stdout_buf.getvalue()
            stderr = stderr_buf.getvalue()
            duration = time.time() - start

            # 添加安装消息
            if install_messages:
                output = "\n".join(install_messages) + "\n" + output

            # 向前端发送输出（至少一次），便于聊天区展示输出区
            if output:
                emit_tool_event(stream_writer, "python_output", data=output)
            if stderr:
                emit_tool_event(stream_writer, "python_output", data=f"[stderr] {stderr}")

            emit_tool_event(stream_writer, "python_complete", status="success", duration=duration)
            
            return {
                "status": "success",
                "output": output,
                "stderr": stderr,
                "result": result,
                "duration": duration,
            }
            
        except asyncio.TimeoutError:
            duration = time.time() - start
            emit_tool_event(stream_writer, "python_complete", status="timeout", duration=duration)
            return {
                "status": "timeout",
                "error": f"执行超时（>{timeout}秒）",
                "duration": duration,
            }
            
        except Exception as e:
            duration = time.time() - start
            emit_tool_event(stream_writer, "python_complete", status="error", duration=duration)
            tb = traceback.format_exc()
            if os.environ.get("APP_ENV", "production") == "development":
                return {"status": "error", "error": str(e), "traceback": tb, "duration": duration}
            logger.error("python_run 执行异常: %s\n%s", e, tb, exc_info=True)
            return {"status": "error", "error": str(e), "duration": duration}


# ============================================================
# 工具定义 - Cursor 风格（内部/外部 Python 分开）
# ============================================================

@tool("python_run")
@traceable(name="python_run", run_type="tool")
async def execute_python_code(
    code: str, 
    timeout: Optional[int] = None,
    mode: str = "auto"
) -> str:
    """Execute Python code for analysis, generation, and automation.

    Purpose:
    - 用 Python 完成复杂计算、数据处理、文档生成与脚本编排。

    When to use:
    - 需要可复现计算、批处理、格式转换或结构化输出。
    - 需要生成图表/表格/JSON 供前端展示。

    Avoid when:
    - 简单单文件读写：用 read_file/write_file/edit_file。

    Parameters:
    - code: 待执行 Python 代码。
    - timeout: 超时时间（秒）。
    - mode: "auto" | "internal" | "external"。

    Returns:
    - 成功返回执行结果文本；若输出为 JSON，会尽量保留结构化格式。
    - 失败返回带错误信息的文本。

    Limitations:
    - 长输出仅返回路径与摘要，写入位置见 workspace_layout；Skills 脚本优先于手写代码。

    Examples:
    - internal: 读取 CSV 并输出统计 JSON。
    - external: 生成图表并返回保存路径。
    """
    stream_writer = get_tool_stream_writer()
    effective_timeout = int(timeout if timeout is not None else _get_default_tool_timeout())
    
    # Auto-detect mode based on code characteristics
    if mode == "auto":
        lines = code.strip().split('\n')
        # Internal mode for: short code, no file output, no visualization
        is_internal = (
            len(lines) <= 10 and
            'plt.' not in code and
            '.savefig' not in code and
            'print_json' not in code and
            len(code) < 500
        )
        mode = "internal" if is_internal else "external"
    
    # Emit mode info for frontend
    emit_tool_event(stream_writer, "python_mode", mode=mode, lines=len(code.split('\n')))
    
    result = await PythonExecutor.execute(code, effective_timeout, stream_writer)

    def _attach_ui_type(obj: Any) -> Any:
        if not isinstance(obj, dict):
            return obj
        if "__ui_type" in obj:
            return obj
        if ("healthScore" in obj or "health_score" in obj) and ("statuses" in obj or "components" in obj):
            obj["__ui_type"] = "system_status"
            return obj
        if any(k in obj for k in ("charts", "tables", "metrics")):
            obj["__ui_type"] = "rich_result"
            return obj
        obj["__ui_type"] = "json_viewer"
        return obj
    
    if result["status"] == "success":
        output = result['output'].strip()
        stderr = result.get('stderr', '').strip()
        duration = result['duration']
        
        if mode == "internal":
            # Internal mode: minimal output, focus on result
            if output:
                # Try to parse JSON for cleaner display
                try:
                    parsed = json.loads(output)
                    parsed = _attach_ui_type(parsed)
                    return json.dumps(parsed, ensure_ascii=False)
                except Exception as e:
                    logger.debug("python_run output 非 JSON，按文本返回: %s", e)
                    return output
            return f"✓ ({duration:.2f}s)"
        else:
            # External mode: full output with context
            if output:
                try:
                    parsed_output = json.loads(output)
                    output = json.dumps(_attach_ui_type(parsed_output), ensure_ascii=False)
                except Exception:
                    pass
            parts = [f"✅ 执行成功 ({duration:.2f}s)"]
            if output:
                parts.append(f"\n{output}")
            if stderr:
                parts.append(f"\n[stderr] {stderr}")
            return "\n".join(parts)
    
    elif result["status"] == "timeout":
        return f"❌ 超时（>{effective_timeout}s）\n建议：检查是否有死循环，或增加 timeout"
    elif result["status"] == "blocked":
        return f"⛔ 已被执行策略拦截\n{result.get('error', '命中安全策略')}"
    
    else:
        return f"❌ 错误\n{result.get('error', '未知错误')}"


@tool("python_internal")
async def execute_python_internal(code: str, timeout: Optional[int] = None) -> str:
    """Fast Python execution for internal data processing. No code display.
    
    Use this for:
    - Quick calculations
    - Data extraction
    - File parsing
    - JSON processing
    
    Returns only the result, not the code or execution details.
    
    Args:
        code: Python code to execute
        timeout: Max seconds（为空时使用 TOOL_DEFAULT_TIMEOUT）
    
    Returns: Result only (JSON preferred)
    """
    # 直接调用 PythonExecutor，不通过 tool
    stream_writer = get_tool_stream_writer()
    emit_tool_event(stream_writer, "python_mode", mode="internal", lines=len(code.split('\n')))
    
    effective_timeout = int(timeout if timeout is not None else _get_default_tool_timeout())
    result = await PythonExecutor.execute(code, effective_timeout, stream_writer)
    
    if result["status"] == "success":
        output = result['output'].strip()
        if output:
            # Try to parse JSON for cleaner display
            try:
                import json
                parsed = json.loads(output)
                return json.dumps(parsed, ensure_ascii=False)
            except Exception as e:
                logger.debug("python_internal output 非 JSON，按文本返回: %s", e)
                return output
        return f"✓ ({result['duration']:.2f}s)"
    elif result["status"] == "timeout":
        return f"❌ 超时（>{effective_timeout}s）"
    elif result["status"] == "blocked":
        return f"⛔ 已被执行策略拦截: {result.get('error', '命中安全策略')}"
    else:
        return f"❌ 错误: {result.get('error', '未知错误')}"


__all__ = [
    "PythonExecutor",
    "execute_python_code",
    "execute_python_internal",
    "load_execution_policy",
    "is_shell_command_blocked",
    "normalize_shell_timeout",
    "resolve_shell_working_directory",
]
