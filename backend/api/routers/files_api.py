"""
文件与工作区只读/读写 API：/files/list, read, write, tree, delete, mkdir, rename。
从 app 拆出，通过 APIRouter 挂载。
"""
import asyncio
import logging
import shutil
from pathlib import Path
from typing import List, Tuple

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from backend.api.common import (
    safe_error_detail,
    resolve_read_path,
    resolve_write_path,
    sync_write_text,
    sync_write_binary,
)
from backend.api.deps import verify_internal_token
from backend.tools.base.paths import get_workspace_root

router = APIRouter(tags=["files"])
logger = logging.getLogger(__name__)

_BINARY_READ_EXT = frozenset(
    {"xlsx", "xls", "pdf", "docx", "doc", "pptx", "ppt", "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"}
)
_FILES_READ_MAX_BYTES = 50 * 1024 * 1024  # 50MB


class WriteFileRequest(BaseModel):
    content: str


class WriteFileBinaryRequest(BaseModel):
    content: str  # base64 编码的二进制内容


def _do_delete_path(file_path: Path) -> None:
    if file_path.is_file():
        file_path.unlink()
    else:
        shutil.rmtree(file_path)


def _do_rename(old: Path, new: Path) -> None:
    new.parent.mkdir(parents=True, exist_ok=True)
    old.rename(new)


@router.get("/files/list")
async def list_uploaded_files(_: None = Depends(verify_internal_token)):
    """列出当前工作区 uploads/ 下已上传的文件（与 set_workspace_root 一致，切换工作区后列表同步）。"""
    try:
        upload_dir = get_workspace_root() / "uploads"
        upload_dir.mkdir(parents=True, exist_ok=True)
        files = []
        for file_path in upload_dir.iterdir():
            if file_path.is_file():
                files.append({
                    "filename": file_path.name,
                    "path": str(file_path.absolute()),
                    "size": file_path.stat().st_size,
                })
        return {"ok": True, "files": files}
    except Exception as e:
        logger.exception("列出上传文件失败: %s", e)
        raise HTTPException(status_code=500, detail=safe_error_detail(e))


@router.get("/files/read")
async def read_file(path: str = "", _: None = Depends(verify_internal_token)):
    """
    读取文件内容。path：工作区相对路径或服务端绝对路径。
    二进制格式返回 base64+size，文本返回 content；超过 50MB 返回 413。
    """
    import base64

    resolved = resolve_read_path(path)
    if resolved.is_file():
        file_size = (await asyncio.to_thread(resolved.stat)).st_size
        if file_size > _FILES_READ_MAX_BYTES:
            raise HTTPException(status_code=413, detail="file too large to read (max 50MB)")
    ext = resolved.suffix.lstrip(".").lower()
    if ext in _BINARY_READ_EXT:
        def _read_bytes() -> Tuple[bytes, int]:
            raw = resolved.read_bytes()
            return raw, len(raw)

        raw_bytes, size = await asyncio.to_thread(_read_bytes)
        b64 = base64.b64encode(raw_bytes).decode("ascii")
        return {"ok": True, "content": b64, "size": size}
    try:
        text = await asyncio.to_thread(resolved.read_text, encoding="utf-8", errors="replace")
        return {"ok": True, "content": text}
    except Exception as e:
        logger.warning("read_file text fallback failed: %s", e)
        raw_bytes = await asyncio.to_thread(resolved.read_bytes)
        b64 = base64.b64encode(raw_bytes).decode("ascii")
        return {"ok": True, "content": b64, "size": len(raw_bytes)}  # type: ignore[return-value]


