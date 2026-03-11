"""
执行日志记录器 - 记录 Agent 执行过程供 Debug 模式使用

设计原则：
1. Agent 模式执行时自动记录过程信息
2. Debug 模式可以读取这些日志进行分析
3. 日志存储在 SQLite 中，支持查询和持久化
"""

import json
import sqlite3
import threading
from pathlib import Path
from typing import Dict, Any, List, Optional
from dataclasses import dataclass, field, asdict
from datetime import datetime, timedelta
from contextlib import contextmanager
import logging

logger = logging.getLogger(__name__)

# 数据库路径
PROJECT_ROOT = Path(__file__).resolve().parents[3]
LOGS_DB_PATH = PROJECT_ROOT / "data" / "execution_logs.db"
LOGS_DB_PATH.parent.mkdir(parents=True, exist_ok=True)


@dataclass
class ExecutionStep:
    """执行步骤"""
    step_id: int
    action: str  # 工具名称或操作类型
    input_data: Dict[str, Any] = field(default_factory=dict)
    output_data: Dict[str, Any] = field(default_factory=dict)
    duration_ms: int = 0
    success: bool = True
    error: Optional[str] = None
    timestamp: str = field(default_factory=lambda: datetime.now().isoformat())
    
    # LLM 调用信息（如果有）
    llm_calls: List[Dict[str, Any]] = field(default_factory=list)


@dataclass
class ExecutionLog:
    """执行日志"""
    task_id: str
    thread_id: str
    mode: str
    user_input: str
    start_time: str = field(default_factory=lambda: datetime.now().isoformat())
    end_time: Optional[str] = None
    status: str = "running"  # running, completed, failed
    
    steps: List[ExecutionStep] = field(default_factory=list)
    final_result: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
    
    # 统计信息
    total_duration_ms: int = 0
    total_llm_calls: int = 0
    total_tool_calls: int = 0
    total_tokens: int = 0
    ttft_ms: int = 0
    queue_wait_ms: int = 0
    retry_count: int = 0
    estimated_cost_usd: float = 0.0
    request_id: Optional[str] = None
    run_id: Optional[str] = None
    task_key: Optional[str] = None
    model_id: Optional[str] = None
    session_id: Optional[str] = None


