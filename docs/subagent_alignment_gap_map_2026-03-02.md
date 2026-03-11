# SubAgent 并行-云端-提智差距地图（流程正确性优先）

## 范围
- 后端编排与并行决策
- 模型路由与云端可运行性
- 前端策略可见/可控
- 发布门禁（提智/成本）

## 风险分级标准
- `P0`：阻断商业承诺兑现（本地并行/云端扩展/云端提智）
- `P1`：影响用户可控性或一致性，可能引发误解
- `P2`：可观测与治理增强项

## 差距清单（含证据）
1. `P0` 并发策略“有参数、少闭环”
   - 现状：存在 `MAX_PARALLEL_*` 和资源自适应收敛，但执行层可验证并发调度链路不足。
   - 证据：
     - `backend/engine/agent/deep_agent.py`
     - `backend/engine/core/main_graph.py`
2. `P0` 云端提智路径默认未打通
   - 现状：模型路由支持 cloud tier，但默认配置无 cloud 模型，升级策略默认关闭。
   - 证据：
     - `backend/config/models.json`
     - `backend/engine/agent/model_manager.py`
3. `P1` 前端缺会话级资源策略直达控制
   - 现状：用户可见 SubAgent 进度，但难在主路径直接设置“本地/云端策略 + 并行级别”。
   - 证据：
     - `frontend/desktop/src/components/ChatComponents/MyRuntimeProvider.tsx`
     - `frontend/desktop/src/components/ChatComponents/cursor-style-composer.tsx`
     - `frontend/desktop/src/components/SettingsView.tsx`
4. `P1` 提智与成本指标未形成 release 阻断
   - 现状：已有观测和汇总，但阻断口径未覆盖提智收益与成本阈值。
   - 证据：
     - `.github/workflows/ci.yml`
     - `backend/scripts/check_ci_release_gates.py`
     - `backend/scripts/build_ci_job_summary.py`
5. `P2` 云端能力透明度不足
   - 现状：模型 tier/配额有展示，但缺统一“执行前能力卡”。
   - 证据：
     - `frontend/desktop/src/components/ChatComponents/model-selector.tsx`
     - `frontend/desktop/src/components/WorkspaceDashboard.tsx`

## 优先修复顺序
1. 并行策略真源化（后端）
2. 云端最小可运行闭环（后端配置+路由）
3. 提智/成本阻断门禁（CI）
4. 会话级策略入口（前端）
5. 端到端回归（后端/前端）
