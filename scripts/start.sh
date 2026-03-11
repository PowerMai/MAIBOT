#!/bin/bash
# ============================================================
# CCB 项目统一启动脚本
# ============================================================
# 
# 用法：
#   ./scripts/start.sh [mode]
#
# 模式：
#   dev       - 开发模式（langgraph dev + 前端）
#   prod      - 生产模式（langgraph up + SQLite 持久化）
#   backend   - 仅启动后端
#   frontend  - 仅启动前端
#   restart   - 重启后端
#   stop      - 停止所有服务
#   status    - 查看服务状态
#
# 示例：
#   ./scripts/start.sh dev      # 开发模式
#   ./scripts/start.sh prod     # 生产模式
#   ./scripts/start.sh stop     # 停止服务
#
# ============================================================

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# 项目路径
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BACKEND_DIR="$PROJECT_ROOT/backend"
FRONTEND_DIR="$PROJECT_ROOT/frontend/desktop"
LOG_DIR="$PROJECT_ROOT/logs"
PID_DIR="$PROJECT_ROOT/.pids"
BACKEND_VENV_DIR="$BACKEND_DIR/.venv"
ROOT_VENV_DIR="$PROJECT_ROOT/.venv"
BACKEND_BASE_URL="${LANGGRAPH_API_URL:-http://127.0.0.1:2024}"
LM_STUDIO_BASE_URL="${LM_STUDIO_URL:-http://localhost:1234/v1}"
BACKEND_PORT="$(printf '%s\n' "$BACKEND_BASE_URL" | sed -E 's#^[a-zA-Z]+://[^:/]+:([0-9]+).*$#\1#')"
if ! [[ "$BACKEND_PORT" =~ ^[0-9]+$ ]]; then
    BACKEND_PORT=2024
fi
LM_STUDIO_MODELS_URL="$LM_STUDIO_BASE_URL/models"
if [[ "$LM_STUDIO_BASE_URL" != */v1 ]]; then
    LM_STUDIO_MODELS_URL="${LM_STUDIO_BASE_URL%/}/v1/models"
fi

# 创建必要目录
mkdir -p "$LOG_DIR" "$PID_DIR"

# ============================================================
# 工具函数
# ============================================================

log_info() {
    echo -e "${GREEN}✅ $1${NC}"
}

log_warn() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

log_error() {
    echo -e "${RED}❌ $1${NC}"
}

log_step() {
    echo -e "${BLUE}[$1]${NC} $2"
}

check_port() {
    local port=$1
    if lsof -ti:$port > /dev/null 2>&1; then
        return 0  # 端口被占用
    else
        return 1  # 端口空闲
    fi
}

kill_port() {
    local port=$1
    if check_port $port; then
        log_warn "端口 $port 被占用，正在释放..."
        lsof -ti:$port | xargs kill -9 2>/dev/null || true
        sleep 1
    fi
}

wait_for_service() {
    local url=$1
    local timeout=$2
    local name=$3
    
    echo -n "   等待 $name 启动"
    for i in $(seq 1 $timeout); do
        if curl -4 -fsS --connect-timeout 1 --max-time 2 "$url" > /dev/null 2>&1; then
            echo ""
            return 0
        fi
        echo -n "."
        sleep 1
    done
    echo ""
    return 1
}

# 前端 Vite 可能只监听 localhost 或 127.0.0.1，且冷启动较慢，故双 URL + 更长超时
wait_for_frontend() {
    local timeout=${1:-90}
    echo -n "   等待 前端 启动"
    for i in $(seq 1 $timeout); do
        if curl -4 -fsS --connect-timeout 1 --max-time 2 "http://127.0.0.1:3000" > /dev/null 2>&1; then
            echo ""
            return 0
        fi
        if curl -4 -fsS --connect-timeout 1 --max-time 2 "http://localhost:3000" > /dev/null 2>&1; then
            echo ""
            return 0
        fi
        echo -n "."
        sleep 1
    done
    echo ""
    return 1
}

