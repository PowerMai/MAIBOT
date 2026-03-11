# 内存泄漏修复说明

## 问题描述

Python 3.12 进程在长时间运行后占用内存达到 18.02GB，重启后恢复正常。

## 根本原因

1. **重复创建存储实例** - 代码中手动创建了 InMemoryStore/MemorySaver，而 LangGraph Server 已通过 `langgraph.json` 配置自动注入
2. **LLM 响应缓存无大小限制** - InMemoryCache 未设置 maxsize，导致无限增长

## 修复方案（使用官方方法）

### 1. 使用 LangGraph Server 自动注入的存储

**langgraph.json 已配置：**
```json
{
  "store": {
    "class": "langgraph.store.sqlite.SQLiteStore",
    "config": { "db_path": "./data/store.db" }
  },
  "checkpointer": {
    "class": "langgraph.checkpoint.sqlite.SqliteSaver",
    "config": { "db_path": "./data/checkpoints.db" }
  }
}
```

**修改内容：**
- 移除手动创建实例的代码
- LangGraph Server 自动创建并注入这些实例
- 避免重复实例导致内存泄漏

### 2. 使用官方 InMemoryCache + maxsize 参数

**官方文档：** https://python.langchain.com/api_reference/core/caches/langchain_core.caches.InMemoryCache.html

**关键特性：**
- `maxsize` 参数：限制最大缓存条目数
- 超过限制时自动删除最旧的条目（LRU 策略）
- 官方内置功能，无需自定义实现

**修改内容：**
```python
from langchain_core.caches import InMemoryCache

# 使用官方 maxsize 参数限制缓存大小
cache = InMemoryCache(maxsize=1000)  # 最多 1000 条
```

### 3. 缓存清理使用官方 clear() 方法

```python
# 官方 clear() 方法
cache.clear()  # 清除所有缓存
```

## 环境变量配置

```bash
# LLM 响应缓存（默认启用）
ENABLE_LLM_CACHE=true

# 最大缓存条目数（默认 1000，设为 0 表示无限制）
LLM_CACHE_MAX_SIZE=1000

# 禁用 Store（如果不需要跨会话记忆）
ENABLE_STORE=false

# 禁用 Checkpointer（如果不需要会话恢复）
ENABLE_CHECKPOINTER=false
```

## LLM 缓存工作原理

### 缓存命中条件

缓存 key 由以下组成：
- `prompt`: 输入的提示词
- `llm_string`: 模型配置字符串（model name, temperature, stop tokens 等）

**只有当 prompt 和 llm_string 完全相同时，才会命中缓存。**

### 适用场景

✅ **适合缓存：**
- 知识库查询（相同问题返回相同答案）
- 固定模板生成
- 重复的分析任务

❌ **不适合缓存：**
- 需要创造性输出的场景
- 每次需要不同结果的场景
- 实时数据查询

### 缓存大小建议

| 场景 | 建议 maxsize |
|------|-------------|
| 开发调试 | 100-500 |
| 生产环境（轻量） | 1000 |
| 生产环境（重度使用） | 5000-10000 |
| 禁用缓存 | 设置 ENABLE_LLM_CACHE=false |

## 内存监控

### API 端点

- `GET /memory/usage` - 获取内存使用情况
- `POST /memory/clear` - 清理所有缓存

### 返回示例

```json
{
  "success": true,
  "memory": {
    "llm_model_cache_size": 2,
    "llm_response_cache": {
      "enabled": true,
      "size": 150,
      "maxsize": 1000
    },
    "agent_cache_size": 1,
    "gc_objects": 50000,
    "rss_mb": 512.5,
    "vms_mb": 1024.0
  }
}
```

### 代码调用

```python
from backend.engine.agent.deep_agent import (
    get_memory_usage,
    get_llm_response_cache_stats,
    clear_all_caches,
    clear_llm_response_cache,
)

# 查看内存使用
usage = get_memory_usage()
print(usage)

# 查看缓存统计
stats = get_llm_response_cache_stats()
print(f"缓存条目: {stats['size']}/{stats['maxsize']}")

# 清理 LLM 响应缓存
clear_llm_response_cache()

# 清理所有缓存
clear_all_caches()
```

## 验证修复

重启服务后，内存应该稳定在合理范围（通常 < 2GB），不再无限增长。

```bash
# 查看 Python 进程内存
ps aux | grep python3.12

# 或使用 API
curl http://localhost:8123/memory/usage
```

## 官方参考

- [LangChain InMemoryCache](https://python.langchain.com/api_reference/core/caches/langchain_core.caches.InMemoryCache.html)
- [LangGraph Persistence](https://langchain-ai.github.io/langgraph/concepts/persistence/)
- [DeepAgent Long-term Memory](https://docs.langchain.com/oss/python/deepagents/long-term-memory)
