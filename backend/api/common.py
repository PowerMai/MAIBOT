"""
API 层共享常量与工具，供 app 与各 router 使用，避免循环引用。
"""
import os
import re
import uuid
from pathlib import Path


def is_valid_thread_id_uuid(thread_id: str) -> bool:
    """LangGraph API 要求 thread_id 为 UUID；非 UUID（如本地占位符 thread-{ts}）会触发 422。"""
    if not thread_id or not isinstance(thread_id, str):
        return False
    try:
        uuid.UUID(thread_id.strip())
        return True
    except (ValueError, TypeError):
        return False

from backend.tools.base.paths import get_project_root, get_workspace_root, UPLOADS_PATH, WORKSPACE_PATH

# 路径（与 app 一致）；读写解析用 get_workspace_root() 以支持 workspace/switch 后当前工作区
PROJECT_ROOT = get_project_root()
UPLOAD_DIR = UPLOADS_PATH
WORKSPACE_DIR = WORKSPACE_PATH

# 敏感文件名规则（与 app._SENSITIVE_FILENAME_RULES 一致）
SENSITIVE_FILENAME_RULES = [
    re.compile(r"^\.env(\..+)?$", re.IGNORECASE),
    re.compile(r".*(secret|credential|passwd|password|token|apikey|api[-_]?key).*", re.IGNORECASE),
    re.compile(r".*\.(pem|key|p12|pfx|jks)$", re.IGNORECASE),
    re.compile(r"^(id_rsa|id_dsa|id_ed25519)$", re.IGNORECASE),
]


def safe_error_detail(e: Exception) -> str:
    """生产环境不暴露内部异常详情，仅开发环境返回 str(e)。"""
    if os.getenv("APP_ENV", "production") == "development":
        return str(e)
    return "内部服务器错误"


def resolve_read_path(path_param: str) -> Path:
    """将前端传入的 path 解析为服务端安全路径（限于项目根或工作区根下）。"""
    from fastapi import HTTPException

    path_param = (path_param or "").strip().replace("\\", "/")
    if not path_param:
        raise HTTPException(status_code=400, detail="path is required")
    ws_root = get_workspace_root()
    if path_param.startswith("workspace/"):
        rest = path_param[len("workspace/") :].lstrip("/")
        resolved = (ws_root / rest).resolve()
    elif path_param.startswith("/") or (len(path_param) > 1 and path_param[1] in (":", "\\")):
        resolved = Path(path_param).resolve()
    else:
        resolved = (ws_root / path_param).resolve()
    if not resolved.is_file():
        raise HTTPException(status_code=404, detail="file not found")
    try:
        rel = resolved.relative_to(PROJECT_ROOT)
    except ValueError:
        try:
            rel = resolved.relative_to(ws_root)
        except ValueError:
            raise HTTPException(status_code=403, detail="path not allowed")
    rel_parts = rel.parts
    rel_str = str(rel).replace("\\", "/")
    if rel_parts and rel_parts[0] == "backend" and len(rel_parts) >= 2 and rel_parts[1] == "config":
        raise HTTPException(status_code=403, detail="path not allowed")
    if rel_str == "data/license.json" or rel_str.startswith("data/license"):
        raise HTTPException(status_code=403, detail="path not allowed")
    for rule in SENSITIVE_FILENAME_RULES:
        if rule.search(resolved.name):
            raise HTTPException(status_code=403, detail="path not allowed")
    return resolved


def sync_write_text(file_path: Path, content: str) -> int:
    """同步写入文本（供 asyncio.to_thread 调用）。"""
    file_path.parent.mkdir(parents=True, exist_ok=True)
    file_path.write_text(content, encoding="utf-8")
    return file_path.stat().st_size


def sync_write_binary(file_path: Path, content_base64: str) -> int:
    """同步写入二进制（content_base64 为 base64 编码字符串，供 asyncio.to_thread 调用）。"""
    import base64
    file_path.parent.mkdir(parents=True, exist_ok=True)
    raw = base64.b64decode(content_base64, validate=True)
    file_path.write_bytes(raw)
    return file_path.stat().st_size


def resolve_write_path(path_param: str) -> Path:
    """将前端传入的 path 解析为服务端安全写入路径（限于项目/工作区下）。与 resolve_read_path 一致的禁止路径与敏感文件名校验。"""
    from fastapi import HTTPException

    path_param = (path_param or "").strip().replace("\\", "/")
    if not path_param:
        raise HTTPException(status_code=400, detail="path is required")
    ws_root = get_workspace_root()
    if path_param.startswith("workspace/"):
        rest = path_param[len("workspace/") :].lstrip("/")
        resolved = (ws_root / rest).resolve()
    elif path_param.startswith("/") or (len(path_param) > 1 and path_param[1] in (":", "\\")):
        resolved = Path(path_param).resolve()
    else:
        resolved = (ws_root / path_param).resolve()
    rel = None
    for base in (PROJECT_ROOT, ws_root):
        try:
            rel = resolved.relative_to(base)
            break
        except ValueError:
            continue
    if rel is None:
        raise HTTPException(status_code=403, detail="write path not allowed")
    rel_parts = rel.parts
    rel_str = str(rel).replace("\\", "/")
    if rel_parts and rel_parts[0] == "backend" and len(rel_parts) >= 2 and rel_parts[1] == "config":
        raise HTTPException(status_code=403, detail="path not allowed")
    if rel_str == "data/license.json" or rel_str.startswith("data/license"):
        raise HTTPException(status_code=403, detail="path not allowed")
    for rule in SENSITIVE_FILENAME_RULES:
        if rule.search(resolved.name):
            raise HTTPException(status_code=403, detail="path not allowed")
    return resolved
