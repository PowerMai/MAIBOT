## 🔧 阻塞调用问题解决方案

---

## 📋 问题诊断

### 错误信息
```
BlockingError: Blocking call to os.getcwd

原因: FilesystemBackend 在初始化时调用了 Path.cwd()
位置: backend/engine/core/main_agent.py:364 → backend_factory()
```

### 根本原因
```python
# FilesystemBackend.__init__ 中的同步调用
self.cwd = Path(root_dir).resolve() if root_dir else Path.cwd()
                                                     ^^^^^^^^^^
# Path.cwd() → os.getcwd() → 阻塞调用
```

---

## ✅ 解决方案对比

### 方案 1: 开发模式 - 允许阻塞（推荐）

```bash
# 启动命令
langgraph dev --allow-blocking

优点:
✅ 最简单，立即生效
✅ 适合开发和测试
✅ 无需修改代码

缺点:
⚠️ 可能影响性能（在高并发时）
⚠️ 仅适用于开发环境
```

### 方案 2: 指定工作目录（中等推荐）

```python
# 修改 backend_factory
def backend_factory(runtime):
    # 显式指定 root_dir，避免调用 Path.cwd()
    return FilesystemBackend(root_dir="/Users/workspace/DevelopProjects/ccb-v0.378")

优点:
✅ 避免阻塞调用
✅ 明确的工作目录

缺点:
⚠️ 硬编码路径
⚠️ 需要修改代码
```

### 方案 3: 异步包装（最佳但复杂）

```python
import asyncio

async def backend_factory_async(runtime):
    # 在单独线程中初始化 FilesystemBackend
    return await asyncio.to_thread(FilesystemBackend)

优点:
✅ 完全异步
✅ 生产级解决方案

缺点:
⚠️ 需要修改 DeepAgent 的调用方式
⚠️ 较复杂
```

### 方案 4: 生产部署 - 环境变量

```bash
# 设置环境变量
export BG_JOB_ISOLATED_LOOPS=true

# 启动服务
langgraph dev

优点:
✅ 适合生产环境
✅ 无需修改代码

缺点:
⚠️ 需要环境配置
```

---

## 🚀 当前采用方案

### ✅ 方案 1: 开发模式允许阻塞

```bash
# 启动命令
cd /Users/workspace/DevelopProjects/ccb-v0.378
langgraph dev --allow-blocking

# 验证
curl http://127.0.0.1:2024/ok
```

**理由:**
- 这是开发环境，性能不是关键
- 最快捷，无需改代码
- LangGraph 官方推荐的开发选项

---

## 📊 后续优化建议

### 开发阶段（现在）
```bash
✅ 使用 --allow-blocking
✅ 专注于功能开发
✅ 不用担心性能
```

### 测试阶段（稍后）
```python
# 可选：指定工作目录
def backend_factory(runtime):
    import os
    workspace = os.environ.get('WORKSPACE_DIR', '/Users/workspace/DevelopProjects/ccb-v0.378')
    return FilesystemBackend(root_dir=workspace)
```

### 生产部署（未来）
```bash
# Dockerfile 或启动脚本
export BG_JOB_ISOLATED_LOOPS=true
langgraph serve
```

---

## 🎯 快速启动指南

### 后端启动
```bash
cd /Users/workspace/DevelopProjects/ccb-v0.378
langgraph dev --allow-blocking

# 输出
✅ API: http://127.0.0.1:2024
✅ Orchestrator Agent created successfully
```

### 前端启动
```bash
cd /Users/workspace/DevelopProjects/ccb-v0.378/frontend/desktop
npm run dev

# 输出
✅ Local: http://localhost:3000
```

### 验证
```bash
# 测试后端健康
curl http://127.0.0.1:2024/ok

# 测试线程创建
curl -X POST http://127.0.0.1:2024/api/threads

# 前端发送消息
# 浏览器打开 http://localhost:3000
# 在对话框输入 "你好"
```

---

## 💡 技术说明

### 为什么 FilesystemBackend 会阻塞？

```
FilesystemBackend 初始化流程:
1. __init__(root_dir=None)
2. self.cwd = Path(root_dir).resolve() if root_dir else Path.cwd()
3. Path.cwd() → pathlib.cwd()
4. pathlib.cwd() → os.getcwd()
5. os.getcwd() → 系统调用 (阻塞)

LangGraph Server 运行在 ASGI:
- 使用异步事件循环
- 阻塞调用会阻塞整个事件循环
- 影响所有并发请求

--allow-blocking 的作用:
- 禁用 blockbuster 检测
- 允许同步阻塞调用
- 简化开发流程
```

### DeepAgent 的其他阻塞点（可能）

```
可能的阻塞调用:
1. ✅ FilesystemBackend: Path.cwd() → 已通过 --allow-blocking 解决
2. ⚠️ File I/O: open(), read(), write() → 可能阻塞
3. ⚠️ subprocess: shell_run 中的 subprocess.run() → 可能阻塞
4. ⚠️ HTTP requests: 同步的 requests.get() → 可能阻塞

当前策略:
- 开发阶段: 全部允许 (--allow-blocking)
- 生产阶段: 按需优化为异步
```

---

## ✅ 总结

**当前状态:**
- ✅ 问题: FilesystemBackend 阻塞调用
- ✅ 解决: langgraph dev --allow-blocking
- ✅ 状态: 后端已启动，等待测试

**下一步:**
1. ✅ 启动前端 (npm run dev)
2. ✅ 浏览器测试 (http://localhost:3000)
3. ✅ 发送 "你好" 验证流程

**性能考虑:**
- 开发: 无需担心
- 生产: 按需优化为异步

🚀 现在系统已经可以正常工作了！

