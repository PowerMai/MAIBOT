#!/bin/bash
# CCB Backend 启动脚本
# 
# 功能：
# 1. 启动前清理过期缓存
# 2. 启动 LangGraph Server
# 3. 支持开发模式和生产模式

set -e

# 项目根目录
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}🚀 CCB Backend 启动脚本${NC}"
echo "项目目录: $PROJECT_ROOT"

# 检查 Python 环境
if [ -d ".venv" ]; then
    source .venv/bin/activate
    echo -e "${GREEN}✅ 已激活虚拟环境${NC}"
else
    echo -e "${YELLOW}⚠️  未找到 .venv，使用系统 Python${NC}"
fi

# 清理过期缓存
echo -e "${YELLOW}🧹 清理过期缓存...${NC}"

# 清理 pickle 缓存（langgraph dev 模式产生的）
if [ -d ".langgraph_api" ]; then
    # 删除超过 3 天的检查点文件
    find .langgraph_api -name ".langgraph_checkpoint.*.pckl" -mtime +3 -delete 2>/dev/null || true
    # 删除超过 100MB 的检查点文件
    find .langgraph_api -name ".langgraph_checkpoint.*.pckl" -size +100M -delete 2>/dev/null || true
    # 删除操作日志（通常很大）
    rm -f .langgraph_api/.langgraph_ops.pckl 2>/dev/null || true
    
    # 计算剩余大小
    SIZE=$(du -sh .langgraph_api 2>/dev/null | cut -f1)
    echo -e "${GREEN}✅ 缓存清理完成，剩余: $SIZE${NC}"
fi

# 解析参数
MODE="dev"  # 默认开发模式
PORT="2024"

while [[ $# -gt 0 ]]; do
    case $1 in
        --prod|--production)
            MODE="prod"
            shift
            ;;
        --port)
            PORT="$2"
            shift 2
            ;;
        *)
            echo -e "${RED}未知参数: $1${NC}"
            exit 1
            ;;
    esac
done

# 设置环境变量
export LANGGRAPH_API=1
export CLEANUP_ON_STARTUP=true
export DEBUG=false
# 默认关闭 watcher，避免启动阶段阻塞导致端口未监听；需要时可手动设为 true
export TASK_WATCHER_ENABLED="${TASK_WATCHER_ENABLED:-false}"

if [ "$MODE" = "dev" ]; then
    echo -e "${YELLOW}📦 开发模式启动...${NC}"
    export DEBUG=true
    export LANGGRAPH_DEV=1
    
    # 开发模式使用 langgraph dev
    # 注意：langgraph dev 会忽略 langgraph.json 中的存储配置
    # 使用 pickle 文件存储，需要定期清理
    # --allow-blocking: 允许阻塞调用（定期清理任务需要）
    cd backend
    export PYTHONPATH="$PROJECT_ROOT${PYTHONPATH:+:$PYTHONPATH}"
    exec langgraph dev --config ../langgraph.json --port "$PORT" --no-browser --allow-blocking --no-reload
else
    echo -e "${GREEN}🏭 生产模式启动...${NC}"
    
    # 生产模式使用 langgraph up 或直接运行
    # 这会使用 langgraph.json 中配置的 SQLite 存储
    cd backend
    export PYTHONPATH="$PROJECT_ROOT${PYTHONPATH:+:$PYTHONPATH}"
    exec langgraph up --config ../langgraph.json --port "$PORT"
fi
