# 文件一致性检查报告

## 检查时间
2026-01-15

## 检查的文件

### 1. restart_backend.sh
- **位置**: 仅在根目录存在 ✅
- **状态**: 已更新，添加了依赖检查和安装逻辑
- **说明**: 从根目录运行，使用根目录的 `.venv`

### 2. start_dev.sh
- **位置**: 仅在根目录存在 ✅
- **状态**: 已更新，添加了依赖检查和安装逻辑
- **说明**: 从根目录运行，使用根目录的 `.venv`

### 3. langgraph.json
- **根目录版本**: ✅ 正确配置
  - `"path": "backend.engine.core.main_graph:graph"`
  - `"app": "backend.api.app:app"`
  - 从根目录运行 LangGraph CLI 时使用此配置
  
- **backend 目录版本**: ⚠️ 已更新为与根目录一致
  - 添加了废弃注释，说明应使用根目录的版本
  - 路径已更新为与根目录一致（以防误用）

## 关键发现

1. **虚拟环境**:
   - 根目录 `.venv` (Python 3.12.11) - 主要使用
   - backend 目录 `.venv` (Python 3.11.14) - 可删除

2. **依赖安装**:
   - `pyproject.toml` 在 `backend/` 目录
   - 需要在 `backend/` 目录运行 `uv pip install -e .` 或 `pip install -e .`
   - 启动脚本已添加自动依赖检查和安装

3. **LangGraph 配置**:
   - `langgraph.json` 应在根目录（LangGraph CLI 从根目录运行）
   - backend 目录的版本已标记为废弃

## 修复内容

1. ✅ 更新 `restart_backend.sh`: 添加依赖检查和安装
2. ✅ 更新 `start_dev.sh`: 添加依赖检查和安装，添加端口参数
3. ✅ 更新 `backend/langgraph.json`: 与根目录一致，添加废弃注释

## 使用建议

1. **启动后端**: 使用根目录的 `restart_backend.sh` 或 `start_dev.sh`
2. **安装依赖**: 脚本会自动检查并安装，或手动运行：
   ```bash
   cd backend
   uv pip install -e .
   ```
3. **配置文件**: 使用根目录的 `langgraph.json`，忽略 backend 目录的版本

