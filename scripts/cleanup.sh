#!/bin/bash
# 清理脚本 - 停止所有项目相关进程

echo "=== 清理 CCB 项目进程 ==="

# 停止 Electron 进程
echo "停止 Electron 进程..."
pkill -9 -f "ccb-v0.378.*Electron" 2>/dev/null || true
pkill -9 -f "Electron App UI Design" 2>/dev/null || true

# 停止 Node/Vite 进程
echo "停止 Node/Vite 进程..."
pkill -9 -f "ccb-v0.378.*node" 2>/dev/null || true
pkill -9 -f "ccb-v0.378.*vite" 2>/dev/null || true

# 停止 LangGraph 进程
echo "停止 LangGraph 进程..."
pkill -9 -f "langgraph dev" 2>/dev/null || true
pkill -9 -f "ccb-v0.378.*python" 2>/dev/null || true

# 等待进程退出
sleep 2

# 检查端口
echo ""
echo "=== 检查端口状态 ==="
lsof -i :3000 2>/dev/null | head -2 || echo "✅ 端口 3000 已释放"
lsof -i :2024 2>/dev/null | head -2 || echo "✅ 端口 2024 已释放"

# 检查残留进程
echo ""
echo "=== 检查残留进程 ==="
ps aux | grep -E "ccb-v0.378.*(Electron|node|python)" | grep -v grep || echo "✅ 无残留进程"

echo ""
echo "=== 清理完成 ==="
echo "现在可以重新启动项目："
echo "  1. 后端: cd /Users/workspace/DevelopProjects/ccb-v0.378 && source .venv/bin/activate && langgraph dev --port 2024"
echo "  2. 前端: cd /Users/workspace/DevelopProjects/ccb-v0.378/frontend/desktop && npm run electron:dev"
