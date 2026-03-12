# MAIBOT UI 统一规范

本规范用于统一聊天区、任务面板、任务详情三端的视觉与交互，避免同一业务在不同页面出现行为分叉。

## 1. 信息架构
- 主信息：当前状态、主操作、最近进展，默认可见。
- 次信息：历史记录、技术细节、ID 信息，默认折叠或放入菜单。
- 单一路径：同一目标（打开任务/打开对话）在任一视图中都使用同一事件路径。

## 2. 视觉规范
- 高密度布局：优先单行摘要 + 次级灰文案，减少大块空白。
- 色彩语义（全聊天区统一）：
  - `running`（执行中/进行中）：violet（Loader、进度条、执行中面板、Todo 进行中行等）
  - `completed`（已完成）：emerald
  - `failed`（失败）：red
  - `paused/cancelled`（暂停/取消）：muted/amber
  - 链接/文件/URL 等语义仍可用 blue，与「运行状态」区分。
- 卡片层级：
  - L1 区块容器：`border + muted background`
  - L2 事件行：`background/60 + hover + focus ring`

## 3. 交互规范
- 主操作优先：
  - 点击事件行或按 Enter/Space 执行主操作（优先任务详情，其次关联对话）。
- 次操作收敛：
  - 使用三点菜单承载“复制ID/查看原始信息”等次要操作，避免按钮泛滥。
- 渐进披露：
  - 默认展示最近 5 条事件；超出通过“查看全部/收起”切换。

## 4. 时间线规范
- 分组规则：
  - 刚刚：2 分钟内
  - 15 分钟内：2-15 分钟
  - 更早：15 分钟以上
- 事件文案模板：
  - `<subject> · <slot> · <time>`
- 时间格式：
  - 摘要使用 `HH:mm`
  - 详情使用 `MM/DD HH:mm`

## 5. 事件总线规范
- 统一事件常量维护于 `frontend/desktop/src/lib/constants.ts`。
- 关键联动事件必须包含幂等键（建议：`thread_id|triggered_at|slot`）。
- 所有跨模块通知必须可去重（同键短窗内仅处理一次）。

## 6. 可访问性规范
- 可聚焦：所有可触发主操作的事件行必须 `tabIndex=0`。
- 键盘操作：Enter/Space 与点击等效。
- 可读性：状态变化必须有文本表达，不只依赖颜色。

## 7. 落地映射
- 聊天区：`frontend/desktop/src/components/ChatComponents/thread.tsx`
- 任务面板：`frontend/desktop/src/components/TaskPanel.tsx`
- 任务详情：`frontend/desktop/src/components/TaskDetailView.tsx`
- 通知中心：`frontend/desktop/src/components/NotificationCenter.tsx`
