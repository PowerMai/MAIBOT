/**
 * 统一诊断信息剪贴板格式（与 Claude/Cursor 错误复制结构对齐）
 * 供 RunTracker 复制诊断、MessageError 复制错误共用
 */

export interface FormatDiagnosticsOptions {
  threadId?: string;
  runId?: string;
  taskId?: string;
  lastError?: string;
  recentFailures?: string[];
  mode?: string;
  workspacePath?: string;
  phaseLabel?: string;
  activeTool?: string;
  elapsedSec?: number;
}

const TITLE = "--- 诊断信息 ---";

export function formatDiagnosticsClipboard(opts: FormatDiagnosticsOptions): string {
  const {
    threadId,
    runId,
    taskId,
    lastError,
    recentFailures = [],
    mode,
    workspacePath,
    phaseLabel,
    activeTool,
    elapsedSec,
  } = opts;
  const lines: string[] = [TITLE];
  if (threadId != null && threadId !== "") lines.push(`Thread: ${threadId}`);
  if (runId != null && runId !== "") lines.push(`RunId: ${runId}`);
  if (taskId != null && taskId !== "") lines.push(`Task: ${taskId}`);
  if (mode != null && mode !== "") lines.push(`Mode: ${mode}`);
  if (workspacePath != null && workspacePath !== "") lines.push(`Workspace: ${workspacePath}`);
  if (phaseLabel != null && phaseLabel !== "") lines.push(`Phase: ${phaseLabel}`);
  if (activeTool != null && activeTool !== "") lines.push(`Tool: ${activeTool}`);
  if (typeof elapsedSec === "number") lines.push(`Elapsed: ${elapsedSec}s`);
  lines.push(`LastError: ${lastError ?? "-"}`);
  const failureSummary = Array.isArray(recentFailures) && recentFailures.length > 0
    ? recentFailures.slice(0, 5).join(" | ")
    : "-";
  lines.push(`RecentFailures: ${failureSummary}`);
  return lines.join("\n");
}
