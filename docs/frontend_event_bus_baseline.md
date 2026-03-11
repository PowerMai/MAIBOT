# Frontend Event Bus Baseline

本基线用于约束前端 `CustomEvent` 的生产/消费关系，避免事件名漂移与联动断点。

## Scope

- 常量定义：`frontend/desktop/src/lib/constants.ts`
- 主要事件：`COMPOSER_PREFS_CHANGED`、`ROLE_CHANGED`、`CHAT_MODE_CHANGED`、`SKILL_PROFILE_CHANGED`、`LICENSE_TIER_CHANGED`、`TASK_PROGRESS`、`SWITCH_LEFT_PANEL`、`OPEN_CHAT_PANEL`、`SETTINGS_AUTO_SAVE_CHANGED`

## Event Matrix

| Event | Producers | Consumers | Detail Contract |
| --- | --- | --- | --- |
| `EVENTS.COMPOSER_PREFS_CHANGED` | `cursor-style-composer.tsx`, `thread.tsx`, `WorkspaceDashboard.tsx`, `SettingsView.tsx`, `FullEditorV2Enhanced.tsx`, `licenseTier.ts` | `thread.tsx`, `WorkspaceDashboard.tsx`, `KnowledgeBasePanel.tsx`, `SettingsView.tsx`, `FullEditorV2Enhanced.tsx`, `cursor-style-composer.tsx`, `AgentCapabilities.tsx` | `{}` |
| `EVENTS.ROLE_CHANGED` | `cursor-style-composer.tsx`, `WorkspaceDashboard.tsx`, `SettingsView.tsx`, `FullEditorV2Enhanced.tsx` | `WorkspaceDashboard.tsx`, `KnowledgeBasePanel.tsx`, `FullEditorV2Enhanced.tsx`, `model-selector.tsx`, `AgentCapabilities.tsx` | `{ roleId: string, source?: string }` |
| `EVENTS.CHAT_MODE_CHANGED` | `WorkspaceDashboard.tsx`, `FullEditorV2Enhanced.tsx` | `thread.tsx`, `cursor-style-composer.tsx` | `{ mode: "agent" \| "plan" \| "ask" \| "debug" }` |
| `EVENTS.SKILL_PROFILE_CHANGED` | `cursor-style-composer.tsx`, `WorkspaceDashboard.tsx`, `SettingsView.tsx`, `FullEditorV2Enhanced.tsx` | （当前主要用于广播，消费方以 `COMPOSER_PREFS_CHANGED` 同步为主） | `{ profileId: string }` |
| `EVENTS.LICENSE_TIER_CHANGED` | `licenseTier.ts`（`setLicenseTier`） | `WorkspaceDashboard.tsx`, `KnowledgeBasePanel.tsx`, `SettingsView.tsx` | `{ tier: "free" \| "pro" \| "enterprise", source?: string }` |
| `EVENTS.TASK_PROGRESS` | `thread.tsx`, `TaskListSidebar.tsx` | `TaskListSidebar.tsx`, `TaskDetailView.tsx`, `FullEditorV2Enhanced.tsx`, `thread.tsx`（工具流聚合展示） | `{ message?: string }` |
| `EVENTS.SWITCH_LEFT_PANEL` | `App.tsx`, `WorkspaceDashboard.tsx`, `KnowledgeBasePanel.tsx`, `thread.tsx` | `FullEditorV2Enhanced.tsx` | `{ tab: "tasks" \| "knowledge" }` |
| `EVENTS.OPEN_CHAT_PANEL` | `SettingsView.tsx` | `FullEditorV2Enhanced.tsx` | `{}`（统一行为：展开聊天面板并聚焦输入框） |
| `EVENTS.SETTINGS_AUTO_SAVE_CHANGED` | `SettingsView.tsx` | `FullEditorV2Enhanced.tsx` | `{ enabled: boolean }` |

## 对话内任务栏规则（与 UI 门禁一致）

- **展示规则**：无 run / 无 hint / 无 autonomous 时不渲染任务栏区域；有任务时展示 phaseLabel、activeTool 与步骤进度。
- **数据源**：与 `toolStreamEventBus` 的 `task_progress`、`stream_end` 及 run 状态一致；`RunSummaryCard`、`TaskPanelHintStrip`、`AutonomousRunsStrip` 均根据上述数据派生，无任务时 return null 或条件不渲染。
- **验收**：与 [UI_RELEASE_QUALITY_GATE.md](UI_RELEASE_QUALITY_GATE.md) 联动一致性门禁一致；主操作结果与聊天区、任务面板、通知中心联动正确。

## Rules

1. 禁止新增硬编码事件字符串，统一通过 `EVENTS.*` 引用。
2. 新增事件时，必须在本文件补齐 Producer/Consumer 与 `detail` 契约。
3. 涉及角色/模式/tier 联动的事件，必须同时触发 `EVENTS.COMPOSER_PREFS_CHANGED` 以保证同 tab 即时同步。
4. 事件 payload 只做追加字段，不做破坏式改名。

## Quick Verification

可使用以下命令快速检查是否出现硬编码回归：

- `rg "\"composer_prefs_changed\"|'composer_prefs_changed'" frontend/desktop/src`
- `rg "\"role_changed\"|'role_changed'" frontend/desktop/src`
- `rg "\"chat_mode_changed\"|'chat_mode_changed'" frontend/desktop/src`
- `rg "\"skill_profile_changed\"|'skill_profile_changed'" frontend/desktop/src`
- `rg "\"license_tier_changed\"|'license_tier_changed'" frontend/desktop/src`
- `rg "\"task_progress\"|'task_progress'" frontend/desktop/src`
- `rg "\"switch_left_panel\"|'switch_left_panel'" frontend/desktop/src`