# ============================================================
# 停止服务
# ============================================================

stop_services() {
    log_step "STOP" "停止所有服务..."
    
    # 停止后端
    pkill -f "langgraph" 2>/dev/null || true
    pkill -f "uvicorn.*$BACKEND_PORT" 2>/dev/null || true
    
    # 停止前端
    pkill -f "vite.*3000" 2>/dev/null || true
    pkill -f "electron" 2>/dev/null || true
    
    # 释放端口
    kill_port "$BACKEND_PORT"
    kill_port 3000
    kill_port 3001
    
    # 清理 PID 文件
    rm -f "$PID_DIR"/*.pid
    
    log_info "所有服务已停止"
}

# ============================================================
# 查看状态
# ============================================================

show_status() {
    echo ""
    echo "================================"
    echo "📊 服务状态"
    echo "================================"
    
    # 后端状态
    if check_port "$BACKEND_PORT"; then
        if curl -fsS "$BACKEND_BASE_URL/health" > /dev/null 2>&1; then
            echo -e "后端 (${BACKEND_PORT}): ${GREEN}运行中${NC}"
        else
            echo -e "后端 (${BACKEND_PORT}): ${YELLOW}端口占用但无响应${NC}"
        fi
    else
        echo -e "后端 (${BACKEND_PORT}): ${RED}未运行${NC}"
    fi
    
    # 前端状态：兼容 Vite(3000) 与 Electron dev-built（无 3000 端口）
    local frontend_pid_file="$PID_DIR/frontend.pid"
    local frontend_pid=""
    if [ -f "$frontend_pid_file" ]; then
        frontend_pid="$(cat "$frontend_pid_file" 2>/dev/null || true)"
    fi
    if check_port 3000; then
        echo -e "前端 (Vite 3000): ${GREEN}运行中${NC}"
    elif [ -n "$frontend_pid" ] && kill -0 "$frontend_pid" 2>/dev/null; then
        echo -e "前端 (Electron PID:$frontend_pid): ${GREEN}运行中${NC}"
    else
        echo -e "前端: ${RED}未运行${NC}"
    fi
    
    # LM Studio 状态
    if curl -fsS "$LM_STUDIO_MODELS_URL" > /dev/null 2>&1; then
        echo -e "LM Studio (1234): ${GREEN}运行中${NC}"
    else
        echo -e "LM Studio (1234): ${YELLOW}未检测到${NC}"
    fi
    
    # 内存状态
    if check_port "$BACKEND_PORT"; then
        echo ""
        echo "内存状态:"
        curl -s "$BACKEND_BASE_URL/memory/health" 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    status = data.get('status', 'unknown')
    if status == 'healthy':
        print('  状态: ✅ 健康')
    elif status == 'warning':
        print('  状态: ⚠️  警告')
    else:
        print('  状态: ❌ 严重')
    if data.get('process'):
        print(f\"  内存: {data['process'].get('rss_mb', 0):.0f}MB\")
except:
    print('  无法获取')
" 2>/dev/null || echo "  无法获取"
    fi
    
    echo "================================"
}

# ============================================================
# 内存清理
# ============================================================

cleanup_memory() {
    local aggressive=$1
    
    if ! check_port "$BACKEND_PORT"; then
        log_error "后端未运行，无法执行清理"
        return 1
    fi
    
    log_step "CLEANUP" "执行内存清理..."
    
    if [ "$aggressive" = "true" ]; then
        log_warn "激进清理模式（会清理更多数据）"
        result=$(curl -s -X POST "$BACKEND_BASE_URL/memory/cleanup?aggressive=true")
    else
        result=$(curl -s -X POST "$BACKEND_BASE_URL/memory/cleanup")
    fi
    
    echo "$result" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(f\"  SQLite 检查点清理: {data.get('sqlite_checkpoints_deleted', 0)} 条\")
    print(f\"  Pickle 文件清理: {data.get('pickle_files_cleaned', 0)} 个\")
    print(f\"  释放空间: {data.get('freed_mb', 0):.1f} MB\")
except:
    print('  清理完成')
" 2>/dev/null || echo "  清理完成"
    
    log_info "清理完成"
}

# ============================================================
# 查看日志
# ============================================================

show_logs() {
    local service=$1
    local lines=${2:-50}
    
    case $service in
        backend)
            if [ -f "$LOG_DIR/backend.log" ]; then
                tail -n $lines "$LOG_DIR/backend.log"
            else
                log_error "后端日志不存在"
            fi
            ;;
        frontend)
            if [ -f "$LOG_DIR/frontend.log" ]; then
                tail -n $lines "$LOG_DIR/frontend.log"
            else
                log_error "前端日志不存在"
            fi
            ;;
        *)
            log_error "未知服务: $service"
            echo "用法: $0 logs [backend|frontend] [行数]"
            ;;
    esac
}

# ============================================================
# 健康检查
# ============================================================

health_check() {
    echo ""
    echo "================================"
    echo "🏥 健康检查"
    echo "================================"
    
    local all_healthy=true
    
    # 检查后端
    echo -n "后端服务... "
    if curl -fsS "$BACKEND_BASE_URL/health" > /dev/null 2>&1; then
        echo -e "${GREEN}✓${NC}"
    else
        echo -e "${RED}✗${NC}"
        all_healthy=false
    fi
    
    # 检查 LM Studio
    echo -n "LM Studio... "
    if curl -fsS "$LM_STUDIO_MODELS_URL" > /dev/null 2>&1; then
        echo -e "${GREEN}✓${NC}"
    else
        echo -e "${YELLOW}✗ (可选)${NC}"
    fi
    
    # 检查内存
    echo -n "内存状态... "
    if check_port "$BACKEND_PORT"; then
        health=$(curl -s "$BACKEND_BASE_URL/memory/health" 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(data.get('status', 'unknown'))
except:
    print('unknown')
" 2>/dev/null)
        if [ "$health" = "healthy" ]; then
            echo -e "${GREEN}✓${NC}"
        elif [ "$health" = "warning" ]; then
            echo -e "${YELLOW}⚠${NC}"
        else
            echo -e "${RED}✗${NC}"
            all_healthy=false
        fi
    else
        echo -e "${YELLOW}跳过${NC}"
    fi
    
    # 检查磁盘空间
    echo -n "磁盘空间... "
    disk_usage=$(df -h "$PROJECT_ROOT" | tail -1 | awk '{print $5}' | tr -d '%')
    if [ "$disk_usage" -lt 80 ]; then
        echo -e "${GREEN}✓ (${disk_usage}%)${NC}"
    elif [ "$disk_usage" -lt 90 ]; then
        echo -e "${YELLOW}⚠ (${disk_usage}%)${NC}"
    else
        echo -e "${RED}✗ (${disk_usage}%)${NC}"
        all_healthy=false
    fi
    
    echo "================================"
    
    if [ "$all_healthy" = true ]; then
        log_info "所有检查通过"
        return 0
    else
        log_warn "部分检查未通过"
        return 1
    fi
}

collect_baseline() {
    log_step "BASELINE" "采集性能基线..."
    if [ ! -x "$PROJECT_ROOT/scripts/perf_baseline.sh" ]; then
        chmod +x "$PROJECT_ROOT/scripts/perf_baseline.sh" 2>/dev/null || true
    fi
    "$PROJECT_ROOT/scripts/perf_baseline.sh"
}

# ============================================================
# 启动后端
# ============================================================

start_backend() {
    local mode=$1  # dev 或 prod
    
    log_step "1" "启动后端 ($mode 模式)..."
    
    cd "$PROJECT_ROOT"
    
    # 统一后端 Python 环境：优先 backend/.venv，兼容回退根目录 .venv
    local venv_dir=""
    if [ -d "$BACKEND_VENV_DIR" ]; then
        venv_dir="$BACKEND_VENV_DIR"
    elif [ -d "$ROOT_VENV_DIR" ]; then
        log_warn "检测到根目录 .venv，建议迁移到 backend/.venv 以统一环境"
        venv_dir="$ROOT_VENV_DIR"
    else
        log_warn "后端虚拟环境不存在，正在创建 backend/.venv ..."
        python3 -m venv "$BACKEND_VENV_DIR"
        venv_dir="$BACKEND_VENV_DIR"
    fi
    
    # shellcheck disable=SC1090
    source "$venv_dir/bin/activate"
    
    # 检查依赖
    if ! python -c "import langgraph" 2>/dev/null; then
        log_warn "安装依赖..."
        cd backend && uv sync 2>/dev/null || pip install -e . && cd ..
    fi
    
    # 清理旧进程并等待端口释放
    kill_port "$BACKEND_PORT"
    sleep 2
    
    # 确保数据目录存在
    mkdir -p "$PROJECT_ROOT/data"

    # 在 backend 目录启动，避免 watch 根目录导致频繁重载
    cd "$BACKEND_DIR"
    export PYTHONPATH="$PROJECT_ROOT${PYTHONPATH:+:$PYTHONPATH}"
    # 默认关闭 watcher，避免启动阶段阻塞导致端口未监听；需要时可手动设为 true
    export TASK_WATCHER_ENABLED="${TASK_WATCHER_ENABLED:-false}"
    
    # 启动
    if [ "$mode" = "prod" ]; then
        # 生产模式：使用 langgraph up（SQLite 持久化）
        log_info "使用 SQLite 持久化存储"
        nohup uv run langgraph up --config ../langgraph.json --port "$BACKEND_PORT" > "$LOG_DIR/backend.log" 2>&1 &
    else
        # 开发模式：使用 langgraph dev
        log_warn "开发模式使用 langgraph dev --allow-blocking（仅建议开发环境）"
        # 关闭自动重载，避免大仓库 watch 抖动导致后端反复重启无法就绪
        nohup uv run langgraph dev --config ../langgraph.json --allow-blocking --no-reload --port "$BACKEND_PORT" > "$LOG_DIR/backend.log" 2>&1 &
    fi
    
    BACKEND_PID=$!
    echo $BACKEND_PID > "$PID_DIR/backend.pid"
    
    # 等待启动（prod 模式 langgraph up 较慢，多等一会）
    local timeout=30
    [ "$mode" = "prod" ] && timeout=50
    if wait_for_service "$BACKEND_BASE_URL/health" "$timeout" "后端" || wait_for_service "$BACKEND_BASE_URL/docs" 8 "后端文档"; then
        log_info "后端已启动 (PID: $BACKEND_PID)"
    else
        # 某些本机网络/防火墙场景会导致健康探活失败，但后端进程已正常运行
        if kill -0 "$BACKEND_PID" 2>/dev/null; then
            log_warn "后端进程已运行，但健康检查未通过（可能是本机网络策略/环回限制）"
            log_warn "可继续启动前端，随后用 '$0 status' 或 '$0 health' 二次确认"
        else
            log_error "后端启动失败，查看日志: $LOG_DIR/backend.log"
            if [ -f "$LOG_DIR/backend.log" ]; then
                echo ""
                log_warn "后端日志最后 20 行:"
                tail -n 20 "$LOG_DIR/backend.log" | sed 's/^/  /'
            fi
            if [ "$mode" = "prod" ]; then
                echo ""
                log_warn "生产模式 (langgraph up) 需要 Docker 运行。若本机未开 Docker，请："
                echo "  - 启动 Docker Desktop 后重试，或"
                echo "  - 使用开发模式: $0 dev  或  $0 dev-built"
            fi
            return 1
        fi
    fi
}

# ============================================================
# 检测前端包管理器（与 pnpm run build 一致）
# ============================================================
detect_pkg_manager() {
    if [ -f "$FRONTEND_DIR/pnpm-lock.yaml" ] || [ -f "$PROJECT_ROOT/pnpm-lock.yaml" ]; then
        echo "pnpm"
    elif [ -f "$FRONTEND_DIR/package-lock.json" ] || [ -f "$PROJECT_ROOT/package-lock.json" ]; then
        echo "npm"
    else
        command -v pnpm >/dev/null 2>&1 && echo "pnpm" || echo "npm"
    fi
}

# ============================================================
# 启动前端（Vite + Electron）
# ============================================================

start_frontend() {
    log_step "2" "启动前端..."
    
    cd "$FRONTEND_DIR" || exit 1
    
    PKG_MANAGER=$(detect_pkg_manager)
    log_info "使用包管理器: $PKG_MANAGER"
    
    # 检查依赖
    if [ ! -d "node_modules" ]; then
        log_warn "安装前端依赖..."
        $PKG_MANAGER install
    fi
    
    # 清理旧进程
    kill_port 3000
    
    # 启动 Electron（包含 Vite 开发服务器）
    log_info "启动 Electron 应用（含 Vite 开发服务器）..."
    nohup $PKG_MANAGER run electron:dev > "$LOG_DIR/frontend.log" 2>&1 &
    FRONTEND_PID=$!
    echo $FRONTEND_PID > "$PID_DIR/frontend.pid"
    
    # 等待 Vite 启动（最多 90 秒，双 URL 探活：127.0.0.1 + localhost，冷启动或环回差异时更稳）
    if wait_for_frontend 90; then
        log_info "前端已启动 (PID: $FRONTEND_PID)"
        log_info "Electron 窗口将在几秒后自动打开..."
    else
        # 兜底：探活失败但进程仍在运行时，提示为“可能已启动”而非直接失败
        if kill -0 "$FRONTEND_PID" 2>/dev/null; then
            log_warn "前端进程已运行，但 HTTP 探活未通过（可能是本机网络/代理/环回限制）"
            log_warn "可继续使用 Electron 窗口，并通过 '$0 status' 或 '$0 logs frontend' 进一步确认"
        else
            log_error "前端启动失败，查看日志: $LOG_DIR/frontend.log"
            log_error "可执行: tail -n 80 $LOG_DIR/frontend.log"
            return 1
        fi
    fi
}

# ============================================================
# 使用已构建前端启动 Electron（不依赖 Vite，适合 build 成功后直接起）
# ============================================================
start_frontend_built() {
    log_step "2" "启动前端（使用已构建 dist）..."
    
    cd "$FRONTEND_DIR" || exit 1
    
    PKG_MANAGER=$(detect_pkg_manager)
    
    if [ ! -f "dist/index.html" ]; then
        log_warn "未找到 dist/index.html，先执行构建..."
        $PKG_MANAGER run build || { log_error "前端构建失败"; return 1; }
    fi
    
    log_info "启动 Electron（加载 dist）..."
    if [ "$PKG_MANAGER" = "pnpm" ]; then
        nohup env NODE_ENV=production pnpm exec electron . > "$LOG_DIR/frontend.log" 2>&1 &
    else
        nohup env NODE_ENV=production npx electron . > "$LOG_DIR/frontend.log" 2>&1 &
    fi
    FRONTEND_PID=$!
    echo $FRONTEND_PID > "$PID_DIR/frontend.pid"
    log_info "前端已启动 (PID: $FRONTEND_PID)，Electron 窗口将打开..."
}

# ============================================================
# 显示帮助
# ============================================================

show_help() {
    echo ""
    echo "CCB 项目启动脚本"
    echo ""
    echo "用法: $0 [命令] [参数]"
    echo ""
    echo "启动命令:"
    echo "  dev         开发模式（默认）- langgraph dev + 前端"
    echo "  prod        生产模式 - langgraph up + SQLite 持久化"
    echo "  backend     仅启动后端（开发模式）"
    echo "  backend-prod 仅启动后端（生产模式）"
    echo "  frontend    仅启动前端（Vite 开发模式）"
    echo "  frontend-built  仅启动前端（使用已构建 dist，无需 Vite）"
    echo "  dev-built      开发后端 + 已构建前端（无需 Vite、无需 Docker，推荐）"
    echo "  prod-built     生产后端 + 已构建前端（生产后端需 Docker）"
    echo ""
    echo "说明: 若仅需前端界面可先 ./scripts/start.sh backend 再 ./scripts/start.sh frontend-built"
    echo ""
    echo "管理命令:"
    echo "  restart     重启后端"
    echo "  stop        停止所有服务"
    echo "  status      查看服务状态"
    echo "  health      健康检查"
    echo ""
    echo "维护命令:"
    echo "  cleanup     清理内存和缓存"
    echo "  cleanup-all 激进清理（清理更多数据）"
    echo "  baseline    采集性能/资源基线"
    echo "  logs        查看日志 (logs backend|frontend [行数])"
    echo ""
    echo "示例:"
    echo "  $0 dev           # 开发模式"
    echo "  $0 prod          # 生产模式（推荐）"
    echo "  $0 stop          # 停止服务"
    echo "  $0 cleanup       # 清理内存"
    echo "  $0 logs backend  # 查看后端日志"
    echo ""
}

# ============================================================
# 主函数
# ============================================================

main() {
    local cmd=${1:-dev}
    local arg2=${2:-}
    local arg3=${3:-}
    
    # 静默命令不显示标题
    local show_header=true
    case $cmd in
        status|health|logs|baseline|help|--help|-h)
            show_header=false
            ;;
    esac
    
    if [ "$show_header" = true ]; then
        echo ""
        echo "=================================================="
        echo "🚀 CCB 项目启动脚本"
        echo "=================================================="
    fi
    
    case $cmd in
        dev)
            start_backend "dev"
            start_frontend
            ;;
        prod)
            start_backend "prod"
            start_frontend
            ;;
        backend)
            start_backend "dev"
            ;;
        backend-prod)
            start_backend "prod"
            ;;
        frontend)
            start_frontend
            ;;
        frontend-built)
            start_frontend_built
            ;;
        dev-built)
            start_backend "dev"
            start_frontend_built
            ;;
        prod-built)
            start_backend "prod"
            start_frontend_built
            ;;
        restart)
            stop_services
            sleep 2
            start_backend "dev"
            ;;
        restart-prod)
            stop_services
            sleep 2
            start_backend "prod"
            ;;
        stop)
            stop_services
            ;;
        status)
            show_status
            ;;
        health)
            health_check
            ;;
        cleanup)
            cleanup_memory "false"
            ;;
        cleanup-all)
            cleanup_memory "true"
            ;;
        logs)
            show_logs "$arg2" "$arg3"
            ;;
        baseline)
            collect_baseline
            ;;
        help|--help|-h)
            show_help
            ;;
        *)
            log_error "未知命令: $cmd"
            show_help
            exit 1
            ;;
    esac
    
    # 启动命令显示完成信息
    case $cmd in
        dev|prod|backend|backend-prod|frontend|frontend-built|dev-built|prod-built)
            echo ""
            echo "=================================================="
            echo "✨ 启动完成！"
            echo "=================================================="
            echo ""
            echo "📊 访问地址:"
            echo "  - 后端 API: $BACKEND_BASE_URL"
            echo "  - 后端文档: $BACKEND_BASE_URL/docs"
            echo "  - 前端: http://localhost:3000"
            echo ""
            echo "📝 常用命令:"
            echo "  - 查看状态: $0 status"
            echo "  - 健康检查: $0 health"
            echo "  - 清理内存: $0 cleanup"
            echo "  - 查看日志: $0 logs backend"
            echo "  - 停止服务: $0 stop"
            echo "=================================================="
            ;;
    esac
}

main "$@"
