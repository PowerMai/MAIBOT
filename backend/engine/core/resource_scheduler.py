"""
资源调度器 - 智能管理 LLM、Embedding 和工具的并行执行

设计原则（Claude/Cursor 风格）：
1. 模型互斥：LLM 和 Embedding 模型不能同时运行（GPU 资源限制）
2. 工具并行：非模型工具可以并行执行
3. 自动检测：运行时检测系统资源，动态调整策略
4. 内存优化：显式释放不再使用的资源

资源类型：
- LLM: 大语言模型推理（独占 GPU）
- Embedding: 向量嵌入模型（独占 GPU）
- Tool: 工具执行（可并行，受 CPU 限制）
- IO: 文件/网络操作（可高并发）
"""

import asyncio
import os
import gc
import time
import threading
from typing import Dict, Any, Optional, Callable, List, Literal
from dataclasses import dataclass, field
from contextlib import asynccontextmanager
from enum import Enum
import logging

logger = logging.getLogger(__name__)

# psutil 是可选依赖
try:
    import psutil
    _HAS_PSUTIL = True
except ImportError:
    _HAS_PSUTIL = False
    logger.warning("⚠️ psutil 未安装，使用默认资源配置。安装: pip install psutil")


class ResourceType(Enum):
    """资源类型"""
    LLM = "llm"                    # LLM 推理（独占 GPU）
    EMBEDDING = "embedding"        # Embedding 模型（独占 GPU）
    TOOL = "tool"                  # 工具执行（CPU 并行）
    IO = "io"                      # IO 操作（高并发）


@dataclass
class SystemResources:
    """系统资源信息"""
    cpu_count: int
    memory_total_gb: float
    memory_available_gb: float
    memory_percent: float
    gpu_available: bool
    gpu_memory_gb: float = 0.0
    
    @classmethod
    def detect(cls) -> "SystemResources":
        """检测系统资源"""
        cpu_count = os.cpu_count() or 4
        
        # 如果 psutil 不可用，使用默认值
        if not _HAS_PSUTIL:
            return cls(
                cpu_count=cpu_count,
                memory_total_gb=16.0,  # 默认假设 16GB
                memory_available_gb=8.0,
                memory_percent=50.0,
                gpu_available=False,
                gpu_memory_gb=0.0,
            )
        
        memory = psutil.virtual_memory()
        
        # 检测 GPU
        gpu_available = False
        gpu_memory_gb = 0.0
        
        try:
            # 尝试检测 Metal (macOS)
            import subprocess
            result = subprocess.run(
                ["system_profiler", "SPDisplaysDataType"],
                capture_output=True, text=True, timeout=5
            )
            if "Metal" in result.stdout:
                gpu_available = True
                # macOS 共享内存，使用系统内存的一部分
                gpu_memory_gb = memory.total / (1024 ** 3) * 0.5  # 假设 50% 可用于 GPU
        except Exception as e:
            logger.debug("GPU/Metal detection failed: %s", e)

        return cls(
            cpu_count=cpu_count,
            memory_total_gb=memory.total / (1024 ** 3),
            memory_available_gb=memory.available / (1024 ** 3),
            memory_percent=memory.percent,
            gpu_available=gpu_available,
            gpu_memory_gb=gpu_memory_gb,
        )


@dataclass
class ResourceLimits:
    """资源限制配置"""
    max_concurrent_tools: int = 4          # 最大并行工具数
    max_concurrent_io: int = 10            # 最大并行 IO 数
    memory_threshold_percent: float = 85   # 内存警告阈值
    memory_critical_percent: float = 95    # 内存临界阈值
    tool_timeout: int = 60                 # 工具超时（秒）
    llm_timeout: int = 300                 # LLM 超时（秒）
    
    @classmethod
    def from_system(cls, resources: SystemResources) -> "ResourceLimits":
        """根据系统资源自动配置限制"""
        # 根据 CPU 核数调整并行工具数
        max_tools = min(resources.cpu_count, 8)
        
        # 根据内存调整
        if resources.memory_available_gb < 4:
            max_tools = min(max_tools, 2)
        elif resources.memory_available_gb < 8:
            max_tools = min(max_tools, 4)
        
        return cls(
            max_concurrent_tools=max_tools,
            max_concurrent_io=max_tools * 2,
        )


