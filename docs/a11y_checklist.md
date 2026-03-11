# 可访问性（A11y）回归清单

用于发布前对关键交互做快速可访问性检查，对齐国际顶级产品（Cursor/Claude/VS Code）的屏幕阅读器、键盘与焦点体验。

## 一、Composer（输入区）

| 检查项 | 说明 | 位置 |
|--------|------|------|
| 发送按钮 | 具备 `aria-label`（如「发送消息」），键盘可聚焦，Enter/Ctrl+Enter 发送 | cursor-style-composer.tsx：ComposerPrimitive.Send 按钮 |
| 停止按钮 | 具备 `aria-label`（如「停止生成」），键盘可聚焦，Escape 可触发停止 | cursor-style-composer.tsx：ComposerPrimitive.Cancel 按钮 |
| 焦点顺序 | Tab 在输入框、附件、发送/停止之间顺序合理，无跳步 | 整体布局 |
| 焦点环 | 所有可交互元素 `focus-visible:ring-2` 等可见焦点环 | 按钮与输入 |

## 二、RunTracker（Composer 上方运行状态与任务列表）

| 检查项 | 说明 | 位置 |
|--------|------|------|
| 区域 | 容器具备 `role="region"` 与 `aria-label`（运行中/上次运行） | RunTracker.tsx |
| 停止 | 停止按钮 `aria-label`（如「停止」） | RunTracker.tsx |
| 重试 / 打开任务 / 打开会话 | 各按钮具备 `aria-label`，键盘可达 | RunTracker.tsx |
| 任务列表 | 列表容器 `role="list"`、`aria-label`（如「任务列表」），列表项语义正确 | RunTracker.tsx RunTodoListCard |

## 三、MessageError（消息内错误块）

| 检查项 | 说明 | 位置 |
|--------|------|------|
| 告警 | 错误根节点 `role="alert"`、`aria-live="assertive"`，屏幕阅读器会播报 | thread.tsx MessageError |
| 展开/收起 | 按钮可键盘激活，文案清晰（展开详情/收起详情） | thread.tsx |
| 复制错误 | 按钮 `aria-label` 或文案可理解（如「复制错误信息」） | thread.tsx |
| 恢复操作 | 重新生成、Ask 诊断、重试步骤等按钮可键盘操作，顺序合理 | thread.tsx |

## 四、ErrorToast（Composer 上方后端错误条）

| 检查项 | 说明 | 位置 |
|--------|------|------|
| 告警 | 容器 `role="alert"`、`aria-live="assertive"` | cursor-style-composer.tsx ErrorToast |
| 关闭 | 关闭按钮具备 `aria-label`（如「关闭」），键盘可聚焦并激活 | cursor-style-composer.tsx ErrorToast |

## 五、回到底部（消息列表）

| 检查项 | 说明 | 位置 |
|--------|------|------|
| 按钮 | 「回到底部」按钮具备 `aria-label`，键盘可达 | thread.tsx |

## 六、聊天消息（步骤进度、信息项、回复内容区、停止原因）

| 检查项 | 说明 | 位置 |
|--------|------|------|
| 步骤进度 | Footer 状态行（run 进行时）具备 `role="status"`、`aria-live="polite"`、`aria-label={stripLabel}`（当前步骤或「执行中」）；消息内时间线为思考块 + 工具卡片 + 正文，无单独步骤条组件 | thread.tsx ViewportFooter 状态行约 L1634 |
| 信息项/结果卡 | 可展开项具备 `aria-expanded`、`aria-label`（展开详情：工具名） | tool-fallback.tsx ProcessToolInfoCard |
| 回复内容区 | 助手消息正文区具备 `role="region"`、`aria-label`（回复内容）；不展示「结论」标题、无结论区竖线，与 Cursor 一致 | thread.tsx AssistantMessage 消息正文区 |
| 代码块复制 | 代码块头部复制按钮具备 `aria-label`（如「复制」）、键盘可聚焦 | markdown-text.tsx CodeHeader |
| 本消息依据 | 可折叠区按钮具备 `aria-expanded`、`aria-label`（展开/收起本消息依据） | thread.tsx MessageEvidenceSummary |
| Process 工具组 | 折叠按钮具备 `aria-expanded`、`aria-label`（展开/收起工具执行详情，共 n 项） | thread.tsx ToolGroupBlock |
| 停止原因提示 | loop_detected 的 toaster 可被屏幕阅读器播报（使用 `role="alert"` 或依赖 sonner 的 a11y） | MyRuntimeProvider.tsx loop_detected 分支 |
| RunSummaryCard 最后错误 | 错误区域具备 `role="alert"`、`aria-live="assertive"`，读屏可播报 | RunTracker.tsx RunSummaryCard lastError 块 |

## 六点一、单条消息内 Tab 顺序

- 建议顺序：过程组（ToolGroupBlock 折叠按钮）→ 本消息依据（MessageEvidenceSummary）→ 回复内容区 → 操作栏（BranchPicker、AssistantActionBar）；步骤进度在 Footer 状态行展示，不占消息内 Tab 流。
- 确保无跳步、无焦点陷阱；Composer、Footer 状态行、回到底部之间 Tab 顺序在布局上合理，回归时用 Tab 走一遍并记录。

## 七、对比度与视觉

- 错误/警告区域：红色与背景对比度满足 WCAG AA（正文与背景至少 4.5:1）。
- 焦点环与主题色在深色/浅色模式下均可见。
- 纯图标按钮必须配有 `aria-label` 或 `title`，避免仅靠图标传达含义。
- **i18n 与可访问性**：Composer 与 RunTracker 内所有用户可见文案及 `aria-label`、`placeholder` 均通过 i18n 提供，避免硬编码中文，以支持多语言与屏幕阅读器一致朗读。

## 八、回归建议

- 每次发布前按上表逐项用键盘（Tab/Enter/Space）走一遍，并用系统屏幕阅读器（如 VoiceOver、NVDA）听读 Composer、RunTracker、MessageError、ErrorToast、回到底部、Footer 步骤进度与消息内信息项、回复内容区、代码块复制、本消息依据、停止原因提示。
- 新增关键交互时同步补全本清单对应行。
