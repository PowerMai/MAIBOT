# UI 全链路对齐差距清单（2026-02-28）

## 评估口径

- 目标基线：Claude / Cowork / Cursor 的交互心智模型（会话隔离、命令输入、运行反馈、异常恢复、任务闭环）。
- 评估维度：体验一致性、业务语义一致性、前后端契约一致性。
- 优先级定义：
  - P0：会导致用户误判状态或误操作。
  - P1：不阻断主流程，但增加认知负担。
  - P2：体验打磨项，提升效率与舒适度。

## P0

- **任务主入口不一致（已修复）**
  - 现象：Dashboard 默认打开任务详情，Task 运行中时用户更希望直接回到对话；入口策略在不同视图存在分叉。
  - 影响：用户无法快速“继续执行”，造成“任务在跑但我找不到执行面板”的误判。
  - 修复：统一使用 `resolveTaskPrimaryEntryAction()` 判定主入口，Dashboard 与 TaskDetail 共用。
  - 文件：`frontend/desktop/src/lib/taskDispatchStage.ts`、`frontend/desktop/src/components/WorkspaceDashboard.tsx`、`frontend/desktop/src/components/TaskDetailView.tsx`

## P1

- **任务状态与动作语义可解释性不足（部分修复）**
  - 现象：`status` / `dispatch_state` 显示虽已投影，但动作提示对用户不够“下一步导向”。
  - 影响：`awaiting_plan_confirm` / `blocked` / `waiting_human` 场景下，用户不知道该去哪继续。
  - 修复：在任务详情增加“推荐入口 + 推荐原因”提示，和 Dashboard 入口策略一致。
  - 文件：`frontend/desktop/src/components/TaskDetailView.tsx`

- **Slash 命令执行反馈不统一（已修复）**
  - 现象：模式切换、插件列表、安装命令反馈主要依赖后续模型回复，缺少即时反馈。
  - 影响：用户误以为命令未生效，重复输入命令。
  - 修复：在命令解析路径增加即时 toast（模式切换、插件列表、安装成功/失败、命令失败）。
  - 文件：`frontend/desktop/src/components/ChatComponents/MyRuntimeProvider.tsx`

- **发送失败提示偏系统术语（已修复）**
  - 现象：错误文案偏技术描述，下一步行动不够直观。
  - 影响：用户在网络波动/线程失效时恢复路径不清晰。
  - 修复：统一为“问题原因 + 建议下一步”结构，减少系统内部术语。
  - 文件：`frontend/desktop/src/components/ChatComponents/MyRuntimeProvider.tsx`

## P2

- **只读/可写边界提示可继续增强（待后续）**
  - 现状：Composer 对 Ask/Review/Plan 已有标签提示。
  - 建议：在任务页动作区补“当前模式是否允许直接执行”的显式提示，减少模式误解。

- **命令冲突可视化（待后续）**
  - 现状：已具备命令去重与 fallback。
  - 建议：当多个插件命令同名时在建议面板显示来源插件，减少歧义。