class ResourceScheduler:
    """
    资源调度器 - 单例模式
    
    核心功能：
    1. 模型互斥锁：确保 LLM 和 Embedding 不同时运行
    2. 工具信号量：限制并行工具数量
    3. 内存监控：自动触发 GC
    4. 资源统计：跟踪使用情况
    """
    
    _instance = None
    _lock = threading.Lock()
    
    def __new__(cls):
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
                    cls._instance._initialized = False
        return cls._instance
    
    def __init__(self):
        if self._initialized:
            return
        
        # 检测系统资源
        self.resources = SystemResources.detect()
        self.limits = ResourceLimits.from_system(self.resources)
        
        # 模型互斥锁（LLM 和 Embedding 共用）
        self._model_lock = asyncio.Lock()
        self._model_in_use: Optional[ResourceType] = None
        
        # 工具信号量
        self._tool_semaphore = asyncio.Semaphore(self.limits.max_concurrent_tools)
        self._io_semaphore = asyncio.Semaphore(self.limits.max_concurrent_io)
        
        # 统计
        self._stats = {
            "llm_calls": 0,
            "embedding_calls": 0,
            "tool_calls": 0,
            "io_calls": 0,
            "gc_triggers": 0,
            "memory_warnings": 0,
        }
        
        # 当前运行的任务
        self._running_tasks: Dict[str, Dict[str, Any]] = {}
        
        self._initialized = True
        
        logger.info(f"✅ ResourceScheduler 初始化完成")
        logger.info(f"   CPU: {self.resources.cpu_count} 核")
        logger.info(f"   内存: {self.resources.memory_available_gb:.1f}/{self.resources.memory_total_gb:.1f} GB")
        logger.info(f"   GPU: {'可用' if self.resources.gpu_available else '不可用'}")
        logger.info(f"   并行工具: {self.limits.max_concurrent_tools}")
    
    # ============================================================
    # 资源获取 API
    # ============================================================
    
    @asynccontextmanager
    async def acquire_llm(self, task_id: str = ""):
        """
        获取 LLM 资源（独占）
        
        使用方式：
            async with scheduler.acquire_llm("task_1"):
                result = await llm.ainvoke(...)
        """
        await self._check_memory()
        
        async with self._model_lock:
            self._model_in_use = ResourceType.LLM
            self._stats["llm_calls"] += 1
            task_key = task_id or f"llm_{time.time()}"
            self._running_tasks[task_key] = {
                "type": "llm",
                "start": time.time(),
            }
            
            try:
                yield
            finally:
                self._model_in_use = None
                self._running_tasks.pop(task_key, None)
    
    @asynccontextmanager
    async def acquire_embedding(self, task_id: str = ""):
        """
        获取 Embedding 资源（独占）
        
        使用方式：
            async with scheduler.acquire_embedding("embed_1"):
                vectors = await embeddings.aembed_documents(...)
        """
        await self._check_memory()
        
        async with self._model_lock:
            self._model_in_use = ResourceType.EMBEDDING
            self._stats["embedding_calls"] += 1
            task_key = task_id or f"embed_{time.time()}"
            self._running_tasks[task_key] = {
                "type": "embedding",
                "start": time.time(),
            }
            
            try:
                yield
            finally:
                self._model_in_use = None
                self._running_tasks.pop(task_key, None)
    
    @asynccontextmanager
    async def acquire_tool(self, task_id: str = "", tool_name: str = ""):
        """
        获取工具资源（并行，受限）
        
        使用方式：
            async with scheduler.acquire_tool("task_1", "python_run"):
                result = await python_run(code)
        """
        await self._check_memory()
        
        async with self._tool_semaphore:
            self._stats["tool_calls"] += 1
            task_key = task_id or f"tool_{time.time()}"
            self._running_tasks[task_key] = {
                "type": "tool",
                "name": tool_name,
                "start": time.time(),
            }
            
            try:
                yield
            finally:
                self._running_tasks.pop(task_key, None)
    
    @asynccontextmanager
    async def acquire_io(self, task_id: str = ""):
        """
        获取 IO 资源（高并发）
        
        使用方式：
            async with scheduler.acquire_io("io_1"):
                content = await read_file(path)
        """
        async with self._io_semaphore:
            self._stats["io_calls"] += 1
            task_key = task_id or f"io_{time.time()}"
            self._running_tasks[task_key] = {
                "type": "io",
                "start": time.time(),
            }
            
            try:
                yield
            finally:
                self._running_tasks.pop(task_key, None)
    
    # ============================================================
    # 并行执行 API
    # ============================================================
    
    async def run_tools_parallel(
        self,
        tasks: List[Dict[str, Any]],
        max_concurrent: Optional[int] = None,
    ) -> List[Any]:
        """
        并行执行多个工具
        
        Args:
            tasks: [{"func": callable, "args": [], "kwargs": {}, "name": "tool_name"}, ...]
            max_concurrent: 最大并发数（默认使用系统限制）
        
        Returns:
            结果列表（与输入顺序一致）
        """
        if not tasks:
            return []
        
        max_concurrent = max_concurrent or self.limits.max_concurrent_tools
        semaphore = asyncio.Semaphore(max_concurrent)
        
        async def run_one(idx: int, task: Dict) -> tuple:
            async with semaphore:
                async with self.acquire_tool(f"parallel_{idx}", task.get("name", "")):
                    func = task["func"]
                    args = task.get("args", [])
                    kwargs = task.get("kwargs", {})
                    
                    try:
                        if asyncio.iscoroutinefunction(func):
                            result = await func(*args, **kwargs)
                        else:
                            result = await asyncio.to_thread(func, *args, **kwargs)
                        return (idx, result, None)
                    except Exception as e:
                        return (idx, None, e)
        
        # 并行执行
        results = await asyncio.gather(*[
            run_one(i, task) for i, task in enumerate(tasks)
        ])
        
        # 按原始顺序整理结果
        ordered_results = [None] * len(tasks)
        for idx, result, error in results:
            if error:
                ordered_results[idx] = {"error": str(error)}
            else:
                ordered_results[idx] = result
        
        return ordered_results
    
    # ============================================================
    # 内存管理
    # ============================================================
    
    async def _check_memory(self):
        """检查内存使用情况"""
        if not _HAS_PSUTIL:
            return  # 无法检测内存，跳过
        
        memory = psutil.virtual_memory()
        
        if memory.percent >= self.limits.memory_critical_percent:
            # 临界：强制 GC
            logger.warning(f"⚠️ 内存临界 ({memory.percent}%)，强制 GC")
            self._force_gc()
            self._stats["gc_triggers"] += 1
            self._stats["memory_warnings"] += 1
            
            # 等待 GC 完成
            await asyncio.sleep(0.1)
            
        elif memory.percent >= self.limits.memory_threshold_percent:
            # 警告：建议 GC
            logger.info(f"ℹ️ 内存较高 ({memory.percent}%)，建议 GC")
            self._stats["memory_warnings"] += 1
    
    def _force_gc(self):
        """强制垃圾回收"""
        gc.collect()
    
    def release_model_memory(self):
        """
        显式释放模型内存
        
        在完成一批任务后调用，释放不再需要的模型内存
        """
        gc.collect()
        self._stats["gc_triggers"] += 1
        logger.info("✅ 模型内存已释放")
    
    # ============================================================
    # 状态查询
    # ============================================================
    
    def get_status(self) -> Dict[str, Any]:
        """获取调度器状态"""
        if _HAS_PSUTIL:
            memory = psutil.virtual_memory()
            memory_available_gb = round(memory.available / (1024 ** 3), 2)
            memory_percent = round(memory.percent, 1)
        else:
            memory_available_gb = self.resources.memory_available_gb
            memory_percent = self.resources.memory_percent
        
        return {
            "resources": {
                "cpu_count": self.resources.cpu_count,
                "memory_total_gb": round(self.resources.memory_total_gb, 2),
                "memory_available_gb": memory_available_gb,
                "memory_percent": memory_percent,
                "gpu_available": self.resources.gpu_available,
            },
            "limits": {
                "max_concurrent_tools": self.limits.max_concurrent_tools,
                "max_concurrent_io": self.limits.max_concurrent_io,
            },
            "current": {
                "model_in_use": self._model_in_use.value if self._model_in_use else None,
                "running_tasks": len(self._running_tasks),
                "task_details": dict(self._running_tasks),
            },
            "stats": dict(self._stats),
        }
    
    def is_model_available(self) -> bool:
        """检查模型资源是否可用"""
        return self._model_in_use is None
    
    def can_run_parallel_tools(self, count: int) -> bool:
        """检查是否可以并行运行指定数量的工具"""
        return count <= self.limits.max_concurrent_tools


