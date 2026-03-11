import { EVENTS } from "../constants";

export interface AutonomousScheduleRun {
  task_id?: string;
  subject?: string;
  slot?: string;
  triggered_at?: string;
  thread_id?: string;
  run_id?: string;
  matched_task_id?: string;
}

export interface AutonomousScheduleEventDetail {
  run: AutonomousScheduleRun;
  key: string;
}

const dedupeCache = new Map<string, number>();
const DEDUPE_WINDOW_MS = 20_000;

export function buildAutonomousScheduleEventKey(run: AutonomousScheduleRun): string {
  return `${run.thread_id || ""}|${run.triggered_at || ""}|${run.slot || ""}`;
}

export function shouldHandleAutonomousScheduleKey(key: string): boolean {
  if (!key) return false;
  const now = Date.now();
  for (const [k, ts] of dedupeCache.entries()) {
    if (now - ts > DEDUPE_WINDOW_MS) dedupeCache.delete(k);
  }
  const prev = dedupeCache.get(key);
  if (prev && now - prev <= DEDUPE_WINDOW_MS) return false;
  dedupeCache.set(key, now);
  return true;
}

export function dispatchAutonomousScheduleEvent(detail: AutonomousScheduleEventDetail): void {
  window.dispatchEvent(new CustomEvent(EVENTS.AUTONOMOUS_SCHEDULE_TRIGGERED, { detail }));
}

export function subscribeAutonomousScheduleEvent(
  handler: (detail: AutonomousScheduleEventDetail) => void
): () => void {
  const listener = (e: Event) => {
    const ce = e as CustomEvent<AutonomousScheduleEventDetail>;
    if (!ce.detail || !ce.detail.run || !ce.detail.key) return;
    if (!shouldHandleAutonomousScheduleKey(ce.detail.key)) return;
    handler(ce.detail);
  };
  window.addEventListener(EVENTS.AUTONOMOUS_SCHEDULE_TRIGGERED, listener);
  return () => window.removeEventListener(EVENTS.AUTONOMOUS_SCHEDULE_TRIGGERED, listener);
}