@router.post("/files/write")
async def write_file(
    path: str,
    request: WriteFileRequest,
    _: None = Depends(verify_internal_token),
):
    """写入文件内容（路径限于项目/工作区）。"""
    try:
        file_path = resolve_write_path(path)
        await asyncio.to_thread(sync_write_text, file_path, request.content)
        logger.info("✅ 文件写入成功: %s", path)
        return {
            "ok": True,
            "path": str(file_path.absolute()),
            "name": file_path.name,
            "size": file_path.stat().st_size,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error("❌ 写入文件失败: %s", e)
        raise HTTPException(status_code=500, detail=safe_error_detail(e))


@router.post("/files/write-binary")
async def write_file_binary(
    path: str,
    request: WriteFileBinaryRequest,
    _: None = Depends(verify_internal_token),
):
    """写入二进制文件（path 限于项目/工作区，body.content 为 base64）。"""
    try:
        file_path = resolve_write_path(path)
        await asyncio.to_thread(sync_write_binary, file_path, request.content)
        logger.info("✅ 二进制文件写入成功: %s", path)
        return {
            "ok": True,
            "path": str(file_path.absolute()),
            "name": file_path.name,
            "size": file_path.stat().st_size,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error("❌ 写入二进制文件失败: %s", e)
        raise HTTPException(status_code=500, detail=safe_error_detail(e))


@router.get("/files/tree")
async def get_file_tree(path: str, max_depth: int = 5):
    """获取目录树结构（path 限于项目/工作区下）。"""
    try:
        root_path = resolve_write_path(path)
        if not root_path.exists():
            raise HTTPException(status_code=404, detail=f"目录不存在: {path}")
        if not root_path.is_dir():
            raise HTTPException(status_code=400, detail=f"路径不是目录: {path}")

        def build_tree(dir_path: Path, depth: int = 0) -> List[dict]:
            if depth >= max_depth:
                return []
            items = []
            try:
                for item in sorted(dir_path.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower())):
                    if item.name.startswith(".") or item.name in {"__pycache__", "node_modules", ".git", "venv", ".venv"}:
                        continue
                    node = {
                        "name": item.name,
                        "path": str(item.absolute()),
                        "type": "folder" if item.is_dir() else "file",
                    }
                    if item.is_file():
                        node["size"] = item.stat().st_size
                    elif item.is_dir():
                        node["children"] = build_tree(item, depth + 1)
                    items.append(node)
            except PermissionError:
                pass
            return items

        return {
            "ok": True,
            "path": str(root_path.absolute()),
            "name": root_path.name,
            "type": "folder",
            "children": build_tree(root_path),
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error("❌ 获取目录树失败: %s", e)
        raise HTTPException(status_code=500, detail=safe_error_detail(e))


@router.delete("/files/delete")
async def delete_file(path: str, _: None = Depends(verify_internal_token)):
    """删除文件或目录（路径限于项目/工作区）。"""
    try:
        file_path = resolve_write_path(path)
        if not file_path.exists():
            raise HTTPException(status_code=404, detail=f"文件不存在: {path}")
        await asyncio.to_thread(_do_delete_path, file_path)
        logger.info("✅ 文件删除成功: %s", path)
        return {"ok": True, "path": path}
    except HTTPException:
        raise
    except Exception as e:
        logger.error("❌ 删除文件失败: %s", e)
        raise HTTPException(status_code=500, detail=safe_error_detail(e))


@router.post("/files/mkdir")
async def create_directory(path: str, _: None = Depends(verify_internal_token)):
    """创建目录（路径限于项目/工作区）。"""
    try:
        dir_path = resolve_write_path(path)
        await asyncio.to_thread(dir_path.mkdir, parents=True, exist_ok=True)
        logger.info("✅ 目录创建成功: %s", path)
        return {"ok": True, "path": str(dir_path.absolute())}
    except HTTPException:
        raise
    except Exception as e:
        logger.error("❌ 创建目录失败: %s", e)
        raise HTTPException(status_code=500, detail=safe_error_detail(e))


@router.post("/files/rename")
async def rename_file(old_path: str, new_path: str, _: None = Depends(verify_internal_token)):
    """重命名文件或目录（路径限于项目/工作区）。"""
    try:
        old = resolve_write_path(old_path)
        new = resolve_write_path(new_path)
        if not old.exists():
            raise HTTPException(status_code=404, detail=f"文件不存在: {old_path}")
        if new.exists():
            raise HTTPException(status_code=400, detail=f"目标路径已存在: {new_path}")
        await asyncio.to_thread(_do_rename, old, new)
        logger.info("✅ 文件重命名成功: %s -> %s", old_path, new_path)
        return {"ok": True, "old_path": old_path, "new_path": str(new.absolute())}
    except HTTPException:
        raise
    except Exception as e:
        logger.error("❌ 重命名失败: %s", e)
        raise HTTPException(status_code=500, detail=safe_error_detail(e))
