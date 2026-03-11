"""
存储管理器 - 精简版（Claude 分层架构）

参考 Claude 的内存管理模式，采用分层而非平铺的设计：
- 本模块只负责：向量索引的持久化存储和元数据管理
- 不重复实现：文件读写（使用 DeepAgent FilesystemMiddleware）
- 不重复实现：资源发现（使用 embedding_tools.ResourceManager）

核心职责（单一职责原则）：
1. SQLite 元数据存储 - 跟踪文档索引状态
2. FAISS 向量索引管理 - 懒加载、增量更新
3. 查询缓存 - 避免重复向量检索

与现有组件的关系：
- ResourceManager (embedding_tools.py) - 资源发现和配置
- FilesystemMiddleware (DeepAgent) - 文件读写
- 本模块 - 向量索引持久化

这样避免了重复实现，符合 DRY 原则。
"""

import os
import sqlite3
import hashlib
import gc
import logging
import threading
from pathlib import Path
from typing import Optional, List, Dict, Any
from dataclasses import dataclass
from datetime import datetime

# ============================================================
# 配置（使用统一路径模块）
# ============================================================
from .paths import DATA_PATH, VECTOR_STORE_PATH as _VECTOR_STORE_PATH

logger = logging.getLogger(__name__)

DATA_DIR = DATA_PATH
SQLITE_DB_PATH = DATA_DIR / "index_metadata.db"
VECTOR_STORE_PATH = _VECTOR_STORE_PATH

# 从环境变量读取配置（与 embedding_tools 对齐）
ALLOWED_EXTENSIONS = set(os.getenv("ALLOWED_EXTENSIONS", ".md,.txt,.pdf,.docx,.xlsx").split(","))
EXCLUDED_PATTERNS = set(os.getenv("EXCLUDED_PATTERNS", "基础资料,archives,images,node_modules,.git,02_operations,02_writing_guide").split(","))
MAX_FILE_SIZE_KB = int(os.getenv("MAX_FILE_SIZE_KB", "5000"))
# add_documents 按此分批写入，控制单次 FAISS 加载/写入量
INDEX_BATCH_SIZE = int(os.getenv("INDEX_BATCH_SIZE", "50"))


# ============================================================
# 数据类
# ============================================================
@dataclass
class IndexedDocument:
    """已索引文档的元数据"""
    doc_id: str
    path: str
    content_hash: str
    chunk_count: int
    indexed_at: str
    file_size: int


