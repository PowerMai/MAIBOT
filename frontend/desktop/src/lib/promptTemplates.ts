/**
 * Composer 快捷提示词书签：默认列表与持久化（localStorage）。
 * 与 cursor-style-composer 的 PROMPT_TEMPLATES 对齐；设置页「编辑书签」读写此处。
 */

import { getItem, setItem } from "./safeStorage";

export type PromptTemplate = { id: string; label: string; text: string; modes?: string[] };

const STORAGE_KEY = "maibot_prompt_templates";

export const DEFAULT_PROMPT_TEMPLATES: PromptTemplate[] = [
  { id: "explain", label: "解释代码", text: "请解释以下代码的作用和关键逻辑：\n\n{{code}}", modes: ["agent", "ask", "debug"] },
  { id: "refactor", label: "重构优化", text: "请在不改变行为的前提下重构并优化以下代码：\n\n{{code}}", modes: ["agent"] },
  { id: "test", label: "生成测试", text: "请为以下代码编写单元测试：\n\n{{code}}", modes: ["agent"] },
  { id: "fix", label: "修复错误", text: "以下代码报错，请分析原因并给出修复方案：\n\n{{error}}\n\n相关代码：\n{{code}}", modes: ["agent", "debug"] },
  { id: "summarize", label: "总结文档", text: "请对以下内容进行结构化总结，输出要点列表：\n\n{{content}}", modes: ["agent", "plan", "ask", "review"] },
  { id: "translate", label: "中英互译", text: "请将以下内容翻译为目标语言，保持专业术语准确：\n\n{{content}}", modes: ["agent", "ask"] },
  { id: "review_pr", label: "PR 代码审查", text: "请对以下代码变更进行 Code Review，按严重级别分类问题与改进建议：\n\n{{code}}", modes: ["agent", "review"] },
  { id: "task_plan", label: "任务拆解", text: "请将以下需求拆解为具体可执行的子任务列表：\n\n{{goal}}", modes: ["agent", "plan"] },
  { id: "debug_trace", label: "调试追踪", text: "请分析以下错误/日志，定位根因并给出修复建议：\n\n{{content}}", modes: ["agent", "debug"] },
  { id: "write_doc", label: "生成文档", text: "请为以下代码/功能生成结构化文档（用途、参数、示例）：\n\n{{code}}", modes: ["agent"] },
];

function isValidTemplate(t: unknown): t is PromptTemplate {
  return (
    t != null &&
    typeof t === "object" &&
    typeof (t as PromptTemplate).id === "string" &&
    typeof (t as PromptTemplate).label === "string" &&
    typeof (t as PromptTemplate).text === "string"
  );
}

export function getPromptTemplates(): PromptTemplate[] {
  try {
    const raw = getItem(STORAGE_KEY, "");
    if (!raw.trim()) return [...DEFAULT_PROMPT_TEMPLATES];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [...DEFAULT_PROMPT_TEMPLATES];
    const list = parsed.filter(isValidTemplate);
    return list.length > 0 ? list : [...DEFAULT_PROMPT_TEMPLATES];
  } catch {
    return [...DEFAULT_PROMPT_TEMPLATES];
  }
}

export function setPromptTemplates(templates: PromptTemplate[]): void {
  const sanitized = templates.filter(isValidTemplate);
  setItem(STORAGE_KEY, JSON.stringify(sanitized));
}

export function resetPromptTemplatesToDefault(): void {
  setItem(STORAGE_KEY, "");
}
