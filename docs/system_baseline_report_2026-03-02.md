# 系统基线体检报告（2026-03-02）

## 检查范围

- 后端服务健康与关键接口可达性
- 前后端联调进程状态
- 业务验收脚本可执行性与通过率
- 发布门禁（回归）状态

## 执行路径与证据

- 服务状态与健康检查：`./scripts/start.sh status && ./scripts/start.sh health`
  - 后端 `2024`：运行中
  - 前端 `3000`：运行中
  - LM Studio `1234`：未检测到（可选）
  - 磁盘空间：95%（告警）
- 后端关键接口探测：
  - `GET /ok` => `200 {"ok":true}`
  - `GET /health` => `200 {"status":"ok",...}`
  - `GET /health/deep` => `200 {"status":"degraded",...}`（可用但降级）
  - `GET /docs` => `200`
- 全业务验收：`uv run python backend/scripts/test_full_business_acceptance.py`
  - 报告文件：`backend/data/business_acceptance_report.json`
  - 结果：`ok=false`
  - 失败项：`test_model_role_dispatch_e2e.py`
  - 失败原因：`active_role_id 未更新: expect=analyst got=default`
- 发布回归门禁：`npm run release:check`
  - 报告文件：`backend/data/regression_report.json`
  - 结果：`9/9 通过`，`gate:release` 通过

## 结论（基线）

- 系统主链路具备运行能力，但“角色激活一致性”存在明确阻断，导致“业务验收未全绿”。
- 当前可达“可运行但不完全可验收通过”的状态。
- 优先修复项：角色激活后 profile 一致性、任务状态与任务可见性稳定性、工作区切换前后端一致性。
