/**
 * 推荐流程与模式下一步提示 — 单源定义
 * 供 AgentCapabilities、ThreadWelcome、cursor-style-composer 等引用，与 FOUR_MODES_DESIGN 对齐
 */

export type ChatModeKey = "agent" | "ask" | "plan" | "debug" | "review";

/** 一句推荐流程（探讨 → 规划 → 执行） */
export const RECOMMENDED_FLOW_SHORT =
  "探讨(Ask) → 规划(Plan) → 执行(Agent)";

/** 按模式给出「建议下一步」短句 */
export const NEXT_STEP_BY_MODE: Record<ChatModeKey, string> = {
  ask: "需要落地时建议切 Plan 或 Agent",
  plan: "确认计划后可切换 Agent 执行",
  agent: "执行完成后可切 Review 做清单评审",
  debug: "根因确认后可切 Agent 执行修复",
  review: "评审完成后可切 Plan 或 Agent 落实改进",
};