# ============================================================
# 元数据存储（SQLite）- 单例
# ============================================================
class IndexMetadataStore:
    """
    索引元数据存储
    
    只负责跟踪哪些文档已被索引，支持增量更新。
    不负责文件读写（由 DeepAgent 处理）。
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
        
        self.db_path = SQLITE_DB_PATH
        self._init_db()
        self._initialized = True
    
    def _init_db(self):
        """初始化数据库"""
        with sqlite3.connect(self.db_path) as conn:
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS indexed_documents (
                    doc_id TEXT PRIMARY KEY,
                    path TEXT UNIQUE NOT NULL,
                    content_hash TEXT NOT NULL,
                    chunk_count INTEGER DEFAULT 0,
                    indexed_at TEXT,
                    file_size INTEGER DEFAULT 0
                );
                
                CREATE TABLE IF NOT EXISTS query_cache (
                    query_hash TEXT PRIMARY KEY,
                    result_ids TEXT,
                    result_data BLOB,
                    created_at TEXT,
                    hit_count INTEGER DEFAULT 1
                );
                
                CREATE INDEX IF NOT EXISTS idx_path ON indexed_documents(path);
                CREATE INDEX IF NOT EXISTS idx_hash ON indexed_documents(content_hash);
            """)
    
    def get_indexed_doc(self, path: str) -> Optional[IndexedDocument]:
        """获取已索引文档信息"""
        with sqlite3.connect(self.db_path) as conn:
            row = conn.execute(
                "SELECT doc_id, path, content_hash, chunk_count, indexed_at, file_size "
                "FROM indexed_documents WHERE path = ?", (path,)
            ).fetchone()
            if row:
                return IndexedDocument(*row)
        return None
    
    def upsert_indexed_doc(self, doc: IndexedDocument):
        """更新或插入索引记录"""
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("""
                INSERT OR REPLACE INTO indexed_documents 
                (doc_id, path, content_hash, chunk_count, indexed_at, file_size)
                VALUES (?, ?, ?, ?, ?, ?)
            """, (doc.doc_id, doc.path, doc.content_hash, doc.chunk_count, doc.indexed_at, doc.file_size))
    
    def get_all_indexed_paths(self) -> List[str]:
        """获取所有已索引的路径"""
        with sqlite3.connect(self.db_path) as conn:
            rows = conn.execute("SELECT path FROM indexed_documents").fetchall()
            return [row[0] for row in rows]

    def get_indexed_doc_count(self) -> int:
        """已索引文档数，用作缓存键中的 index_version，索引变更后缓存自然失效。"""
        with sqlite3.connect(self.db_path) as conn:
            row = conn.execute("SELECT COUNT(*) FROM indexed_documents").fetchone()
            return row[0] if row else 0

    def delete_indexed_doc(self, path: str):
        """删除索引记录"""
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("DELETE FROM indexed_documents WHERE path = ?", (path,))
    
    def clear_indexed_docs(self):
        """清空已索引记录（强制重建时调用，与 FAISS 索引保持一致）"""
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("DELETE FROM indexed_documents")
    
    def needs_reindex(self, path: str, current_hash: str) -> bool:
        """检查文件是否需要重新索引"""
        doc = self.get_indexed_doc(path)
        if doc is None:
            return True
        return doc.content_hash != current_hash
    
    def cache_query(
        self,
        query: str,
        result_ids: List[str],
        result_data: List[Dict] = None,
        cache_key_suffix: str = "",
    ):
        """
        缓存查询结果
        
        Args:
            query: 查询字符串
            result_ids: 结果文档 ID 列表
            result_data: 完整结果数据（可选，压缩存储）
        """
        import json
        import gzip
        key_material = query if not cache_key_suffix else f"{query}\n##{cache_key_suffix}"
        query_hash = hashlib.md5(key_material.encode()).hexdigest()
        
        # 压缩完整结果数据
        compressed_data = None
        if result_data:
            try:
                compressed_data = gzip.compress(json.dumps(result_data, ensure_ascii=False).encode('utf-8'))
            except Exception as e:
                logger.warning("压缩查询结果失败: %s", e)
        
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("""
                INSERT OR REPLACE INTO query_cache (query_hash, result_ids, result_data, created_at, hit_count)
                VALUES (?, ?, ?, ?, COALESCE(
                    (SELECT hit_count + 1 FROM query_cache WHERE query_hash = ?), 1
                ))
            """, (query_hash, json.dumps(result_ids), compressed_data, datetime.now().isoformat(), query_hash))
    
    def get_cached_query(
        self,
        query: str,
        return_full_data: bool = False,
        cache_key_suffix: str = "",
    ) -> Optional[Any]:
        """
        获取缓存的查询结果
        
        Args:
            query: 查询字符串
            return_full_data: 是否返回完整结果数据
        
        Returns:
            如果 return_full_data=False，返回 List[str]（ID 列表）
            如果 return_full_data=True，返回 List[Dict]（完整结果）或 None
        """
        import json
        import gzip
        key_material = query if not cache_key_suffix else f"{query}\n##{cache_key_suffix}"
        query_hash = hashlib.md5(key_material.encode()).hexdigest()
        with sqlite3.connect(self.db_path) as conn:
            if return_full_data:
                row = conn.execute(
                    "SELECT result_data FROM query_cache WHERE query_hash = ?", (query_hash,)
                ).fetchone()
                if row and row[0]:
                    conn.execute(
                        "UPDATE query_cache SET hit_count = hit_count + 1 WHERE query_hash = ?",
                        (query_hash,)
                    )
                    try:
                        return json.loads(gzip.decompress(row[0]).decode('utf-8'))
                    except Exception as e:
                        logger.warning("解压查询结果失败: %s", e)
                        return None
            else:
                row = conn.execute(
                    "SELECT result_ids FROM query_cache WHERE query_hash = ?", (query_hash,)
                ).fetchone()
                if row:
                    conn.execute(
                        "UPDATE query_cache SET hit_count = hit_count + 1 WHERE query_hash = ?",
                        (query_hash,)
                    )
                    return json.loads(row[0])
        return None
    
    def clear_query_cache(self) -> None:
        """清空查询缓存（索引重建后调用，避免命中旧结果）。"""
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("DELETE FROM query_cache")
            conn.commit()

    def cleanup_cache(self, max_entries: int = 100):
        """清理旧缓存"""
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("""
                DELETE FROM query_cache WHERE query_hash NOT IN (
                    SELECT query_hash FROM query_cache 
                    ORDER BY hit_count DESC, created_at DESC 
                    LIMIT ?
                )
            """, (max_entries,))
    
    def get_stats(self) -> Dict:
        """获取统计信息"""
        with sqlite3.connect(self.db_path) as conn:
            doc_count = conn.execute("SELECT COUNT(*) FROM indexed_documents").fetchone()[0]
            cache_count = conn.execute("SELECT COUNT(*) FROM query_cache").fetchone()[0]
            total_chunks = conn.execute("SELECT SUM(chunk_count) FROM indexed_documents").fetchone()[0] or 0
            
            return {
                "indexed_documents": doc_count,
                "total_chunks": total_chunks,
                "cached_queries": cache_count,
                "db_size_kb": round(self.db_path.stat().st_size / 1024, 2) if self.db_path.exists() else 0,
            }


