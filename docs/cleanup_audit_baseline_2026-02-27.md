# 全库保守清理基线（2026-02-27）

本文件用于冻结本轮清理前后的证据与结论，遵循“不确定不清理”。

## 高置信低风险（本轮可执行）

- `.pids/*.pid`：运行时 PID 文件，可再生。
- `logs/backend.log`、`logs/frontend.log`：运行日志，可再生。
- `backend/tmp/.memory/learning/*.tmp`：临时产物，可清理。
- `frontend/desktop/build/`：历史构建目录；当前 Vite 输出为 `dist`。
- 前端未引用代码：
  - `frontend/desktop/src/components/WorkspaceSelector.tsx`
  - `frontend/desktop/src/components/TaskPanel.tsx`
  - `frontend/desktop/src/lib/hooks/useLocalStorageSync.ts`
  - `frontend/desktop/src/lib/utils/apiOptimizer.ts`
  - `frontend/desktop/src/lib/utils/index.ts`（仅承载上方导出链）
- 后端未使用函数：
  - `backend/api/app.py`：`_api_success`、`_api_error`
  - `backend/engine/network/registry.py`：`get_network_registry`

## 需人工确认（本轮默认不删）

- `backend/.env.bak`：配置备份，存在回溯价值。
- `tmp/tmp/`：存在业务产出文件，默认保留。

## 本次复核中“未发现/已不存在”的中风险目录

- `frontend/desktop/workspace/Downloads`
- `frontend/desktop/workspace/ccb-v0.378_副本`
- `backend/prompt_backup`

以上目录在本次执行前复核中未检出，因此本轮不做处理。

## 关键尺寸快照（清理前）

- `.pids`：8.0K
- `logs`：712K
- `backend/tmp/.memory/learning`：36K
- `frontend/desktop/build`：8.3M
- `backend/.env.bak`：4.0K
- `tmp/tmp`：152K

## 结构结论（保守）

- 核心结构 `backend/frontend/scripts/docs` 无严重分层问题。
- 本轮不做核心目录重构；仅执行噪声清理与无引用代码清理。

## 执行结果

- 已删除：
  - `.pids/backend.pid`
  - `.pids/frontend.pid`
  - `logs/backend.log`
  - `logs/frontend.log`
  - `backend/tmp/.memory/learning/*.tmp`（6 个）
  - `frontend/desktop/build/`
  - `frontend/desktop/src/components/WorkspaceSelector.tsx`
  - `frontend/desktop/src/components/TaskPanel.tsx`
  - `frontend/desktop/src/lib/hooks/useLocalStorageSync.ts`
  - `frontend/desktop/src/lib/utils/apiOptimizer.ts`
  - `frontend/desktop/src/lib/utils/index.ts`
  - `backend/.env.bak`（先归档后删除）
- 已代码清理：
  - `backend/api/app.py` 移除 `_api_success`、`_api_error`
  - `backend/engine/network/registry.py` 移除 `get_network_registry`
  - `backend/engine/network/__init__.py` 同步移除过期导出
- 已归档到仓库外：
  - `/Users/workspace/cleanup-archives/ccb-v0.378-2026-02-27/backend/.env.bak`
  - `/Users/workspace/cleanup-archives/ccb-v0.378-2026-02-27/tmp/tmp`（保留原目录，不删除）

## 清理后快照

- `.pids`：0B
- `logs`：0B
- `backend/tmp/.memory/learning`：12K
- `tmp/tmp`：152K（按保守策略保留）

## 回归验证结果

- 前端构建：`npm run build` 通过。
- 后端校验：`py_compile` 与关键导入检查通过。
- 代码诊断：本轮变更相关路径无 linter 报错。
