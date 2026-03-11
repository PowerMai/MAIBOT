export type ResultIssueKind = "权限" | "路径" | "参数" | "网络" | "限流";

export const RESULT_ISSUE_REGEX =
  /(permission denied|access denied|forbidden|unauthorized|权限|鉴权|拒绝|not found|no such file|enoent|路径|文件不存在|invalid argument|invalid parameter|参数错误|类型错误|type error|timeout|timed out|超时|connection refused|network error|网络错误|rate limit|限流|429)/gi;

export function classifyResultIssueToken(token: string): ResultIssueKind | null {
  const t = String(token || "").toLowerCase();
  if (!t) return null;
  if (/permission denied|access denied|forbidden|unauthorized|权限|鉴权|拒绝/.test(t)) return "权限";
  if (/not found|no such file|enoent|路径|文件不存在/.test(t)) return "路径";
  if (/invalid argument|invalid parameter|参数错误|类型错误|type error/.test(t)) return "参数";
  if (/timeout|timed out|超时|connection refused|network error|网络错误/.test(t)) return "网络";
  if (/rate limit|限流|429/.test(t)) return "限流";
  return null;
}

export function extractResultIssueHints(text: string): ResultIssueKind[] {
  const raw = String(text || "");
  if (!raw) return [];
  const found = new Set<ResultIssueKind>();
  const matches = raw.match(RESULT_ISSUE_REGEX) || [];
  for (const m of matches) {
    const kind = classifyResultIssueToken(m);
    if (kind) found.add(kind);
  }
  return Array.from(found);
}

const ISSUE_RECOMMENDATIONS: Record<ResultIssueKind, string> = {
  权限: "检查当前模型/工具所需凭据是否配置（API Key、角色权限、可访问范围）。",
  路径: "确认工作区路径与文件名是否正确，优先使用绝对路径并检查文件是否存在。",
  参数: "核对工具参数类型与必填字段，避免空值、字段名错误或不支持的枚举值。",
  网络: "检查网络连通性与目标服务状态，必要时增加重试或切换可用端点。",
  限流: "降低并发或延时重试，必要时切换模型/服务层级避免 429 高频触发。",
};

export function getResultIssueRecommendations(kinds: ResultIssueKind[]): string[] {
  const ordered: ResultIssueKind[] = ["权限", "路径", "参数", "网络", "限流"];
  const set = new Set(kinds);
  const result: string[] = [];
  for (const k of ordered) {
    if (set.has(k)) result.push(ISSUE_RECOMMENDATIONS[k]);
  }
  return result;
}
