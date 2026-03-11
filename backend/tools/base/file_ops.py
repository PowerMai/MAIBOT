"""
统一文件操作工具 - 遵循业界标准（Cursor/Claude/LangChain）
支持流式输出显示读取进度

设计原则：
1. 简单直接：只接受 file_path，不做自动查找
2. 路径处理：支持绝对路径和相对于 root_dir 的相对路径
3. 如果找不到：返回清晰错误，由 LLM 使用 ls/glob/find 工具查找
4. 单一职责：read_file 只负责读取，不负责查找

业界做法：
- Cursor: read_file 只读取，file_search/grep 用于查找
- Claude: 同上
- LangChain: ReadFileTool 只接受 file_path，有 root_dir 限制
"""

import os
import time
from pathlib import Path
from typing import Optional
from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field
from langchain_community.tools import ReadFileTool as LangChainReadFileTool

from ..internal.document_loader import UnifiedDocumentLoader
from .streaming import get_tool_stream_writer, emit_tool_event


# 项目根目录（作为 root_dir 使用）
PROJECT_ROOT = Path(__file__).resolve().parents[3]


class ReadFileInput(BaseModel):
    """ReadFile input schema"""
    file_path: str = Field(description="File path to read")


class EnhancedReadFileTool(BaseTool):
    """
    增强版 ReadFileTool - 遵循业界标准
    
    与 LangChain ReadFileTool 的区别：
    - 自动检测文件类型，使用正确的解析器（支持 docx, pdf, xlsx 等）
    - 同样的简洁接口：只需要 file_path
    - 输出长度限制，避免超长内容占满上下文
    
    不做的事情（遵循业界标准）：
    - 不自动查找文件（如果路径错误，返回错误）
    - 不递归搜索目录
    - 由 LLM 使用其他工具（ls, glob, file_search）找到正确路径
    """
    
    # 输出长度限制（字符数），超过时截断并提示
    # 默认 100000 字符（约 25K-50K tokens），可通过环境变量配置
    MAX_OUTPUT_CHARS: int = int(os.getenv("READ_FILE_MAX_CHARS", "100000"))
    
    name: str = "read_file"
    description: str = (
        "Read and return the contents of a file from the local filesystem. "
        "This tool automatically detects file types and uses the appropriate parser "
        "(supports txt, md, pdf, docx, xlsx, csv, json, yaml, and more). "
        "\n\n"
        "WHEN TO USE:\n"
        "- When you need to examine file contents before making changes\n"
        "- When the user references a file by path or mentions an uploaded file\n"
        "- When you need to understand code structure or document content\n"
        "\n"
        "IMPORTANT:\n"
        "- Always read a file BEFORE attempting to edit it\n"
        "- If the file doesn't exist, you'll get an error - use file_search or ls first to find the correct path\n"
        "- For user-uploaded files, the path is provided in the message as '[附件] filename (absolute_path)'\n"
        "\n"
        "INPUT: file_path - absolute path or path relative to workspace root\n"
        "OUTPUT: file content as text (for binary files like images, returns metadata)"
    )
    args_schema: type[BaseModel] = ReadFileInput
    
    # Pydantic 字段定义
    root_dir: Path = Field(default=PROJECT_ROOT, exclude=True)
    _text_tool: LangChainReadFileTool = None
    
    def __init__(self, root_dir: Optional[Path] = None, **kwargs):
        """
        初始化
        
        Args:
            root_dir: 根目录，限制文件访问范围。默认为项目根目录。
        """
        _root = Path(root_dir) if root_dir is not None else PROJECT_ROOT
        
        super().__init__(
            root_dir=_root,
            **kwargs,
        )
        # 私有属性需要用 object.__setattr__
        object.__setattr__(self, '_text_tool', LangChainReadFileTool(root_dir=str(_root)))
    
    def _get_validated_path(self, file_path: str) -> tuple[Optional[Path], Optional[str]]:
        """
        验证并解析路径 - 遵循 LangChain 标准
        
        Args:
            file_path: 文件路径
            
        Returns:
            (path, error): 如果成功返回 (path, None)，失败返回 (None, error_message)
        """
        import urllib.parse
        
        # 清理路径
        file_path = file_path.strip().strip('"').strip("'")
        
        # URL 解码
        try:
            decoded = urllib.parse.unquote(file_path)
            if decoded != file_path:
                file_path = decoded
        except Exception:
            pass
        
        path = Path(file_path)
        
        # 绝对路径：必须在 root_dir 或允许的目录内
        if path.is_absolute():
            resolved = path.resolve()
            root_resolved = self.root_dir.resolve()
            allowed = False
            try:
                resolved.relative_to(root_resolved)
                allowed = True
            except ValueError:
                pass
            if not allowed:
                return None, f"Error: path outside workspace: {file_path}"
            if resolved.exists():
                return resolved, None
            else:
                return None, f"Error: no such file: {file_path}"
        
        # 相对路径 - 相对于 root_dir
        full_path = self.root_dir / file_path
        if full_path.exists():
            return full_path, None
        
        # 尝试 backend/ 子目录
        backend_path = self.root_dir / "backend" / file_path
        if backend_path.exists():
            return backend_path, None
        
        return None, f"Error: no such file: {file_path}"
    
    def _run(self, file_path: str) -> str:
        """
        同步读取文件（支持流式输出）
        
        遵循业界标准：
        - 路径不存在 → 返回错误
        - 路径存在 → 读取并返回内容
        - 不做任何自动查找
        """
        import logging
        logger = logging.getLogger(__name__)
        
        # 获取流式写入器
        writer = get_tool_stream_writer()
        start_time = time.time()
        
        # 验证路径
        path, error = self._get_validated_path(file_path)
        if error:
            logger.warning(f"[read_file] {error}")
            emit_tool_event(writer, "file_read_error", error=error, file_path=file_path)
            return error
        
        logger.info(f"[read_file] 读取: {path}")
        
        # 获取文件大小
        file_size = path.stat().st_size if path.exists() else 0
        
        # 发送开始事件
        emit_tool_event(writer, "file_read_start", 
                       file_path=str(path), 
                       file_size=file_size,
                       file_type=path.suffix.lower())
        
        # 获取扩展名
        ext = path.suffix.lower()
        
        # 根据文件类型选择解析器
        if ext in UnifiedDocumentLoader.SUPPORTED_FORMATS:
            try:
                emit_tool_event(writer, "file_read_progress", 
                               status="parsing", 
                               file_type=ext)
                
                docs = UnifiedDocumentLoader.load(str(path))
                content = "\n\n".join([doc.page_content for doc in docs])
                
                # 截断过长内容
                original_len = len(content)
                if original_len > self.MAX_OUTPUT_CHARS:
                    content = content[:self.MAX_OUTPUT_CHARS]
                    content += f"\n\n[内容已截断：原始 {original_len} 字符，显示前 {self.MAX_OUTPUT_CHARS} 字符。如需完整内容，请使用 grep 定位关键部分或分段读取]"
                    logger.info(f"[read_file] 截断: {original_len} -> {self.MAX_OUTPUT_CHARS} chars")
                
                duration = time.time() - start_time
                logger.info(f"[read_file] 成功: {len(content)} chars")
                
                emit_tool_event(writer, "file_read_complete",
                               status="success",
                               chars_read=len(content),
                               duration=duration)
                return content
            except Exception as e:
                emit_tool_event(writer, "file_read_error", error=str(e))
                return f"Error reading {ext} file: {e}"
        else:
            # 文本文件
            try:
                emit_tool_event(writer, "file_read_progress", status="reading")
                
                with path.open("r", encoding="utf-8") as f:
                    content = f.read()
                
                # 截断过长内容
                original_len = len(content)
                if original_len > self.MAX_OUTPUT_CHARS:
                    content = content[:self.MAX_OUTPUT_CHARS]
                    content += f"\n\n[内容已截断：原始 {original_len} 字符，显示前 {self.MAX_OUTPUT_CHARS} 字符。如需完整内容，请使用 grep 定位关键部分或分段读取]"
                    logger.info(f"[read_file] 截断: {original_len} -> {self.MAX_OUTPUT_CHARS} chars")
                
                duration = time.time() - start_time
                logger.info(f"[read_file] 成功: {len(content)} chars")
                
                emit_tool_event(writer, "file_read_complete",
                               status="success",
                               chars_read=len(content),
                               lines_read=content.count('\n') + 1,
                               duration=duration)
                return content
            except Exception as e:
                emit_tool_event(writer, "file_read_error", error=str(e))
                return f"Error reading file: {e}"
    
    async def _arun(self, file_path: str) -> str:
        """
        异步读取文件
        
        使用 asyncio.to_thread 避免阻塞事件循环
        """
        import asyncio
        return await asyncio.to_thread(self._run, file_path)


