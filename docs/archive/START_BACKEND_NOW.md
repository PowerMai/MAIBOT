# 🚀 立即启动后端服务

## 问题
前端无法连接到后端：`ERR_CONNECTION_REFUSED` - 后端服务未运行

## 解决方案

### 方法1: 使用启动脚本（推荐）

```bash
cd /Users/workspace/DevelopProjects/ccb-v0.378
bash start_dev.sh
```

### 方法2: 手动启动

**步骤1: 激活虚拟环境**
```bash
cd /Users/workspace/DevelopProjects/ccb-v0.378
source .venv/bin/activate  # 或 source venv/bin/activate
```

**步骤2: 启动 LangGraph Server**
```bash
langgraph dev --port 2024 --host 0.0.0.0
```

**预期输出**:
```
✅ Listening on http://127.0.0.1:2024
✅ Orchestrator Agent created successfully
```

**步骤3: 验证后端启动**
```bash
# 在另一个终端运行
curl http://localhost:2024/health
# 或
curl http://localhost:2024/ok
```

---

## ⚠️ 注意事项

1. **虚拟环境**: 必须在虚拟环境中运行 `langgraph dev`
2. **LM Studio**: 确保 LM Studio 已启动（如果使用本地模型）
3. **端口**: 确保 2024 端口未被占用

---

## 🔍 故障排查

### 检查虚拟环境
```bash
cd /Users/workspace/DevelopProjects/ccb-v0.378
ls -la | grep venv
```

### 检查端口占用
```bash
lsof -i :2024
```

### 检查 LangGraph 是否安装
```bash
source .venv/bin/activate
python -m langgraph --version
```

### 查看启动日志
```bash
# 如果使用后台运行
tail -f /tmp/langgraph.log
```

---

## ✅ 启动成功标志

1. 终端显示: `✅ Listening on http://127.0.0.1:2024`
2. 健康检查返回: `{"ok":true}` 或类似响应
3. 前端不再显示 `ERR_CONNECTION_REFUSED`

---

*生成时间: 2024-12-19*


