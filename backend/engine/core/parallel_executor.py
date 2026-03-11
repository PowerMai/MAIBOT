"""
并行工具执行器 - 智能调度多个工具并行执行

设计原则（Claude/Cursor 风格）：
1. 依赖感知：根据工具间依赖关系自动排序
2. 资源调度：使用 ResourceScheduler 管理并发
3. 流式反馈：工具完成即返回，不等待全部
4. 错误隔离：单个工具失败不影响其他工具
5. 超时控制：每个工具独立超时
"""

import asyncio
import time
import logging
from typing import List, Dict, Any, Optional, Callable, Awaitable
from dataclasses import dataclass, field
from enum import Enum

from .resource_scheduler import get_scheduler, ResourceType

logger = logging.getLogger(__name__)


class ToolStatus(Enum):
    """工具执行状态"""
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    TIMEOUT = "timeout"
    SKIPPED = "skipped"


@dataclass
class ToolTask:
    """工具任务定义"""
    id: str                                    # 任务 ID
    name: str                                  # 工具名称
    func: Callable[..., Awaitable[Any]]       # 异步执行函数
    args: tuple = field(default_factory=tuple) # 位置参数
    kwargs: dict = field(default_factory=dict) # 关键字参数
    dependencies: List[str] = field(default_factory=list)  # 依赖的任务 ID
    timeout: float = 60.0                      # 超时时间（秒）
    priority: int = 0                          # 优先级（越大越优先）
    
    # 执行状态
    status: ToolStatus = ToolStatus.PENDING
    result: Any = None
    error: Optional[str] = None
    start_time: Optional[float] = None
    end_time: Optional[float] = None
    
    @property
    def duration(self) -> Optional[float]:
        """执行耗时"""
        if self.start_time and self.end_time:
            return self.end_time - self.start_time
        return None


@dataclass
class ExecutionResult:
    """执行结果"""
    total_tasks: int
    completed: int
    failed: int
    skipped: int
    total_duration: float
    tasks: List[ToolTask]
    
    @property
    def success_rate(self) -> float:
        """成功率"""
        if self.total_tasks == 0:
            return 1.0
        return self.completed / self.total_tasks


