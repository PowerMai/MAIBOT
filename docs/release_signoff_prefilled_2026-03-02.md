# 发布签字单（预填充草稿）

项目：`ccb-v0.378`  
版本：`2026-03-02 Claude/Cowork 对齐优化批次`  
签字日期：`______`

## 一、发布范围确认

- [x] 已确认本次发布仅包含“Claude 对齐深度清理 + 能力闭合”相关改动。
- [x] 已确认关键变更已纳入验收报告：`docs/release_acceptance_report_2026-03-02.md`。
- [x] 已确认发布前清单：`docs/release-readiness-checklist_2026-03-02.md`。

## 二、验收结果确认

- [x] 自动化检查全部通过（session-state / single-agent / role-mode / session-flow）。
- [x] 后端关键接口回归通过（plugins/list、plugins/commands、slash/execute）。
- [x] UI 关键路径通过（slash 建议、插件命令、Dashboard 快捷任务、填充动作）。
- [ ] 人工补测已完成并记录：`docs/manual_session_plugin_isolation_5min.md`。

## 三、风险知悉

- [x] 已知风险 1：生产网络下官方插件源连通性需复验（当前环境存在 SSL EOF）。
- [x] 已知风险 2：仓库文档中仍有历史 bidding 语义，不影响运行但影响“全仓语义纯净”标准。
- [x] 已准备对应应急回滚方案（前端 slash fallback、后端 slash 插件分支、suggestions/work 模板）。

## 四、发布决策

- [x] 同意进入灰度发布
- [ ] 同意全量发布
- [ ] 暂缓发布（原因：`______`）

## 五、签字

产品负责人（PO）：`______`  
测试负责人（QA）：`______`  
技术负责人（Tech Lead）：`______`

备注：当前剩余两项发布前收口——(1) 人工补测会话插件隔离并签字；(2) 生产网络下复验 `/plugins/sync` 官方源连通性。
