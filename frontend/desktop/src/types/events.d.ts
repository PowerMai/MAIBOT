/**
 * CustomEvent detail 类型与 WindowEventMap 扩展
 * 供 addEventListener / dispatchEvent 获得正确类型，避免 as any
 */

/** 运行摘要更新事件 payload（与 runSummaryState / RunTracker 一致） */
export interface RunSummaryUpdatedDetail {
  running?: boolean;
  phaseLabel?: string;
  activeTool?: string;
  elapsedSec?: number;
  lastError?: string;
  recentFailures?: string[];
  linkedTaskId?: string;
  linkedThreadId?: string;
  linkedSubject?: string;
}

/**
 * TASK_PROGRESS 事件 detail 类型（与 main_graph task_progress / write_todos 推送一致）。
 * 可选字段：message 进度文案；phase/step/tool/tool_call_id 步骤信息；waited_ms 等待毫秒；
 * todos 当前 run 的任务列表（id/content/status）；threadId/taskId/source 来源标识。
 */
export interface TaskProgressDetail {
  message?: string;
  phase?: string;
  step?: string | number;
  tool?: string;
  tool_call_id?: string;
  waited_ms?: number;
  todos?: Array<{ id?: string; content?: string; status?: string }>;
  threadId?: string;
  taskId?: string;
  source?: string;
}

/** 与 EVENTS 常量值一致的自定义事件名 → detail 类型（未列出的为 CustomEvent<unknown>） */
declare global {
  interface WindowEventMap {
    session_changed: CustomEvent<{ threadId?: string; title?: string; roleId?: string; mode?: string; workspacePath?: string }>;
    session_created: CustomEvent<{ threadId?: string; title?: string; roleId?: string; mode?: string; workspacePath?: string }>;
    role_changed: CustomEvent<{ roleId?: string; threadId?: string; source?: string }>;
    chat_mode_changed: CustomEvent<{ mode?: string; threadId?: string }>;
    run_summary_updated: CustomEvent<RunSummaryUpdatedDetail | Record<string, unknown> | null>;
    composer_prefs_changed: CustomEvent<unknown>;
    license_tier_changed: CustomEvent<unknown>;
    focus_mode_changed: CustomEvent<unknown>;
    collab_center_open: CustomEvent<unknown>;
    switch_to_thread: CustomEvent<{ threadId?: string }>;
    workspace_context_changed: CustomEvent<unknown>;
    context_items_changed: CustomEvent<unknown>;
    fill_prompt: CustomEvent<unknown>;
    composer_submit: CustomEvent<unknown>;
    followup_message: CustomEvent<unknown>;
    plan_confirmed: CustomEvent<unknown>;
    plan_edit_request: CustomEvent<unknown>;
    plan_revert_request: CustomEvent<unknown>;
    editor_ask_context: CustomEvent<unknown>;
    open_chat_panel: CustomEvent<unknown>;
    settings_auto_save_changed: CustomEvent<{ enabled?: boolean }>;
    new_thread_request: CustomEvent<unknown>;
    stop_generation_request: CustomEvent<unknown>;
    confirm_cloud_model: CustomEvent<unknown>;
    command_palette_command: CustomEvent<{ commandId: string }>;
    open_command_palette: CustomEvent<unknown>;
    open_editor_command_palette: CustomEvent<unknown>;
    open_shortcuts_help: CustomEvent<unknown>;
    connection_retry_request: CustomEvent<unknown>;
    focus_composer: CustomEvent<unknown>;
    open_task_in_editor: CustomEvent<{ taskId: string; subject: string; focusSection?: 'result' }>;
    autonomous_schedule_triggered: CustomEvent<unknown>;
    autonomous_watcher_config_changed: CustomEvent<unknown>;
    capability_action: CustomEvent<unknown>;
    artifact_focus_request: CustomEvent<unknown>;
    message_focus_request: CustomEvent<unknown>;
    switch_left_panel: CustomEvent<{ tab: 'workspace' | 'knowledge' | 'tasks' }>;
    open_file_in_editor: CustomEvent<unknown>;
    add_file_to_context: CustomEvent<unknown>;
    knowledge_updated: CustomEvent<unknown>;
    editor_selection_changed: CustomEvent<unknown>;
    task_progress: CustomEvent<TaskProgressDetail>;
    tool_result_for_ui: CustomEvent<{ threadId?: string; messageId?: string; tool_call_id?: string; result_preview?: string }>;
    backend_error: CustomEvent<unknown>;
    context_stats: CustomEvent<unknown>;
    thread_list_focus_search: CustomEvent<unknown>;
    ui_stream_metrics_summary: CustomEvent<unknown>;
    persona_changed: CustomEvent<unknown>;
    task_panel_thread_hint: CustomEvent<unknown>;
    // 状态栏/运行态（未在 EVENTS 中常量化，但需类型安全）
    task_running: CustomEvent<{ running?: boolean }>;
    model_changed: CustomEvent<{ modelId: string }>;
    editor_ai_action: CustomEvent<{ action: string; text?: string; range?: { startLine: number; endLine: number }; filePath?: string }>;
    send_selection_to_chat: CustomEvent<unknown>;
    get_selected_code: CustomEvent<{ callback: (code: string, filePath: string, lineRange: string) => void }>;
    open_workspace_file_picker: CustomEvent<{ callback: (path: string, name: string) => void }>;
    open_folder_picker: CustomEvent<{ callback: (folderPath: string, folderName: string) => void }>;
  }
}

export {};
