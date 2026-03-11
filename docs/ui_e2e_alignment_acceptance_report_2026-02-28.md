# UI 全链路一致性验收报告（2026-02-28）

## 验收范围

- 聊天主链路：`ChatArea` / `cursor-style-composer` / `MyRuntimeProvider`
- 工作台与任务视图：`WorkspaceDashboard` / `TaskDetailView`
- 状态投影与入口策略：`taskDispatchStage`
- 后端契约对照：`/board/tasks*`、`/slash/execute`、`/plugins/*`

## 本轮改造

- 新增统一任务主入口判定：
  - `resolveTaskPrimaryEntryAction(task)`，按用户视角给出“继续对话”或“打开任务详情”。
- Dashboard 与 TaskDetail 统一使用同一入口判定，避免跨视图分叉。
- TaskDetail 新增“推荐入口”提示，明确当前状态下最佳下一步。
- Slash 命令路径补齐即时反馈（模式切换、插件查询、插件安装、命令失败）。
- 发送失败提示改为“问题原因 + 建议下一步”用户可行动文案。

## 回归清单（本轮）

- `check:session-state`：会话状态写入/事件链路一致性
- `check:session-flow`：Plan 确认流转与线程级插件隔离
- `check:role-mode-contract`：角色第四模式契约一致性
- `check:slash-mode`：slash 分支可达性与 mode 透传一致性
- `check:single-agent`：单体运行模式链路可用性

## 结论

- 体验一致性：通过（主入口、即时反馈、错误恢复均更接近用户心智）。
- 业务逻辑一致性：通过（任务状态到用户动作映射收敛为单一判定）。
- 前后端一致性：通过（前端状态呈现和后端状态机契约无新增分叉）。

## 残余风险

- 高并发事件下 localStorage + 事件总线仍可能出现短暂显示抖动（已有守卫，建议后续集中状态容器化）。
- 插件同名命令冲突仍为“去重 + 首命中”，建议补来源提示。