# ============================================================
# 全局实例
# ============================================================

_scheduler: Optional[ResourceScheduler] = None


def get_scheduler() -> ResourceScheduler:
    """获取资源调度器单例"""
    global _scheduler
    if _scheduler is None:
        _scheduler = ResourceScheduler()
    return _scheduler


# ============================================================
# 便捷装饰器
# ============================================================

def with_llm_resource(func):
    """LLM 资源装饰器"""
    async def wrapper(*args, **kwargs):
        scheduler = get_scheduler()
        async with scheduler.acquire_llm():
            return await func(*args, **kwargs)
    return wrapper


def with_embedding_resource(func):
    """Embedding 资源装饰器"""
    async def wrapper(*args, **kwargs):
        scheduler = get_scheduler()
        async with scheduler.acquire_embedding():
            return await func(*args, **kwargs)
    return wrapper


def with_tool_resource(tool_name: str = ""):
    """工具资源装饰器"""
    def decorator(func):
        async def wrapper(*args, **kwargs):
            scheduler = get_scheduler()
            async with scheduler.acquire_tool(tool_name=tool_name):
                return await func(*args, **kwargs)
        return wrapper
    return decorator


__all__ = [
    "ResourceScheduler",
    "ResourceType",
    "SystemResources",
    "ResourceLimits",
    "get_scheduler",
    "with_llm_resource",
    "with_embedding_resource",
    "with_tool_resource",
]
