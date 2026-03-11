"""
基于 mtime 的文件读取缓存，供 agent_prompts、deep_agent 等复用。
线程安全，LRU 淘汰，持锁仅读/写缓存，磁盘 I/O 在锁外。
"""

import threading
import time
from pathlib import Path
from typing import Optional
from collections import OrderedDict


class MtimeFileCache:
    """按路径 + mtime 缓存文件内容，max_age 秒内复用。"""

    __slots__ = ("_cache", "_lock", "_max_entries")

    def __init__(self, max_entries: int = 256):
        self._cache: OrderedDict[str, tuple[float, str, float]] = OrderedDict()
        self._lock = threading.Lock()
        self._max_entries = max(1, max_entries)

    def get(self, path: Path, max_age: float = 30.0, encoding: str = "utf-8") -> Optional[str]:
        """读取文件内容，命中缓存且未过期则直接返回。"""
        key = str(path)
        with self._lock:
            cached = self._cache.get(key)
        try:
            if not path.exists():
                with self._lock:
                    self._cache.pop(key, None)
                return None
            mtime = path.stat().st_mtime
            now = time.time()
            if cached and cached[0] == mtime and (now - cached[2]) < max_age:
                with self._lock:
                    self._cache.move_to_end(key)
                return cached[1]
            content = path.read_text(encoding=encoding)
            with self._lock:
                self._cache.pop(key, None)
                self._cache[key] = (mtime, content, now)
                self._cache.move_to_end(key)
                while len(self._cache) > self._max_entries:
                    self._cache.popitem(last=False)
            return content
        except Exception:
            return None