# ============================================================
# 批量读取文件工具 - Claude 风格效率优化
# ============================================================

class BatchReadFilesInput(BaseModel):
    """BatchReadFiles input schema"""
    file_paths: list[str] = Field(description="List of file paths to read")
    max_chars_per_file: int = Field(default=50000, description="Max chars per file (default 50000)")


class BatchReadFilesTool(BaseTool):
    """
    批量读取文件工具 - 减少 LLM 调用次数
    
    Claude 风格优化：
    - 一次调用读取多个文件
    - 自动截断过长内容
    - 返回结构化结果
    """
    
    name: str = "batch_read_files"
    description: str = (
        "Read multiple files in a single call, significantly more efficient than multiple read_file calls. "
        "Use this when you need to examine several related files at once, such as understanding a module's structure "
        "or reviewing multiple configuration files.\n\n"
        "WHEN TO USE:\n"
        "- When you need to read 2+ files that are related (e.g., a class and its tests)\n"
        "- When exploring a directory's contents after using ls or file_search\n"
        "- When comparing multiple files\n\n"
        "INPUT:\n"
        "- file_paths: list of file paths to read\n"
        "- max_chars_per_file: maximum characters per file (default 50000, truncates longer files)\n\n"
        "OUTPUT: JSON array with {path, chars, truncated, content} for each file"
    )
    args_schema: type[BaseModel] = BatchReadFilesInput
    
    root_dir: Path = Field(default=PROJECT_ROOT, exclude=True)
    _read_tool: EnhancedReadFileTool = None
    
    def __init__(self, root_dir: Optional[Path] = None, **kwargs):
        _root = Path(root_dir) if root_dir is not None else PROJECT_ROOT
        super().__init__(root_dir=_root, **kwargs)
        object.__setattr__(self, '_read_tool', EnhancedReadFileTool(root_dir=_root))
    
    def _run(self, file_paths: list[str], max_chars_per_file: int = 50000) -> str:
        """批量读取文件"""
        import json
        
        writer = get_tool_stream_writer()
        start_time = time.time()
        
        emit_tool_event(writer, "batch_read_start", file_count=len(file_paths))
        
        results = []
        for i, path in enumerate(file_paths):
            emit_tool_event(writer, "batch_read_progress", 
                           current=i+1, 
                           total=len(file_paths),
                           file=path)
            
            content = self._read_tool._run(path)
            
            # 截断过长内容
            truncated = False
            if len(content) > max_chars_per_file:
                content = content[:max_chars_per_file] + f"\n\n... [截断，共 {len(content)} 字符]"
                truncated = True
            
            results.append({
                "path": path,
                "chars": len(content),
                "truncated": truncated,
                "content": content,
            })
        
        duration = time.time() - start_time
        emit_tool_event(writer, "batch_read_complete", 
                       file_count=len(file_paths),
                       duration=duration)
        
        return json.dumps({
            "status": "success",
            "files_read": len(results),
            "duration": f"{duration:.2f}s",
            "results": results,
        }, ensure_ascii=False, indent=2)
    
    async def _arun(self, file_paths: list[str], max_chars_per_file: int = 50000) -> str:
        import asyncio
        return await asyncio.to_thread(self._run, file_paths, max_chars_per_file)


# ============================================================
# 其他文件操作工具 - 直接使用 LangChain 标准工具
# ============================================================
# 
# 已在 CoreToolsRegistry 中注册：
# - write_file: WriteFileTool
# - delete_file: DeleteFileTool  
# - list_directory: ListDirectoryTool
# - copy_file: CopyFileTool
# - move_file: MoveFileTool
# - file_search: FileSearchTool
# - glob: 使用 python_run
#
# 这些工具保持 LangChain 标准接口，不做额外封装
