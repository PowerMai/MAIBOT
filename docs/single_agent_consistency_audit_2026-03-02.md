# 单体 Agent 四维一致性审计（2026-03-02）

## 审计范围

- 范围：单体 Agent 阶段核心链路（Plan 确认、任务治理、人审、会话隔离、发布门禁）。
- 四维：功能语义（Feature）/ 接口契约（API&State）/ 前端交互（UI）/ 回归验证（Test）。
- 风险等级：`P0`（上线阻断）、`P1`（需发布前关闭）、`P2`（可灰度跟踪）。

## 一致性矩阵

- Plan 确认
  - 功能语义：规划后需人工确认再执行
  - 后端契约：`plan_confirmation` 中断；状态 `awaiting_plan_confirm`
  - 前端表现：中断弹窗 + 确认执行按钮
  - 验证：`check:single-agent`
  - 结论：已闭环；风险 `P1`
- blocked 治理
  - 功能语义：信息不足可阻塞并补充后恢复
  - 后端契约：`/board/tasks/{id}/blocked`；状态可回 `available`
  - 前端表现：TaskDetail 显示 `blocked_reason/missing_information`
  - 验证：`test_single_agent_api_acceptance`
  - 结论：已闭环；风险 `P1`
- artifacts 审计
  - 功能语义：产出、改动、回滚建议可落库
  - 后端契约：`/board/tasks/{id}/artifacts`；字段 `deliverables/changed_files/rollback_hint`
  - 前端表现：TaskDetail 展示交付与审计字段
  - 验证：`test_single_agent_api_acceptance`
  - 结论：已闭环；风险 `P1`
- 人审扩展决策
  - 功能语义：支持 `delegate/skip`
  - 后端契约：`/board/tasks/{id}/human-review` 支持新 decision
  - 前端表现：InterruptDialog/TaskDetail 可操作
  - 验证：`check:single-agent` + API 验收
  - 结论：已闭环；风险 `P1`
- 会话插件隔离
  - 功能语义：插件开关线程级隔离
  - 后端契约：线程键 `maibot_session_plugins_thread_*`
  - 前端表现：切线程后插件计数独立
  - 验证：`check:session-flow` + 人工脚本
  - 结论：自动化通过，人工待签；风险 `P1`
- 角色-模式契约
  - 功能语义：第四模式由后端配置驱动
  - 后端契约：`preferred_fourth_mode` 契约字段
  - 前端表现：composer 模式归一化使用后端值
  - 验证：`check:role-mode-contract`
  - 结论：已闭环；风险 `P2`
- 状态流转守卫
  - 功能语义：非法状态迁移必须拒绝
  - 后端契约：`_is_valid_board_transition` + watcher 规则
  - 前端表现：UI 操作受后端约束
  - 验证：负例契约脚本
  - 结论：已补齐；风险 `P1`
- 发布准入
  - 功能语义：PR 与发布前门禁分层
  - 后端契约：CI jobs + release gate
  - 前端表现：无直接 UI
  - 验证：workflow `release-readiness`
  - 结论：已补齐；风险 `P1`

## 已识别缺口（本轮必须收口）

1. 缺少“状态迁移负例”自动化契约检查（当前偏正向路径验证）。
2. 发布门禁虽有检查项，但尚未形成 PR 与 Release 分层执行策略。
3. 可靠性指标已有接口，但缺少 SLO 阈值策略、历史趋势快照与告警约定。
4. 发布模板（签字、回滚、复盘）未标准化，历史语义清理缺少执行计划。

## 收口动作与责任建议

- 状态迁移负例守卫
  - 输出物：`backend/scripts/check_board_contracts.py`
  - 建议 Owner：Backend
  - 截止：第2周
- 分层门禁
  - 输出物：CI 中 PR/Release 分层 job
  - 建议 Owner：Backend/DevOps
  - 截止：第2周
- SLO 监控与趋势
  - 输出物：`check_reliability_slo.py` + SLO 策略文档
  - 建议 Owner：Backend
  - 截止：第3周
- 发布模板与语义清理
  - 输出物：签字模板/回滚模板/历史语义清理计划
  - 建议 Owner：Product+Eng
  - 截止：第4周

## 进入发布前的硬门槛

- `check:session-state`、`check:session-flow`、`check:single-agent`、`check:role-mode-contract` 全通过。
- `test_single_agent_api_acceptance` + 状态迁移负例契约检查通过。
- 会话插件隔离人工补测签字完成（`manual_session_plugin_isolation_5min.md`）。
- 可靠性指标快照生成并进入发布记录。
