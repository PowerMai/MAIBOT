/**
 * 应用常量配置
 * 
 * 集中管理事件名称等常量，避免硬编码
 */

// ============================================================================
// 事件名称
// ============================================================================

export const EVENTS = {
  // 任务/对话闭环（仪表盘 ↔ Chat，单一路径）
  FILL_PROMPT: 'fill_prompt',
  COMPOSER_SUBMIT: 'composer_submit',
  // 工具卡片触发的普通跟进消息（不改变 Plan 确认状态）
  FOLLOWUP_MESSAGE: 'followup_message',
  // Plan 模式确认执行（会影响后端 plan_confirmed 门禁）
  PLAN_CONFIRMED: 'plan_confirmed',
  // Plan 模式修改请求（不改变 plan_confirmed）
  PLAN_EDIT_REQUEST: 'plan_edit_request',
  // Plan 模式回退请求（不改变 plan_confirmed）
  PLAN_REVERT_REQUEST: 'plan_revert_request',
  SWITCH_TO_THREAD: 'switch_to_thread',
  // 编辑区 → 对话区联动：携带当前文件/选中内容打开对话并填入上下文
  EDITOR_ASK_CONTEXT: 'editor_ask_context',
  // 请求打开对话面板（由布局组件监听并 setShowChat(true)）
  OPEN_CHAT_PANEL: 'open_chat_panel',
  // 编辑器自动保存开关变更（设置页保存后广播）
  SETTINGS_AUTO_SAVE_CHANGED: 'settings_auto_save_changed',
  // 请求新建对话（Cmd+Shift+O，由 ThreadList 监听并触发新建）
  NEW_THREAD_REQUEST: 'new_thread_request',
  // 请求停止当前对话生成（由 Composer 监听并调用 cancelRun）
  STOP_GENERATION_REQUEST: 'stop_generation_request',
  // 云端模型使用确认（异步弹窗，由 Thread 层 AlertDialog 承接，避免 window.confirm 阻塞流）
  CONFIRM_CLOUD_MODEL: 'confirm_cloud_model',
  // 命令面板命令分发（App/编辑区统一消费）
  COMMAND_PALETTE_COMMAND: 'command_palette_command',
  // 请求打开全局命令面板
  OPEN_COMMAND_PALETTE: 'open_command_palette',
  // 请求打开编辑器命令面板
  OPEN_EDITOR_COMMAND_PALETTE: 'open_editor_command_palette',
  // 请求打开快捷键帮助对话框
  OPEN_SHORTCUTS_HELP: 'open_shortcuts_help',
  // Composer 断线时请求重连（由 FullEditor 监听并调用 handleConnectionClick）
  CONNECTION_RETRY_REQUEST: 'connection_retry_request',
  // 请求聚焦聊天输入框
  FOCUS_COMPOSER: 'focus_composer',
  // 在编辑区打开任务详情（由左侧任务列表/仪表盘触发）
  OPEN_TASK_IN_EDITOR: 'open_task_in_editor',
  // 在右侧控制台展示任务执行过程（由左侧任务列表「在控制台查看」触发）
  OPEN_TASK_IN_CONSOLE: 'open_task_in_console',
  // 自治调度触发（任务面板/聊天区/通知中心联动）
  AUTONOMOUS_SCHEDULE_TRIGGERED: 'autonomous_schedule_triggered',
  // 自治巡检配置变更（TaskPanel/Settings 联动刷新）
  AUTONOMOUS_WATCHER_CONFIG_CHANGED: 'autonomous_watcher_config_changed',
  // 工作区根切换后，触发上下文重置与线程隔离
  WORKSPACE_CONTEXT_CHANGED: 'workspace_context_changed',
  // 组合器偏好变更（角色/模式/联网等）
  COMPOSER_PREFS_CHANGED: 'composer_prefs_changed',
  // 会话切换（统一替代 thread_changed）
  SESSION_CHANGED: 'session_changed',
  // 会话创建（新建线程后广播）
  SESSION_CREATED: 'session_created',
  // Agent 档案/助理名更新（设置页保存后广播，欢迎区等可刷新显示名）
  AGENT_PROFILE_CHANGED: 'agent_profile_changed',
  // 角色切换
  ROLE_CHANGED: 'role_changed',
  // 对话模式切换
  CHAT_MODE_CHANGED: 'chat_mode_changed',
  /** 本 run 实际使用的模型已解析（session_context.modelId），便于 UI 展示「当前由哪台模型在服务」 */
  RUN_MODEL_RESOLVED: 'run_model_resolved',
  // Skill profile 切换
  SKILL_PROFILE_CHANGED: 'skill_profile_changed',
  // License tier 切换
  LICENSE_TIER_CHANGED: 'license_tier_changed',
  // 运行进度事件
  TASK_PROGRESS: 'task_progress',
  /** 工具结果即时推送（tool_result 到达时带 messageId，供工具卡片在 merge 前展示） */
  TOOL_RESULT_FOR_UI: 'tool_result_for_ui',
  // 聊天运行摘要更新（Chat ↔ Workspace Dashboard）
  RUN_SUMMARY_UPDATED: 'run_summary_updated',
  // 协作中心入口（全局壳层 ↔ Workspace Dashboard）
  COLLAB_CENTER_OPEN: 'collab_center_open',
  // 能力提升动作（Dashboard 卡片 → App/Thread 统一消费）
  CAPABILITY_ACTION: 'capability_action',
  // 全局专注态变更（壳层/仪表盘/线程列表同步）
  FOCUS_MODE_CHANGED: 'focus_mode_changed',
  // Artifact 与消息双向定位
  ARTIFACT_FOCUS_REQUEST: 'artifact_focus_request',
  MESSAGE_FOCUS_REQUEST: 'message_focus_request',
  // 切换左侧面板
  SWITCH_LEFT_PANEL: 'switch_left_panel',
  // 在编辑区打开文件并可选展示 diff（来自聊天区 Apply 等）
  OPEN_FILE_IN_EDITOR: 'open_file_in_editor',
  // 打开二进制对比（原 vs 新），接受/另存为/拒绝
  OPEN_BINARY_DIFF: 'open_binary_diff',
  // 将文件/路径添加到对话上下文（文件树、知识库等触发）
  ADD_FILE_TO_CONTEXT: 'add_file_to_context',
  // 将文件夹添加到对话上下文（文件树右键触发）
  ADD_FOLDER_TO_CONTEXT: 'add_folder_to_context',
  // 知识库有更新（左侧面板 Knowledge tab 显示徽章）
  KNOWLEDGE_UPDATED: 'knowledge_updated',
  // 编辑器选区变更（Composer 显示「添加为上下文」提示条）
  EDITOR_SELECTION_CHANGED: 'editor_selection_changed',
  // 编辑器当前打开文件变更（Apply 按钮 hasActiveFile 同步）
  ACTIVE_FILE_PATH_CHANGED: 'active_file_path_changed',
  // 请求打开设置页（如从任务详情「查看执行日志」）
  OPEN_SETTINGS: 'open_settings',
  // 请求创建引导示例任务（设置页/工作台空态「创建示例任务」触发）
  CREATE_ONBOARDING_SAMPLE_TASK: 'create_onboarding_sample_task',
  // 联网搜索开关变更
  WEB_SEARCH_CHANGED: 'web_search_changed',
  // 上下文项变更（附件列表）
  CONTEXT_ITEMS_CHANGED: 'context_items_changed',
  // 用户消息已发送
  MESSAGE_SENT: 'message_sent',
  // 后端错误（Toast 等）
  BACKEND_ERROR: 'backend_error',
  // 上下文统计（流式结束后或刷新）
  CONTEXT_STATS: 'context_stats',
  // 打开文件夹选择器（添加文件夹到上下文）
  OPEN_FOLDER_PICKER: 'open_folder_picker',
  // 打开工作区文件选择器（从已打开文件选为附件）
  OPEN_WORKSPACE_FILE_PICKER: 'open_workspace_file_picker',
  // 打开工作区树形选择器（从工作区目录树选文件加入 Composer，可不先打开文件）
  OPEN_WORKSPACE_TREE_PICKER: 'open_workspace_tree_picker',
  // 请求 Composer 打开本地上传（工作区选择弹窗空态等触发）
  TRIGGER_COMPOSER_FILE_UPLOAD: 'trigger_composer_file_upload',
  // 获取当前选中代码（编辑器 → 聊天区）
  GET_SELECTED_CODE: 'get_selected_code',
  // 请求打开 Skills 面板（结晶 Toast 等触发）
  OPEN_SKILLS_PANEL: 'open_skills_panel',
  // 线程已删除（设置页/会话列表删除后广播，会话列表搜索数据同步过滤）
  THREAD_DELETED: 'thread_deleted',
  // 请求聚焦会话列表搜索框（命令面板「搜索对话」等触发）
  THREAD_LIST_FOCUS_SEARCH: 'thread_list_focus_search',
  // 流式 UI 指标摘要（RunTracker/DEV 指标等消费）
  UI_STREAM_METRICS_SUMMARY: 'ui_stream_metrics_summary',
  // 人设/角色人格变更（设置页保存后广播）
  PERSONA_CHANGED: 'persona_changed',
  // 任务面板线程提示（创建任务后提示关联 thread）
  TASK_PANEL_THREAD_HINT: 'task_panel_thread_hint',
  // 工具/计划等中断已确认或拒绝，同一会话内继续（携带 run_id 供接流续显）
  INTERRUPT_RESOLVED: 'interrupt_resolved',
} as const;

/** 会话切换等待 SESSION_CHANGED 的超时（毫秒），编辑器内与仪表盘统一使用 */
export const SESSION_SWITCH_TIMEOUT_MS = 3000;

export interface SessionChangedDetail {
  threadId: string;
  title?: string;
  roleId?: string;
  mode?: string;
  workspacePath?: string;
}

export interface SessionCreatedDetail extends SessionChangedDetail {}

export interface RoleChangedDetail {
  roleId: string;
  threadId?: string;
  source?: string;
}

export interface ChatModeChangedDetail {
  mode: 'agent' | 'plan' | 'ask' | 'debug' | 'review';
  threadId?: string;
}

/** TASK_PROGRESS 事件 detail 类型，与 events.d.ts 一致，供监听方按可选字段读取 */
export type { TaskProgressDetail } from '../types/events';
