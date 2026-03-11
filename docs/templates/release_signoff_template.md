# 发布签字模板（Release Sign-off）

## 基本信息

- 版本号：
- 发布批次：
- 发布负责人：
- 时间窗口：
- 关联变更（PR/任务）：

## 三段门结果

### 1) 代码门（静态契约 + 构建）

- [ ] 前端契约守卫通过（`check:session-state` / `check:session-flow` / `check:role-mode-contract`）
- [ ] 后端契约守卫通过（`check_board_contracts.py`）
- [ ] 前端构建通过（`pnpm build`）

### 2) 链路门（端到端回归）

- [ ] `test_single_agent_api_acceptance.py` 通过
- [ ] `check_reliability_slo.py` 已生成快照并评审
- [ ] 关键人工链路补测完成（Plan确认、blocked恢复、checkpoint决策）

### 3) 运营门（人工签字 + 外网复验）

- [ ] `manual_session_plugin_isolation_5min.md` 签字完成
- [ ] `/plugins/sync` 外网连通性复验完成
- [ ] 风险接受项已登记（如有）

## 业务验收门（商业化闭环）

- [ ] 激活率（Activation Rate）已填写并达成目标：
- [ ] 转化率（Conversion Rate）已填写并达成目标：
- [ ] D7 留存（Retention D7）已填写并达成目标：
- [ ] 试用到付费时长（Trial to Paid Days）已填写并达成目标：

## 风险与回滚

- 已知风险：
- 触发回滚条件：
- 回滚负责人：
- 回滚脚本/步骤引用：

## 签字

- 产品负责人：
- 工程负责人：
- 值班负责人：
- 结论：`同意发布 / 暂缓发布`