# ============================================================
# 向量索引管理器 - 单例
# ============================================================
class VectorIndexManager:
    """
    向量索引管理器
    
    只负责 FAISS 索引的加载、保存和查询。
    文档内容的获取由调用者负责（通过 ResourceManager）。
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
        
        self.store_path = VECTOR_STORE_PATH
        self.metadata_store = IndexMetadataStore()
        self._initialized = True
    
    def index_exists(self) -> bool:
        """检查索引是否存在"""
        return (self.store_path / "index.faiss").exists()
    
    def add_documents(self, documents: List, embeddings, create_new: bool = False) -> int:
        """
        添加文档到索引（Claude 风格：增量优先，已向量化不重做）。
        
        - create_new=True 或索引不存在：全量建索引，并写入 metadata。
        - create_new=False 且索引存在：仅对 needs_reindex(path, file_hash) 的文档做向量化并合并，并更新 metadata。
        
        Args:
            documents: LangChain Document 列表（metadata 需含 source、file_hash）
            embeddings: Embedding 模型
            create_new: 是否强制新建（删除旧索引）
            
        Returns:
            本次添加的文档块数
        """
        try:
            from langchain_community.vectorstores import FAISS
        except ImportError:
            logger.warning("FAISS 未安装，跳过向量索引。安装 pip install .[local-embedding] 启用。")
            return 0

        from datetime import datetime

        if not documents:
            return 0

        # 按 path 分组，便于增量判断与 metadata 写入
        path_to_docs = {}
        for doc in documents:
            path = doc.metadata.get("source", "")
            if path not in path_to_docs:
                path_to_docs[path] = []
            path_to_docs[path].append(doc)

        to_add = []
        if create_new or not self.index_exists():
            to_add = documents
        else:
            for path, docs in path_to_docs.items():
                file_hash = docs[0].metadata.get("file_hash", "")
                if self.metadata_store.needs_reindex(path, file_hash):
                    to_add.extend(docs)
            if not to_add:
                return 0

        try:
            paths_added = set(doc.metadata.get("source") for doc in to_add)
            now = datetime.now().isoformat()
            is_new_index = create_new or not self.index_exists()

            for i in range(0, len(to_add), INDEX_BATCH_SIZE):
                batch = to_add[i : i + INDEX_BATCH_SIZE]
                if i == 0 and is_new_index:
                    vectorstore = FAISS.from_documents(batch, embeddings)
                else:
                    vectorstore = FAISS.load_local(
                        str(self.store_path),
                        embeddings,
                        allow_dangerous_deserialization=True
                    )
                    vectorstore.add_documents(batch)
                vectorstore.save_local(str(self.store_path))
                del vectorstore
                gc.collect()

            # 写入 metadata：仅对本次加入索引的 path 做 upsert
            for path in paths_added:
                docs = path_to_docs.get(path, [])
                if not docs:
                    continue
                file_hash = docs[0].metadata.get("file_hash", "")
                try:
                    file_size = Path(path).stat().st_size if path and Path(path).exists() else 0
                except Exception:
                    file_size = 0
                self.metadata_store.upsert_indexed_doc(IndexedDocument(
                    doc_id=path,
                    path=path,
                    content_hash=file_hash,
                    chunk_count=len(docs),
                    indexed_at=now,
                    file_size=file_size,
                ))

            return len(to_add)

        except Exception as e:
            logger.warning("添加文档到索引失败: %s", e)
            return 0
    
    def search(
        self,
        query: str,
        embeddings,
        top_k: int = 10,
        scope: str = "",
    ) -> List[Dict]:
        """
        搜索向量索引。
        缓存键含 scope、top_k、index_version，避免不同 scope/版本串结果。
        """
        if not self.index_exists():
            return []

        index_version = self.metadata_store.get_indexed_doc_count()
        cache_key_suffix = (
            f"top_k={int(top_k)}|scope={scope or 'default'}|"
            f"index_version={index_version}|index={self.store_path.as_posix()}"
        )
        cached = self.metadata_store.get_cached_query(
            query,
            return_full_data=True,
            cache_key_suffix=cache_key_suffix,
        )
        if cached is not None and isinstance(cached, list):
            return cached

        try:
            from langchain_community.vectorstores import FAISS
        except ImportError:
            return []

        try:
            vectorstore = FAISS.load_local(
                str(self.store_path),
                embeddings,
                allow_dangerous_deserialization=True
            )
            results = vectorstore.similarity_search_with_score(query, k=top_k)

            output = []
            doc_ids = []
            for doc, score in results:
                doc_id = doc.metadata.get("doc_id", hashlib.md5(doc.page_content[:100].encode()).hexdigest())
                doc_ids.append(doc_id)
                meta = doc.metadata
                output.append({
                    "content": doc.page_content,
                    "source": meta.get("source", ""),
                    "score": float(score),
                    "metadata": {k: (v if isinstance(v, (str, int, float, bool, type(None))) else str(v)) for k, v in meta.items()},
                })

            if output:
                self.metadata_store.cache_query(
                    query,
                    doc_ids,
                    result_data=output,
                    cache_key_suffix=cache_key_suffix,
                )

            del vectorstore
            gc.collect()
            return output

        except Exception as e:
            logger.warning("搜索失败: %s", e)
            return []
    
    def delete_index(self):
        """删除索引（Claude 风格：与 metadata 同步，避免残留）"""
        import shutil
        self.metadata_store.clear_indexed_docs()
        if self.store_path.exists():
            shutil.rmtree(self.store_path)
            self.store_path.mkdir(parents=True, exist_ok=True)
    
    def get_stats(self) -> Dict:
        """获取索引统计"""
        index_file = self.store_path / "index.faiss"
        pkl_file = self.store_path / "index.pkl"
        
        return {
            "exists": self.index_exists(),
            "path": str(self.store_path),
            "index_size_mb": round(index_file.stat().st_size / 1024 / 1024, 2) if index_file.exists() else 0,
            "pkl_size_mb": round(pkl_file.stat().st_size / 1024 / 1024, 2) if pkl_file.exists() else 0,
            "metadata": self.metadata_store.get_stats(),
        }


# ============================================================
# 文件过滤器（辅助函数）
# ============================================================
def should_index_file(path: Path) -> bool:
    """
    判断文件是否应该被索引
    
    使用环境变量配置的规则
    """
    # 检查扩展名
    if path.suffix.lower() not in ALLOWED_EXTENSIONS:
        return False
    
    # 检查排除模式
    path_str = str(path)
    for pattern in EXCLUDED_PATTERNS:
        if pattern in path_str:
            return False
    
    # 检查文件大小
    try:
        if path.stat().st_size > MAX_FILE_SIZE_KB * 1024:
            return False
    except OSError:
        return False
    
    return True


def compute_file_hash(path: Path) -> str:
    """计算文件内容哈希"""
    hasher = hashlib.md5()
    try:
        with open(path, 'rb') as f:
            for chunk in iter(lambda: f.read(8192), b''):
                hasher.update(chunk)
        return hasher.hexdigest()
    except Exception:
        return ""


def load_indexignore(kb_path: Path) -> set:
    """加载 .indexignore 文件"""
    ignore_file = kb_path / ".indexignore"
    patterns = set()
    
    if ignore_file.exists():
        try:
            for line in ignore_file.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line and not line.startswith('#'):
                    patterns.add(line.rstrip('/'))
        except Exception as e:
            logger.debug("load_indexignore failed: %s", e)
    
    return patterns


# ============================================================
# 便捷函数
# ============================================================
def get_metadata_store() -> IndexMetadataStore:
    """获取元数据存储单例"""
    return IndexMetadataStore()


def get_index_manager() -> VectorIndexManager:
    """获取向量索引管理器单例"""
    return VectorIndexManager()


# ============================================================
# 导出
# ============================================================
__all__ = [
    "IndexMetadataStore",
    "VectorIndexManager",
    "IndexedDocument",
    "get_metadata_store",
    "get_index_manager",
    "should_index_file",
    "compute_file_hash",
    "load_indexignore",
    "ALLOWED_EXTENSIONS",
    "EXCLUDED_PATTERNS",
    "MAX_FILE_SIZE_KB",
    "VECTOR_STORE_PATH",
]