class ParallelExecutor:
    """
    并行工具执行器
    
    核心功能：
    1. 拓扑排序：根据依赖关系确定执行顺序
    2. 批次执行：将无依赖的任务分组并行执行
    3. 结果传递：支持任务间结果传递
    4. 流式回调：支持任务完成时的回调
    """
    
    def __init__(
        self,
        max_parallel: Optional[int] = None,
        default_timeout: float = 60.0,
        on_task_complete: Optional[Callable[[ToolTask], None]] = None,
    ):
        """
        初始化执行器
        
        Args:
            max_parallel: 最大并行数（None 表示使用 ResourceScheduler 配置）
            default_timeout: 默认超时时间
            on_task_complete: 任务完成回调
        """
        self.scheduler = get_scheduler()
        self.max_parallel = max_parallel or self.scheduler.limits.max_concurrent_tools
        self.default_timeout = default_timeout
        self.on_task_complete = on_task_complete
        
        # 任务结果缓存（用于依赖传递）
        self._results_cache: Dict[str, Any] = {}
    
    async def execute(
        self,
        tasks: List[ToolTask],
        stop_on_error: bool = False,
    ) -> ExecutionResult:
        """
        执行多个工具任务
        
        Args:
            tasks: 任务列表
            stop_on_error: 遇到错误是否停止
        
        Returns:
            ExecutionResult: 执行结果
        """
        if not tasks:
            return ExecutionResult(
                total_tasks=0,
                completed=0,
                failed=0,
                skipped=0,
                total_duration=0.0,
                tasks=[],
            )
        
        start_time = time.time()
        self._results_cache.clear()
        
        # 拓扑排序，获取执行批次
        batches = self._topological_sort(tasks)
        
        logger.info(f"🚀 开始并行执行 {len(tasks)} 个任务，分为 {len(batches)} 批")
        
        # 按批次执行
        for batch_idx, batch in enumerate(batches):
            logger.debug(f"📦 执行第 {batch_idx + 1}/{len(batches)} 批: {[t.name for t in batch]}")
            
            # 检查是否应该停止
            if stop_on_error and any(t.status == ToolStatus.FAILED for t in tasks):
                # 标记剩余任务为跳过
                for t in batch:
                    if t.status == ToolStatus.PENDING:
                        t.status = ToolStatus.SKIPPED
                continue
            
            # 并行执行当前批次
            await self._execute_batch(batch)
        
        # 统计结果
        completed = sum(1 for t in tasks if t.status == ToolStatus.COMPLETED)
        failed = sum(1 for t in tasks if t.status == ToolStatus.FAILED)
        skipped = sum(1 for t in tasks if t.status == ToolStatus.SKIPPED)
        timeout_count = sum(1 for t in tasks if t.status == ToolStatus.TIMEOUT)
        
        total_duration = time.time() - start_time
        
        logger.info(
            f"✅ 并行执行完成: {completed}/{len(tasks)} 成功, "
            f"{failed} 失败, {timeout_count} 超时, {skipped} 跳过, "
            f"总耗时 {total_duration:.2f}s"
        )
        
        return ExecutionResult(
            total_tasks=len(tasks),
            completed=completed,
            failed=failed + timeout_count,
            skipped=skipped,
            total_duration=total_duration,
            tasks=tasks,
        )
    
    async def _execute_batch(self, batch: List[ToolTask]):
        """执行一批任务"""
        semaphore = asyncio.Semaphore(self.max_parallel)
        
        async def run_with_semaphore(task: ToolTask):
            async with semaphore:
                await self._execute_single(task)
        
        await asyncio.gather(*[run_with_semaphore(t) for t in batch])
    
    async def _execute_single(self, task: ToolTask):
        """执行单个任务"""
        task.status = ToolStatus.RUNNING
        task.start_time = time.time()
        
        try:
            # 使用 ResourceScheduler 获取工具资源
            async with self.scheduler.acquire_tool(task.id, task.name):
                # 替换参数中的依赖引用
                kwargs = self._resolve_dependencies(task.kwargs)
                
                # 执行任务（带超时）
                timeout = task.timeout or self.default_timeout
                result = await asyncio.wait_for(
                    task.func(*task.args, **kwargs),
                    timeout=timeout,
                )
                
                task.result = result
                task.status = ToolStatus.COMPLETED
                
                # 缓存结果（用于依赖传递）
                self._results_cache[task.id] = result
                
                logger.debug(f"✅ 任务完成: {task.name} ({task.duration:.2f}s)")
                
        except asyncio.TimeoutError:
            task.status = ToolStatus.TIMEOUT
            task.error = f"任务超时 ({task.timeout}s)"
            logger.warning(f"⏱️ 任务超时: {task.name}")
            
        except Exception as e:
            task.status = ToolStatus.FAILED
            task.error = str(e)
            logger.error(f"❌ 任务失败: {task.name} - {e}")
            
        finally:
            task.end_time = time.time()
            
            # 调用完成回调
            if self.on_task_complete:
                try:
                    self.on_task_complete(task)
                except Exception as e:
                    logger.warning(f"⚠️ 任务完成回调失败: {e}")
    
    def _topological_sort(self, tasks: List[ToolTask]) -> List[List[ToolTask]]:
        """
        拓扑排序，将任务分成可并行执行的批次
        
        Returns:
            List[List[ToolTask]]: 批次列表，每个批次内的任务可并行执行
        """
        # 构建任务映射
        task_map = {t.id: t for t in tasks}
        
        # 计算每个任务的入度（依赖数量）
        in_degree = {t.id: 0 for t in tasks}
        for task in tasks:
            for dep_id in task.dependencies:
                if dep_id in task_map:
                    in_degree[task.id] += 1
        
        # 按批次排序
        batches = []
        remaining = set(t.id for t in tasks)
        
        while remaining:
            # 找出当前可执行的任务（入度为 0）
            ready = [
                task_map[tid]
                for tid in remaining
                if in_degree[tid] == 0
            ]
            
            if not ready:
                # 存在循环依赖
                logger.warning(f"⚠️ 检测到循环依赖，强制执行剩余任务")
                ready = [task_map[tid] for tid in remaining]
            
            # 按优先级排序
            ready.sort(key=lambda t: -t.priority)
            
            batches.append(ready)
            
            # 更新入度
            for task in ready:
                remaining.remove(task.id)
                for other_id in remaining:
                    other = task_map[other_id]
                    if task.id in other.dependencies:
                        in_degree[other_id] -= 1
        
        return batches
    
    def _resolve_dependencies(self, kwargs: dict) -> dict:
        """
        解析参数中的依赖引用
        
        支持格式：
        - {"input": "$task_id"} -> 引用任务结果
        - {"input": "$task_id.field"} -> 引用任务结果的字段
        """
        resolved = {}
        
        for key, value in kwargs.items():
            if isinstance(value, str) and value.startswith("$"):
                # 解析依赖引用
                ref = value[1:]  # 去掉 $
                parts = ref.split(".", 1)
                task_id = parts[0]
                
                if task_id in self._results_cache:
                    result = self._results_cache[task_id]
                    
                    # 如果有字段引用
                    if len(parts) > 1 and isinstance(result, dict):
                        resolved[key] = result.get(parts[1])
                    else:
                        resolved[key] = result
                else:
                    # 依赖任务未完成
                    resolved[key] = None
            else:
                resolved[key] = value
        
        return resolved


# ============================================================
# 便捷函数
# ============================================================

async def run_tools_parallel(
    tools: List[Dict[str, Any]],
    max_parallel: Optional[int] = None,
    on_complete: Optional[Callable[[ToolTask], None]] = None,
) -> ExecutionResult:
    """
    便捷函数：并行执行多个工具
    
    Args:
        tools: 工具列表，每个工具是一个字典：
            {
                "id": "task_1",           # 可选，默认自动生成
                "name": "read_file",      # 工具名称
                "func": async_func,       # 异步函数
                "args": [],               # 位置参数
                "kwargs": {},             # 关键字参数
                "dependencies": [],       # 依赖的任务 ID
                "timeout": 60,            # 超时时间
                "priority": 0,            # 优先级
            }
        max_parallel: 最大并行数
        on_complete: 任务完成回调
    
    Returns:
        ExecutionResult: 执行结果
    """
    # 转换为 ToolTask
    tasks = []
    for i, tool in enumerate(tools):
        task = ToolTask(
            id=tool.get("id", f"task_{i}"),
            name=tool.get("name", f"tool_{i}"),
            func=tool["func"],
            args=tool.get("args", ()),
            kwargs=tool.get("kwargs", {}),
            dependencies=tool.get("dependencies", []),
            timeout=tool.get("timeout", 60.0),
            priority=tool.get("priority", 0),
        )
        tasks.append(task)
    
    # 执行
    executor = ParallelExecutor(
        max_parallel=max_parallel,
        on_task_complete=on_complete,
    )
    
    return await executor.execute(tasks)


# ============================================================
# 导出
# ============================================================

__all__ = [
    "ToolStatus",
    "ToolTask",
    "ExecutionResult",
    "ParallelExecutor",
    "run_tools_parallel",
]