class ExecutionLogger:
    """
    执行日志记录器
    
    使用方式：
    ```python
    logger = ExecutionLogger()
    
    # 开始记录
    task_id = logger.start_task(thread_id, mode, user_input)
    
    # 记录步骤
    logger.log_step(task_id, "read_file", {"path": "..."}, {"content": "..."}, 150, True)
    
    # 记录 LLM 调用
    logger.log_llm_call(task_id, step_id, {"prompt_tokens": 1000, "completion_tokens": 500})
    
    # 完成任务
    logger.complete_task(task_id, final_result)
    
    # 查询日志（Debug 模式使用）
    logs = logger.get_task_logs(thread_id)
    ```
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
        
        self.db_path = LOGS_DB_PATH
        self._init_db()
        self._current_tasks: Dict[str, ExecutionLog] = {}
        self._initialized = True
    
    def _init_db(self):
        """初始化数据库"""
        with self._get_conn() as conn:
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS execution_logs (
                    task_id TEXT PRIMARY KEY,
                    thread_id TEXT NOT NULL,
                    mode TEXT NOT NULL,
                    user_input TEXT,
                    start_time TEXT,
                    end_time TEXT,
                    status TEXT DEFAULT 'running',
                    steps_json TEXT,
                    final_result_json TEXT,
                    error TEXT,
                    total_duration_ms INTEGER DEFAULT 0,
                    total_llm_calls INTEGER DEFAULT 0,
                    total_tool_calls INTEGER DEFAULT 0,
                    total_tokens INTEGER DEFAULT 0,
                    ttft_ms INTEGER DEFAULT 0,
                    queue_wait_ms INTEGER DEFAULT 0,
                    retry_count INTEGER DEFAULT 0,
                    estimated_cost_usd REAL DEFAULT 0,
                    request_id TEXT,
                    run_id TEXT,
                    task_key TEXT,
                    model_id TEXT,
                    session_id TEXT
                );
                
                CREATE INDEX IF NOT EXISTS idx_thread_id ON execution_logs(thread_id);
                CREATE INDEX IF NOT EXISTS idx_status ON execution_logs(status);
                CREATE INDEX IF NOT EXISTS idx_start_time ON execution_logs(start_time);
            """)
            # 兼容历史库：按需补列（幂等）
            cols = {str(r["name"]) for r in conn.execute("PRAGMA table_info(execution_logs)").fetchall()}
            if "ttft_ms" not in cols:
                conn.execute("ALTER TABLE execution_logs ADD COLUMN ttft_ms INTEGER DEFAULT 0")
            if "queue_wait_ms" not in cols:
                conn.execute("ALTER TABLE execution_logs ADD COLUMN queue_wait_ms INTEGER DEFAULT 0")
            if "retry_count" not in cols:
                conn.execute("ALTER TABLE execution_logs ADD COLUMN retry_count INTEGER DEFAULT 0")
            if "estimated_cost_usd" not in cols:
                conn.execute("ALTER TABLE execution_logs ADD COLUMN estimated_cost_usd REAL DEFAULT 0")
            if "request_id" not in cols:
                conn.execute("ALTER TABLE execution_logs ADD COLUMN request_id TEXT")
            if "run_id" not in cols:
                conn.execute("ALTER TABLE execution_logs ADD COLUMN run_id TEXT")
            if "task_key" not in cols:
                conn.execute("ALTER TABLE execution_logs ADD COLUMN task_key TEXT")
            if "model_id" not in cols:
                conn.execute("ALTER TABLE execution_logs ADD COLUMN model_id TEXT")
            if "session_id" not in cols:
                conn.execute("ALTER TABLE execution_logs ADD COLUMN session_id TEXT")
    
    @contextmanager
    def _get_conn(self):
        """获取数据库连接"""
        conn = sqlite3.connect(self.db_path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()
    
    def start_task(
        self,
        thread_id: str,
        mode: str,
        user_input: str,
        metrics: Optional[Dict[str, Any]] = None,
        correlation: Optional[Dict[str, Any]] = None,
        task_id: Optional[str] = None,
    ) -> str:
        """开始记录任务"""
        if not task_id:
            task_id = f"{thread_id}_{datetime.now().strftime('%Y%m%d_%H%M%S_%f')}"
        metrics = metrics or {}
        correlation = correlation or {}
        
        log = ExecutionLog(
            task_id=task_id,
            thread_id=thread_id,
            mode=mode,
            user_input=user_input,
            ttft_ms=max(0, int(metrics.get("ttft_ms", 0) or 0)),
            queue_wait_ms=max(0, int(metrics.get("queue_wait_ms", 0) or 0)),
            retry_count=max(0, int(metrics.get("retry_count", 0) or 0)),
            estimated_cost_usd=max(0.0, float(metrics.get("estimated_cost_usd", 0.0) or 0.0)),
            request_id=(str(correlation.get("request_id", "")) or None),
            run_id=(str(correlation.get("run_id", "")) or None),
            task_key=(str(correlation.get("task_key", "")) or None),
            model_id=(str(correlation.get("model_id", "")) or None),
            session_id=(str(correlation.get("session_id", "")) or None),
        )
        
        self._current_tasks[task_id] = log
        
        # 写入数据库
        with self._get_conn() as conn:
            conn.execute("""
                INSERT INTO execution_logs 
                (task_id, thread_id, mode, user_input, start_time, status, ttft_ms, queue_wait_ms, retry_count, estimated_cost_usd, request_id, run_id, task_key, model_id, session_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                task_id, thread_id, mode, user_input, log.start_time, "running",
                log.ttft_ms, log.queue_wait_ms, log.retry_count, log.estimated_cost_usd,
                log.request_id, log.run_id, log.task_key, log.model_id, log.session_id,
            ))
        
        logger.info(f"📝 开始记录任务: {task_id}")
        return task_id
    
    def log_step(
        self,
        task_id: str,
        action: str,
        input_data: Dict[str, Any],
        output_data: Dict[str, Any],
        duration_ms: int,
        success: bool,
        error: Optional[str] = None,
    ) -> int:
        """记录执行步骤"""
        log = self._current_tasks.get(task_id)
        if not log:
            logger.warning(f"任务不存在: {task_id}")
            return -1
        
        step_id = len(log.steps) + 1
        step = ExecutionStep(
            step_id=step_id,
            action=action,
            input_data=self._truncate_data(input_data),
            output_data=self._truncate_data(output_data),
            duration_ms=duration_ms,
            success=success,
            error=error,
        )
        
        log.steps.append(step)
        log.total_tool_calls += 1
        log.total_duration_ms += duration_ms
        
        return step_id
    
    def log_llm_call(
        self,
        task_id: str,
        step_id: int,
        llm_info: Dict[str, Any],
    ):
        """记录 LLM 调用"""
        log = self._current_tasks.get(task_id)
        if not log:
            return
        
        # 找到对应的步骤
        for step in log.steps:
            if step.step_id == step_id:
                step.llm_calls.append(llm_info)
                log.total_llm_calls += 1
                log.total_tokens += llm_info.get("prompt_tokens", 0)
                log.total_tokens += llm_info.get("completion_tokens", 0)
                break
    
    def complete_task(
        self,
        task_id: str,
        final_result: Optional[Dict[str, Any]] = None,
        error: Optional[str] = None,
        metrics: Optional[Dict[str, Any]] = None,
    ):
        """完成任务"""
        log = self._current_tasks.get(task_id)
        if not log:
            return
        metrics = metrics or {}
        
        log.end_time = datetime.now().isoformat()
        log.status = "failed" if error else "completed"
        log.final_result = final_result
        log.error = error
        if metrics:
            if metrics.get("ttft_ms") is not None:
                log.ttft_ms = max(0, int(metrics.get("ttft_ms") or 0))
            if metrics.get("queue_wait_ms") is not None:
                log.queue_wait_ms = max(0, int(metrics.get("queue_wait_ms") or 0))
            if metrics.get("retry_count") is not None:
                log.retry_count = max(0, int(metrics.get("retry_count") or 0))
            if metrics.get("estimated_cost_usd") is not None:
                log.estimated_cost_usd = max(0.0, float(metrics.get("estimated_cost_usd") or 0.0))
        
        # 更新数据库
        with self._get_conn() as conn:
            conn.execute("""
                UPDATE execution_logs SET
                    end_time = ?,
                    status = ?,
                    steps_json = ?,
                    final_result_json = ?,
                    error = ?,
                    total_duration_ms = ?,
                    total_llm_calls = ?,
                    total_tool_calls = ?,
                    total_tokens = ?,
                    ttft_ms = ?,
                    queue_wait_ms = ?,
                    retry_count = ?,
                    estimated_cost_usd = ?
                WHERE task_id = ?
            """, (
                log.end_time,
                log.status,
                json.dumps([asdict(s) for s in log.steps], ensure_ascii=False),
                json.dumps(final_result, ensure_ascii=False) if final_result else None,
                error,
                log.total_duration_ms,
                log.total_llm_calls,
                log.total_tool_calls,
                log.total_tokens,
                log.ttft_ms,
                log.queue_wait_ms,
                log.retry_count,
                log.estimated_cost_usd,
                task_id,
            ))
        
        # 清理内存
        del self._current_tasks[task_id]
        logger.info(f"✅ 任务完成: {task_id} ({log.status})")
    
    def get_task_logs(
        self,
        thread_id: str,
        limit: int = 10,
        status: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """获取任务日志（Debug 模式使用）"""
        with self._get_conn() as conn:
            query = "SELECT * FROM execution_logs WHERE thread_id = ?"
            params = [thread_id]
            
            if status:
                query += " AND status = ?"
                params.append(status)
            
            query += " ORDER BY start_time DESC LIMIT ?"
            params.append(limit)
            
            rows = conn.execute(query, params).fetchall()
            
            logs = []
            for row in rows:
                log = dict(row)
                if log.get("steps_json"):
                    log["steps"] = json.loads(log["steps_json"])
                    del log["steps_json"]
                if log.get("final_result_json"):
                    log["final_result"] = json.loads(log["final_result_json"])
                    del log["final_result_json"]
                logs.append(log)
            
            return logs
    
    def get_latest_task(self, thread_id: str) -> Optional[Dict[str, Any]]:
        """获取最新的任务日志"""
        logs = self.get_task_logs(thread_id, limit=1)
        return logs[0] if logs else None

    def cleanup_old_logs(self, days: int = 30) -> int:
        """清理过期执行日志，返回删除条数。"""
        safe_days = max(1, int(days))
        cutoff = (datetime.now() - timedelta(days=safe_days)).isoformat()
        with self._get_conn() as conn:
            cur = conn.execute(
                "DELETE FROM execution_logs WHERE start_time IS NOT NULL AND start_time < ?",
                (cutoff,),
            )
            deleted = int(cur.rowcount or 0)
        if deleted > 0:
            logger.info("🧹 执行日志清理完成: deleted=%s cutoff=%s", deleted, cutoff)
        return deleted

    @staticmethod
    def _percentile(values: List[float], p: float) -> float:
        if not values:
            return 0.0
        data = sorted(values)
        if len(data) == 1:
            return float(data[0])
        idx = (len(data) - 1) * max(0.0, min(100.0, p)) / 100.0
        lo = int(idx)
        hi = min(lo + 1, len(data) - 1)
        frac = idx - lo
        return float(data[lo] * (1.0 - frac) + data[hi] * frac)

    def get_sli_summary(self, window_hours: int = 24) -> Dict[str, Any]:
        """聚合调度/执行核心 SLI 指标。"""
        cutoff = (datetime.now() - timedelta(hours=max(1, int(window_hours)))).isoformat()
        with self._get_conn() as conn:
            rows = conn.execute(
                """
                SELECT status, ttft_ms, queue_wait_ms, retry_count, estimated_cost_usd, model_id
                FROM execution_logs
                WHERE start_time IS NOT NULL AND start_time >= ?
                """,
                (cutoff,),
            ).fetchall()
        if not rows:
            return {
                "window_hours": max(1, int(window_hours)),
                "total_runs": 0,
                "ttft_p50_ms": 0,
                "ttft_p95_ms": 0,
                "queue_wait_p50_ms": 0,
                "queue_wait_p95_ms": 0,
                "retry_rate": 0.0,
                "fallback_rate": 0.0,
                "cost_per_task_usd": 0.0,
            }
        ttft = [max(0.0, float(r["ttft_ms"] or 0)) for r in rows]
        queue_wait = [max(0.0, float(r["queue_wait_ms"] or 0)) for r in rows]
        retries = [max(0, int(r["retry_count"] or 0)) for r in rows]
        costs = [max(0.0, float(r["estimated_cost_usd"] or 0.0)) for r in rows]
        fallback_hits = sum(1 for r in rows if str(r["model_id"] or "").strip().startswith("fallback:"))
        retry_hits = sum(1 for x in retries if x > 0)
        total = len(rows)
        return {
            "window_hours": max(1, int(window_hours)),
            "total_runs": total,
            "ttft_p50_ms": round(self._percentile(ttft, 50), 2),
            "ttft_p95_ms": round(self._percentile(ttft, 95), 2),
            "queue_wait_p50_ms": round(self._percentile(queue_wait, 50), 2),
            "queue_wait_p95_ms": round(self._percentile(queue_wait, 95), 2),
            "retry_rate": round(retry_hits / max(1, total), 4),
            "fallback_rate": round(fallback_hits / max(1, total), 4),
            "cost_per_task_usd": round(sum(costs) / max(1, total), 6),
        }
    
    def _truncate_data(self, data: Dict[str, Any], max_len: int = 1000) -> Dict[str, Any]:
        """截断过长的数据"""
        result = {}
        for key, value in data.items():
            if isinstance(value, str) and len(value) > max_len:
                result[key] = value[:max_len] + f"... (truncated, total {len(value)} chars)"
            elif isinstance(value, (list, dict)):
                json_str = json.dumps(value, ensure_ascii=False)
                if len(json_str) > max_len:
                    result[key] = f"[{type(value).__name__}, {len(json_str)} chars]"
                else:
                    result[key] = value
            else:
                result[key] = value
        return result


# 全局实例
_logger: Optional[ExecutionLogger] = None


def get_execution_logger() -> ExecutionLogger:
    """获取执行日志记录器"""
    global _logger
    if _logger is None:
        _logger = ExecutionLogger()
    return _logger


# ============================================================
# 导出
# ============================================================

__all__ = [
    "ExecutionLogger",
    "ExecutionLog",
    "ExecutionStep",
    "get_execution_logger",
]
