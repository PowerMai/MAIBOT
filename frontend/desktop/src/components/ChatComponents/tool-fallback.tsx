/**
 * 工具 UI 组件 - Cursor 风格 v3
 * 
 * 核心原则：
 * 1. 进度可见 - 让用户看到实际的进展
 * 2. 结果优先 - 完成后显示有意义的结果摘要
 * 3. 简洁但信息丰富 - 一行显示关键信息
 * 4. 状态清晰 - 运行中/完成/错误状态一目了然
 */
/// <reference types="vite/client" />

import React, { useState, useCallback, useEffect, useContext } from "react";
import { makeAssistantToolUI, useMessage } from "@assistant-ui/react";
import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  XCircleIcon,
  FileTextIcon,
  SearchIcon,
  CodeIcon,
  FileIcon,
  AlertCircleIcon,
  LoaderIcon,
  CheckCircleIcon,
  FolderOpenIcon,
  PencilIcon,
  EyeIcon,
  TrashIcon,
  ListChecksIcon,
  TerminalIcon,
  GlobeIcon,
  MessageCircleIcon,
  BrainIcon,
  PackageIcon,
  PlayIcon,
  SparklesIcon,
  CopyIcon,
  ExternalLinkIcon,
  RefreshCwIcon,
  RotateCcwIcon,
} from "lucide-react";
import { cn } from "../ui/utils";
import { Button } from "../ui/button";
import { toast } from "sonner";
import { toolStreamEventBus, ToolStreamEvent } from "../../lib/events/toolStreamEvents";
import { fileEventBus } from "../../lib/events/fileEvents";
import { EVENTS } from "../../lib/constants";
import { t } from "../../lib/i18n";
import { getItem as getStorageItem, setItem as setStorageItem, removeItem as removeStorageItem } from "../../lib/safeStorage";
import { getCurrentThreadIdFromStorage } from "../../lib/sessionState";
import { setScopedChatMode } from "../../lib/chatModeState";
import { getInterruptState, resumeInterrupt, validServerThreadIdOrUndefined } from "../../lib/api/langserveChat";
import { GenerativeUI } from "./generative-ui";
import { InlineDiffView } from "./inline-diff";
import { ToolActionContext, ToolResultsByMessageIdContext, InterruptStateContext } from "./thread";

// ============================================================
// 调试模式开关 - 用户级 vs 开发者级信息
// ============================================================
const DEBUG_MODE = import.meta.env?.DEV || false;

// ============================================================
// 通用工具状态 Hook - 统一状态管理
// ============================================================
function useToolStatus(status?: { type: string }) {
  return {
    isRunning: status?.type === "running",
    isComplete: status?.type === "complete",
    isIncomplete: status?.type === "incomplete",
  };
}

function useToolElapsedSeconds(status?: { type: string }) {
  const isRunning = status?.type === "running";
  const [elapsed, setElapsed] = useState(0);
  const startRef = React.useRef<number | null>(null);

  useEffect(() => {
    if (!isRunning) {
      if (startRef.current != null) {
        setElapsed(Math.max(1, Math.floor((Date.now() - startRef.current) / 1000)));
      }
      startRef.current = null;
      return;
    }
    if (startRef.current == null) startRef.current = Date.now();
    const timer = setInterval(() => {
      if (startRef.current != null) {
        setElapsed(Math.max(1, Math.floor((Date.now() - startRef.current) / 1000)));
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [isRunning]);

  return elapsed;
}

// ============================================================
// 通用简单工具 UI - 用于结构相似的工具
// ============================================================
interface SimpleToolConfig {
  icon: React.ReactNode;
  iconColor: string;
  displayName: string;
  getQuery?: (args: any) => string;
  getCount?: (result: string) => { count: number; unit: string };
  expandable?: boolean;
  /** 隐形工具：不在聊天中显示（hidden tier） */
  hidden?: boolean;
}

function createSimpleToolUI<TArgs extends Record<string, any>>(
  toolName: string,
  config: SimpleToolConfig
) {
  return makeAssistantToolUI<TArgs, string>({
    toolName,
    render: function SimpleToolRender({ args, result, status, toolCallId }) {
      const messageId = useMessage((s) => (s as { id?: string }).id);
      const toolResultsMap = useContext(ToolResultsByMessageIdContext);
      const fallbackResult = messageId && toolCallId ? toolResultsMap.get(messageId)?.[toolCallId] : undefined;
      const displayResult = (result != null && result !== "") ? result : (fallbackResult ?? "");
      const { retryTool } = React.useContext(ToolActionContext);
      const { isRunning, isComplete } = useToolStatus(status);
      const [showResults, setShowResults] = useState(false);
      
      const query = config.getQuery?.(args) || "";
      const shortQuery = query.length > 40 ? query.slice(0, 40) + "..." : query;
      const countInfo = config.getCount && displayResult ? config.getCount(displayResult) : null;
      const canExpand = config.expandable !== false && displayResult;
      
      if (config.hidden) return null;
      
      return (
        <div className="my-1.5">
          <button
            type="button"
            onClick={() => canExpand && setShowResults(!showResults)}
            className={cn(
              "inline-flex items-center gap-1.5 text-sm rounded px-1.5 py-0.5 -ml-1.5 transition-colors",
              canExpand && "hover:bg-muted/30"
            )}
            aria-expanded={canExpand ? showResults : undefined}
            aria-label={canExpand ? t("toolCard.expandCollapseResult") : undefined}
          >
            {isRunning ? (
              <LoaderIcon className={cn("size-3.5 animate-spin", config.iconColor)} />
            ) : (
              <CheckIcon className="size-3.5 text-emerald-500" />
            )}
            <span className={config.iconColor}>{config.icon}</span>
            <span className="text-foreground">{config.displayName}</span>
            {shortQuery && <span className="text-muted-foreground font-mono text-xs">{shortQuery}</span>}
            
            {isRunning ? (
              <span className="text-xs text-muted-foreground"><ProgressDots /></span>
            ) : isComplete && (
              <span className="text-xs text-muted-foreground">
                {countInfo && `· ${countInfo.count} ${countInfo.unit}`}
                {!displayResult && "· "}
                {!displayResult && t("toolCard.resultNotReturned")}
                {canExpand && (showResults ? <ChevronDownIcon className="size-3 inline ml-1" /> : <ChevronRightIcon className="size-3 inline ml-1" />)}
              </span>
            )}
          </button>
          {isComplete && !displayResult && !config.hidden && (
            <div className="mt-1 ml-5 text-[12px] text-muted-foreground/90">
              {t("toolCard.resultNotReturned")}
            </div>
          )}
          {showResults && displayResult && isComplete && (
            <div className="mt-1 ml-5 space-y-1">
              <ToolActionBar
                actions={[
                  { label: t("toolCard.runAgain"), icon: <RefreshCwIcon className="size-3" />, onClick: () => retryTool(toolName, (args ?? {}) as Record<string, unknown>) },
                  { label: t("toolCard.copyResult"), icon: <CopyIcon className="size-3" />, onClick: () => copyToClipboard(displayResult) },
                ]}
              />
              <div className="text-xs text-muted-foreground whitespace-pre-wrap max-h-[300px] overflow-auto">
                {displayResult}
              </div>
            </div>
          )}
        </div>
      );
    },
  });
}

// ============================================================
// JSON 结果用户友好显示 - 将 JSON 转换为用户可理解的格式
// 支持招投标业务的专业显示（五维分析、响应矩阵、风险评估）
// ============================================================
interface ParsedResult {
  status?: string;
  document?: string;
  summary?: string;
  findings?: Array<{ item?: string; finding?: string; source?: string; loc?: string; location?: string; quote?: string; level?: string }>;
  evidence?: Array<{ finding?: string; source?: string; location?: string; quote?: string }>;
  output?: {
    type?: string;
    path?: string;
    charts?: string[];
    preview?: string;
  };
  for_next_step?: string;
  error?: string;
  // 增强的输出字段
  charts?: string[];
  tables?: Array<{
    title?: string;
    headers?: string[];
    rows?: string[][];
  }>;
  key_info?: {
    project?: { name?: string; number?: string; budget?: string; deadline?: string; location?: string };
    structure?: string;
    findings?: Array<{ item?: string; source?: string; loc?: string; quote?: string }>;
  };
  quality_criteria?: {
    depth?: string;
    dimensions?: string[];
    output_quality?: string;
  };
  // ✅ 招投标业务专用字段
  bidding?: {
    // 五维分析结果
    D1_project?: { budget?: string; deadline?: string; location?: string };
    D2_qualify?: { mandatory?: string[]; disqualify?: string[]; starred?: string[] };
    D3_technical?: { params?: string[]; quantity?: string };
    D4_commercial?: { payment?: string; warranty?: string };
    D5_scoring?: { items?: Array<{ name: string; score: number; weight?: string }>; total?: number };
    // 风险评估
    risks?: Array<{ level: 'high' | 'medium' | 'low'; item: string; reason?: string }>;
    // 响应矩阵
    response_matrix?: Array<{ requirement: string; status: string; response?: string; evidence?: string }>;
  };
  // 分析进度
  progress?: {
    current_step?: string;
    total_steps?: number;
    completed_steps?: number;
    percentage?: number;
  };
}

const UserFriendlyResult: React.FC<{ 
  result: string; 
  toolName: string;
  showDebug?: boolean;
}> = ({ result, toolName, showDebug = DEBUG_MODE }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  
  // 尝试解析 JSON
  const parsed = React.useMemo<ParsedResult | null>(() => {
    if (!result) return null;
    try {
      return JSON.parse(result);
    } catch {
      return null;
    }
  }, [result]);
  
  // 如果不是 JSON，直接显示文本
  if (!parsed) {
    // 检查是否是文档生成成功的消息
    if (result.includes("✅") && result.includes("文档已生成")) {
      const pathMatch = result.match(/文档已生成:\s*(.+)/);
      if (pathMatch) {
        return (
          <div className="text-sm text-emerald-600 flex items-center gap-1.5">
            <CheckCircleIcon className="size-4" />
            <span>{t("toolCard.documentGenerated")}</span>
            <ClickableFilePath path={pathMatch[1].trim()} className="text-blue-500" />
          </div>
        );
      }
    }
    
    // 普通文本，截断显示
    if (result.length > 200) {
      return (
        <div className="text-sm text-muted-foreground">
          {isExpanded ? result : result.slice(0, 200) + "..."}
          <button 
            onClick={() => setIsExpanded(!isExpanded)}
            className="ml-2 text-blue-500 hover:underline"
          >
            {isExpanded ? t("toolCard.collapse") : t("toolCard.expand")}
          </button>
        </div>
      );
    }
    return <div className="text-sm text-muted-foreground">{result}</div>;
  }
  
  // JSON 结果 - 用户友好显示
  return (
    <div className="mt-1.5 space-y-2">
      {/* 状态和摘要 */}
      {parsed.status === "success" && parsed.summary && (
        <div className="text-sm text-emerald-600 flex items-center gap-1.5">
          <CheckCircleIcon className="size-4" />
          <span>{parsed.summary}</span>
        </div>
      )}
      
      {/* 生成的文档 */}
      {parsed.document && (
        <div className="text-sm flex items-center gap-1.5">
          <FileTextIcon className="size-4 text-blue-500" />
          <span className="text-muted-foreground">{t("toolCard.generatedDocumentLabel")}</span>
          <ClickableFilePath path={parsed.document} className="text-blue-500" />
        </div>
      )}
      
      {/* 发现列表 - 用户友好格式 */}
      {parsed.findings && parsed.findings.length > 0 && (
        <div className="space-y-1">
          <div className="text-xs text-muted-foreground font-medium">{t("toolCard.findingsCount", { count: parsed.findings.length })}</div>
          <ul className="text-sm space-y-0.5 ml-4">
            {parsed.findings.slice(0, isExpanded ? undefined : 3).map((f, i) => (
              <li key={i} className="text-foreground">
                • {f.item || f.finding}
                {(f.source || f.loc || f.location) && (
                  <span className="text-muted-foreground text-xs ml-1">
                    ({f.source}{f.loc || f.location ? `, ${f.loc || f.location}` : ""})
                  </span>
                )}
              </li>
            ))}
          </ul>
          {parsed.findings.length > 3 && (
            <button 
              onClick={() => setIsExpanded(!isExpanded)}
              className="text-xs text-blue-500 hover:underline ml-4"
            >
              {isExpanded ? t("toolCard.collapse") : t("toolCard.viewAllItems", { n: parsed.findings.length })}
            </button>
          )}
        </div>
      )}
      
      {/* 证据链 - 用户友好格式 */}
      {parsed.evidence && parsed.evidence.length > 0 && (
        <div className="space-y-1">
          <div className="text-xs text-muted-foreground font-medium">{t("toolCard.evidenceChain")}</div>
          <div className="text-sm space-y-1 ml-4">
            {parsed.evidence.slice(0, isExpanded ? undefined : 2).map((e, i) => (
              <div key={i} className="border-l-2 border-muted pl-2">
                <div className="text-foreground">{e.finding}</div>
                {e.quote && (
                  <div className="text-xs text-muted-foreground italic">"{e.quote}"</div>
                )}
                <div className="text-xs text-muted-foreground">
                  — {e.source}{e.location ? `, ${e.location}` : ""}
                </div>
              </div>
            ))}
          </div>
          {parsed.evidence.length > 2 && (
            <button 
              onClick={() => setIsExpanded(!isExpanded)}
              className="text-xs text-blue-500 hover:underline ml-4"
            >
              {isExpanded ? t("toolCard.collapse") : t("toolCard.viewAllEvidence", { n: parsed.evidence.length })}
            </button>
          )}
        </div>
      )}
      
      {/* 生成的图表 - 可点击查看 */}
      {(parsed.charts || parsed.output?.charts) && (
        <div className="space-y-2">
          <div className="text-xs text-muted-foreground font-medium flex items-center gap-1">
            <svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 3v18h18" />
              <path d="M18 17V9" />
              <path d="M13 17V5" />
              <path d="M8 17v-3" />
            </svg>
            {t("toolCard.charts")}
          </div>
          <div className="flex flex-wrap gap-2">
            {(parsed.charts || parsed.output?.charts || []).map((chartPath: string, i: number) => (
              <button
                key={i}
                onClick={() => fileEventBus.openFile(chartPath)}
                className="group relative overflow-hidden rounded-lg border border-muted hover:border-blue-500 transition-colors"
              >
                <div className="w-32 h-24 bg-linear-to-br from-blue-50 to-indigo-50 dark:from-blue-950/30 dark:to-indigo-950/30 flex items-center justify-center">
                  <svg className="size-8 text-blue-500/50 group-hover:text-blue-500 transition-colors" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M3 3v18h18" />
                    <path d="M18 17V9" />
                    <path d="M13 17V5" />
                    <path d="M8 17v-3" />
                  </svg>
                </div>
                <div className="absolute bottom-0 left-0 right-0 bg-black/60 text-white text-xs px-2 py-1 truncate">
                  {chartPath.split('/').pop()}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
      
      {/* 表格数据 - 专业格式 */}
      {parsed.tables && parsed.tables.length > 0 && (
        <div className="space-y-3">
          {parsed.tables.map((table, i) => (
            <div key={i} className="overflow-x-auto">
              {table.title && (
                <div className="text-sm font-medium text-foreground mb-1">{table.title}</div>
              )}
              <table className="w-full text-sm border-collapse">
                {table.headers && (
                  <thead>
                    <tr className="bg-muted/50">
                      {table.headers.map((h, j) => (
                        <th key={j} className="px-3 py-2 text-left font-semibold text-foreground border-b border-muted">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                )}
                <tbody>
                  {table.rows?.map((row, j) => (
                    <tr key={j} className={j % 2 === 0 ? 'bg-background' : 'bg-muted/20'}>
                      {row.map((cell, k) => (
                        <td key={k} className="px-3 py-2 text-muted-foreground border-b border-muted/50">
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
      
      {/* 项目信息摘要 - 卡片式显示 */}
      {parsed.key_info?.project && (
        <div className="bg-linear-to-r from-blue-50 to-indigo-50 dark:from-blue-950/20 dark:to-indigo-950/20 rounded-lg p-3 space-y-1">
          <div className="text-xs font-medium text-blue-600 dark:text-blue-400">{t("toolCard.projectInfo")}</div>
          <div className="grid grid-cols-2 gap-2 text-sm">
            {parsed.key_info.project.name && (
              <div>
                <span className="text-muted-foreground">{t("toolCard.labelName")}</span>
                <span className="text-foreground font-medium">{parsed.key_info.project.name}</span>
              </div>
            )}
            {parsed.key_info.project.number && (
              <div>
                <span className="text-muted-foreground">{t("toolCard.labelNumber")}</span>
                <span className="text-foreground">{parsed.key_info.project.number}</span>
              </div>
            )}
            {parsed.key_info.project.budget && (
              <div>
                <span className="text-muted-foreground">{t("toolCard.labelBudget")}</span>
                <span className="font-medium text-emerald-600">{parsed.key_info.project.budget}</span>
              </div>
            )}
          </div>
          {parsed.key_info.structure && (
            <div className="text-xs text-muted-foreground mt-1">
              {t("toolCard.labelStructure")}{parsed.key_info.structure}
            </div>
          )}
        </div>
      )}
      
      {/* 质量标准 - 标签式显示 */}
      {parsed.quality_criteria && (
        <div className="flex flex-wrap gap-1.5">
          {parsed.quality_criteria.depth && (
            <span className="px-2 py-0.5 text-xs rounded-full bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300">
              {t("toolCard.labelDepth")} {parsed.quality_criteria.depth}
            </span>
          )}
          {parsed.quality_criteria.output_quality && (
            <span className="px-2 py-0.5 text-xs rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
              {t("toolCard.labelQuality")} {parsed.quality_criteria.output_quality}
            </span>
          )}
          {parsed.quality_criteria.dimensions?.map((dim, i) => (
            <span key={i} className="px-2 py-0.5 text-xs rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
              {dim}
            </span>
          ))}
        </div>
      )}
      
      {/* ✅ 招投标业务专业显示 - 五维分析 */}
      {parsed.bidding && (
        <div className="space-y-3 mt-2">
          {/* 项目基本信息 D1 */}
          {parsed.bidding.D1_project && (
            <div className="bg-linear-to-r from-slate-50 to-gray-50 dark:from-slate-950/30 dark:to-gray-950/30 rounded-lg p-3">
              <div className="text-xs font-semibold text-slate-600 dark:text-slate-400 mb-2 flex items-center gap-1">
                <span className="w-5 h-5 rounded bg-slate-500 text-white text-[10px] flex items-center justify-center">D1</span>
                {t("toolCard.projectInfo")}
              </div>
              <div className="grid grid-cols-3 gap-2 text-sm">
                {parsed.bidding.D1_project.budget && (
                  <div><span className="text-muted-foreground">{t("toolCard.labelBudget")}</span><span className="font-medium text-emerald-600">{parsed.bidding.D1_project.budget}</span></div>
                )}
                {parsed.bidding.D1_project.deadline && (
                  <div><span className="text-muted-foreground">{t("toolCard.labelDeadline")}</span><span className="font-medium text-amber-600">{parsed.bidding.D1_project.deadline}</span></div>
                )}
                {parsed.bidding.D1_project.location && (
                  <div><span className="text-muted-foreground">{t("toolCard.labelLocation")}</span><span>{parsed.bidding.D1_project.location}</span></div>
                )}
              </div>
            </div>
          )}
          
          {/* 资格条件 D2 - 最重要，突出显示 */}
          {parsed.bidding.D2_qualify && (
            <div className="bg-linear-to-r from-red-50 to-orange-50 dark:from-red-950/30 dark:to-orange-950/30 rounded-lg p-3 border border-red-200 dark:border-red-800">
              <div className="text-xs font-semibold text-red-600 dark:text-red-400 mb-2 flex items-center gap-1">
                <span className="w-5 h-5 rounded bg-red-500 text-white text-[10px] flex items-center justify-center">D2</span>
                {t("toolCard.qualifyConditions")} <span className="text-[10px] bg-red-100 dark:bg-red-900/50 px-1.5 py-0.5 rounded ml-1">{t("toolCard.highestPriority")}</span>
              </div>
              {parsed.bidding.D2_qualify.disqualify && parsed.bidding.D2_qualify.disqualify.length > 0 && (
                <div className="mb-2">
                  <div className="text-xs text-red-500 font-medium mb-1">⚠️ {t("toolCard.disqualifyClause")}</div>
                  <ul className="text-sm space-y-0.5 ml-4">
                    {parsed.bidding.D2_qualify.disqualify.slice(0, 5).map((item, i) => (
                      <li key={i} className="text-red-700 dark:text-red-300">• {item}</li>
                    ))}
                  </ul>
                </div>
              )}
              {parsed.bidding.D2_qualify.starred && parsed.bidding.D2_qualify.starred.length > 0 && (
                <div className="mb-2">
                  <div className="text-xs text-amber-600 font-medium mb-1">★ {t("toolCard.mustSatisfy")}</div>
                  <ul className="text-sm space-y-0.5 ml-4">
                    {parsed.bidding.D2_qualify.starred.slice(0, 5).map((item, i) => (
                      <li key={i} className="text-amber-700 dark:text-amber-300">• {item}</li>
                    ))}
                  </ul>
                </div>
              )}
              {parsed.bidding.D2_qualify.mandatory && parsed.bidding.D2_qualify.mandatory.length > 0 && (
                <div>
                  <div className="text-xs text-muted-foreground font-medium mb-1">{t("toolCard.mandatoryReq")}</div>
                  <ul className="text-sm space-y-0.5 ml-4">
                    {parsed.bidding.D2_qualify.mandatory.slice(0, 5).map((item, i) => (
                      <li key={i} className="text-foreground">• {item}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
          
          {/* 评分标准 D5 */}
          {parsed.bidding.D5_scoring && parsed.bidding.D5_scoring.items && (
            <div className="bg-linear-to-r from-emerald-50 to-teal-50 dark:from-emerald-950/30 dark:to-teal-950/30 rounded-lg p-3">
              <div className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 mb-2 flex items-center gap-1">
                <span className="w-5 h-5 rounded bg-emerald-500 text-white text-[10px] flex items-center justify-center">D5</span>
                {t("toolCard.scoringCriteria")} {parsed.bidding.D5_scoring.total && <span className="text-muted-foreground ml-1">{t("toolCard.totalScore")} {parsed.bidding.D5_scoring.total}</span>}
              </div>
              <div className="space-y-1.5">
                {parsed.bidding.D5_scoring.items.slice(0, 6).map((item, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <div className="flex-1 text-sm">{item.name}</div>
                    <div className="w-24 h-2 bg-muted rounded-full overflow-hidden">
                      <div 
                        className="h-full bg-emerald-500 rounded-full transition-all"
                        style={{ width: `${Math.min((item.score / (parsed.bidding?.D5_scoring?.total || 100)) * 100, 100)}%` }}
                      />
                    </div>
                    <div className="w-12 text-right text-sm font-medium text-emerald-600">{item.score}{t("toolCard.scoreSuffix")}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
          
          {/* 风险评估 */}
          {parsed.bidding.risks && parsed.bidding.risks.length > 0 && (
            <div className="bg-linear-to-r from-amber-50 to-yellow-50 dark:from-amber-950/30 dark:to-yellow-950/30 rounded-lg p-3">
              <div className="text-xs font-semibold text-amber-600 dark:text-amber-400 mb-2 flex items-center gap-1">
                ⚠️ {t("toolCard.riskAssessment")}
              </div>
              <div className="space-y-1.5">
                {parsed.bidding.risks.map((risk, i) => (
                  <div key={i} className="flex items-start gap-2 text-sm">
                    <span className={cn(
                      "px-1.5 py-0.5 text-[10px] rounded font-medium shrink-0",
                      risk.level === 'high' ? "bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300" :
                      risk.level === 'medium' ? "bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300" :
                      "bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300"
                    )}>
                      {risk.level === 'high' ? t("toolCard.riskLevelHigh") : risk.level === 'medium' ? t("toolCard.riskLevelMedium") : t("toolCard.riskLevelLow")}
                    </span>
                    <div>
                      <span className="text-foreground">{risk.item}</span>
                      {risk.reason && <span className="text-muted-foreground text-xs ml-1">({risk.reason})</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      
      {/* 分析进度 */}
      {parsed.progress && (
        <div className="bg-muted/30 rounded-lg p-3">
          <div className="flex items-center justify-between text-sm mb-2">
            <span className="text-muted-foreground">{parsed.progress.current_step || t("toolCard.processing")}</span>
            <span className="text-foreground font-medium">
              {parsed.progress.completed_steps || 0}/{parsed.progress.total_steps || 0}
            </span>
          </div>
          <div className="h-2 bg-muted rounded-full overflow-hidden">
            <div 
              className="h-full bg-emerald-500 rounded-full transition-all duration-300"
              style={{ width: `${parsed.progress.percentage || 0}%` }}
            />
          </div>
        </div>
      )}
      
      {/* 错误信息 */}
      {parsed.status === "failed" && parsed.error && (
        <div className="text-sm text-red-500 flex items-center gap-1.5">
          <AlertCircleIcon className="size-4" />
          <span>{parsed.error}</span>
        </div>
      )}
      
      {/* 调试模式：显示原始 JSON */}
      {showDebug && (
        <details className="text-xs">
          <summary className="text-muted-foreground/50 cursor-pointer hover:text-muted-foreground">
            {t("toolCard.debugRawJson")}
          </summary>
          <pre className="mt-1 p-2 bg-muted/30 rounded text-muted-foreground overflow-x-auto">
            {JSON.stringify(parsed, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
};

// ============================================================
// 进度指示器 - Claude 风格：简洁优雅的动画
// ============================================================
const ProgressDots: React.FC<{ text?: string; className?: string }> = ({ text, className }) => {
  return (
    <span className={cn("text-muted-foreground inline-flex items-center gap-1", className)}>
      {text && <span>{text}</span>}
      <span className="inline-flex gap-0.5">
        <span className="w-1 h-1 rounded-full bg-current animate-bounce" style={{ animationDelay: '0ms' }} />
        <span className="w-1 h-1 rounded-full bg-current animate-bounce" style={{ animationDelay: '150ms' }} />
        <span className="w-1 h-1 rounded-full bg-current animate-bounce" style={{ animationDelay: '300ms' }} />
      </span>
    </span>
  );
};

// 活跃状态指示器 - 用于表示正在处理
const ActiveIndicator: React.FC<{ active: boolean }> = ({ active }) => {
  if (!active) return null;
  return (
    <span className="relative flex h-2 w-2">
      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
      <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
    </span>
  );
};

/** 解析策略/权限/禁用等错误 JSON，返回 reason_text 或 reason 文案（供证据区与工具卡展示） */
function parseErrorOrPolicyResult(result: string): { reasonText: string } | null {
  const trimmed = result.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (parsed.error === "permission_denied" || parsed.policy_layer || parsed.reason_code) {
      const reason = typeof parsed.reason_text === "string" && parsed.reason_text.trim()
        ? parsed.reason_text.trim()
        : typeof parsed.error === "string" ? String(parsed.error) : null;
      if (reason) return { reasonText: reason };
    }
    if (parsed.error === "tool_disabled") {
      const reason = typeof parsed.reason === "string" && parsed.reason.trim()
        ? parsed.reason.trim()
        : typeof parsed.action === "string" ? parsed.action : String(parsed.error);
      return { reasonText: reason };
    }
  } catch {
    /* ignore */
  }
  return null;
}

// 提取结果摘要 - 让用户看到有意义的结果（供 ProcessToolsSummary / 信息项卡 使用）
export function extractResultSummary(result: string, toolName: string): string | null {
  if (!result) return null;
  const trimmed = result.trim();

  // 错误/策略 JSON 优先：展示「未通过：reason_text」供证据区与工具卡
  const err = parseErrorOrPolicyResult(trimmed);
  if (err) {
    const one = err.reasonText.replace(/\s+/g, " ").trim();
    const short = one.length > 80 ? `${one.slice(0, 80)}…` : one;
    return t("thread.sourcesSummary.notPassed") + "：" + short;
  }

  // 纯文本策略/权限类错误（LicenseGate、MCPPermission 等）
  if (trimmed.includes("[LicenseGate]") || trimmed.includes("[MCPPermission]") || trimmed.includes("被拦截") || trimmed.includes("禁止调用")) {
    const firstLine = trimmed.split(/\n/)[0]?.replace(/\s+/g, " ").trim() || trimmed.slice(0, 80);
    return firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine;
  }

  // JSON 结果优先提取常见摘要字段
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const summaryLike = parsed.summary ?? parsed.message ?? parsed.result ?? parsed.status ?? parsed.output;
      if (typeof summaryLike === "string" && summaryLike.trim()) {
        const oneLine = summaryLike.replace(/\s+/g, " ").trim();
        return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
      }
    } catch {
      // ignore JSON parse failure
    }
  }
  
  // 成功标记
  if (result.includes("✅")) {
    const match = result.match(/✅\s*(.+?)(?:\n|$)/);
    if (match) return match[1].slice(0, 60);
  }
  
  // 文件读取 - 显示行数
  if (toolName === "read_file") {
    const lines = result.split("\n").length;
    return t("toolCard.summary.readFileLines", { n: lines });
  }
  
  // 网页搜索：优先解析后端 JSON { query, results: [{ title, source_id, excerpt }] }（Cursor 式详情）
  if (toolName === "web_search") {
    try {
      const parsed = JSON.parse(trimmed) as { query?: string; results?: Array<{ title?: string; source_id?: string; excerpt?: string }> };
      const arr = Array.isArray(parsed?.results) ? parsed.results : [];
      const n = arr.length;
      if (n > 0) {
        const first = arr[0];
        const title = typeof first?.title === "string" ? first.title.trim() : "";
        const excerpt = typeof first?.excerpt === "string" ? first.excerpt.replace(/\s+/g, " ").trim() : "";
        const extra = title || (excerpt.length > 40 ? excerpt.slice(0, 40) + "…" : excerpt) || first?.source_id?.slice(0, 50) || "";
        return extra ? t("toolCard.summary.foundResults", { n }) + " · " + extra : t("toolCard.summary.foundResults", { n });
      }
      if (n === 0 && (parsed?.query || arr)) return t("toolCard.summary.foundResults", { n: 0 });
    } catch {
      // fallback to text format
    }
    const lines = result.split(/\n/).filter(Boolean);
    const count = lines.length;
    const firstTitle = lines.find((l) => l.trim() && !/^https?:\/\//i.test(l.trim()))?.replace(/^\d+\.\s*\*?\*?|\*?\*?$/g, "").trim();
    const firstUrl = lines.find((l) => /^https?:\/\//i.test(l.trim()));
    const titlePart = firstTitle ? (firstTitle.length > 40 ? firstTitle.slice(0, 40) + "…" : firstTitle) : "";
    const urlPart = firstUrl ? (firstUrl.length > 50 ? firstUrl.slice(0, 50) + "…" : firstUrl) : "";
    const extra = titlePart && urlPart ? `${titlePart} | ${urlPart}` : titlePart || urlPart || "";
    if (count > 0) {
      return extra ? t("toolCard.summary.foundResults", { n: count }) + " · " + extra : t("toolCard.summary.foundResults", { n: count });
    }
  }
  // 知识检索：解析 **[检索结果]** 后 [1] 格式或取首条摘要（Cursor 式详情）
  if (toolName === "search_knowledge" || (toolName.includes("search") && toolName !== "web_search") || toolName === "grep_search") {
    if (trimmed.includes("**[检索结果]**")) {
      const afterMarker = trimmed.split("**[检索结果]**")[1] ?? "";
      const entries = afterMarker.match(/\n\[\d+\]/g);
      const n = entries ? entries.length : 0;
      const firstBlock = afterMarker.split(/\n\[\d+\]/)[1];
      const snippet = firstBlock ? firstBlock.replace(/\s+/g, " ").trim().slice(0, 50) : "";
      if (n > 0) return snippet ? t("toolCard.summary.foundResults", { n }) + " · " + (snippet.length >= 50 ? snippet + "…" : snippet) : t("toolCard.summary.foundResults", { n });
    }
    const matchCount = (result.match(/\n/g) || []).length;
    const countMsg = matchCount > 0 ? t("toolCard.summary.foundResults", { n: matchCount }) : null;
    const firstLine = trimmed.split(/\n/)[0]?.replace(/\s+/g, " ").trim() || "";
    const snippet = firstLine.length > 50 ? firstLine.slice(0, 50) + "…" : firstLine;
    if (countMsg) return snippet ? `${countMsg} · ${snippet}` : countMsg;
  }
  
  // 文件写入/编辑
  if (toolName === "write_file" || toolName === "edit_file") {
    return t("toolCard.summary.fileSaved");
  }
  if (toolName === "write_file_binary") {
    return t("toolCard.summary.binarySaved");
  }

  // 分析文档：首行摘要或「已分析」
  if (toolName === "analyze_document") {
    const first = trimmed.split(/\n/)[0]?.replace(/\s+/g, " ").trim() || "";
    if (first.length > 0) return first.length > 80 ? `${first.slice(0, 80)}…` : first;
    return "已分析";
  }

  // 查找文件：N 个结果
  if (toolName === "file_search") {
    const lines = result.split(/\n/).filter((l) => l.trim()).length;
    if (lines > 0) return t("toolCard.summary.foundResults", { n: lines });
    return "无匹配";
  }

  // 代码执行
  if (toolName === "python_run" || toolName === "execute_python_code") {
    if (result.includes("Error")) return t("toolCard.summary.execError");
    const outputLines = result.split("\n").filter(l => l.trim()).length;
    return outputLines > 0 ? t("toolCard.summary.outputLines", { n: outputLines }) : t("toolCard.summary.execDone");
  }

  // 列表/目录类：显示项数（Cursor 式：N 项）
  if (toolName === "ls" || toolName === "list_directory" || toolName === "glob_file_search" || toolName === "glob") {
    const lines = result.split("\n").filter(l => l.trim()).length;
    if (lines > 0) return t("toolCard.summary.itemsCount", { n: lines });
    return "（无条目）";
  }

  // grep 搜索：N 处匹配 + 首行片段（Cursor 式）
  if (toolName === "grep_search" || toolName === "grep") {
    const lineList = result.split("\n").filter(l => l.trim());
    const n = lineList.length;
    if (n > 0) {
      const first = lineList[0].replace(/\s+/g, " ").trim();
      const snippet = first.length > 50 ? `${first.slice(0, 50)}…` : first;
      return `${t("toolCard.summary.grepMatches", { n })}${snippet ? ` · ${snippet}` : ""}`;
    }
    return t("toolCard.summary.grepMatches", { n: 0 });
  }

  // shell_run：退出码或输出行数（Cursor 式）
  if (toolName === "shell_run" || toolName === "shell") {
    if (trimmed.startsWith("{")) {
      try {
        const p = JSON.parse(trimmed) as { exit_code?: number; returncode?: number; stdout?: string };
        const code = p.exit_code ?? p.returncode;
        if (code !== undefined && code !== null) return code === 0 ? t("toolCard.summary.shellDone") : `退出码 ${code}`;
        if (p.stdout && String(p.stdout).trim()) return t("toolCard.summary.outputLines", { n: String(p.stdout).split("\n").filter(Boolean).length });
      } catch {
        // ignore
      }
    }
    const lineCount = result.split("\n").filter(l => l.trim()).length;
    if (lineCount > 0) return t("toolCard.summary.outputLines", { n: lineCount });
    return t("toolCard.summary.shellDone");
  }

  // 通用兜底：首行或前 60 字，保证每条工具都有可读摘要
  const firstLine = trimmed.split(/\n/)[0]?.replace(/\s+/g, " ").trim() || "";
  if (firstLine.length > 0) {
    return firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine;
  }
  return null;
}

/** 从 result 提取依据片段/结果预览（供本消息依据展开详情，Cursor 式：搜索类为首条标题/摘要） */
export function extractResultPreview(result: string | null | undefined, toolName: string, maxChars: number = 120): string | null {
  if (!result || typeof result !== "string") return null;
  const trimmed = result.trim();
  if (!trimmed) return null;
  const cap = (s: string) => (s.length > maxChars ? `${s.slice(0, maxChars)}…` : s);
  const err = parseErrorOrPolicyResult(trimmed);
  if (err) return cap(err.reasonText);
  if (trimmed.includes("[LicenseGate]") || trimmed.includes("[MCPPermission]") || trimmed.includes("被拦截") || trimmed.includes("禁止调用")) {
    const first = trimmed.split(/\n/)[0]?.replace(/\s+/g, " ").trim() || trimmed;
    return cap(first);
  }
  if (toolName === "web_search") {
    try {
      const parsed = JSON.parse(trimmed) as { results?: Array<{ title?: string; excerpt?: string; source_id?: string }> };
      const arr = Array.isArray(parsed?.results) ? parsed.results : [];
      const first = arr[0];
      if (first) {
        const title = typeof first.title === "string" ? first.title.trim() : "";
        const excerpt = typeof first.excerpt === "string" ? first.excerpt.replace(/\s+/g, " ").trim() : "";
        return cap(title || excerpt || String(first.source_id ?? "")) || null;
      }
    } catch {
      // fallback to text: first non-URL line as title, first URL as source
    }
    const textLines = trimmed.split(/\n/).map((l) => l.trim()).filter(Boolean);
    const firstTitle = textLines.find((l) => !/^https?:\/\//i.test(l));
    const firstUrl = textLines.find((l) => /^https?:\/\//i.test(l));
    if (firstTitle || firstUrl) return cap(firstTitle || firstUrl || "");
  }
  if (toolName === "search_knowledge" && trimmed.includes("**[检索结果]**")) {
    const afterMarker = trimmed.split("**[检索结果]**")[1] ?? "";
    const firstBlock = afterMarker.split(/\n\[\d+\]/)[1];
    if (firstBlock) {
      const one = firstBlock.replace(/\s+/g, " ").trim();
      return one ? cap(one) : null;
    }
  }
  const firstLine = trimmed.split(/\n/)[0]?.replace(/\s+/g, " ").trim() || trimmed.replace(/\s+/g, " ").trim();
  if (!firstLine) return null;
  return firstLine.length > maxChars ? `${firstLine.slice(0, maxChars)}…` : firstLine;
}

/** 过程工具 part 可含 result/status，用于摘要与信息项卡 */
export type ProcessToolPartWithResult = ProcessToolPart & {
  result?: unknown;
  status?: { type?: string; reason?: string };
};

/** 过程工具合并摘要：含 result 时追加结果摘要（如：读取：config.py(12 行), utils.py(8 行)） */
export const ProcessToolsSummaryWithResult: React.FC<{
  parts: ProcessToolPartWithResult[];
  className?: string;
  isRunning?: boolean;
}> = ({ parts, className, isRunning }) => {
  const line = React.useMemo(() => {
    if (!parts.length) return "";
    const byName = new Map<string, Array<{ key: string; resultSummary?: string | null }>>();
    for (const p of parts) {
      const name = p?.toolCall?.name ?? "";
      const key = getPartKeyInfo(p);
      const rawResult = p?.result;
      const resultStr = typeof rawResult === "string" ? rawResult : rawResult != null ? String(rawResult) : "";
      const resultSummary = resultStr ? extractResultSummary(resultStr, name) : null;
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name)!.push({ key, resultSummary });
    }
    const segments: string[] = [];
    byName.forEach((items, name) => {
      const label = getToolDisplayName(name);
      const partsStr = items
        .map(({ key, resultSummary }) => (key && resultSummary ? `${key}(${resultSummary})` : key || resultSummary || ""))
        .filter(Boolean);
      const uniq = [...new Set(partsStr)];
      segments.push(uniq.length > 0 ? `${label}：${uniq.join(", ")}` : label);
    });
    return segments.join("  ·  ");
  }, [parts]);
  if (!parts.length) return null;
  return (
    <span
      className={cn(
        "text-xs text-muted-foreground truncate min-w-0 inline-block max-w-full",
        isRunning && "animate-shimmer bg-linear-to-r from-muted-foreground via-foreground/60 to-muted-foreground bg-size-[200%_100%] bg-clip-text text-transparent",
        className,
      )}
      title={line}
    >
      {line}
    </span>
  );
};

/** 首行或前 N 字，用于无摘要时的行内兜底 */
function firstLineOrChars(text: string, maxChars: number): string {
  const trimmed = text.trim();
  const first = trimmed.split(/\n/)[0]?.replace(/\s+/g, " ").trim() || trimmed.replace(/\s+/g, " ").trim();
  if (first.length <= maxChars) return first;
  return `${first.slice(0, maxChars)}…`;
}

/** 单行信息项卡：过程工具一条结果摘要，可展开看详情 */
export const ProcessToolInfoCard: React.FC<{
  part: ProcessToolPartWithResult;
  order: number;
}> = ({ part, order }) => {
  const [expanded, setExpanded] = useState(false);
  const name = part?.toolCall?.name ?? "";
  const keyInfo = getPartKeyInfo(part);
  const rawResult = part?.result;
  const resultStr = typeof rawResult === "string" ? rawResult : rawResult != null ? String(rawResult) : "";
  const resultSummary = React.useMemo(
    () => (resultStr ? extractResultSummary(resultStr, name) : null),
    [resultStr, name]
  );
  const fallbackDisplay = resultSummary ?? (resultStr ? firstLineOrChars(resultStr, 80) : null);
  const status = part?.status?.type;
  const isRunning = status === "running";
  const isError = status === "incomplete" && (part?.status as { reason?: string })?.reason === "error";
  const displayName = getToolDisplayName(name);
  const hasExpandable = Boolean(resultStr && resultStr.length > 120);
  const ariaLabel = keyInfo
    ? t("thread.infoItem.expandDetail", { tool: displayName, key: keyInfo })
    : t("thread.infoItem.expandDetailShort", { tool: displayName });
  const borderAccent = isError ? "border-l-4 border-l-red-500/70" : isRunning ? "border-l-4 border-l-violet-500/60" : "border-l-4 border-l-emerald-500/40";
  return (
    <div className={cn("rounded-lg border border-border/20 bg-muted/5 shadow-elevation-sm overflow-hidden", borderAccent)}>
      <button
        type="button"
        onClick={() => hasExpandable && setExpanded((e) => !e)}
        className="w-full inline-flex items-center gap-1.5 px-2 py-1.5 text-left text-[12px] min-w-0"
        aria-expanded={hasExpandable ? expanded : undefined}
        aria-label={ariaLabel}
      >
        {hasExpandable && (expanded ? <ChevronDownIcon className="size-3 shrink-0" /> : <ChevronRightIcon className="size-3 shrink-0" />)}
        {isRunning ? (
          <LoaderIcon className="size-3 shrink-0 animate-spin text-muted-foreground" />
        ) : isError ? (
          <XCircleIcon className="size-3 shrink-0 text-red-500" />
        ) : (
          <CheckIcon className="size-3 shrink-0 text-emerald-500" />
        )}
        <span className="text-muted-foreground/80 tabular-nums shrink-0">#{order + 1}</span>
        <span className="font-medium text-foreground/90">{displayName}</span>
        {keyInfo && <span className="text-muted-foreground/70 truncate max-w-[180px]">{keyInfo}</span>}
        {fallbackDisplay && <span className="text-muted-foreground/60">· {fallbackDisplay}</span>}
      </button>
      {expanded && resultStr && (
        <div className="px-2 pb-2 pt-0">
          <pre className="text-[11px] text-muted-foreground whitespace-pre-wrap wrap-break-word max-h-48 overflow-y-auto rounded bg-muted/20 p-2">
            {resultStr}
          </pre>
        </div>
      )}
    </div>
  );
};

// ============================================================
// 可点击的文件路径 - 点击打开文件，可选跳转到指定行
// ============================================================
const ClickableFilePath: React.FC<{ 
  path: string; 
  line?: number;
  className?: string;
  showFullPath?: boolean;
}> = ({ path, line, className, showFullPath = false }) => {
  const fileName = path.split('/').pop() || path;
  const displayName = showFullPath ? path : fileName;
  
  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    fileEventBus.openFile(path, line);
  }, [path, line]);
  
  return (
    <button
      onClick={handleClick}
      className={cn(
        "font-mono text-blue-500 hover:text-blue-600 dark:hover:text-blue-400 hover:underline cursor-pointer px-1 rounded hover:bg-blue-50 dark:hover:bg-blue-950/30",
        className
      )}
      title={line != null ? t("toolCard.openAndGoToLine", { line, path }) : t("toolCard.clickToOpen", { path })}
    >
      {displayName}
    </button>
  );
};

// ============================================================
// 工具操作栏 - 按工具类型提供主操作（打开/复制等）
// ============================================================
const ToolActionBar: React.FC<{
  actions: Array<{ label: string; icon: React.ReactNode; onClick: () => void; disabled?: boolean }>;
  className?: string;
}> = ({ actions, className }) => (
  <div className={cn("flex items-center gap-1 flex-wrap rounded-md border border-border/35 bg-background/40 px-1.5 py-1", className)}>
    {actions.map((a, i) => (
      <button
        key={i}
        type="button"
        onClick={(e) => { e.stopPropagation(); a.onClick(); }}
        disabled={a.disabled}
        className={cn(
          "inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded border border-border/35 bg-muted/20 text-muted-foreground",
          TOOL_MOTION_CLASS,
          TOOL_FOCUS_CLASS,
          a.disabled ? "opacity-50 cursor-not-allowed" : "hover:bg-muted/50 hover:text-foreground"
        )}
        title={a.label}
        aria-label={a.label}
      >
        {a.icon}
        <span>{a.label}</span>
      </button>
    ))}
  </div>
);

/** Cursor 一致：非空工具卡统一容器（与 ToolFallback 一致） */
const TOOL_CARD_CONTAINER_BASE = "rounded-lg border border-border/20 bg-muted/5 px-2.5 py-1.5";
const TOOL_CARD_BORDER_RUNNING = "border-l-4 border-l-violet-500/70";
const TOOL_CARD_BORDER_COMPLETE = "border-l-4 border-l-emerald-500/50";
const TOOL_CARD_BORDER_ERROR = "border-l-4 border-l-red-500/80";
const TOOL_CARD_BORDER_CANCELLED = "border-l-4 border-l-amber-500/60";

const TOOL_RESULT_BOX_CLASS =
  "rounded-lg border border-border/40 bg-muted/20 px-2.5 py-2 text-[11px] font-mono text-foreground/85 overflow-x-auto";

const TOOL_DETAIL_PANEL_CLASS =
  "rounded-lg border border-border/35 bg-background/30 px-2.5 py-2";

const TOOL_MOTION_CLASS = "transition-colors duration-200 ease-out";
const TOOL_EXPAND_MOTION_CLASS = "grid transition-[grid-template-rows,opacity] duration-200 ease-out overflow-hidden";
const TOOL_FOCUS_CLASS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-1";

const copyToClipboard = (text: string) => {
  navigator.clipboard.writeText(text).then(() => toast.success(t("common.copied"))).catch(() => toast.error(t("common.copyFailedManual")));
};

const triggerAgentPrompt = (prompt: string) => {
  try {
    const threadId = getCurrentThreadIdFromStorage();
    window.dispatchEvent(
      new CustomEvent(EVENTS.FILL_PROMPT, {
        detail: { prompt, autoSend: true, threadId: threadId || undefined },
      })
    );
    toast.success(t("toolCard.retryRequestSent"));
  } catch {
    toast.error(t("toolCard.actionFailedRetry"));
  }
};

// ============================================================
// Cursor 风格：简洁的内联工具显示
// ============================================================

// 工具图标映射 - 使用更小的图标
const getToolIcon = (toolName: string) => {
  const iconClass = "size-3.5 shrink-0";
  switch (toolName) {
    case "read_file":
    case "batch_read_files":
      return <EyeIcon className={cn(iconClass, "text-blue-500")} />;
    case "write_file":
    case "edit_file":
      return <PencilIcon className={cn(iconClass, "text-emerald-500")} />;
    case "write_file_binary":
      return <FileIcon className={cn(iconClass, "text-emerald-500")} />;
    case "delete_file":
      return <TrashIcon className={cn(iconClass, "text-red-500")} />;
    case "list_directory":
    case "ls":
      return <FolderOpenIcon className={cn(iconClass, "text-amber-500")} />;
    case "python_run":
    case "execute_python_code":
      return <CodeIcon className={cn(iconClass, "text-yellow-500")} />;
    case "shell_run":
    case "execute":
      return <TerminalIcon className={cn(iconClass, "text-gray-500")} />;
    case "grep_search":
    case "grep":
      return <SearchIcon className={cn(iconClass, "text-purple-500")} />;
    case "file_search":
      return <FolderOpenIcon className={cn(iconClass, "text-blue-500")} />;
    case "web_search":
      return <GlobeIcon className={cn(iconClass, "text-blue-500")} />;
    case "think_tool":
      return <BrainIcon className={cn(iconClass, "text-amber-500")} />;
    case "plan_next_moves":
      return <ListChecksIcon className={cn(iconClass, "text-blue-500")} />;
    case "task":
      return <PlayIcon className={cn(iconClass, "text-emerald-500")} />;
    case "write_todos":
      return <ListChecksIcon className={cn(iconClass, "text-emerald-500")} />;
    case "record_result":
      return <CheckCircleIcon className={cn(iconClass, "text-green-500")} />;
    case "ask_user":
      return <MessageCircleIcon className={cn(iconClass, "text-orange-500")} />;
    case "search_knowledge":
    case "query_kg":
    case "knowledge_graph":
      return <SearchIcon className={cn(iconClass, "text-violet-500")} />;
    case "critic_review":
      return <CheckCircleIcon className={cn(iconClass, "text-indigo-500")} />;
    default:
      return <FileIcon className={cn(iconClass, "text-muted-foreground")} />;
  }
};

// 获取工具的友好名称（供 ProcessToolsSummary / MessageEvidenceSummary 等使用）
// 与 toolTier 对齐，覆盖所有 tier 内工具；未知工具用 snake_case 转可读短语兜底
export const getToolDisplayName = (toolName: string): string => {
  const names: Record<string, string> = {
    read_file: "读取",
    batch_read_files: "批量读取",
    write_file: "写入",
    edit_file: "编辑",
    write_file_binary: "写入二进制",
    delete_file: "删除",
    list_directory: "列出目录",
    ls: "列出目录",
    glob: "文件匹配",
    grep_search: "搜索",
    file_search: "查找文件",
    search_knowledge: "知识库检索",
    query_kg: "知识图谱",
    knowledge_graph: "知识图谱",
    ontology: "本体",
    ontology_import: "外部本体导入",
    web_search: "网页搜索",
    analyze_document: "分析文档",
    learn_from_doc: "从文档学习",
    python_run: "Python",
    execute_python_code: "Python",
    shell_run: "Shell",
    execute: "执行",
    create_chart: "创建图表",
    ask_user: "询问",
    plan_next_moves: "规划",
    write_todos: "任务列表",
    task: "执行任务",
    critic_review: "结构化审查",
    think_tool: "思考",
    extended_thinking: "扩展思考",
    record_result: "记录结果",
    report_task_result: "上报任务结果",
    record_failure: "记录失败",
    get_libraries: "获取库",
    get_learning_stats: "学习统计",
    extract_entities: "抽取实体",
    ontology_query: "本体查询",
    ontology_extract: "本体抽取",
    list_skills: "列出能力",
    match_skills: "匹配能力",
    get_skill_info: "查看技能详情",
    run_skill_script: "执行技能脚本",
    generate_ppt: "生成 PPT",
    generate_pdf: "生成 PDF",
    generate_word: "生成 Word",
    generate_image: "生成图片",
    generate_video: "生成视频",
    web_fetch: "获取网页",
    web_crawl_batch: "批量爬取",
    content_extract: "内容抽取",
    template_render: "模板渲染",
    analyze_image: "分析图片",
    manage_memory: "记忆管理",
    search_memory: "记忆检索",
    search_learning_experience: "学习经验检索",
    get_similar_paths: "相似路径",
    verify_output: "验证输出",
    verify_knowledge_entry: "验证知识条目",
    verify_ontology_entity: "验证本体实体",
    enter_plan_mode: "进入计划",
    exit_plan_mode: "退出计划",
  };
  if (names[toolName]) return names[toolName];
  const lower = toolName.toLowerCase();
  const readable = toolName
    .split("_")
    .map((s) => (s.length > 0 ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s))
    .join(" ");
  if (lower.startsWith("mcp_") || lower.includes("mcp_")) return `MCP · ${readable}`;
  return readable;
};

const getToolRunningPhase = (toolName: string, args?: Record<string, any>): string | null => {
  const name = String(toolName || "").toLowerCase();
  if (name === "get_skill_info" || name === "run_skill_script") {
    const skillName = String(args?.skill_name || args?.skill || "").trim();
    return skillName ? `正在使用技能：${skillName}` : (name === "get_skill_info" ? "正在查看技能详情…" : "正在执行技能脚本…");
  }
  if (name === "list_skills") return "正在列出能力…";
  if (name === "match_skills") return "正在匹配能力…";
  if (name === "ls" || name === "list_directory" || name === "glob" || name === "glob_file_search") return "正在列出目录…";
  if (name === "grep_search" || name === "grep") return "正在搜索内容…";
  if (name === "search_knowledge" || name === "search_memory") return "正在检索…";
  if (name.includes("read") || name.includes("file_search")) return "正在读取…";
  if (name.includes("write") || name.includes("edit") || name.includes("delete")) return "正在写入变更…";
  if (name.includes("python") || name.includes("execute_python")) return "正在执行 Python…";
  if (name.includes("shell_run") || name === "shell") return "正在执行命令…";
  if (name.includes("web_search")) return "正在联网检索…";
  if (name.includes("task")) {
    const subagent = String(args?.subagent_type || "").trim();
    return subagent ? `正在调度 ${subagent}…` : "正在调度子任务…";
  }
  if (name.includes("plan")) return "正在规划步骤…";
  if (name.includes("think")) return "正在思考…";
  return "正在处理中…";
};

// 工具展示层级（面向用户的展示业务逻辑）
export type ToolDisplayTier = "hidden" | "process" | "action" | "interactive" | "result";

const TOOL_TIER: Record<string, ToolDisplayTier> = {
  think_tool: "hidden",
  extended_thinking: "hidden",
  record_result: "hidden",
  record_failure: "hidden",
  report_task_result: "hidden",
  get_libraries: "hidden",
  get_learning_stats: "hidden",
  extract_entities: "hidden",

  read_file: "process",
  batch_read_files: "process",
  list_directory: "process",
  ls: "process",
  glob: "process",
  glob_file_search: "process",
  grep_search: "process",
  file_search: "process",
  search_knowledge: "process",
  query_kg: "process",
  knowledge_graph: "process",
  ontology: "process",
  ontology_import: "process",
  web_search: "process",
  web_fetch: "process",
  analyze_document: "process",
  analyze_image: "process",
  learn_from_doc: "process",
  list_skills: "process",
  match_skills: "process",
  get_skill_info: "process",
  run_skill_script: "process",

  write_file: "action",
  generate_ppt: "action",
  generate_image: "action",
  generate_video: "action",
  edit_file: "action",
  delete_file: "action",
  python_run: "action",
  execute_python_code: "action",
  shell_run: "action",
  execute: "action",
  create_chart: "action",

  ask_user: "interactive",
  plan_next_moves: "interactive",
  write_todos: "interactive",
  task: "interactive",
  critic_review: "result",

  web_crawl_batch: "process",
  content_extract: "process",
  template_render: "action",
  manage_memory: "hidden",
  search_memory: "process",
  search_learning_experience: "process",
  get_similar_paths: "process",
  generate_pdf: "action",
  generate_word: "action",
  verify_output: "hidden",
  verify_knowledge_entry: "hidden",
  verify_ontology_entity: "hidden",
  enter_plan_mode: "interactive",
  exit_plan_mode: "interactive",
};

export function getToolTier(toolName: string): ToolDisplayTier {
  return TOOL_TIER[toolName] ?? "process";
}

// 提取文件名
const getFileName = (path?: string): string => {
  if (!path) return "";
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
};

/** 过程工具单条摘要：从 part 的 args 提取简短描述（供 MessageEvidenceSummary / Fallback 等使用）；与 Cursor 对齐：支持 file_path/path/doc_path/list_directory/directory/paths/file_paths 等，见 tool_display_cursor_alignment.md */
export function getPartKeyInfo(part: { toolCall?: { name?: string }; args?: Record<string, unknown> }): string {
  const args = part?.args;
  const name = part?.toolCall?.name;
  if (!args) return "";
  if (args.file_path || args.path) return getFileName(String(args.file_path || args.path));
  if (args.doc_path) return getFileName(String(args.doc_path));
  if ((name === "list_directory" || name === "ls") && (args.directory || args.path || (args as Record<string, unknown>).list_directory)) {
    const dir = String(args.directory || args.path || (args as Record<string, unknown>).list_directory || "");
    return dir ? getFileName(dir) || dir : "";
  }
  if (name === "glob" || name === "glob_file_search") {
    const pattern = String(args.pattern ?? args.path ?? "").trim();
    const dir = args.directory ? getFileName(String(args.directory)) || String(args.directory).slice(0, 30) : "";
    if (pattern && dir) return `${pattern.slice(0, 25)}… · ${dir}`;
    if (pattern) return pattern.length > 35 ? pattern.slice(0, 35) + "…" : pattern;
    if (dir) return dir;
  }
  if (args.directory) return getFileName(String(args.directory)) || String(args.directory).slice(0, 40);
  const queryLike = args.query ?? args.pattern ?? args.search_query ?? args.q;
  if (queryLike != null && String(queryLike).trim()) {
    const q = String(queryLike).trim();
    const short = q.length > 30 ? q.slice(0, 30) + "…" : q;
    if (name === "web_search") {
      const site = String(args.url ?? args.website ?? args.source ?? "").trim();
      if (site) {
        try {
          const host = site.startsWith("http") ? new URL(site).host : site;
          const base = host ? `${short} · ${host}` : short;
          const num = args.num_results ?? args.max_results;
          if (num != null && Number.isFinite(Number(num))) return `${base} · 最多 ${Number(num)} 条`;
          return base;
        } catch {
          const base = site.length > 20 ? `${short} · ${site.slice(0, 20)}…` : `${short} · ${site}`;
          const num = args.num_results ?? args.max_results;
          if (num != null && Number.isFinite(Number(num))) return `${base} · 最多 ${Number(num)} 条`;
          return base;
        }
      }
      const num = args.num_results ?? args.max_results;
      if (num != null && Number.isFinite(Number(num))) return `${short} · 最多 ${Number(num)} 条`;
      return short;
    }
    if (name === "search_knowledge" && (args.doc_path || args.source)) {
      const src = getFileName(String(args.doc_path ?? args.source ?? ""));
      return src ? `${short} · ${src}` : short;
    }
    return short;
  }
  if (name === "file_search" && (args.directory || args.path)) {
    const pathOrDir = String(args.path ?? args.directory ?? "").trim();
    return pathOrDir ? getFileName(pathOrDir) || pathOrDir.slice(0, 40) : "";
  }
  if (name === "grep_search") {
    const pat = args.pattern != null ? String(args.pattern).trim().slice(0, 40) + (String(args.pattern).length > 40 ? "…" : "") : "";
    const pathPart = args.path ? getFileName(String(args.path)) || String(args.path).slice(0, 30) : "";
    if (pat && pathPart) return `${pat} · ${pathPart}`;
    if (pat) return pat;
    if (pathPart) return pathPart;
  }
  if (args.url || args.website || args.source) {
    const u = String(args.url ?? args.website ?? args.source ?? "");
    if (u) {
      try {
        return u.startsWith("http") ? new URL(u).host : u.slice(0, 40);
      } catch {
        return u.length > 40 ? u.slice(0, 40) + "…" : u;
      }
    }
  }
  if (args.command) {
    const c = String(args.command);
    return c.length > 30 ? c.slice(0, 30) + "…" : c;
  }
  if ((name === "python_run" || name === "execute_python_code") && (args.code || args.script)) {
    const code = String(args.code ?? args.script ?? "");
    const lines = code.split(/\n/).filter((l) => l.trim()).length;
    const first = code.trim().split(/\n/)[0]?.trim() || "";
    if (first) return lines > 1 ? `${first.slice(0, 28)}… · ${lines} 行` : (first.length > 32 ? first.slice(0, 30) + "…" : first);
    return lines > 0 ? `${lines} 行代码` : "";
  }
  if (Array.isArray(args.paths) && args.paths.length > 0) return `${args.paths.length} 个文件`;
  if (Array.isArray(args.file_paths) && args.file_paths.length > 0) return `${args.file_paths.length} 个文件`;
  if (args.question) {
    const q = String(args.question);
    return q.length > 40 ? q.slice(0, 40) + "…" : q;
  }
  if (args.goal && (name === "plan_next_moves" || name === "plan")) {
    const g = String(args.goal);
    return g.length > 40 ? g.slice(0, 40) + "…" : g;
  }
  if (args.thinking) {
    const first = String(args.thinking).split("\n")[0]?.trim() || "";
    return first.length > 40 ? first.slice(0, 40) + "…" : first;
  }
  if (args.description) {
    const d = String(args.description);
    return d.length > 40 ? d.slice(0, 40) + "…" : d;
  }
  // 兜底：任意 args 都尽量展示关键信息，避免「未知工具」无价值
  const keys = Object.keys(args || {}).filter((k) => args![k] != null && String(args![k]).trim() !== "");
  if (keys.length === 0) return "";
  const first = keys[0];
  const v = args![first];
  const str = typeof v === "string" ? v : Array.isArray(v) ? `${v.length} 项` : JSON.stringify(v);
  const short = str.length > 36 ? str.slice(0, 34) + "…" : str;
  return keys.length > 1 ? `${short} · +${keys.length - 1}` : short;
}

/** 过程工具合并摘要：将多个 process 工具合并为一行显示（如：读取：config.py, utils.py  ·  搜索：xxx） */
export type ProcessToolPart = { toolCall?: { name?: string }; args?: Record<string, unknown> };

export const ProcessToolsSummary: React.FC<{
  parts: ProcessToolPart[];
  className?: string;
  /** 是否有工具仍在运行中 */
  isRunning?: boolean;
}> = ({ parts, className, isRunning }) => {
  const line = React.useMemo(() => {
    if (!parts.length) return "";
    const byName = new Map<string, string[]>();
    for (const p of parts) {
      const name = p?.toolCall?.name ?? "";
      const key = getPartKeyInfo(p);
      if (!byName.has(name)) byName.set(name, []);
      if (key) byName.get(name)!.push(key);
    }
    const segments: string[] = [];
    byName.forEach((keys, name) => {
      const label = getToolDisplayName(name);
      const uniq = [...new Set(keys)];
      segments.push(uniq.length > 0 ? `${label}：${uniq.join(", ")}` : label);
    });
    return segments.join("  ·  ");
  }, [parts]);
  if (!parts.length) return null;
  return (
    <span
      className={cn(
        "text-xs text-muted-foreground truncate min-w-0 inline-block max-w-full",
        isRunning && "animate-shimmer bg-linear-to-r from-muted-foreground via-foreground/60 to-muted-foreground bg-size-[200%_100%] bg-clip-text text-transparent",
        className,
      )}
      title={line}
    >
      {line}
    </span>
  );
};

// ============================================================
// 通用工具 Fallback
// ============================================================
export const ToolFallback: ToolCallMessagePartComponent = ({
  toolName,
  toolCallId,
  args,
  result,
  status,
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [livePreview, setLivePreview] = useState<string | null>(null);
  const isRunning = status?.type === "running";
  const isComplete = status?.type === "complete";
  const isError = status?.type === "incomplete" && status.reason === "error";
  const isCancelled = status?.type === "incomplete" && status.reason === "cancelled";
  const elapsedSec = useToolElapsedSeconds(status as { type: string } | undefined);

  const messageId = useMessage((s) => (s as { id?: string }).id);
  const toolResultsMap = useContext(ToolResultsByMessageIdContext);
  const fallbackResult = messageId && toolCallId ? (toolResultsMap.get(messageId)?.[toolCallId]) : undefined;
  const displayResult = (result != null && result !== "") ? result : (fallbackResult ?? "");

  useEffect(() => {
    if (!toolCallId) return;
    const unsub = toolStreamEventBus.on("tool_result", (ev: ToolStreamEvent) => {
      const evId = (ev as { tool_call_id?: string; data?: { tool_call_id?: string } }).tool_call_id
        ?? (ev as { data?: { tool_call_id?: string } }).data?.tool_call_id;
      if (evId !== toolCallId) return;
      const preview = (ev as { result_preview?: string }).result_preview
        ?? (ev as { data?: { result_preview?: string } }).data?.result_preview;
      if (typeof preview === "string") setLivePreview(preview);
    });
    return unsub;
  }, [toolCallId]);
  useEffect(() => {
    if (isComplete && (result != null || displayResult)) setLivePreview(null);
  }, [isComplete, result, displayResult]);

  // 与 getPartKeyInfo 统一，保证 Fallback 与 ProcessToolInfoCard 等展示一致（路径/查询/命令/目录/doc_path/paths）
  const keyInfo = React.useMemo(
    () => getPartKeyInfo({ toolCall: { name: toolName }, args }),
    [toolName, args]
  );

  const resultSummary = React.useMemo(() => {
    const summary = extractResultSummary(displayResult || "", toolName);
    if (summary) return summary;
    if (!displayResult) return null;
    if (displayResult.length < 100) return displayResult;
    if (displayResult.includes("✅")) {
      const match = displayResult.match(/✅\s*(.+?)(?:\n|$)/);
      return match ? match[1] : "成功";
    }
    if (displayResult.includes("❌")) {
      const match = displayResult.match(/❌\s*(.+?)(?:\n|$)/);
      return match ? match[1] : "失败";
    }
    if (toolName === "read_file") return `${displayResult.split("\n").length} 行`;
    // 充分展示：有结果时至少显示首行摘要，避免空白
    const first = displayResult.trim().split(/\n/)[0]?.replace(/\s+/g, " ").trim() || "";
    return first.length > 60 ? `${first.slice(0, 60)}…` : first || null;
  }, [displayResult, toolName]);

  const displayName = (toolName && getToolDisplayName(toolName)) || (toolCallId ? `工具 · ${String(toolCallId).slice(0, 12)}${String(toolCallId).length > 12 ? "…" : ""}` : "工具");
  const runningPhase = React.useMemo(
    () => (isRunning ? getToolRunningPhase(toolName, args) : null),
    [isRunning, toolName, args]
  );
  const isEmptyCard = !keyInfo && !displayResult && !isRunning;
  const hasExpandableContent = !isEmptyCard && Boolean(displayResult) && (Boolean(isError || isCancelled) || (displayResult?.length ?? 0) > 200);
  const showShortInline = displayResult && displayResult.length <= 200 && isComplete;
  const failureClassifier = React.useMemo(() => {
    const raw = `${displayResult || ""}`;
    const text = `${raw}\n${JSON.stringify(args || {})}`.toLowerCase();
    const errParsed = displayResult ? parseErrorOrPolicyResult(displayResult) : null;
    const hintFromReason = errParsed?.reasonText?.trim() ?? null;
    if (isCancelled) {
      return {
        category: "cancelled" as const,
        actionLabel: t("toolCard.retryContinue"),
        hint: t("toolCard.retryHintCancelled"),
        strategy: t("toolCard.retryStrategyCancelled"),
      };
    }
    if (raw.includes("tool_disabled")) {
      return {
        category: "policy" as const,
        actionLabel: t("toolCard.retryPermission"),
        hint: hintFromReason || t("toolCard.retryHintPolicy"),
        strategy: t("toolCard.retryStrategyPermission"),
      };
    }
    if (
      text.includes("network") ||
      text.includes("fetch") ||
      text.includes("timeout") ||
      text.includes("connection") ||
      text.includes("econnrefused")
    ) {
      return {
        category: "network" as const,
        actionLabel: t("toolCard.retryNetwork"),
        hint: hintFromReason || t("toolCard.retryHintNetwork"),
        strategy: t("toolCard.retryStrategyNetwork"),
      };
    }
    if (
      raw.includes("permission_denied") ||
      raw.includes("policy_layer") ||
      raw.includes("reason_code") ||
      raw.includes("被拦截") ||
      raw.includes("禁止") ||
      raw.includes("LicenseGate") ||
      raw.includes("MCPPermission")
    ) {
      return {
        category: "policy" as const,
        actionLabel: t("toolCard.retryPermission"),
        hint: hintFromReason || t("toolCard.retryHintPolicy"),
        strategy: t("toolCard.retryStrategyPermission"),
      };
    }
    if (
      text.includes("permission") ||
      text.includes("forbidden") ||
      text.includes("denied") ||
      text.includes("unauthorized")
    ) {
      return {
        category: "permission" as const,
        actionLabel: t("toolCard.retryPermission"),
        hint: hintFromReason || t("toolCard.retryHintPermission"),
        strategy: t("toolCard.retryStrategyPermission"),
      };
    }
    if (
      text.includes("invalid") ||
      text.includes("schema") ||
      text.includes("parse") ||
      text.includes("json") ||
      text.includes("argument")
    ) {
      return {
        category: "argument" as const,
        actionLabel: t("toolCard.retryArgument"),
        hint: t("toolCard.retryHintArgument"),
        strategy: t("toolCard.retryStrategyArgument"),
      };
    }
    return {
      category: "generic" as const,
      actionLabel: t("toolCard.retryGeneric"),
      hint: hintFromReason || t("toolCard.retryHintGeneric"),
      strategy: t("toolCard.retryStrategyGeneric"),
    };
  }, [args, isCancelled, displayResult]);
  const retryPrompt = React.useMemo(() => {
    const argsText = args ? JSON.stringify(args, null, 2) : "{}";
    const summary = (resultSummary || displayResult || "").trim();
    const summaryPreview = summary ? summary.slice(0, 400) : (isCancelled ? t("toolCard.lastCallCancelled") : t("toolCard.lastCallFailed"));
    return [
      t("toolCard.retryPromptIntro"),
      t("toolCard.retryPromptStrategy", { strategy: failureClassifier.strategy }),
      t("toolCard.retryPromptToolName", { name: toolName }),
      t("toolCard.retryPromptStatus", { status: isCancelled ? "cancelled" : "error" }),
      "",
      t("toolCard.retryPromptParams"),
      argsText,
      "",
      t("toolCard.retryPromptSummaryLabel"),
      summaryPreview,
    ].join("\n");
  }, [args, failureClassifier.strategy, isCancelled, displayResult, resultSummary, toolName]);
  const handleRetryTool = useCallback(() => {
    triggerAgentPrompt(retryPrompt);
  }, [retryPrompt]);
  const { retryTool } = React.useContext(ToolActionContext);

  if (isEmptyCard) {
    const executedLabel = t("toolCard.executed", { name: displayName });
    return (
      <div className="my-1 text-xs text-muted-foreground/70 inline-flex items-center gap-1.5" role="status" aria-label={executedLabel}>
        <CheckIcon className="size-3 text-emerald-500/80" aria-hidden />
        <span>{executedLabel}</span>
      </div>
    );
  }

  const borderAccent = isError || isCancelled
    ? "border-l-4 border-l-red-500/80"
    : isRunning
      ? "border-l-4 border-l-violet-500/70"
      : isComplete
        ? "border-l-4 border-l-emerald-500/50"
        : "";

  return (
    <div className={cn("my-1.5 text-xs rounded-lg border border-border/20 bg-muted/5 shadow-elevation-sm px-2.5 py-1.5", borderAccent)}>
      <button
        type="button"
        onClick={() => hasExpandableContent && setIsExpanded(!isExpanded)}
        className={cn(
          "w-full text-left inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground/85",
          TOOL_MOTION_CLASS,
          TOOL_FOCUS_CLASS,
          hasExpandableContent && "hover:text-foreground/90 cursor-pointer"
        )}
        aria-expanded={hasExpandableContent ? isExpanded : undefined}
        aria-label={hasExpandableContent ? t("toolCard.expandCollapseResultFor", { name: displayName }) : undefined}
      >
        {hasExpandableContent && (
          isExpanded ? <ChevronDownIcon className="size-3 shrink-0" /> : <ChevronRightIcon className="size-3 shrink-0" />
        )}
        {isRunning ? (
          <LoaderIcon className="size-3 shrink-0 animate-spin text-violet-500" aria-hidden />
        ) : isComplete ? (
          <CheckIcon className="size-3 shrink-0 text-emerald-500" aria-hidden />
        ) : isError ? (
          <XCircleIcon className="size-3 shrink-0 text-red-500" aria-hidden />
        ) : isCancelled ? (
          <XCircleIcon className="size-3 shrink-0 text-amber-500" aria-hidden />
        ) : null}
        <span className="font-medium text-foreground/90 shrink-0">{displayName}</span>
        {keyInfo && (
          <span className="min-w-0 max-w-[320px] truncate px-1.5 py-0.5 rounded bg-muted/40 text-muted-foreground/90 text-[11px] border border-border/30" title={keyInfo}>
            {keyInfo}
          </span>
        )}
        {isError && (failureClassifier.category === "policy" || failureClassifier.category === "permission") && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30">
            {failureClassifier.category === "policy" ? t("toolCard.badgePolicy") : t("toolCard.badgePermission")}
          </span>
        )}
        {(toolName === "get_skill_info" || toolName === "run_skill_script") && (args?.skill_name || args?.skill) && (
          <span className="text-[11px] px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20">
            技能：{String(args?.skill_name ?? args?.skill)}
          </span>
        )}
        {isRunning && (
          <span className="text-[11px] text-violet-600 dark:text-violet-400 font-medium">
            {runningPhase || t("toolCard.statusRunning")}
          </span>
        )}
        {(resultSummary || (isComplete && displayResult && (displayResult.length <= 120 || displayResult.trim().split(/\n/)[0]))) && !showShortInline && (
          <span className="text-muted-foreground/80 truncate max-w-[280px]" title={resultSummary || (displayResult || "").trim().split(/\n/)[0]}>
            · {resultSummary || ((displayResult || "").trim().split(/\n/)[0]?.replace(/\s+/g, " ").slice(0, 80) || "").trim()}{((displayResult || "").trim().split(/\n/)[0]?.length ?? 0) > 80 ? "…" : ""}
          </span>
        )}
        {livePreview && !resultSummary && !isRunning && (
          <span className="text-muted-foreground/60">· {livePreview.replace(/\n/g, " ").slice(0, 80)}{livePreview.length > 80 ? "…" : ""}</span>
        )}
        {livePreview && isRunning && (
          <span className="text-muted-foreground/70 truncate max-w-[280px]">{livePreview.replace(/\n/g, " ").slice(0, 60)}{livePreview.length > 60 ? "…" : ""}</span>
        )}
        {elapsedSec > 0 && !isRunning && (
          <span className="text-muted-foreground/50 text-[10px] tabular-nums">{elapsedSec}s</span>
        )}
      </button>
      {isComplete && !displayResult && (
        <div className="mt-1.5 ml-5 text-[11px] text-muted-foreground/80">
          {t("toolCard.resultNotReturned")}
        </div>
      )}
      {isRunning && livePreview && livePreview.length > 80 && (
        <div className="mt-1.5 ml-5 pl-2 border-l-2 border-violet-400/30 text-[11px] text-muted-foreground/85 line-clamp-3 wrap-break-word">
          {livePreview.replace(/\n/g, " ").slice(0, 280)}{livePreview.length > 280 ? "…" : ""}
        </div>
      )}
      {(isError || isCancelled) && (
        <div className="mt-1.5 ml-5 space-y-1">
          <div className="text-[11px] text-muted-foreground/80">{failureClassifier.hint}</div>
          <ToolActionBar
            actions={[
              {
                label: failureClassifier.actionLabel,
                icon: <RotateCcwIcon className="size-3" />,
                onClick: handleRetryTool,
              },
              ...(displayResult
                ? [{ label: t("toolCard.copyError"), icon: <CopyIcon className="size-3" />, onClick: () => copyToClipboard(displayResult) }]
                : []),
            ]}
          />
        </div>
      )}
      {/* 短结果（≤200 字）折叠时直接内联显示全文（Cursor 式：紧凑结果区） */}
      {showShortInline && !isExpanded && (
        <div className="mt-1.5 ml-5 space-y-1">
          <div className={TOOL_RESULT_BOX_CLASS}>
            <pre className="whitespace-pre-wrap wrap-break-word">{displayResult}</pre>
          </div>
          <RawOutputPanel raw={displayResult} toolName={toolName} />
        </div>
      )}
      {isExpanded && displayResult && (
        <div className={cn("mt-1.5 ml-5 space-y-1.5", TOOL_DETAIL_PANEL_CLASS)}>
          <ToolActionBar
            actions={[
              { label: t("toolCard.runAgain"), icon: <RefreshCwIcon className="size-3" />, onClick: () => retryTool(toolName, (args ?? {}) as Record<string, unknown>) },
              { label: t("toolCard.copyResult"), icon: <CopyIcon className="size-3" />, onClick: () => copyToClipboard(displayResult) },
            ]}
          />
          <div className={cn(TOOL_RESULT_BOX_CLASS, "max-h-[220px] overflow-y-auto")}>
            <pre className="whitespace-pre-wrap wrap-break-word">{displayResult}</pre>
          </div>
          <RawOutputPanel raw={displayResult} toolName={toolName} />
        </div>
      )}
    </div>
  );
};

// Cursor 风格：文件内容直接显示为纯文本，不使用代码块背景
// Cursor 中文件内容是直接嵌入到对话流中的，没有特殊的黑色背景框
const FileContent: React.FC<{ content: string; maxLines?: number; language?: string }> = ({ 
  content, 
  maxLines = 15,
  language,
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  
  // ✅ 检测内容是否已包含行号格式（如 "1|内容" 或 "  1|内容"）
  const hasLineNumbers = React.useMemo(() => {
    const firstLines = content.split("\n").slice(0, 5);
    return firstLines.some(line => /^\s*\d+\|/.test(line));
  }, [content]);
  
  // ✅ 如果内容已包含行号，去除行号前缀
  const processedLines = React.useMemo(() => {
    const lines = content.split("\n");
    if (hasLineNumbers) {
      return lines.map(line => line.replace(/^\s*\d+\|/, ''));
    }
    return lines;
  }, [content, hasLineNumbers]);
  
  const needsTruncate = processedLines.length > maxLines;
  const displayLines = needsTruncate && !isExpanded 
    ? processedLines.slice(0, maxLines)
    : processedLines;
  
  // Cursor 风格：文件内容用等宽字体，浅灰色，左侧有行号
  return (
    <div className="mt-1.5 rounded-lg border border-border/40 bg-zinc-900/95 text-zinc-100 overflow-x-auto">
      <div className="px-2.5 py-1 text-[10px] uppercase tracking-wide text-zinc-400 border-b border-zinc-700/70">
        {language || "text"}
      </div>
      <div className="p-2 text-xs font-mono">
      {displayLines.map((line, i) => (
        <div key={i} className="flex hover:bg-zinc-800/70 leading-5 rounded-sm">
          <span className="w-8 text-right pr-3 text-zinc-500 select-none shrink-0">{i + 1}</span>
          <span className="whitespace-pre">{line || " "}</span>
        </div>
      ))}
      {needsTruncate && (
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="mt-1 text-xs text-blue-400 hover:text-blue-300"
        >
          {isExpanded ? t("toolCard.collapse") : t("toolCard.showAllLines", { n: processedLines.length })}
        </button>
      )}
      </div>
    </div>
  );
};

// ============================================================
// 读取文件 - Cursor 风格：文件名突出，内容直接显示 + 流式进度
// ============================================================
type ReadFileArgs = { file_path?: string; path?: string; offset?: number; limit?: number };

export const ReadFileToolUI = makeAssistantToolUI<ReadFileArgs, string>({
  toolName: "read_file",
  render: function ReadFileUI({ args, result, status, toolCallId }) {
    const messageId = useMessage((s) => (s as { id?: string }).id);
    const toolResultsMap = useContext(ToolResultsByMessageIdContext);
    const fallbackResult = messageId && toolCallId ? toolResultsMap.get(messageId)?.[toolCallId] : undefined;
    const displayResult = (result != null && result !== "") ? result : (fallbackResult ?? "");
    const isRunning = status?.type === "running";
    const isComplete = status?.type === "complete";
    const elapsedSeconds = useToolElapsedSeconds(status);
    const lineCount = displayResult ? displayResult.split("\n").length : 0;
    const [showContent, setShowContent] = useState(false);
    useEffect(() => {
      if (isComplete && displayResult) setShowContent(true);
    }, [isComplete, displayResult]);
    
    // ✅ 流式读取进度
    const [readProgress, setReadProgress] = useState<{
      status: string;
      fileType?: string;
      charsRead?: number;
    } | null>(null);
    
    // ✅ 订阅读取进度事件（按类型订阅，避免 onAll 高频触发）
    useEffect(() => {
      if (!isRunning) {
        setReadProgress(null);
        return;
      }
      const unsubStart = toolStreamEventBus.on('file_read_start', (event) => {
        setReadProgress({ status: '开始读取', fileType: event.file_type });
      });
      const unsubProgress = toolStreamEventBus.on('file_read_progress', (event) => {
        setReadProgress(prev => ({ ...prev, status: event.status === 'parsing' ? '解析中' : '读取中' }));
      });
      const unsubComplete = toolStreamEventBus.on('file_read_complete', (event) => {
        setReadProgress({ status: '完成', charsRead: event.chars_read });
      });
      return () => {
        unsubStart();
        unsubProgress();
        unsubComplete();
      };
    }, [isRunning]);
    
    const filePath = args?.file_path || args?.path || "";
    const fileName = getFileName(filePath);
    const fileExt = fileName.includes(".") ? fileName.split(".").pop() : undefined;
    
    const borderAccent = isRunning ? TOOL_CARD_BORDER_RUNNING : isComplete ? TOOL_CARD_BORDER_COMPLETE : "";
    return (
      <div className={cn("my-1.5", TOOL_CARD_CONTAINER_BASE, borderAccent)}>
        <div className="inline-flex items-center gap-1.5 text-sm">
          <button
            onClick={() => (displayResult || lineCount > 0) && setShowContent(!showContent)}
            className="inline-flex items-center gap-1.5 hover:bg-muted/30 rounded px-1.5 py-0.5 -ml-1.5 transition-colors"
          >
            {isRunning ? (
              <LoaderIcon className="size-3.5 animate-spin text-violet-500" />
            ) : (
              <CheckIcon className="size-3.5 text-emerald-500" />
            )}
            <FileIcon className="size-3.5 text-blue-500" />
          </button>
          <ClickableFilePath path={filePath} className="text-foreground" />
          
          {isRunning ? (
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <ProgressDots text="读取" />
              {readProgress && (
                <span className="text-blue-400">
                  {readProgress.status}
                  {readProgress.fileType && ` (${readProgress.fileType})`}
                </span>
              )}
              {elapsedSeconds > 0 && <span className="text-muted-foreground/50 tabular-nums">· {elapsedSeconds}s</span>}
            </span>
          ) : isComplete && (
            <button
              onClick={() => (displayResult || lineCount > 0) && setShowContent(!showContent)}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              · {displayResult ? `${lineCount} 行` : t("toolCard.resultNotReturned")}
              {elapsedSeconds > 0 && <span className="tabular-nums"> · {elapsedSeconds}s</span>}
              {(displayResult || lineCount > 0) && (showContent ? <ChevronDownIcon className="size-3 inline ml-1" /> : <ChevronRightIcon className="size-3 inline ml-1" />)}
            </button>
          )}
        </div>
        {isComplete && !displayResult && filePath && (
          <div className="mt-1 ml-5 text-[12px] text-muted-foreground/90">
            {t("toolCard.resultNotReturned")}
          </div>
        )}
        {/* 文件内容与操作栏：仅在展开时显示 */}
        {displayResult && isComplete && showContent && (
          <>
            <div className="mt-1.5 ml-5">
              <ToolActionBar
                actions={[
                  { label: t("toolCard.openInEditor"), icon: <ExternalLinkIcon className="size-3" />, onClick: () => fileEventBus.openFile(filePath) },
                  { label: t("toolCard.copyPath"), icon: <CopyIcon className="size-3" />, onClick: () => copyToClipboard(filePath) },
                  { label: t("toolCard.copyContent"), icon: <CopyIcon className="size-3" />, onClick: () => copyToClipboard(displayResult) },
                ]}
              />
            </div>
            <FileContent content={displayResult} maxLines={25} language={fileExt} />
          </>
        )}
      </div>
    );
  },
});

// ============================================================
// 批量读取文件工具 - 文件列表展示
// ============================================================
type BatchReadFilesArgs = { file_paths?: string[]; max_chars_per_file?: number };

export const BatchReadFilesToolUI = makeAssistantToolUI<BatchReadFilesArgs, string>({
  toolName: "batch_read_files",
  render: function BatchReadFilesUI({ args, result, status, toolCallId }) {
    const messageId = useMessage((s) => (s as { id?: string }).id);
    const toolResultsMap = useContext(ToolResultsByMessageIdContext);
    const fallbackResult = messageId && toolCallId ? toolResultsMap.get(messageId)?.[toolCallId] : undefined;
    const displayResult = (result != null && result !== "") ? result : (fallbackResult ?? "");
    const isRunning = status?.type === "running";
    const isComplete = status?.type === "complete";
    const [isExpanded, setIsExpanded] = useState(false);

    const raw = args?.file_paths;
    const filePaths: string[] = Array.isArray(raw)
      ? raw.filter((p): p is string => typeof p === "string")
      : raw && typeof raw === "object"
        ? Object.values(raw).filter((p): p is string => typeof p === "string")
        : [];
    const fileCount = filePaths.length;
    
    const resultInfo = React.useMemo(() => {
      if (!displayResult) return null;
      try {
        const parsed = JSON.parse(displayResult);
        return {
          filesRead: parsed.files_read || 0,
          duration: parsed.duration || "",
          results: parsed.results || [],
          totalChars: parsed.results?.reduce((sum: number, f: any) => sum + (f.chars || 0), 0) || 0,
        };
      } catch {
        return null;
      }
    }, [displayResult]);
    
    // 格式化字符数
    const formatChars = (chars: number) => {
      if (chars > 10000) return `${(chars / 1000).toFixed(1)}K`;
      return chars.toString();
    };
    const borderAccent = isRunning ? TOOL_CARD_BORDER_RUNNING : isComplete ? TOOL_CARD_BORDER_COMPLETE : "";
    return (
      <div className={cn("my-1.5", TOOL_CARD_CONTAINER_BASE, borderAccent)}>
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="inline-flex items-center gap-1.5 text-sm hover:bg-muted/30 rounded px-1.5 py-0.5 -ml-1.5 transition-colors w-full text-left"
        >
          {isRunning ? (
            <LoaderIcon className="size-3.5 animate-spin text-violet-500" />
          ) : isComplete ? (
            <CheckIcon className="size-3.5 text-emerald-500" />
          ) : (
            <EyeIcon className="size-3.5 text-blue-500" />
          )}
          <FileIcon className="size-3.5 text-blue-500" />
          <span className="text-foreground">读取文件</span>
          <span className="text-xs text-muted-foreground">
            · {resultInfo ? resultInfo.filesRead : fileCount} 个
            {resultInfo?.totalChars ? ` · ${formatChars(resultInfo.totalChars)} 字符` : ''}
            {resultInfo?.duration && ` · ${resultInfo.duration}`}
          </span>
          {(resultInfo?.results?.length || filePaths.length > 0) && (
            isExpanded ? (
              <ChevronDownIcon className="size-3 text-muted-foreground" />
            ) : (
              <ChevronRightIcon className="size-3 text-muted-foreground" />
            )
          )}
        </button>
        {isComplete && !displayResult && filePaths.length > 0 && (
          <div className="mt-1 ml-5 text-[12px] text-muted-foreground/90">
            {t("toolCard.resultNotReturned")}
          </div>
        )}
        {/* 文件列表 + 复制所有路径 */}
        {isExpanded && (
          <div className="mt-1.5 ml-5 space-y-1.5">
            {isComplete && (resultInfo?.results?.length || filePaths.length > 0) && (
              <ToolActionBar
                actions={[{
                  label: t("toolCard.copyAllPaths"),
                  icon: <CopyIcon className="size-3" />,
                  onClick: () => copyToClipboard(
                    (resultInfo?.results?.map((f: any) => f.path) ?? filePaths).filter(Boolean).join("\n")
                  ),
                }]}
              />
            )}
            <div className="space-y-0.5">
            {(resultInfo?.results || filePaths.map(p => ({ path: p }))).map((file: any, i: number) => (
              <div 
                key={i} 
                className="flex items-center gap-2 py-0.5 px-1.5 rounded hover:bg-muted/30 text-xs"
              >
                <FileIcon className="size-3 text-muted-foreground shrink-0" />
                <ClickableFilePath path={file.path} className="flex-1 truncate" />
                {file.chars && (
                  <span className="text-muted-foreground/60 shrink-0">
                    {formatChars(file.chars)}
                    {file.truncated && <span className="text-amber-500 ml-1">截断</span>}
                  </span>
                )}
              </div>
            ))}
            </div>
          </div>
        )}
      </div>
    );
  },
});

// 可折叠原始输出面板：文件类用片段，其它用截断 JSON/文本
const FILE_LIKE_TOOLS = new Set(["read_file", "write_file", "edit_file", "batch_read_files", "grep_search", "file_search", "list_directory", "delete_file"]);
const RAW_PREVIEW_LINES = 25;
const RAW_PREVIEW_CHARS = 500;

const RawOutputPanel: React.FC<{ raw: string; toolName: string }> = ({ raw, toolName }) => {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(false);
  const isFileLike = FILE_LIKE_TOOLS.has(toolName);
  const lines = raw.split("\n");
  const snippet = isFileLike
    ? lines.slice(0, full ? undefined : RAW_PREVIEW_LINES).join("\n")
    : raw.length <= RAW_PREVIEW_CHARS || full ? raw : raw.slice(0, RAW_PREVIEW_CHARS) + "\n…";
  const hasMore = isFileLike ? lines.length > RAW_PREVIEW_LINES : raw.length > RAW_PREVIEW_CHARS;
  if (!raw) return null;
  return (
    <div className="mt-1.5 rounded border border-border/50 bg-muted/30 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full inline-flex items-center gap-1.5 px-2 py-1.5 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/40 text-left"
      >
        {open ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />}
        <span>原始输出</span>
        {!open && <span className="text-muted-foreground/60">({isFileLike ? `${lines.length} 行` : `${raw.length} 字符`})</span>}
      </button>
      {open && (
        <div className="px-2 pb-2 pt-0 max-h-[280px] overflow-y-auto">
          <pre className="text-[11px] font-mono whitespace-pre-wrap wrap-break-word text-muted-foreground">{snippet}</pre>
          {hasMore && (
            <button
              type="button"
              onClick={() => setFull((f) => !f)}
              className="mt-1 text-[11px] text-primary hover:underline"
            >
              {full ? t("toolCard.collapse") : t("toolCard.expandAll")}
            </button>
          )}
        </div>
      )}
    </div>
  );
};

// 可展开结果 - 优化版，支持搜索结果格式化
const ExpandableResult: React.FC<{ result: string; toolName: string }> = ({ result, toolName }) => {
  const [isExpanded, setIsExpanded] = useState(result.length < 300);
  
  // 解析搜索结果，提取文件和匹配行
  const parsedResults = React.useMemo(() => {
    if (!toolName.includes("search") && toolName !== "grep_search") {
      return null;
    }
    
    const files: Array<{ path: string; matches: Array<{ line: number; content: string }> }> = [];
    let currentFile: { path: string; matches: Array<{ line: number; content: string }> } | null = null;
    
    const lines = result.split("\n");
    for (const line of lines) {
      // 匹配文件路径行（如 "📄 path/to/file.ts" 或 "path/to/file.ts:"）
      const fileMatch = line.match(/^(?:📄\s*)?([^\s:]+\.[a-zA-Z]+):?$/);
      if (fileMatch) {
        if (currentFile) files.push(currentFile);
        currentFile = { path: fileMatch[1], matches: [] };
        continue;
      }
      
      // 匹配带行号的内容（如 "  123: content" 或 "123|content"）
      const lineMatch = line.match(/^\s*(\d+)[:|]\s*(.*)$/);
      if (lineMatch && currentFile) {
        currentFile.matches.push({
          line: parseInt(lineMatch[1]),
          content: lineMatch[2],
        });
      }
    }
    if (currentFile) files.push(currentFile);
    
    return files.length > 0 ? files : null;
  }, [result, toolName]);
  
  // 如果是搜索结果，使用格式化显示；每行可点击打开并定位
  if (parsedResults) {
    return (
      <div className="mt-1 space-y-2">
        {parsedResults.slice(0, isExpanded ? undefined : 3).map((file, i) => (
          <div key={i} className="text-sm">
            <ClickableFilePath path={file.path} className="text-blue-500 text-xs" />
            <div className="mt-0.5 ml-2 space-y-0.5">
              {file.matches.slice(0, isExpanded ? undefined : 2).map((match, j) => (
                <button
                  key={j}
                  type="button"
                  onClick={() => fileEventBus.openFile(file.path, match.line)}
                  className="w-full flex text-xs font-mono hover:bg-blue-500/10 text-left rounded"
                  title={`打开并定位到第 ${match.line} 行`}
                >
                  <span className="w-10 text-right pr-2 text-muted-foreground/50 shrink-0">
                    {match.line}
                  </span>
                  <span className="text-muted-foreground truncate">
                    {match.content}
                  </span>
                </button>
              ))}
              {!isExpanded && file.matches.length > 2 && (
                <div className="text-xs text-muted-foreground/50 ml-10">
                  ... 还有 {file.matches.length - 2} 行
                </div>
              )}
            </div>
          </div>
        ))}
        {(parsedResults.length > 3 || parsedResults.some(f => f.matches.length > 2)) && (
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="text-xs text-blue-500 hover:text-blue-600"
          >
            {isExpanded ? t("toolCard.collapse") : t("toolCard.expandAllFiles", { n: parsedResults.length })}
          </button>
        )}
      </div>
    );
  }
  
  // 普通结果显示
  if (result.length < 300) {
    return (
      <div className="mt-1 text-sm text-muted-foreground whitespace-pre-wrap">
        {result}
      </div>
    );
  }
  
  return (
    <div className="mt-1">
      <div className="text-sm text-muted-foreground whitespace-pre-wrap">
        {isExpanded ? result : result.slice(0, 200) + "..."}
      </div>
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="text-xs text-muted-foreground/60 hover:text-muted-foreground mt-1"
      >
        {isExpanded ? t("toolCard.collapse") : t("toolCard.expandMore")}
      </button>
    </div>
  );
};

// ============================================================
// 写入文件 - 文件创建/修改展示
// ============================================================
type WriteFileArgs = { file_path?: string; path?: string; content?: string };

const actionRequestsMatch = (
  actions: Array<{ name?: string; args?: Record<string, unknown>; diff?: { original?: string; modified?: string; path?: string } }>,
  toolName: string,
  path: string
): { index: number; action: typeof actions[0] } | null => {
  const idx = actions.findIndex(
    (a) => (a.name === toolName) && ((a.args?.file_path ?? a.args?.path) === path || String(a.args?.file_path ?? a.args?.path ?? "").trim() === path)
  );
  return idx >= 0 ? { index: idx, action: actions[idx] } : null;
};

export const WriteFileToolUI = makeAssistantToolUI<WriteFileArgs, string>({
  toolName: "write_file",
  render: function WriteFileUI({ args, result, status, toolCallId }) {
    const messageId = useMessage((s) => (s as { id?: string }).id);
    const toolResultsMap = useContext(ToolResultsByMessageIdContext);
    const fallbackResult = messageId && toolCallId ? toolResultsMap.get(messageId)?.[toolCallId] : undefined;
    const displayResult = (result != null && result !== "") ? result : (fallbackResult ?? "");
    const isRunning = status?.type === "running";
    const isComplete = status?.type === "complete";
    const contentLines = args?.content?.split("\n").length || 0;
    const [showContent, setShowContent] = useState(false);
    const [resumeLoading, setResumeLoading] = useState(false);
    const { state: interruptState } = useContext(InterruptStateContext);
    const actions = (Array.isArray(interruptState.interruptData?.action_requests) ? interruptState.interruptData?.action_requests : []) as Array<{ name?: string; args?: Record<string, unknown>; diff?: { original?: string; modified?: string; path?: string } }>;
    const filePath = args?.file_path || args?.path || "";
    const pendingMatch = interruptState.hasInterrupt && interruptState.interruptType === "tool_diff_approval" && filePath
      ? actionRequestsMatch(actions, "write_file", filePath)
      : null;
    useEffect(() => {
      if (isComplete && args?.content && contentLines <= 15) setShowContent(true);
    }, [isComplete, args?.content, contentLines]);

    const fileName = getFileName(filePath);
    const isSuccess = !!displayResult && (displayResult.includes("✅") || displayResult.includes("成功") || (isComplete && !displayResult.includes("❌") && !displayResult.includes("失败")));
    const isNewFile = displayResult?.includes("创建") || displayResult?.includes("新建");
    const isError = isComplete && !isSuccess;
    const borderAccent = isRunning ? TOOL_CARD_BORDER_RUNNING : isComplete ? (isError ? TOOL_CARD_BORDER_ERROR : TOOL_CARD_BORDER_COMPLETE) : "";

    const handleApproveReject = useCallback(async (approve: boolean) => {
      const threadId = getCurrentThreadIdFromStorage();
      if (!threadId || !pendingMatch) return;
      setResumeLoading(true);
      try {
        const decisions = actions.map((_, i) => ({ type: i === pendingMatch.index ? (approve ? "approve" : "reject") : "approve" }));
        await resumeInterrupt(threadId, { decisions });
        if (approve) toast.success(t("interrupt.toast.accepted"));
        else toast.success(t("interrupt.toast.rejected"));
      } catch (e) {
        toast.error(t("thread.planConfirmFailed"));
      } finally {
        setResumeLoading(false);
      }
    }, [pendingMatch, actions]);

    return (
      <div className={cn("my-1.5", TOOL_CARD_CONTAINER_BASE, borderAccent)}>
        <div className="inline-flex items-center gap-1.5 text-sm">
          <button
            onClick={() => args?.content && setShowContent(!showContent)}
            className="inline-flex items-center gap-1.5 hover:bg-muted/30 rounded px-1.5 py-0.5 -ml-1.5 transition-colors w-full text-left"
          >
            {isRunning ? (
              <LoaderIcon className="size-3.5 animate-spin text-violet-500" />
            ) : isSuccess ? (
              <CheckIcon className="size-3.5 text-emerald-500" />
            ) : (
              <AlertCircleIcon className="size-3.5 text-red-500" />
            )}
            {isNewFile ? (
              <FileIcon className="size-3.5 text-emerald-500" />
            ) : (
              <PencilIcon className="size-3.5 text-amber-500" />
            )}
          </button>
          <ClickableFilePath path={filePath} className="text-foreground" />
          
          {isRunning ? (
            <>
              <span className="text-xs text-muted-foreground"><ProgressDots text="写入" /></span>
              <span className="text-[11px] text-muted-foreground/80 ml-1" title={t("toolCard.idePermissionHint")}>{t("toolCard.idePermissionHint")}</span>
            </>
          ) : isComplete && (
            <>
              <span className="text-xs text-muted-foreground">
                · {isNewFile ? "已创建" : "已保存"} · {contentLines} 行
              </span>
              {args?.content && (
                <button
                  onClick={() => setShowContent(!showContent)}
                  className="text-xs text-muted-foreground hover:text-foreground ml-1"
                  title={showContent ? t("toolCard.collapseContent") : t("toolCard.expandContent")}
                >
                  {showContent ? <ChevronDownIcon className="size-3 inline" /> : <ChevronRightIcon className="size-3 inline" />}
                </button>
              )}
            </>
          )}
        </div>
        {/* 会话内确认：待审批时在卡内展示 diff + 接受/拒绝（与 Footer 简短提示配合） */}
        {pendingMatch && pendingMatch.action.diff && (
          <div className="mt-2 ml-5 rounded-lg border border-border/50 bg-muted/10 p-2 space-y-2">
            <p className="text-[11px] text-muted-foreground">{t("thread.waitingConfirmation")}</p>
            <InlineDiffView
              original={pendingMatch.action.diff.original ?? ""}
              modified={pendingMatch.action.diff.modified ?? ""}
              filePath={pendingMatch.action.diff.path ?? filePath}
              maxLines={12}
            />
            <div className="flex gap-2">
              <Button size="sm" variant="default" disabled={resumeLoading} onClick={() => handleApproveReject(true)}>
                {resumeLoading ? <LoaderIcon className="size-3.5 animate-spin" /> : null}
                {t("interrupt.btnAccept")}
              </Button>
              <Button size="sm" variant="outline" disabled={resumeLoading} onClick={() => handleApproveReject(false)}>
                {t("interrupt.btnReject")}
              </Button>
            </div>
          </div>
        )}
        {/* 完成后提示：内容已写入，可在编辑器中查看 + 打开/复制路径 */}
        {isComplete && isSuccess && filePath && (
          <div className="mt-1.5 ml-5 flex items-center gap-2 flex-wrap">
            <span className="text-[11px] text-muted-foreground/80">内容已写入，可在编辑器中查看当前文件。</span>
            <button
              type="button"
              onClick={() => fileEventBus.openFile(filePath)}
              className="text-xs text-primary hover:underline"
            >
              {t("toolCard.openInEditor")}
            </button>
            <ToolActionBar
              actions={[
                { label: t("toolCard.copyPath"), icon: <CopyIcon className="size-3" />, onClick: () => copyToClipboard(filePath) },
              ]}
            />
          </div>
        )}
        {/* 写入内容预览 - Cursor 风格 */}
        {showContent && args?.content && (
          <FileContent content={args.content} maxLines={15} />
        )}
      </div>
    );
  },
});

// ============================================================
// 编辑文件 - Cursor 风格（专用 UI，显示 diff 提示）
// ============================================================
type EditFileArgs = {
  file_path?: string; path?: string;
  old_string?: string; new_string?: string;
  old_str?: string; new_str?: string;
  insert_line?: number; content?: string;
};

export const EditFileToolUI = makeAssistantToolUI<EditFileArgs, string>({
  toolName: "edit_file",
  render: function EditFileUI({ args, result, status, toolCallId }) {
    const messageId = useMessage((s) => (s as { id?: string }).id);
    const toolResultsMap = useContext(ToolResultsByMessageIdContext);
    const fallbackResult = messageId && toolCallId ? toolResultsMap.get(messageId)?.[toolCallId] : undefined;
    const displayResult = (result != null && result !== "") ? result : (fallbackResult ?? "");
    const isRunning = status?.type === "running";
    const isComplete = status?.type === "complete";
    const elapsedSeconds = useToolElapsedSeconds(status);
    const [showDiff, setShowDiff] = useState(false);
    const [resumeLoading, setResumeLoading] = useState(false);
    const { state: interruptState } = useContext(InterruptStateContext);
    const actions = (Array.isArray(interruptState.interruptData?.action_requests) ? interruptState.interruptData?.action_requests : []) as Array<{ name?: string; args?: Record<string, unknown>; diff?: { original?: string; modified?: string; path?: string } }>;
    const filePath = args?.file_path || args?.path || "";
    const pendingMatch = interruptState.hasInterrupt && interruptState.interruptType === "tool_diff_approval" && filePath
      ? actionRequestsMatch(actions, "edit_file", filePath)
      : null;
    const fileName = getFileName(filePath);
    const isSuccess = displayResult?.includes("✅") || displayResult?.includes("成功") || (isComplete && !displayResult?.includes("❌") && !displayResult?.includes("失败"));

    const oldContent = args?.old_string ?? args?.old_str;
    const newContent = args?.new_string ?? args?.new_str;
    // 是否有 diff 数据且确有变更（后端传 old_string/new_string，兼容 old_str/new_str）
    const hasDiff = Boolean(oldContent != null && newContent != null && oldContent !== newContent);
    const isError = isComplete && !isSuccess;
    const borderAccent = isRunning ? TOOL_CARD_BORDER_RUNNING : isComplete ? (isError ? TOOL_CARD_BORDER_ERROR : TOOL_CARD_BORDER_COMPLETE) : "";
    useEffect(() => {
      if (isComplete && hasDiff) setShowDiff(true);
    }, [isComplete, hasDiff]);

    const handleApproveReject = useCallback(async (approve: boolean) => {
      const threadId = getCurrentThreadIdFromStorage();
      if (!threadId || !pendingMatch) return;
      setResumeLoading(true);
      try {
        const decisions = actions.map((_, i) => ({ type: i === pendingMatch.index ? (approve ? "approve" : "reject") : "approve" }));
        await resumeInterrupt(threadId, { decisions });
        if (approve) toast.success(t("interrupt.toast.accepted"));
        else toast.success(t("interrupt.toast.rejected"));
      } catch (e) {
        toast.error(t("thread.planConfirmFailed"));
      } finally {
        setResumeLoading(false);
      }
    }, [pendingMatch, actions]);

    // 变更描述
    const changeDesc = React.useMemo(() => {
      if (oldContent && newContent) {
        const oldLines = oldContent.split("\n").length;
        const newLines = newContent.split("\n").length;
        return `${oldLines} 行 → ${newLines} 行`;
      }
      if (args?.insert_line != null) return `在第 ${args.insert_line} 行插入`;
      return "已编辑";
    }, [args, oldContent, newContent]);

    return (
      <div className={cn("my-1.5", TOOL_CARD_CONTAINER_BASE, borderAccent)}>
        <div className="inline-flex items-center gap-1.5 text-sm">
          <div className="inline-flex items-center gap-1.5 px-1.5 py-0.5 -ml-1.5">
            {isRunning ? (
              <LoaderIcon className="size-3.5 animate-spin text-violet-500" />
            ) : isSuccess ? (
              <CheckIcon className="size-3.5 text-emerald-500" />
            ) : (
              <AlertCircleIcon className="size-3.5 text-red-500" />
            )}
            <PencilIcon className="size-3.5 text-amber-500" />
          </div>
          <ClickableFilePath path={filePath} className="text-foreground" />
          {isRunning ? (
            <>
              <span className="text-xs text-muted-foreground"><ProgressDots text="编辑" /></span>
              <span className="text-[11px] text-muted-foreground/80 ml-1" title={t("toolCard.idePermissionHint")}>{t("toolCard.idePermissionHint")}</span>
            </>
          ) : isComplete && (
            <>
              <span className="text-xs text-muted-foreground">· {changeDesc}</span>
              {elapsedSeconds > 0 && <span className="text-xs text-muted-foreground tabular-nums">· {elapsedSeconds}s</span>}
              {hasDiff && (
                <button
                  onClick={() => setShowDiff(!showDiff)}
                  className="text-xs text-primary/80 hover:text-primary ml-1 transition-colors"
                >
                  {showDiff ? t("toolCard.collapseDiff") : t("toolCard.viewDiff")}
                </button>
              )}
            </>
          )}
        </div>
        {/* 会话内确认：待审批时在卡内展示 diff + 接受/拒绝 */}
        {pendingMatch && pendingMatch.action.diff && (
          <div className="mt-2 ml-5 rounded-lg border border-border/50 bg-muted/10 p-2 space-y-2">
            <p className="text-[11px] text-muted-foreground">{t("thread.waitingConfirmation")}</p>
            <InlineDiffView
              original={pendingMatch.action.diff.original ?? ""}
              modified={pendingMatch.action.diff.modified ?? ""}
              filePath={pendingMatch.action.diff.path ?? filePath}
              maxLines={12}
            />
            <div className="flex gap-2">
              <Button size="sm" variant="default" disabled={resumeLoading} onClick={() => handleApproveReject(true)}>
                {resumeLoading ? <LoaderIcon className="size-3.5 animate-spin" /> : null}
                {t("interrupt.btnAccept")}
              </Button>
              <Button size="sm" variant="outline" disabled={resumeLoading} onClick={() => handleApproveReject(false)}>
                {t("interrupt.btnReject")}
              </Button>
            </div>
          </div>
        )}
        {isComplete && isSuccess && filePath && (
          <div className="mt-1.5 ml-5 flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => {
                if (hasDiff && oldContent != null && newContent != null) {
                  window.dispatchEvent(
                    new CustomEvent(EVENTS.OPEN_FILE_IN_EDITOR, {
                      detail: { path: filePath, showDiff: true, diffOriginal: oldContent, diffContent: newContent },
                    })
                  );
                } else {
                  fileEventBus.openFile(filePath);
                }
              }}
              className="text-xs text-primary hover:underline"
            >
              {t("toolCard.openInEditorDiff")}
            </button>
            <ToolActionBar
              actions={[
                { label: t("toolCard.copyPath"), icon: <CopyIcon className="size-3" />, onClick: () => copyToClipboard(filePath) },
              ]}
            />
          </div>
        )}
        {/* 内联 diff 展示 */}
        {showDiff && hasDiff && oldContent != null && newContent != null && (
          <div className="mt-1.5 ml-5">
            <InlineDiffView
              original={oldContent}
              modified={newContent}
              filePath={filePath}
            />
          </div>
        )}
      </div>
    );
  },
});

// ============================================================
// 写入二进制文件 - 完成后可「在编辑区对比并保存」
// ============================================================
type WriteFileBinaryArgs = { file_path?: string; content?: string };

export const WriteFileBinaryToolUI = makeAssistantToolUI<WriteFileBinaryArgs, string>({
  toolName: "write_file_binary",
  render: function WriteFileBinaryUI({ args, result, status }) {
    const displayResult = (result != null && result !== "") ? result : "";
    const isRunning = status?.type === "running";
    const isComplete = status?.type === "complete";
    const filePath = (args?.file_path ?? "").trim();
    const content = args?.content ?? "";
    let isSuccess = false;
    if (displayResult) {
      try {
        const parsed = JSON.parse(displayResult) as { ok?: boolean };
        isSuccess = parsed?.ok === true;
      } catch {
        isSuccess = displayResult.includes("✅") || (isComplete && !displayResult.includes("❌") && !displayResult.includes("失败"));
      }
    }
    const isError = isComplete && !isSuccess;
    const borderAccent = isRunning ? TOOL_CARD_BORDER_RUNNING : isComplete ? (isError ? TOOL_CARD_BORDER_ERROR : TOOL_CARD_BORDER_COMPLETE) : "";

    return (
      <div className={cn("my-1.5", TOOL_CARD_CONTAINER_BASE, borderAccent)}>
        <div className="inline-flex items-center gap-1.5 text-sm">
          <button type="button" className="inline-flex items-center gap-1.5 hover:bg-muted/30 rounded px-1.5 py-0.5 -ml-1.5 transition-colors cursor-default">
            {isRunning ? (
              <LoaderIcon className="size-3.5 animate-spin text-violet-500" />
            ) : isSuccess ? (
              <CheckIcon className="size-3.5 text-emerald-500" />
            ) : (
              <AlertCircleIcon className="size-3.5 text-red-500" />
            )}
            <FileIcon className="size-3.5 text-emerald-500" />
          </button>
          <ClickableFilePath path={filePath || "(未指定路径)"} className="text-foreground" />
          {isRunning ? (
            <span className="text-xs text-muted-foreground"><ProgressDots text="写入二进制" /></span>
          ) : isComplete ? (
            <span className="text-xs text-muted-foreground">· 已写入二进制</span>
          ) : null}
        </div>
        {isComplete && isSuccess && filePath && content && (
          <div className="mt-1.5 ml-5 flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => {
                window.dispatchEvent(new CustomEvent(EVENTS.OPEN_BINARY_DIFF, {
                  detail: { targetPath: filePath, newBase64: content },
                }));
              }}
              className="text-xs text-primary hover:underline"
            >
              {t("editor.binaryDiffOpenInEditor")}
            </button>
            <ToolActionBar
              actions={[
                { label: t("toolCard.copyPath"), icon: <CopyIcon className="size-3" />, onClick: () => copyToClipboard(filePath) },
              ]}
            />
          </div>
        )}
      </div>
    );
  },
});

// ============================================================
// 分析文档 - Cursor 风格
// ============================================================
type AnalyzeDocumentArgs = { file_path?: string; document_path?: string; depth?: string };

export const AnalyzeDocumentToolUI = makeAssistantToolUI<AnalyzeDocumentArgs, string>({
  toolName: "analyze_document",
  render: function AnalyzeDocumentUI({ args, result, status, toolCallId }) {
    const messageId = useMessage((s) => (s as { id?: string }).id);
    const toolResultsMap = useContext(ToolResultsByMessageIdContext);
    const fallbackResult = messageId && toolCallId ? toolResultsMap.get(messageId)?.[toolCallId] : undefined;
    const displayResult = (result != null && result !== "") ? result : (fallbackResult ?? "");
    const { retryTool } = React.useContext(ToolActionContext);
    const isRunning = status?.type === "running";
    const isComplete = status?.type === "complete";
    const [showDetails, setShowDetails] = useState(false);
    const filePath = args?.file_path || args?.document_path || "";
    const fileName = getFileName(filePath);

    const resultSummary = React.useMemo(() => {
      if (!displayResult || displayResult.length < 2) return "";
      const firstLine = displayResult.split("\n")[0].trim();
      if (firstLine.length > 80) return firstLine.slice(0, 80) + "…";
      return firstLine;
    }, [displayResult]);
    const hasExpandableResult = displayResult && displayResult.length > 120;

    const borderAccent = isRunning ? TOOL_CARD_BORDER_RUNNING : isComplete ? TOOL_CARD_BORDER_COMPLETE : "";
    return (
      <div className={cn("my-1.5", TOOL_CARD_CONTAINER_BASE, borderAccent)}>
        <div className="inline-flex items-center gap-1.5 text-sm flex-wrap">
          {isRunning ? (
            <LoaderIcon className="size-3.5 animate-spin text-violet-500" />
          ) : (
            <FileTextIcon className="size-3.5 text-blue-500" />
          )}
          <span className="text-muted-foreground">分析</span>
          {filePath ? (
            <ClickableFilePath path={filePath} className="text-foreground font-mono text-xs" />
          ) : (
            <span className="font-mono text-muted-foreground">{fileName || "—"}</span>
          )}
          {isRunning && <span className="text-muted-foreground animate-pulse">...</span>}
          {isComplete && !displayResult && (
            <span className="text-muted-foreground text-xs">· {t("toolCard.resultNotReturned")}</span>
          )}
          {isComplete && resultSummary && !showDetails && (
            <span className="text-muted-foreground text-xs truncate max-w-[280px]">· {resultSummary}</span>
          )}
          {isComplete && hasExpandableResult && (
            <button
              type="button"
              onClick={() => setShowDetails(!showDetails)}
              className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-0.5"
              aria-expanded={showDetails}
              aria-label={t("toolCard.expandCollapseResult")}
            >
              {showDetails ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />}
              {showDetails ? t("toolCard.collapse") : t("toolCard.expandDetail")}
            </button>
          )}
        </div>
        {isComplete && !displayResult && (
          <div className="mt-1 ml-5 text-[12px] text-muted-foreground/90">
            {t("toolCard.resultNotReturned")}
          </div>
        )}
        {isComplete && (filePath || displayResult) && (
          <div className={cn("mt-1.5 ml-5 space-y-1", TOOL_DETAIL_PANEL_CLASS)}>
            <ToolActionBar
              actions={[
                { label: t("toolCard.runAgain"), icon: <RefreshCwIcon className="size-3" />, onClick: () => retryTool("analyze_document", (args ?? {}) as Record<string, unknown>) },
                ...(filePath ? [
                  { label: t("toolCard.openInEditor"), icon: <ExternalLinkIcon className="size-3" />, onClick: () => fileEventBus.openFile(filePath) },
                  { label: t("toolCard.copyPath"), icon: <CopyIcon className="size-3" />, onClick: () => copyToClipboard(filePath) },
                ] : []),
                ...(displayResult ? [{ label: t("toolCard.copyResult"), icon: <CopyIcon className="size-3" />, onClick: () => copyToClipboard(displayResult) }] : []),
              ]}
            />
            {showDetails && displayResult && hasExpandableResult && (
              <div className="mt-1.5 pt-1.5 border-t border-border/30">
                <UserFriendlyResult result={displayResult} toolName="analyze_document" />
              </div>
            )}
          </div>
        )}
      </div>
    );
  },
});

// ============================================================
// 搜索工具 - 通用搜索
// ============================================================
type SearchArgs = { query?: string; pattern?: string };

export const SearchToolUI = makeAssistantToolUI<SearchArgs, string>({
  toolName: "search",
  render: function SearchUI({ args, result, status, toolCallId }) {
    const messageId = useMessage((s) => (s as { id?: string }).id);
    const toolResultsMap = useContext(ToolResultsByMessageIdContext);
    const fallbackResult = messageId && toolCallId ? toolResultsMap.get(messageId)?.[toolCallId] : undefined;
    const displayResult = (result != null && result !== "") ? result : (fallbackResult ?? "");
    const isRunning = status?.type === "running";
    const isComplete = status?.type === "complete";
    const [showResults, setShowResults] = useState(false);
    
    const query = args?.query || args?.pattern || "";
    const shortQuery = query.length > 35 ? query.slice(0, 35) + "..." : query;
    
    const resultCount = displayResult ? (displayResult.match(/📄|^\d+\./gm) || []).length : 0;
    const borderAccent = isRunning ? TOOL_CARD_BORDER_RUNNING : isComplete ? TOOL_CARD_BORDER_COMPLETE : "";
    return (
      <div className={cn("my-1.5", TOOL_CARD_CONTAINER_BASE, borderAccent)}>
        <button
          onClick={() => (displayResult || resultCount > 0) && setShowResults(!showResults)}
          className="inline-flex items-center gap-1.5 text-xs hover:bg-muted/30 rounded px-1 py-0.5 -ml-1 transition-colors w-full text-left"
        >
          {isRunning ? (
            <LoaderIcon className="size-3 animate-spin text-violet-500" />
          ) : resultCount > 0 ? (
            <CheckIcon className="size-3 text-emerald-500" />
          ) : (
            <SearchIcon className="size-3 text-muted-foreground" />
          )}
          <SearchIcon className="size-3 text-blue-500" />
          <span className="text-foreground">搜索</span>
          <span className="text-muted-foreground truncate max-w-[200px]">"{shortQuery}"</span>
          
          {isRunning ? (
            <span className="text-blue-500 animate-pulse">...</span>
          ) : isComplete && (
            <span className="text-muted-foreground">
              · {resultCount > 0 ? `${resultCount} 结果` : displayResult ? "无结果" : t("toolCard.resultNotReturned")}
              {(resultCount > 0 || displayResult) && (showResults ? <ChevronDownIcon className="size-3 inline ml-1" /> : <ChevronRightIcon className="size-3 inline ml-1" />)}
            </span>
          )}
        </button>
        {isComplete && !displayResult && (
          <div className="mt-1 ml-5 text-[12px] text-muted-foreground/90">
            {t("toolCard.resultNotReturned")}
          </div>
        )}
        {showResults && displayResult && isComplete && (
          <div className="mt-1 ml-4 space-y-1">
            <ToolActionBar
              actions={[{ label: "复制结果", icon: <CopyIcon className="size-3" />, onClick: () => copyToClipboard(displayResult) }]}
            />
            <ExpandableResult result={displayResult} toolName="search" />
          </div>
        )}
      </div>
    );
  },
});

// ============================================================
// Grep 搜索 - 代码搜索结果展示
// ============================================================
type GrepSearchArgs = { pattern?: string; path?: string };

export const GrepSearchToolUI = makeAssistantToolUI<GrepSearchArgs, string>({
  toolName: "grep_search",
  render: function GrepSearchUI({ args, result, status, toolCallId }) {
    const messageId = useMessage((s) => (s as { id?: string }).id);
    const toolResultsMap = useContext(ToolResultsByMessageIdContext);
    const fallbackResult = messageId && toolCallId ? toolResultsMap.get(messageId)?.[toolCallId] : undefined;
    const displayResult = (result != null && result !== "") ? result : (fallbackResult ?? "");
    const { retryTool } = React.useContext(ToolActionContext);
    const isRunning = status?.type === "running";
    const isComplete = status?.type === "complete";
    const [showResults, setShowResults] = useState(false);
    
    // 流式搜索进度
    const [searchProgress, setSearchProgress] = useState<{
      filesSearched: number;
      totalFiles: number;
      matchesFound: number;
    } | null>(null);
    
    // 订阅搜索进度事件（按类型订阅，避免 onAll 高频触发）
    useEffect(() => {
      if (!isRunning) {
        setSearchProgress(null);
        return;
      }
      const handlerStart = () => setSearchProgress({ filesSearched: 0, totalFiles: 0, matchesFound: 0 });
      const handlerFilesFound = (event: ToolStreamEvent) => setSearchProgress(prev => prev ? { ...prev, totalFiles: event.count || 0 } : null);
      const handlerProgress = (event: ToolStreamEvent) => setSearchProgress({
        filesSearched: event.files_searched || 0,
        totalFiles: event.total_files || 0,
        matchesFound: event.matches_found || 0
      });
      const handlerMatch = (event: ToolStreamEvent) => setSearchProgress(prev => prev ? { ...prev, matchesFound: event.total_matches || prev.matchesFound + 1 } : null);
      const unsubStart = toolStreamEventBus.on('search_start', handlerStart);
      const unsubFilesFound = toolStreamEventBus.on('search_files_found', handlerFilesFound);
      const unsubProgress = toolStreamEventBus.on('search_progress', handlerProgress);
      const unsubMatch = toolStreamEventBus.on('search_match', handlerMatch);
      const unsubComplete = toolStreamEventBus.on('search_complete', () => {});
      return () => {
        unsubStart();
        unsubFilesFound();
        unsubProgress();
        unsubMatch();
        unsubComplete();
      };
    }, [isRunning]);
    
    const pattern = args?.pattern || "";
    const searchPath = args?.path ? getFileName(args.path) : "";
    
    // 解析搜索结果（使用 displayResult 与兜底一致）
    const parsedResults = React.useMemo(() => {
      if (!displayResult) return { files: [], totalMatches: 0 };
      
      const files: Array<{ path: string; matches: Array<{ line: number; content: string }> }> = [];
      let currentFile: typeof files[0] | null = null;
      let totalMatches = 0;
      
      const lines = displayResult.split("\n");
      for (const line of lines) {
        // 匹配文件路径
        const fileMatch = line.match(/^(?:📄\s*)?([^\s:]+\.[a-zA-Z]+):?$/);
        if (fileMatch) {
          if (currentFile) files.push(currentFile);
          currentFile = { path: fileMatch[1], matches: [] };
          continue;
        }
        
        // 匹配带行号的内容
        const lineMatch = line.match(/^\s*(\d+)[:|]\s*(.*)$/);
        if (lineMatch && currentFile) {
          currentFile.matches.push({
            line: parseInt(lineMatch[1]),
            content: lineMatch[2],
          });
          totalMatches++;
        }
      }
      if (currentFile) files.push(currentFile);
      
      return { files, totalMatches };
    }, [displayResult]);
    
    const fileCount = parsedResults.files.length;
    const matchCount = parsedResults.totalMatches;
    const borderAccent = isRunning ? TOOL_CARD_BORDER_RUNNING : isComplete ? TOOL_CARD_BORDER_COMPLETE : "";
    return (
      <div className={cn("my-1.5", TOOL_CARD_CONTAINER_BASE, borderAccent)}>
        <button
          type="button"
          onClick={() => (displayResult || matchCount > 0) && setShowResults(!showResults)}
          className="inline-flex items-center gap-1.5 text-sm hover:bg-muted/30 rounded px-1.5 py-0.5 -ml-1.5 transition-colors max-w-full w-full text-left"
          aria-expanded={showResults}
          aria-label={t("toolCard.expandCollapseResult")}
        >
          {isRunning ? (
            <LoaderIcon className="size-3.5 animate-spin text-violet-500" />
          ) : matchCount > 0 ? (
            <CheckIcon className="size-3.5 text-emerald-500" />
          ) : (
            <SearchIcon className="size-3.5 text-muted-foreground" />
          )}
          <SearchIcon className="size-3.5 text-purple-500" />
          <code className="font-mono text-foreground text-xs truncate max-w-[150px]">
            {pattern.length > 25 ? pattern.slice(0, 25) + "..." : pattern}
          </code>
          
          {isRunning ? (
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <ProgressDots text="搜索" />
              {searchProgress && searchProgress.totalFiles > 0 && (
                <span className="text-purple-400">
                  {searchProgress.filesSearched}/{searchProgress.totalFiles}
                  {searchProgress.matchesFound > 0 && ` · ${searchProgress.matchesFound} 匹配`}
                </span>
              )}
            </span>
          ) : isComplete && (
            <span className="text-xs text-muted-foreground shrink-0">
              · {matchCount > 0 ? `${fileCount} 文件 · ${matchCount} 匹配` : displayResult ? "无结果" : t("toolCard.resultNotReturned")}
              {searchPath && ` · ${searchPath}`}
              {(matchCount > 0 || displayResult) && (showResults ? <ChevronDownIcon className="size-3 inline ml-1" /> : <ChevronRightIcon className="size-3 inline ml-1" />)}
            </span>
          )}
        </button>
        {isComplete && !displayResult && (
          <div className="mt-1 ml-5 text-[12px] text-muted-foreground/90">
            {t("toolCard.resultNotReturned")}
          </div>
        )}
        {/* 搜索结果 - 按文件分组 + 复制所有匹配 */}
        {showResults && isComplete && parsedResults.files.length > 0 && (
          <div className="mt-2 ml-5 space-y-2">
            {displayResult && (
              <ToolActionBar
                actions={[
                  { label: t("toolCard.runAgain"), icon: <RefreshCwIcon className="size-3" />, onClick: () => retryTool("grep_search", (args ?? {}) as Record<string, unknown>) },
                  { label: t("toolCard.copyAllMatches"), icon: <CopyIcon className="size-3" />, onClick: () => copyToClipboard(displayResult) },
                ]}
              />
            )}
            {parsedResults.files.slice(0, 5).map((file, i) => (
              <div key={i} className="rounded-lg border border-border/30 overflow-hidden">
                {/* 文件头 */}
                <div className="flex items-center gap-2 px-2 py-1 bg-muted/30 border-b border-border/20">
                  <FileIcon className="size-3 text-blue-500" />
                  <ClickableFilePath path={file.path} className="text-xs flex-1" />
                  <span className="text-xs text-muted-foreground">{file.matches.length} 匹配</span>
                </div>
                {/* 匹配行 - 点击打开文件并定位到该行 */}
                <div className="max-h-[120px] overflow-y-auto">
                  {file.matches.slice(0, 5).map((match, j) => (
                    <button
                      key={j}
                      type="button"
                      onClick={() => fileEventBus.openFile(file.path, match.line)}
                      className="w-full flex text-xs font-mono hover:bg-blue-500/10 text-left rounded px-1"
                      title={`打开并定位到第 ${match.line} 行`}
                    >
                      <span className="w-10 text-right pr-2 py-0.5 text-muted-foreground/50 bg-muted/10 shrink-0 select-none">
                        {match.line}
                      </span>
                      <span className="py-0.5 px-2 text-muted-foreground truncate">
                        {match.content}
                      </span>
                    </button>
                  ))}
                  {file.matches.length > 5 && (
                    <div className="text-xs text-muted-foreground/50 px-2 py-1 bg-muted/10">
                      ... 还有 {file.matches.length - 5} 行
                    </div>
                  )}
                </div>
              </div>
            ))}
            {parsedResults.files.length > 5 && (
              <div className="text-xs text-muted-foreground">
                还有 {parsedResults.files.length - 5} 个文件...
              </div>
            )}
          </div>
        )}
      </div>
    );
  },
});

// ============================================================
// Python 执行 - Cursor 风格 + 流式输出增强
// 支持 toolName: "python_run" 和 "execute_python_code"
// ============================================================
type PythonRunArgs = { code?: string };

// 提取 render 函数，供多个 toolName 复用
function PythonRunRender({ args, result, status, toolCallId }: { args: PythonRunArgs; result?: string; status?: { type: string }; toolCallId?: string }) {
    const messageId = useMessage((s) => (s as { id?: string }).id);
    const toolResultsMap = useContext(ToolResultsByMessageIdContext);
    const fallbackResult = messageId && toolCallId ? toolResultsMap.get(messageId)?.[toolCallId] : undefined;
    const displayResult = (result != null && result !== "") ? result : (fallbackResult ?? "");
    const isRunning = status?.type === "running";
    const isComplete = status?.type === "complete";
  const elapsedSeconds = useToolElapsedSeconds(status);
    const isError = displayResult?.includes("Error") || displayResult?.includes("❌");
    const [showDetails, setShowDetails] = useState(false); // 完成后默认折叠，只显示摘要行
    const { runCode } = React.useContext(ToolActionContext);

    // ✅ 流式输出状态
    const [streamingOutput, setStreamingOutput] = useState<string[]>([]);
    const [streamStatus, setStreamStatus] = useState<'idle' | 'running' | 'complete'>('idle');
    
    // 订阅流式输出事件（按类型订阅，避免 onAll 高频触发）。事件为全局、不区分 message_id，依赖当前仅有一个 run 在跑。
    useEffect(() => {
      if (!isRunning) {
        setStreamingOutput([]);
        setStreamStatus('idle');
        return;
      }
      setStreamStatus('running');
      const unsubStart = toolStreamEventBus.on('python_start', () => {
        setStreamingOutput([]);
        setStreamStatus('running');
      });
      const unsubOutput = toolStreamEventBus.on('python_output', (event: ToolStreamEvent) => {
        if (event.data) setStreamingOutput(prev => [...prev, event.data!]);
      });
      const unsubLibs = toolStreamEventBus.on('python_libs_loaded', (event: ToolStreamEvent) => {
        setStreamingOutput(prev => [...prev, `✓ 已加载 ${event.count} 个库\n`]);
      });
      const unsubComplete = toolStreamEventBus.on('python_complete', () => setStreamStatus('complete'));
      return () => {
        unsubStart();
        unsubOutput();
        unsubLibs();
        unsubComplete();
      };
    }, [isRunning]);
    
    const codeLines = args?.code?.split("\n").length || 0;
    
    // 解析执行结果（兼容多种格式）
    const parseResult = (res: string | undefined) => {
      if (!res) return { output: "", duration: "", status: "" };
      
      // 格式1: ✅ 执行成功 (X.XXs)\n输出内容
      const successMatch = res.match(/^✅\s*执行成功\s*\((\d+\.?\d*)s\)\n?([\s\S]*)/);
      if (successMatch) {
        return {
          output: successMatch[2]?.trim() || "",
          duration: successMatch[1],
          status: "success"
        };
      }
      
      // 格式2: ❌ 错误\n错误信息
      const errorMatch = res.match(/^❌\s*(超时|错误)\n?([\s\S]*)/);
      if (errorMatch) {
        return {
          output: errorMatch[2]?.trim() || "",
          duration: "",
          status: "error"
        };
      }
      
      // 格式3: 旧格式 【输出】\n...
      const outputMatch = res.match(/【输出】\n([\s\S]*?)(?=\n【|$)/);
      if (outputMatch) {
        const durationMatch = res.match(/耗时:\s*([\d.]+)\s*秒/);
        const statusMatch = res.match(/状态:\s*(\S+)/);
        return {
          output: outputMatch[1].trim(),
          duration: durationMatch ? durationMatch[1] : "",
          status: statusMatch ? statusMatch[1] : ""
        };
      }
      
      // 默认：整个结果作为输出
      return { output: res, duration: "", status: "" };
    };
    
    const parsed = parseResult(displayResult);
    const outputLines = parsed.output.split("\n").filter(l => l.trim()).length;

    // 尝试解析为结构化输出（支持 __ui_type），用于 GenerativeUI 展示
    const parsedStructured = (() => {
      const raw = parsed.output?.trim();
      if (!raw) return null;
      try {
        const direct = JSON.parse(raw);
        if (direct && typeof direct === "object") {
          return direct;
        }
      } catch {
        const jsonBlock = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonBlock?.[1]) {
          try {
            const inner = JSON.parse(jsonBlock[1].trim());
            if (inner && typeof inner === "object") return inner;
          } catch {
            //
          }
        }
      }
      return null;
    })();
    const structuredUiType = parsedStructured?.__ui_type;
    const hasStructured = parsedStructured && (
      !!structuredUiType ||
      (Array.isArray(parsedStructured.charts) && parsedStructured.charts.length > 0) ||
      (Array.isArray(parsedStructured.tables) && parsedStructured.tables.length > 0) ||
      (Array.isArray(parsedStructured.metrics) && parsedStructured.metrics.length > 0) ||
      (parsedStructured.output && (
        (Array.isArray(parsedStructured.output.charts) && parsedStructured.output.charts.length > 0) ||
        (Array.isArray(parsedStructured.output.tables) && parsedStructured.output.tables.length > 0) ||
        (Array.isArray(parsedStructured.output.metrics) && parsedStructured.output.metrics.length > 0)
      ))
    );
    const charts = hasStructured ? (parsedStructured.charts ?? parsedStructured.output?.charts ?? []) : [];
    const tables = hasStructured ? (parsedStructured.tables ?? parsedStructured.output?.tables ?? []) : [];
    const metrics = hasStructured ? (parsedStructured.metrics ?? parsedStructured.output?.metrics ?? []) : [];
    const chartItems = charts.filter((c: { src?: string; path?: string }) => (c.src ?? c.path ?? "").trim() !== "");
    const triggerAgentAction = useCallback((prompt: string) => {
      try {
        const threadId = getCurrentThreadIdFromStorage();
        window.dispatchEvent(
          new CustomEvent(EVENTS.FILL_PROMPT, {
            detail: { prompt, autoSend: true, threadId: threadId || undefined },
          })
        );
      } catch {
        toast.error(t("toolCard.actionFailedRetry"));
      }
    }, []);
    const handleGeneratedUiAction = useCallback((action: string, data: any) => {
      if (action === "copy_json") {
        const text = String(data?.text || "").trim();
        if (!text) {
          toast.error(t("toolCard.noJsonToCopy"));
          return;
        }
        navigator.clipboard.writeText(text).then(
          () => toast.success("已复制 JSON"),
          () => toast.error(t("common.copyFailed"), { description: t("common.copyFailedDescription") })
        );
        return;
      }
      if (action === "refresh_system_status") {
        triggerAgentAction("/status all");
        return;
      }
      if (action === "check_path_normalization") {
        triggerAgentAction("/status commands");
        return;
      }
      const payload = JSON.stringify(data || {}, null, 2);
      const templates: Record<string, string> = {
        analyze_table: "请分析以下表格数据，并给出关键结论、异常点和下一步建议：",
        verify_evidence: "请核验以下引用证据的真实性、相关性和完整性：",
        reanalyze_chart: "请重新分析该图表，给出趋势、异常和可执行建议：",
        retry_step: "请仅重试以下失败/未完成步骤，并说明修复策略（不要重复已成功步骤；若曾 report_blocked 请针对阻塞原因补齐后继续）：",
      };
      const prefix = templates[action];
      if (!prefix) {
        toast.info(`暂不支持动作：${action}`);
        return;
      }
      triggerAgentAction(`${prefix}\n${payload}`);
    }, [triggerAgentAction]);

    // 提取代码摘要（第一行有意义的代码）
    const getCodeSummary = (code: string | undefined) => {
      if (!code) return "";
      const lines = code.split("\n").filter(l => l.trim() && !l.trim().startsWith("#") && !l.trim().startsWith("import"));
      return lines[0]?.slice(0, 40) || "";
    };
    
    const codeSummary = getCodeSummary(args?.code);
    
    // ✅ 流式输出内容
    const streamingContent = streamingOutput.join('');
    
    const borderAccent = isRunning ? TOOL_CARD_BORDER_RUNNING : isError ? TOOL_CARD_BORDER_ERROR : isComplete ? TOOL_CARD_BORDER_COMPLETE : "";
    return (
      <div className={cn("my-1.5", TOOL_CARD_CONTAINER_BASE, borderAccent)}>
        <button
          onClick={() => setShowDetails(!showDetails)}
          className="inline-flex items-center gap-1.5 text-sm hover:bg-muted/30 rounded px-1.5 py-0.5 -ml-1.5 transition-colors w-full text-left"
        >
          <span className="inline-flex shrink-0 transition-opacity duration-200">
            {isRunning ? (
              <LoaderIcon className="size-3.5 animate-spin text-violet-500" />
            ) : isError ? (
              <AlertCircleIcon className="size-3.5 text-red-500" />
            ) : (
              <CheckIcon className="size-3.5 text-emerald-500" />
            )}
          </span>
          <CodeIcon className="size-3.5 text-yellow-500 shrink-0" />
          <span className="text-foreground font-medium">Python</span>
          
          {isRunning ? (
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <ProgressDots text="执行" />
              {codeSummary && <code className="text-xs opacity-50 truncate max-w-[200px]">{codeSummary}...</code>}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              · {codeLines} 行
              {outputLines > 0 && <span className="text-emerald-500">→ {outputLines} 行输出</span>}
              {parsed.duration && <span className="opacity-50">({parsed.duration}s)</span>}
              {elapsedSeconds > 0 && <span className="opacity-50 tabular-nums">· {elapsedSeconds}s</span>}
              {showDetails ? <ChevronDownIcon className="size-3 ml-1" /> : <ChevronRightIcon className="size-3 ml-1" />}
            </span>
          )}
        </button>
        {isComplete && !displayResult && (
          <div className="mt-1 ml-5 text-[12px] text-muted-foreground/90">
            {t("toolCard.resultNotReturned")}
          </div>
        )}
        {/* ✅ 执行过程 - 实时流式显示 */}
        {isRunning && args?.code && (
          <div className="mt-2 ml-5 border-l-2 border-yellow-500/30 pl-3">
            {!streamingContent && (
              <pre className="text-xs font-mono text-muted-foreground/50 whitespace-pre-wrap max-h-[60px] overflow-hidden mb-2">
                {args.code.split("\n").slice(0, 3).join("\n")}
                {codeLines > 3 && "\n..."}
              </pre>
            )}
            {streamingContent && (
              <pre className="text-xs font-mono text-foreground/70 whitespace-pre-wrap bg-muted/20 p-2 rounded max-h-[150px] overflow-y-auto">
                {streamingContent}
                <span className="text-muted-foreground animate-pulse">...</span>
              </pre>
            )}
          </div>
        )}
        
        {/* 结构化输出 - 图表/表格/指标 用 GenerativeUI 展示（交错入场） */}
        {isComplete && hasStructured && (
          <div className="mt-2 ml-5 space-y-2">
            {structuredUiType === "system_status" && (
              <GenerativeUI
                ui={{
                  type: "system_status",
                  title: parsedStructured?.title || "系统状态",
                  healthScore: parsedStructured?.healthScore ?? parsedStructured?.health_score ?? 0,
                  statuses: parsedStructured?.statuses ?? parsedStructured?.components ?? [],
                  summary: parsedStructured?.summary,
                }}
                onAction={handleGeneratedUiAction}
              />
            )}
            {structuredUiType === "json_viewer" && (
              <GenerativeUI ui={{ type: "json_viewer", title: parsedStructured?.title || "结构化结果", data: parsedStructured }} onAction={handleGeneratedUiAction} />
            )}
            {chartItems.map((c: { src?: string; path?: string; alt?: string; caption?: string; title?: string; data?: { columns?: string[]; rows?: Record<string, unknown>[] } }, i: number) => (
              <div key={`chart-${i}`} className={cn("animate-genui-enter", `genui-stagger-${Math.min(i, 5)}`)}>
                <GenerativeUI
                  ui={{ type: "chart", src: (c.src ?? c.path ?? "").trim(), alt: c.alt, caption: c.caption, title: c.title, data: c.data }}
                  onAction={handleGeneratedUiAction}
                />
              </div>
            ))}
            {tables.map((t: { columns?: string[]; data?: Record<string, unknown>[] }, i: number) =>
              t.columns && Array.isArray(t.data) ? (
                <div key={`table-${i}`} className={cn("animate-genui-enter", `genui-stagger-${Math.min(chartItems.length + i, 5)}`)}>
                  <GenerativeUI ui={{ type: "table", columns: t.columns, data: t.data }} onAction={handleGeneratedUiAction} />
                </div>
              ) : null
            )}
            {metrics.length > 0 && (
              <div className={cn("animate-genui-enter", `genui-stagger-${Math.min(chartItems.length + tables.length, 5)}`)}>
                <GenerativeUI
                  ui={{
                    type: "metrics",
                    metrics: metrics.map((m: { label?: string; value?: unknown; change?: number; changeLabel?: string; baseline?: string }) => ({
                      label: m?.label ?? "—",
                      value: m?.value ?? "—",
                      change: m?.change,
                      changeLabel: m?.changeLabel,
                      baseline: m?.baseline,
                    })),
                  }}
                  onAction={handleGeneratedUiAction}
                />
              </div>
            )}
          </div>
        )}

        {/* 代码和输出详情 - Cursor 风格 + 复制操作（grid 平滑展开） */}
        <div className={TOOL_EXPAND_MOTION_CLASS} style={{ gridTemplateRows: showDetails && isComplete ? "1fr" : "0fr" }}>
          <div className="min-h-0 mt-2 ml-5 border-l-2 border-muted pl-3 space-y-2">
            {showDetails && isComplete && (
            <>
            <ToolActionBar
              actions={[
                ...(args?.code ? [{ label: t("toolCard.run"), icon: <PlayIcon className="size-3" />, onClick: () => runCode(args.code!) }] : []),
                ...(args?.code ? [{ label: t("toolCard.copyCode"), icon: <CopyIcon className="size-3" />, onClick: () => copyToClipboard(args!.code!) }] : []),
                ...(parsed.output ? [{ label: t("toolCard.copyOutput"), icon: <CopyIcon className="size-3" />, onClick: () => copyToClipboard(parsed.output) }] : []),
              ]}
            />
            {/* 代码 */}
            {args?.code && (
              <div>
                <div className="text-xs text-muted-foreground/50 mb-1 flex items-center gap-1">
                  <CodeIcon className="size-3" />
                  代码 ({codeLines} 行)
                </div>
                <FileContent content={args.code} maxLines={20} />
              </div>
            )}
            
            {/* 输出 */}
            {parsed.output && (
              <div className={cn(isError ? "text-red-500" : "")}>
                <div className="text-xs text-muted-foreground/50 mb-1 flex items-center gap-1">
                  {isError ? <AlertCircleIcon className="size-3" /> : <CheckIcon className="size-3" />}
                  输出 {parsed.duration && `(${parsed.duration}s)`}
                </div>
                <pre className={cn(
                  "text-xs font-mono whitespace-pre-wrap p-2 rounded border",
                  isError ? "bg-red-500/10 text-red-400 border-red-500/20" : "bg-zinc-900 text-zinc-100 border-zinc-700"
                )}>
                  {parsed.output}
                </pre>
              </div>
            )}
            </>
            )}
          </div>
        </div>

        {/* 简洁输出预览 - 未展开时显示 */}
        {!showDetails && isComplete && parsed.output && outputLines > 0 && (
          <div className="mt-1 ml-5 text-xs text-muted-foreground/60 truncate max-w-[400px]">
            {parsed.output.split("\n")[0]}
            {outputLines > 1 && "..."}
          </div>
        )}
      </div>
    );
}

// 导出 python_run 工具 UI
export const PythonRunToolUI = makeAssistantToolUI<PythonRunArgs, string>({
  toolName: "python_run",
  render: PythonRunRender,
});

// 导出 execute_python_code 工具 UI（复用同一个 render）
export const CodeExecutionToolUI = makeAssistantToolUI<PythonRunArgs, string>({
  toolName: "execute_python_code",
  render: PythonRunRender,
});

// ============================================================
// Shell 执行 - 终端风格
// 支持 toolName: "shell_run" 和 "execute"
// ============================================================
type ShellRunArgs = { command?: string };

// 提取 render 函数，供多个 toolName 复用
function ShellRunRender({ args, result, status, toolCallId }: { args: ShellRunArgs; result?: string; status?: { type: string }; toolCallId?: string }) {
  const messageId = useMessage((s) => (s as { id?: string }).id);
  const toolResultsMap = useContext(ToolResultsByMessageIdContext);
  const fallbackResult = messageId && toolCallId ? toolResultsMap.get(messageId)?.[toolCallId] : undefined;
  const displayResult = (result != null && result !== "") ? result : (fallbackResult ?? "");
  const isRunning = status?.type === "running";
  const isComplete = status?.type === "complete";
  const elapsedSeconds = useToolElapsedSeconds(status);
  const isError = displayResult?.includes("Error") || displayResult?.includes("❌") || displayResult?.includes("error:");
  const [showOutput, setShowOutput] = useState(false);
  const [streamingOutput, setStreamingOutput] = useState<string[]>([]);
  const { runShellAgain } = React.useContext(ToolActionContext);

  // 事件为全局、不区分 message_id，依赖当前仅有一个 run 在跑。
  useEffect(() => {
    if (!isRunning) {
      setStreamingOutput([]);
      return;
    }
    const unsub = toolStreamEventBus.on("shell_output", (ev: ToolStreamEvent) => {
      const data = (ev as { data?: string }).data;
      if (typeof data === "string") setStreamingOutput((prev) => [...prev, data]);
    });
    return unsub;
  }, [isRunning]);

  useEffect(() => {
    if (isComplete && displayResult) setShowOutput(true);
  }, [isComplete, displayResult]);

  const cmd = args?.command || "";
  const shortCmd = cmd.length > 60 ? cmd.slice(0, 60) + "..." : cmd;

  const outputLines = displayResult?.split("\n").filter(Boolean).length || 0;
  const streamingText = streamingOutput.join("");
  const borderAccent = isRunning ? TOOL_CARD_BORDER_RUNNING : isError ? TOOL_CARD_BORDER_ERROR : isComplete ? TOOL_CARD_BORDER_COMPLETE : "";

  return (
    <div className={cn("my-1.5", TOOL_CARD_CONTAINER_BASE, borderAccent)}>
      <button
        onClick={() => (displayResult || outputLines > 0) && setShowOutput(!showOutput)}
        className="inline-flex items-center gap-1.5 text-sm hover:bg-muted/30 rounded px-1.5 py-0.5 -ml-1.5 transition-colors max-w-full w-full text-left"
      >
        {isRunning ? (
          <LoaderIcon className="size-3.5 animate-spin text-violet-500" />
        ) : isError ? (
          <AlertCircleIcon className="size-3.5 text-red-500" />
        ) : (
          <CheckIcon className="size-3.5 text-emerald-500" />
        )}
        <TerminalIcon className="size-3.5 text-emerald-500" />
        <code className="font-mono text-foreground text-xs truncate max-w-[300px]">$ {shortCmd}</code>
        
        {isRunning ? (
          <span className="text-xs text-emerald-500"><ProgressDots /></span>
        ) : isComplete && (
          <span className="text-xs text-muted-foreground shrink-0">
            {outputLines > 0 && `· ${outputLines} 行`}
            {!displayResult && outputLines === 0 && t("toolCard.resultNotReturned")}
            {elapsedSeconds > 0 && <span className="tabular-nums"> · {elapsedSeconds}s</span>}
            {(displayResult || outputLines > 0) && (showOutput ? <ChevronDownIcon className="size-3 inline ml-1" /> : <ChevronRightIcon className="size-3 inline ml-1" />)}
          </span>
        )}
      </button>
      {isComplete && !displayResult && (
        <div className="mt-1 ml-5 text-[12px] text-muted-foreground/90">
          {t("toolCard.resultNotReturned")}
        </div>
      )}
      {/* 运行中：终端式流式输出 */}
      {isRunning && streamingText && (
        <div className="mt-1.5 ml-5 p-2 rounded-lg font-mono text-xs overflow-x-auto bg-zinc-900 dark:bg-zinc-950 border border-zinc-700">
          <pre className="whitespace-pre-wrap text-zinc-300">{streamingText}</pre>
        </div>
      )}

      {/* 终端输出 + 复制操作 */}
      {showOutput && displayResult && isComplete && (
        <div className="mt-1.5 ml-5 space-y-1.5">
          <ToolActionBar
            actions={[
              ...(cmd ? [{ label: t("toolCard.runAgain"), icon: <RotateCcwIcon className="size-3" />, onClick: () => runShellAgain(cmd) }] : []),
              ...(cmd ? [{ label: t("toolCard.copyCommand"), icon: <CopyIcon className="size-3" />, onClick: () => copyToClipboard(cmd) }] : []),
              { label: t("toolCard.copyOutput"), icon: <CopyIcon className="size-3" />, onClick: () => copyToClipboard(displayResult) },
            ]}
          />
          <div className={cn(
            "p-2 rounded-lg font-mono text-xs overflow-x-auto",
            isError 
              ? "bg-red-500/10 border border-red-500/20" 
              : "bg-zinc-900 dark:bg-zinc-950 border border-zinc-700"
          )}>
            <pre className={cn(
              "whitespace-pre-wrap",
              isError ? "text-red-400" : "text-zinc-300"
            )}>
              {displayResult}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

// 导出 shell_run 工具 UI
export const ShellRunToolUI = makeAssistantToolUI<ShellRunArgs, string>({
  toolName: "shell_run",
  render: ShellRunRender,
});

// 导出 execute 工具 UI（复用同一个 render）
export const ShellRunUI = makeAssistantToolUI<ShellRunArgs, string>({
  toolName: "execute",
  render: ShellRunRender,
});

// ============================================================
// Web 搜索 - Cursor 风格（关键词 · 网站/来源 · 结果条数）
// ============================================================
type WebSearchArgs = { query?: string; url?: string; website?: string; source?: string };

export const WebSearchToolUI = makeAssistantToolUI<WebSearchArgs, string>({
  toolName: "web_search",
  render: function WebSearchUI({ args, result, status, toolCallId }) {
    const { retryTool } = React.useContext(ToolActionContext);
    const messageId = useMessage((s) => (s as { id?: string }).id);
    const toolResultsMap = useContext(ToolResultsByMessageIdContext);
    const fallbackResult = messageId && toolCallId ? (toolResultsMap.get(messageId)?.[toolCallId]) : undefined;
    const displayResult = (result != null && result !== "") ? result : (fallbackResult ?? "");
    const isRunning = status?.type === "running";
    const isComplete = status?.type === "complete";
    const [showResults, setShowResults] = useState(false);

    const query = args?.query ?? (args as Record<string, unknown>)?.search_query ?? (args as Record<string, unknown>)?.q ?? "";
    const shortQuery = String(query).length > 35 ? String(query).slice(0, 35) + "..." : String(query);
    const siteLabel = React.useMemo(() => {
      const u = args?.url ?? (args as Record<string, unknown>)?.website ?? (args as Record<string, unknown>)?.source;
      if (!u || typeof u !== "string") return "";
      try {
        return u.startsWith("http") ? new URL(u).host : u.slice(0, 24);
      } catch {
        return String(u).slice(0, 24);
      }
    }, [args?.url, (args as Record<string, unknown>)?.website, (args as Record<string, unknown>)?.source]);

    // 解析搜索结果：优先后端 JSON { query, results: [{ title, source_id, excerpt }] }（Cursor 式）
    const parsedResults = React.useMemo(() => {
      if (!displayResult) return [];
      const trimmed = displayResult.trim();
      try {
        const parsed = JSON.parse(trimmed) as { results?: Array<{ title?: string; source_id?: string; excerpt?: string }> };
        const arr = Array.isArray(parsed?.results) ? parsed.results : [];
        if (arr.length > 0) {
          return arr.map((r) => ({
            title: typeof r.title === "string" ? r.title.trim() : "",
            url: typeof r.source_id === "string" && /^https?:\/\//i.test(r.source_id) ? r.source_id : "",
            snippet: typeof r.excerpt === "string" ? r.excerpt.replace(/\s+/g, " ").trim() : "",
          })).filter((x) => x.title || x.snippet || x.url);
        }
      } catch {
        // fallback to text format
      }
      const items = displayResult.split(/\n\d+\.\s/).filter(Boolean);
      return items.map(item => {
        const lines = item.split('\n').filter(Boolean);
        const title = lines[0]?.replace(/^\*\*|\*\*$/g, '').trim() || '';
        const url = lines.find(l => l.startsWith('http'))?.trim() || '';
        const snippet = lines.slice(1).filter(l => !l.startsWith('http')).join(' ').trim();
        return { title, url, snippet };
      }).filter(r => r.title || r.snippet || r.url);
    }, [displayResult]);

    const resultCount = parsedResults.length;
    const firstResultSummary = parsedResults[0]
      ? (parsedResults[0].title || (parsedResults[0].snippet && parsedResults[0].snippet.slice(0, 40) + (parsedResults[0].snippet.length > 40 ? "…" : "")) || "")
      : "";

    React.useEffect(() => {
      if (isComplete && resultCount > 0 && resultCount <= 5) setShowResults(true);
    }, [isComplete, resultCount]);

    const borderAccent = isRunning ? TOOL_CARD_BORDER_RUNNING : isComplete ? TOOL_CARD_BORDER_COMPLETE : "";
    return (
      <div className={cn("my-1.5", TOOL_CARD_CONTAINER_BASE, borderAccent)}>
        <button
          type="button"
          onClick={() => (displayResult != null || resultCount > 0) && setShowResults(!showResults)}
          className="inline-flex items-center gap-1.5 text-sm hover:bg-muted/30 rounded px-1.5 py-0.5 -ml-1.5 transition-colors max-w-full w-full text-left"
          aria-expanded={showResults}
          aria-label={t("toolCard.expandCollapseResult")}
        >
          {isRunning ? (
            <LoaderIcon className="size-3.5 animate-spin text-violet-500" />
          ) : (
            <CheckIcon className="size-3.5 text-emerald-500" />
          )}
          <GlobeIcon className="size-3.5 text-blue-500" />
          <span className="text-foreground">搜索</span>
          {shortQuery && <span className="text-muted-foreground truncate max-w-[200px]">"{shortQuery}"</span>}
          {siteLabel && <span className="text-muted-foreground/80 text-xs">· {siteLabel}</span>}
          {isRunning ? (
            <span className="text-xs text-muted-foreground">
              <ProgressDots text="搜索" />
            </span>
          ) : isComplete && (
            <span className="text-xs text-muted-foreground shrink-0">
              · {resultCount > 0 ? t("toolCard.summary.foundResults", { n: resultCount }) : displayResult ? "无结果" : t("toolCard.resultNotReturned")}
              {resultCount > 0 && (showResults ? <ChevronDownIcon className="size-3 inline ml-1" /> : <ChevronRightIcon className="size-3 inline ml-1" />)}
            </span>
          )}
        </button>
        {isComplete && !displayResult && (
          <div className="mt-1 ml-5 text-[12px] text-muted-foreground/90">
            {t("toolCard.resultNotReturned")}
          </div>
        )}
        {isComplete && resultCount > 0 && firstResultSummary && !showResults && (
          <div className="mt-1 ml-5 text-[12px] text-muted-foreground/90">
            {t("toolCard.firstResult")}：{firstResultSummary}
          </div>
        )}
        
        {/* 搜索结果 - 卡片式展示，每条可打开链接 / 复制链接 */}
        {showResults && isComplete && parsedResults.length > 0 && (
          <div className="mt-2 ml-5 space-y-2">
            <ToolActionBar
              actions={[
                { label: t("toolCard.runAgain"), icon: <RefreshCwIcon className="size-3" />, onClick: () => retryTool("web_search", (args ?? {}) as Record<string, unknown>) },
                { label: t("toolCard.copyResult"), icon: <CopyIcon className="size-3" />, onClick: () => copyToClipboard(displayResult) },
              ]}
            />
            {parsedResults.slice(0, 5).map((item, i) => (
              <div key={i} className="p-2 rounded-lg border border-border/30 bg-muted/10 hover:bg-muted/20 transition-colors">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    {item.url ? (
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm font-medium text-foreground line-clamp-1 hover:text-blue-500 hover:underline"
                      >
                        {item.title}
                      </a>
                    ) : (
                      <div className="text-sm font-medium text-foreground line-clamp-1">{item.title}</div>
                    )}
                  </div>
                  {item.url && (
                    <button
                      type="button"
                      onClick={() => copyToClipboard(item.url)}
                      className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 text-xs rounded border border-border/50 bg-muted/30 hover:bg-muted/60 text-muted-foreground hover:text-foreground"
                      title={t("toolCard.copyLink")}
                      aria-label={t("toolCard.copyLink")}
                    >
                      <CopyIcon className="size-3" />
                      {t("toolCard.copyLink")}
                    </button>
                  )}
                </div>
                {item.url && (
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-blue-500 hover:underline truncate block mt-0.5"
                  >
                    {item.url}
                  </a>
                )}
                {item.snippet && (
                  <div className="text-xs text-muted-foreground mt-1 line-clamp-2">
                    {item.snippet}
                  </div>
                )}
              </div>
            ))}
            {parsedResults.length > 5 && (
              <div className="text-xs text-muted-foreground">
                还有 {parsedResults.length - 5} 条结果...
              </div>
            )}
          </div>
        )}
        
        {/* 原始结果回退 */}
        {showResults && isComplete && parsedResults.length === 0 && displayResult && (
          <div className="mt-1 ml-5">
            <ExpandableResult result={displayResult} toolName="web_search" />
          </div>
        )}
      </div>
    );
  },
});

// ============================================================
// 文件搜索 - 文件列表展示
// ============================================================
type FileSearchArgs = { pattern?: string; query?: string; directory?: string };

export const FileSearchToolUI = makeAssistantToolUI<FileSearchArgs, string>({
  toolName: "file_search",
  render: function FileSearchUI({ args, result, status, toolCallId }) {
    const messageId = useMessage((s) => (s as { id?: string }).id);
    const toolResultsMap = useContext(ToolResultsByMessageIdContext);
    const fallbackResult = messageId && toolCallId ? toolResultsMap.get(messageId)?.[toolCallId] : undefined;
    const displayResult = (result != null && result !== "") ? result : (fallbackResult ?? "");
    const { retryTool } = React.useContext(ToolActionContext);
    const isRunning = status?.type === "running";
    const isComplete = status?.type === "complete";
    const [showResults, setShowResults] = useState(false);
    
    const pattern = args?.pattern || args?.query || "";
    const directory = args?.directory ? getFileName(args.directory) : "";
    const shortPattern = pattern.length > 25 ? pattern.slice(0, 25) + "..." : pattern;
    
    const files = React.useMemo(() => {
      if (!displayResult) return [];
      const matches = displayResult.match(/(?:📄\s*)?([^\s\n]+\.[a-zA-Z0-9]+)/g) || [];
      return matches.map(m => m.replace(/^📄\s*/, '').trim()).filter(Boolean);
    }, [displayResult]);
    
    const fileCount = files.length;
    const borderAccent = isRunning ? TOOL_CARD_BORDER_RUNNING : isComplete ? TOOL_CARD_BORDER_COMPLETE : "";
    return (
      <div className={cn("my-1.5", TOOL_CARD_CONTAINER_BASE, borderAccent)}>
        <button
          type="button"
          onClick={() => (displayResult || fileCount > 0) && setShowResults(!showResults)}
          className="inline-flex items-center gap-1.5 text-sm hover:bg-muted/30 rounded px-1.5 py-0.5 -ml-1.5 transition-colors max-w-full w-full text-left"
          aria-expanded={showResults}
          aria-label={t("toolCard.expandCollapseResult")}
        >
          {isRunning ? (
            <LoaderIcon className="size-3.5 animate-spin text-violet-500" />
          ) : fileCount > 0 ? (
            <CheckIcon className="size-3.5 text-emerald-500" />
          ) : (
            <FolderOpenIcon className="size-3.5 text-muted-foreground" />
          )}
          <FolderOpenIcon className="size-3.5 text-amber-500" />
          <span className="text-foreground">查找</span>
          <code className="font-mono text-muted-foreground text-xs truncate max-w-[150px]">{shortPattern}</code>
          {directory && <span className="text-muted-foreground/60 text-xs">in {directory}</span>}
          
          {isRunning ? (
            <span className="text-xs text-amber-500">
              <ProgressDots />
            </span>
          ) : isComplete && (
            <span className="text-xs text-muted-foreground shrink-0">
              · {fileCount > 0 ? `${fileCount} 文件` : displayResult ? "无结果" : t("toolCard.resultNotReturned")}
              {(fileCount > 0 || displayResult) && (showResults ? <ChevronDownIcon className="size-3 inline ml-1" /> : <ChevronRightIcon className="size-3 inline ml-1" />)}
            </span>
          )}
        </button>
        {isComplete && !displayResult && (
          <div className="mt-1 ml-5 text-[12px] text-muted-foreground/90">
            {t("toolCard.resultNotReturned")}
          </div>
        )}
        {/* 文件列表 + 复制所有路径 */}
        {showResults && isComplete && files.length > 0 && (
          <div className="mt-1.5 ml-5 space-y-1">
            <ToolActionBar
              actions={[
                { label: t("toolCard.runAgain"), icon: <RefreshCwIcon className="size-3" />, onClick: () => retryTool("file_search", (args ?? {}) as Record<string, unknown>) },
                { label: t("toolCard.copyAllPaths"), icon: <CopyIcon className="size-3" />, onClick: () => copyToClipboard(files.join("\n")) },
              ]}
            />
            <div className="space-y-0.5">
            {files.slice(0, 10).map((file, i) => (
              <div 
                key={i}
                className="flex items-center gap-2 py-0.5 px-1.5 rounded hover:bg-muted/30 text-xs"
              >
                <FileIcon className="size-3 text-amber-500 shrink-0" />
                <ClickableFilePath path={file} className="truncate" />
              </div>
            ))}
            {files.length > 10 && (
              <div className="text-xs text-muted-foreground px-1.5">
                还有 {files.length - 10} 个文件...
              </div>
            )}
            </div>
          </div>
        )}
      </div>
    );
  },
});

// ============================================================
// 思考工具 - 简洁的思考过程展示
// ============================================================
type ThinkToolArgs = { thinking?: string };

export const ThinkToolUI = makeAssistantToolUI<ThinkToolArgs, string>({
  toolName: "think_tool",
  render: function ThinkToolUI() {
    return null; // InlineThinkingBlock 负责渲染思考内容
  },
});

// ============================================================
// 规划工具 - Cursor 风格：只显示目标，其他折叠
// ============================================================
type PlanToolArgs = { next_actions?: string };

// 解析规划内容
function parsePlanContent(content: string): {
  goal?: string;
  understanding?: string;
  steps?: Array<{ id: number; description: string }>;
  raw?: string;
} {
  if (!content) return { raw: "" };
  try {
    const parsed = JSON.parse(content);
    return {
      goal: parsed.goal,
      understanding: parsed.understanding,
      steps: parsed.steps,
    };
  } catch {
    return { raw: content };
  }
}

export const PlanToolUI = makeAssistantToolUI<PlanToolArgs, string>({
  toolName: "plan_next_moves",
  render: function PlanToolUI({ args, status }) {
    const isRunning = status?.type === "running";
    const [showSteps, setShowSteps] = useState(true); // 默认展开
    const [planAction, setPlanAction] = useState<string | null>(null);
    
    const planContent = args?.next_actions || "";
    const parsed = React.useMemo(() => parsePlanContent(planContent), [planContent]);
    
    // 运行中显示动画
    if (isRunning) {
      return (
        <div className="my-2 p-2.5 rounded-lg border border-violet-500/30 bg-violet-500/5">
          <div className="flex items-center gap-2 text-sm">
            <LoaderIcon className="size-4 animate-spin text-violet-500" />
            <span className="text-violet-600 dark:text-violet-400 font-medium">
              <ProgressDots text={t("toolCard.planMaking")} />
            </span>
          </div>
        </div>
      );
    }
    
    // 规划完成 - 卡片式展示
    if (parsed.goal || parsed.steps) {
      const stepCount = parsed.steps?.length || 0;
      
      return (
        <div className="my-2 p-3 rounded-lg border border-border/50 bg-muted/20">
          {/* 头部 + 复制计划 */}
          <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
            <div className="flex items-center gap-2">
<ListChecksIcon className="size-4 text-violet-500" />
            <span className="text-sm font-medium text-foreground">{t("toolCard.planExecute")}</span>
            </div>
            <div className="flex items-center gap-2">
              {stepCount > 0 && (
                <span className="text-xs text-muted-foreground">{t("toolCard.stepsCount", { n: stepCount })}</span>
              )}
              <button
                type="button"
                onClick={() => copyToClipboard(planContent)}
                className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded border border-border/50 bg-muted/30 hover:bg-muted/60 text-muted-foreground hover:text-foreground"
                title={t("toolCard.copyPlanFull")}
                aria-label={t("toolCard.copyPlanFull")}
              >
                <CopyIcon className="size-3" />
                {t("toolCard.copyPlan")}
              </button>
            </div>
          </div>
          
          {/* 目标 */}
          {parsed.goal && (
            <div className="text-sm text-foreground mb-2 p-2 bg-violet-500/10 rounded border-l-2 border-violet-500">
              {parsed.goal}
            </div>
          )}
          {/* 理解/背景（若有，便于用户知晓 AI 对任务的把握） */}
          {parsed.understanding && (
            <div className="text-xs text-muted-foreground mb-2 p-2 bg-muted/30 rounded border-l-2 border-border/50">
              {parsed.understanding}
            </div>
          )}
          
          {/* 步骤列表 */}
          {stepCount > 0 && (
            <>
              <button
                onClick={() => setShowSteps(!showSteps)}
                className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 mb-1"
              >
                {showSteps ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />}
                <span>{showSteps ? t("toolCard.collapseSteps") : t("toolCard.expandSteps")}</span>
              </button>
              
              {showSteps && (
                <div className="space-y-1">
                  {parsed.steps!.map((step, i) => (
                    <div 
                      key={i} 
                      className="flex items-start gap-2 text-sm py-1 px-2 rounded hover:bg-muted/30"
                    >
                      <span className="size-5 rounded-full bg-blue-500/20 text-blue-600 dark:text-blue-400 text-xs flex items-center justify-center shrink-0 mt-0.5">
                        {i + 1}
                      </span>
                      <span className="text-muted-foreground">{step.description}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
          
          {/* 确认执行 / 修改 / 取消 - Plan 模式核心交互 */}
          {stepCount > 0 && (
            <div className="mt-3 pt-2 border-t border-border/30 space-y-1.5">
              <p className="text-[10px] text-muted-foreground/70">
                {t("toolCard.planConfirmHint")}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  disabled={!!planAction}
                  onClick={async () => {
                    setPlanAction("confirm");
                    const threadId = getCurrentThreadIdFromStorage();
                    if (!threadId) {
                      toast.error(t("thread.planConfirmFailed"));
                      setPlanAction(null);
                      return;
                    }
                    try {
                      const state = await getInterruptState(threadId);
                      if (state.interrupted && state.interruptType === "plan_confirmation") {
                        await resumeInterrupt(threadId, "approve");
                        setScopedChatMode("agent", threadId);
                        window.dispatchEvent(new CustomEvent(EVENTS.CHAT_MODE_CHANGED, { detail: { mode: "agent", threadId } }));
                        toast.success(t("thread.planConfirmResumed"));
                      } else {
                        const shouldSwitchToAgent = (() => {
                          try {
                            const v = getStorageItem("maibot_plan_confirm_switch_to_agent");
                            return v == null || v === "" ? true : v !== "false";
                          } catch {
                            return true;
                          }
                        })();
                        const validTid = validServerThreadIdOrUndefined(threadId);
                        if (validTid) setStorageItem(`maibot_plan_confirmed_thread_${validTid}`, "true");
                        window.dispatchEvent(new CustomEvent(EVENTS.PLAN_CONFIRMED, {
                          detail: {
                            goal: parsed.goal,
                            steps: parsed.steps,
                            message: "确认执行上述计划",
                            threadId,
                            planConfirmed: true,
                            shouldSwitchToAgent,
                          },
                        }));
                      }
                    } catch (e) {
                      console.error("[PlanToolUI] 确认执行失败:", e);
                      toast.error(t("thread.planConfirmFailed"));
                    } finally {
                      setPlanAction(null);
                    }
                  }}
                  className="px-3 py-1.5 text-xs font-medium bg-blue-500 hover:bg-blue-600 text-white rounded-md transition-colors flex items-center gap-1.5 disabled:opacity-50 disabled:pointer-events-none"
                  title="有中断时恢复执行；否则发送「确认执行上述计划」"
                >
                  <PlayIcon className="size-3" />
                  确认执行
                </button>
                <button
                  disabled={!!planAction}
                  onClick={() => {
                    setPlanAction("edit");
                    try {
                      const threadId = getCurrentThreadIdFromStorage();
                      const validTid = validServerThreadIdOrUndefined(threadId);
                      if (validTid) removeStorageItem(`maibot_plan_confirmed_thread_${validTid}`);
                      window.dispatchEvent(new CustomEvent(EVENTS.COMPOSER_PREFS_CHANGED));
                      window.dispatchEvent(new CustomEvent(EVENTS.PLAN_EDIT_REQUEST, {
                        detail: { goal: parsed.goal, steps: parsed.steps, threadId: threadId || undefined }
                      }));
                    } catch {
                      toast.error(t("common.actionFailedRetry"));
                    } finally {
                      setPlanAction(null);
                    }
                  }}
                  className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded-md transition-colors disabled:opacity-50 disabled:pointer-events-none"
                  title="发送修改请求，由 AI 产出修订计划"
                >
                  修改计划
                </button>
                <button
                  disabled={!!planAction}
                  onClick={() => {
                    setPlanAction("revert");
                    try {
                      const threadId = getCurrentThreadIdFromStorage();
                      const validTid = validServerThreadIdOrUndefined(threadId);
                      if (validTid) removeStorageItem(`maibot_plan_confirmed_thread_${validTid}`);
                      window.dispatchEvent(new CustomEvent(EVENTS.COMPOSER_PREFS_CHANGED));
                      window.dispatchEvent(new CustomEvent(EVENTS.PLAN_REVERT_REQUEST, {
                        detail: { message: '取消，暂不执行该计划', threadId: threadId || undefined }
                      }));
                    } catch {
                      toast.error(t("common.actionFailedRetry"));
                    } finally {
                      setPlanAction(null);
                    }
                  }}
                  className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded-md transition-colors disabled:opacity-50 disabled:pointer-events-none"
                  title="回退：发送「取消，暂不执行该计划」"
                >
                  取消计划
                </button>
              </div>
            </div>
          )}
        </div>
      );
    }
    
    // 原始文本
    if (parsed.raw) {
      return (
        <div className="my-1 text-sm text-muted-foreground p-2 bg-muted/20 rounded">
          {parsed.raw.length > 200 ? parsed.raw.slice(0, 200) + "..." : parsed.raw}
        </div>
      );
    }
    
    return null;
  },
});

// ============================================================
// 任务工具 - SubAgent 执行状态展示
// ============================================================
type TaskToolArgs = { subagent_type?: string; description?: string };

// SubAgent 类型配置
const SUBAGENT_CONFIG: Record<string, { icon: React.ReactNode; label: string; color: string }> = {
  "explore-agent": { icon: <SearchIcon className="size-3.5" />, label: "探索", color: "text-blue-500" },
  "bash-agent": { icon: <TerminalIcon className="size-3.5" />, label: "终端", color: "text-green-600" },
  "browser-agent": { icon: <GlobeIcon className="size-3.5" />, label: "浏览器", color: "text-amber-600" },
  "general-purpose": { icon: <SparklesIcon className="size-3.5" />, label: "通用", color: "text-cyan-500" },
};

// 执行阶段：开始 -> 执行中 -> 完成（用于 Task 卡片内）
type TaskPhase = "start" | "running" | "complete";

export const TaskToolUI = makeAssistantToolUI<TaskToolArgs, string>({
  toolName: "task",
  render: function TaskToolUI({ args, result, status, toolCallId }) {
    const messageId = useMessage((s) => (s as { id?: string }).id);
    const toolResultsMap = useContext(ToolResultsByMessageIdContext);
    const fallbackResult = messageId && toolCallId ? toolResultsMap.get(messageId)?.[toolCallId] : undefined;
    const displayResult = (result != null && result !== "") ? result : (fallbackResult ?? "");
    const isRunning = status?.type === "running";
    const isComplete = status?.type === "complete";
    const [showDetails, setShowDetails] = useState(false);
    const [elapsedSec, setElapsedSec] = useState(0);
    const [phase, setPhase] = useState<TaskPhase>("start");
    const [subagentSummary, setSubagentSummary] = useState("");
    const [steps, setSteps] = useState<{ step: string; tool?: string }[]>([]);
    const [stepsExpanded, setStepsExpanded] = useState(true);
    const startTimeRef = React.useRef<number | null>(null);
    const myToolCallId = (toolCallId as string) || "";

    useEffect(() => {
      if (isRunning) {
        startTimeRef.current = startTimeRef.current ?? Date.now();
        setPhase("start");
        setSubagentSummary("");
        setSteps([]);
        const t = setInterval(() => {
          if (startTimeRef.current) {
            const sec = Math.floor((Date.now() - startTimeRef.current) / 1000);
            setElapsedSec(sec);
            setPhase((p) => (p === "start" && sec >= 1 ? "running" : p));
          }
        }, 2000);
        const unsubStart = toolStreamEventBus.on("subagent_start", (ev: unknown) => {
          const e = ev as { data?: { tool_call_id?: string }; tool_call_id?: string };
          const evId = e?.data?.tool_call_id ?? (e as { tool_call_id?: string }).tool_call_id;
          if (!myToolCallId || evId === myToolCallId) setPhase("running");
        });
        const unsubEnd = toolStreamEventBus.on("subagent_end", (ev: unknown) => {
          const e = ev as { data?: { tool_call_id?: string; summary?: string }; tool_call_id?: string };
          const evId = e?.data?.tool_call_id ?? (e as { tool_call_id?: string }).tool_call_id;
          if (myToolCallId && evId !== myToolCallId) return;
          setPhase("complete");
          const s = e?.data?.summary;
          if (s) setSubagentSummary(String(s).slice(0, 150));
        });
        const unsubProgress = toolStreamEventBus.on(EVENTS.TASK_PROGRESS, (ev: unknown) => {
          const e = ev as { phase?: string; step?: string; tool?: string; data?: { tool_call_id?: string }; tool_call_id?: string };
          const evId = e?.data?.tool_call_id ?? (e as { tool_call_id?: string }).tool_call_id;
          if (myToolCallId && evId !== undefined && evId !== myToolCallId) return;
          if (e?.phase === "tool_call" && e?.step) {
            setSteps((prev) => [...prev, { step: e.step as string, tool: e.tool }]);
          } else if (e?.phase && e.phase !== "tool_call" && e?.step) {
            setSteps((prev) => [...prev, { step: e.step as string, tool: e.tool }]);
          }
        });
        return () => {
          clearInterval(t);
          unsubStart();
          unsubEnd();
          unsubProgress();
        };
      } else {
        if (startTimeRef.current && isComplete) {
          setElapsedSec(Math.floor((Date.now() - startTimeRef.current) / 1000));
          setPhase("complete");
        }
        startTimeRef.current = null;
      }
    }, [isRunning, isComplete]);

    const subagentType = args?.subagent_type || "general-purpose";
    const description = args?.description || "";
    const config = SUBAGENT_CONFIG[subagentType] || SUBAGENT_CONFIG["general-purpose"];
    
    const resultSummary = React.useMemo(() => {
      if (!displayResult) return "";
      const fromHelper = extractResultSummary(displayResult, "task");
      if (fromHelper) return fromHelper;
      const lines = displayResult
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("{") && !l.startsWith("}") && !l.startsWith("[") && !l.startsWith("]"));
      if (lines.length === 0) return "";
      const firstMeaningful = lines.find((l) => l.length > 8) ?? lines[0];
      return firstMeaningful.length > 80 ? `${firstMeaningful.slice(0, 80)}…` : firstMeaningful;
    }, [displayResult]);
    
    const isError = React.useMemo(() => {
      if (!displayResult || typeof displayResult !== "string") return false;
      try {
        const parsed = JSON.parse(displayResult) as { status?: string };
        if (parsed?.status === "error") return true;
      } catch {
        // not JSON, use regex
      }
      return /\bError\b|❌|执行失败|任务失败/.test(displayResult);
    }, [displayResult]);
    const displayPhase = isComplete ? "complete" : phase;

    return (
      <div className={cn(
        "my-2 rounded-lg border p-3",
        isRunning
          ? "border-primary/30 bg-primary/5"
          : isError
            ? "border-red-500/25 bg-red-500/5 border-l-2 border-l-red-500/70"
            : "border-border/50 bg-muted/10"
      )}>
        {/* 头部：标签 + 描述 + 耗时 + 展开 */}
        <button
          type="button"
          onClick={() => (displayResult || resultSummary) && setShowDetails(!showDetails)}
          className={cn("w-full flex items-center gap-2 text-left", TOOL_MOTION_CLASS, TOOL_FOCUS_CLASS)}
          aria-expanded={!!displayResult && showDetails}
        >
          {isRunning ? (
            <LoaderIcon className={cn("size-4 animate-spin shrink-0", config.color)} />
          ) : isError ? (
            <AlertCircleIcon className="size-4 text-red-500 shrink-0" />
          ) : isComplete ? (
            <CheckIcon className="size-4 text-emerald-500 shrink-0" />
          ) : (
            <span className={config.color}>{config.icon}</span>
          )}
          <span className={cn("text-xs px-2 py-0.5 rounded-full font-medium shrink-0", config.color, "bg-muted/50")}>
            {config.label}
          </span>
          <span className="text-sm text-foreground truncate flex-1 min-w-0">
            {description.length > 60 ? description.slice(0, 60) + "…" : description || t("taskTool.runTask")}
          </span>
          {elapsedSec > 0 && (
            <span className="text-xs text-muted-foreground tabular-nums shrink-0">
              {isRunning ? `已运行 ${elapsedSec}s` : `耗时 ${elapsedSec}s`}
            </span>
          )}
          {(displayResult || resultSummary) && (
            showDetails ? <ChevronDownIcon className="size-4 text-muted-foreground shrink-0" /> : <ChevronRightIcon className="size-4 text-muted-foreground shrink-0" />
          )}
        </button>

        {isComplete && !displayResult && (
          <div className="mt-2 text-[12px] text-muted-foreground/90">
            {t("toolCard.resultNotReturned")}
          </div>
        )}

        {/* 执行阶段指示 + 步骤列表（可展开/折叠，与 ArtifactPanel/消息流联动：步骤若带 messageId/artifactId 可派发 MESSAGE_FOCUS_REQUEST/ARTIFACT_FOCUS_REQUEST） */}
        <div className="mt-2 space-y-1.5">
          {steps.length > 0 ? (
            <>
              <button
                type="button"
                onClick={() => setStepsExpanded((e) => !e)}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                aria-expanded={stepsExpanded}
              >
                {stepsExpanded ? <ChevronDownIcon className="size-3.5 shrink-0" /> : <ChevronRightIcon className="size-3.5 shrink-0" />}
                <span>{t("taskTool.stepsCount", { n: steps.length })}</span>
              </button>
              {stepsExpanded && (
                <ul className="text-xs text-muted-foreground space-y-0.5 list-none pl-0">
                  {steps.map((s, i) => (
                    <li key={i} className="flex items-center gap-1.5">
                      <span className="text-muted-foreground/70 tabular-nums shrink-0">{i + 1}.</span>
                      <span className="truncate">{s.step}</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>{t("taskTool.execPhase")}:</span>
              <span className="flex items-center gap-1.5">
                <span className={cn(displayPhase === "start" && isRunning && "text-foreground font-medium")}>{t("taskTool.phaseStart")}</span>
                <span className="text-muted-foreground/50">→</span>
                <span className={cn(displayPhase === "running" && "text-foreground font-medium", displayPhase === "running" && isRunning && "flex items-center gap-1")}>
                  {displayPhase === "running" && isRunning ? <><ProgressDots /> {t("taskTool.phaseRunning")}</> : t("taskTool.phaseRunning")}
                </span>
                <span className="text-muted-foreground/50">→</span>
                <span className={cn(displayPhase === "complete" && "text-emerald-600 dark:text-emerald-400 font-medium")}>{t("taskTool.phaseComplete")}</span>
              </span>
            </div>
          )}
          {displayPhase === "complete" && subagentSummary && (
            <p className="text-[11px] text-muted-foreground mt-1 line-clamp-2">{subagentSummary}</p>
          )}
        </div>

        {/* 结果摘要（完成后直接展示，无需展开） */}
        {isComplete && (resultSummary || isError) && (
          <div className={cn("mt-2 rounded-md border px-2 py-1.5 text-sm", isError ? "border-red-500/25 bg-red-500/5 text-red-500" : "border-border/40 bg-background/40 text-muted-foreground")}>
            {isError ? (displayResult?.slice(0, 120) || "执行失败") : resultSummary}
          </div>
        )}

        {/* 操作栏 */}
        {isComplete && (
          <div className="mt-2">
            <ToolActionBar
              actions={[
                { label: t("taskTool.copyResult"), icon: <CopyIcon className="size-3" />, onClick: () => displayResult && copyToClipboard(displayResult) },
                { label: t("taskTool.copyDesc"), icon: <CopyIcon className="size-3" />, onClick: () => copyToClipboard(description || t("taskTool.runTask")) },
              ]}
            />
          </div>
        )}

        {/* 展开提示（有结果且未展开时） */}
        {displayResult && isComplete && !showDetails && (
          <button
            type="button"
            onClick={() => setShowDetails(true)}
            className="mt-2 text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
          >
            <ChevronRightIcon className="size-3" />
            {t("taskTool.expandDetails")}
          </button>
        )}

        {/* 可折叠详情 */}
        {showDetails && displayResult && isComplete && (
          <div className={cn("mt-3 pt-3 border-t border-border/30 text-sm", isError && "border-red-500/20")}>
            <UserFriendlyResult result={displayResult} toolName="task" />
          </div>
        )}
      </div>
    );
  },
});

// ============================================================
// 任务列表工具 - 进度跟踪，默认展开显示
// ============================================================
type WriteTodosArgs = { todos?: Array<{ content: string; status: string; id?: string }> };

export const WriteTodosToolUI = makeAssistantToolUI<WriteTodosArgs, string>({
  toolName: "write_todos",
  render: function WriteTodosUI({ args, status }) {
    const raw = args?.todos;
    const todos: Array<{ content: string; status: string; id?: string }> = Array.isArray(raw)
      ? raw.filter((t): t is { content: string; status: string; id?: string } => t != null && typeof t === "object" && "status" in t)
      : raw && typeof raw === "object"
        ? Object.values(raw).filter((t): t is { content: string; status: string; id?: string } => t != null && typeof t === "object" && "status" in t)
        : [];
    if (todos.length === 0) return null;
    
    // ✅ 关键修复：检查工具调用状态
    // status 是对象类型：{ type: "running" | "complete" | "incomplete" | "requires-action", ... }
    // 当 status.type === "complete" 时，工具调用已完成，不应再显示转圈
    const isToolComplete = status?.type === "complete";
    
    // 统计任务状态
    const completedCount = todos.filter(t => t.status === "completed").length;
    const inProgressCount = todos.filter(t => t.status === "in_progress").length;
    const pendingCount = todos.filter(t => t.status === "pending").length;
    const totalCount = todos.length;
    const allTasksComplete = completedCount === totalCount;
    const progress = Math.round((completedCount / totalCount) * 100);
    
    // 找到当前进行中的任务
    const currentTask = todos.find(t => t.status === "in_progress");
    
    // ✅ 关键修复：只有在工具仍在执行中 且 有进行中的任务时才显示转圈
    // 如果工具调用已完成（isToolComplete），即使有 in_progress 任务也不转圈
    const shouldShowSpinner = !isToolComplete && currentTask && !allTasksComplete;
    
    const todosAsText = todos.map(t => {
      const prefix = t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[.]" : "[ ]";
      return `${prefix} ${t.content}`;
    }).join("\n");

    return (
      <div className="my-2 p-2.5 rounded-lg border border-border/50 bg-muted/20">
        {/* 进度头部 + 复制任务列表 */}
        <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
          <div className="flex items-center gap-2">
            {allTasksComplete ? (
              <CheckCircleIcon className="size-4 text-emerald-500" />
            ) : (
              <ListChecksIcon className="size-4 text-violet-500" />
            )}
            <span className="text-xs font-medium text-foreground">
              {t("toolCard.taskProgress")}
            </span>
            {shouldShowSpinner && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-600 dark:text-violet-400 font-medium">
                {t("toolCard.inProgress")}
              </span>
            )}
          </div>
          <ToolActionBar
            actions={[{ label: t("toolCard.copyTaskList"), icon: <CopyIcon className="size-3" />, onClick: () => copyToClipboard(todosAsText) }]}
          />
          <span className={cn(
            "text-xs font-medium",
            allTasksComplete ? "text-emerald-500" : "text-muted-foreground"
          )}>
            {completedCount}/{totalCount} ({progress}%)
          </span>
        </div>
        
        {/* Cursor 式：仅保留步骤点/spinner，不保留条状进度 */}
        {/* 当前任务提示 - 只在工具执行中且有进行中任务时显示转圈 */}
        {shouldShowSpinner && (
          <div className="flex items-center gap-1.5 text-xs text-violet-600 dark:text-violet-400 mb-2 px-1">
            <LoaderIcon className="size-3 animate-spin text-violet-500" />
            <span className="truncate">{currentTask.content}</span>
          </div>
        )}
        
        {/* 任务列表 - 紧凑显示 */}
        <div className="space-y-0.5">
          {todos.map((todo, i) => (
            <div 
              key={todo.id || i} 
              className={cn(
                "flex items-center gap-2 py-1 px-1 rounded text-xs transition-colors",
                todo.status === "in_progress" && !isToolComplete && "bg-violet-500/10"
              )}
            >
              {/* 状态图标 - 工具完成后停止转圈 */}
              {todo.status === "completed" ? (
                <CheckIcon className="size-3.5 text-emerald-500 shrink-0" />
              ) : todo.status === "in_progress" && !isToolComplete ? (
                <div className="size-3.5 rounded-full border-2 border-violet-500 border-t-transparent animate-spin shrink-0" />
              ) : todo.status === "in_progress" && isToolComplete ? (
                // 工具已完成但任务标记为 in_progress - 显示暂停状态
                <div className="size-3.5 rounded-full border-2 border-amber-500 shrink-0" />
              ) : (
                <div className="size-3.5 rounded-full border border-muted-foreground/30 shrink-0" />
              )}
              
              {/* 任务内容 */}
              <span className={cn(
                "flex-1",
                todo.status === "completed" 
                  ? "text-muted-foreground line-through" 
                  : todo.status === "in_progress"
                    ? "text-foreground font-medium"
                    : "text-muted-foreground"
              )}>
                {todo.content}
              </span>
            </div>
          ))}
        </div>
        
        {/* 完成提示 */}
        {allTasksComplete && (
          <div className="mt-2 pt-2 border-t border-border/30 text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
            <CheckCircleIcon className="size-3" />
            所有任务已完成
          </div>
        )}
      </div>
    );
  },
});

// ============================================================
// 记录结果工具 - 步骤完成标记
// ============================================================
type RecordResultArgs = { step_name?: string; status?: string; result?: string; next_action?: string };

export const RecordResultToolUI = makeAssistantToolUI<RecordResultArgs, string>({
  toolName: "record_result",
  render: function RecordResultUI() {
    return null;
  },
});

// ============================================================
// 结构化审查工具 - 生成式 UI 展示
// ============================================================
type CriticReviewArgs = { draft?: string; evidence?: string };
type CriticReviewResult = {
  unsupported_claims?: string[];
  unverified_calculations?: string[];
  overall_quality?: string;
  revision_notes?: string[];
};

export const CriticReviewToolUI = makeAssistantToolUI<CriticReviewArgs, string>({
  toolName: "critic_review",
  render: function CriticReviewUI({ args, result, status, toolCallId }) {
    const messageId = useMessage((s) => (s as { id?: string }).id);
    const toolResultsMap = useContext(ToolResultsByMessageIdContext);
    const fallbackResult = messageId && toolCallId ? toolResultsMap.get(messageId)?.[toolCallId] : undefined;
    const displayResult = (result != null && result !== "") ? result : (fallbackResult ?? "");
    const isRunning = status?.type === "running";
    const isComplete = status?.type === "complete";
    const [showRaw, setShowRaw] = useState(false);
    const autoTriggeredRef = React.useRef(false);

    const parsed = React.useMemo<CriticReviewResult | null>(() => {
      if (!displayResult) return null;
      try {
        return JSON.parse(displayResult) as CriticReviewResult;
      } catch {
        return null;
      }
    }, [displayResult]);

    if (isRunning) {
      return (
        <div className="my-1.5 inline-flex items-center gap-1.5 text-sm">
          <LoaderIcon className="size-3.5 animate-spin text-indigo-500" />
          <CheckCircleIcon className="size-3.5 text-indigo-500" />
          <span className="text-foreground">结构化审查</span>
          <span className="text-xs text-muted-foreground">
            <ProgressDots text="审查中" />
          </span>
        </div>
      );
    }

    if (isComplete && !displayResult) {
      return (
        <div className="my-1.5 rounded-lg border border-border/40 bg-muted/5 px-2 py-1.5 text-sm">
          <span className="text-muted-foreground">{getToolDisplayName("critic_review")}</span>
          <span className="text-muted-foreground/80 ml-1">· {t("toolCard.resultNotReturned")}</span>
        </div>
      );
    }

    if (isComplete && displayResult && !parsed) {
      return (
        <div className="my-1.5 rounded-lg border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-sm">
          <span className="text-foreground/90">{getToolDisplayName("critic_review")}</span>
          <span className="text-muted-foreground/80 ml-1">· {t("toolCard.reviewResultParseFailed")}</span>
          <div className="mt-1.5">
            <ToolActionBar
              actions={[{ label: t("toolCard.copyResult"), icon: <CopyIcon className="size-3" />, onClick: () => copyToClipboard(displayResult) }]}
            />
          </div>
        </div>
      );
    }

    if (!isComplete || !parsed) {
      return null;
    }

    const unsupported = Array.isArray(parsed.unsupported_claims) ? parsed.unsupported_claims : [];
    const unverified = Array.isArray(parsed.unverified_calculations) ? parsed.unverified_calculations : [];
    const notes = Array.isArray(parsed.revision_notes) ? parsed.revision_notes : [];
    const quality = (parsed.overall_quality || "revise").toLowerCase();

    const qualityLabelMap: Record<string, string> = {
      pass: "通过",
      revise: "需修订",
      reject: "拒绝",
    };
    const qualityLabel = qualityLabelMap[quality] || parsed.overall_quality || "需修订";
    const hasIssues = unsupported.length > 0 || unverified.length > 0;
    const reviewPolicy = React.useMemo(() => {
      try {
        const v = getStorageItem("maibot_review_policy");
        return v === "auto" || v === "gate" ? v : "notify";
      } catch {
        return "notify";
      }
    }, [isComplete]);
    const reviewTemplate = React.useMemo(() => {
      try {
        const v = getStorageItem("maibot_review_template");
        return v === "short" || v === "strict" ? v : "standard";
      } catch {
        return "standard";
      }
    }, []);
    const reviewPolicyLabel = reviewPolicy === "gate" ? "审查门禁" : reviewPolicy === "auto" ? "自动审查" : "仅提示";
    const reviewTemplateLabel = reviewTemplate === "short" ? "短版" : reviewTemplate === "strict" ? "严格" : "标准";

    const evidenceFromArgs = React.useMemo(() => {
      if (!args?.evidence || typeof args.evidence !== "string") return [];
      const parseSourceRef = (sourceRef: string): { source: string; url?: string; path?: string; line?: number } => {
        const trimmed = sourceRef.trim();
        const isUrl = /^https?:\/\//i.test(trimmed);
        if (isUrl) {
          return { source: trimmed, url: trimmed };
        }
        const m = trimmed.match(/^(.*?)(?::L?(\d+))$/);
        if (m) {
          const p = (m[1] || "").trim();
          const line = parseInt(m[2] || "", 10);
          if (p && Number.isFinite(line)) {
            return { source: `${p} (L${line})`, path: p, line };
          }
        }
        return { source: trimmed, path: trimmed };
      };
      try {
        const parsedEvidence = JSON.parse(args.evidence);
        if (!Array.isArray(parsedEvidence)) return [];
        return parsedEvidence
          .map((it, i) => {
            if (!it || typeof it !== "object") return null;
            const sourceId = String((it as { source_id?: unknown }).source_id ?? "");
            const excerpt = String((it as { excerpt?: unknown }).excerpt ?? "");
            if (!sourceId && !excerpt) return null;
            const parsedSource = parseSourceRef(sourceId || `证据 ${i + 1}`);
            return {
              source: parsedSource.source,
              content: excerpt || "(无摘录)",
              url: parsedSource.url,
              path: parsedSource.path,
              line: parsedSource.line,
            };
          })
          .filter(Boolean);
      } catch {
        return [];
      }
    }, [args?.evidence]) as Array<{ source: string; content: string; url?: string; path?: string; line?: number }>;

    const issueEvidences = React.useMemo(() => {
      const calcScore = (issue: string, excerpt: string): number => {
        if (!issue || !excerpt) return 0;
        const issueLower = issue.toLowerCase();
        const excerptLower = excerpt.toLowerCase();
        if (excerptLower.includes(issueLower)) return 100;
        // 简单词项匹配：尽量轻量，不引入额外依赖
        const issueTokens = issueLower
          .split(/[\s,，。；;:：、()（）[\]{}"'`]+/)
          .map((t) => t.trim())
          .filter((t) => t.length >= 2);
        let score = 0;
        for (const t of issueTokens) {
          if (excerptLower.includes(t)) score += 1;
        }
        return score;
      };

      const pickBestEvidence = (issue: string, fallbackIndex: number) => {
        if (!evidenceFromArgs.length) return null;
        let best = evidenceFromArgs[Math.min(fallbackIndex, evidenceFromArgs.length - 1)];
        let bestScore = calcScore(issue, best.content || "");
        for (const ev of evidenceFromArgs) {
          const s = calcScore(issue, ev.content || "");
          if (s > bestScore) {
            best = ev;
            bestScore = s;
          }
        }
        return best;
      };

      const linkedUnsupported = unsupported.map((issue, i) => {
        const linked = pickBestEvidence(issue, i);
        return {
          source: linked ? `待补证断言 ${i + 1} · ${linked.source}` : `待补证断言 ${i + 1}`,
          content: issue,
          url: linked?.url,
          path: linked?.path,
          line: linked?.line,
        };
      });
      const linkedUnverified = unverified.map((issue, i) => {
        const linked = pickBestEvidence(issue, i);
        return {
          source: linked ? `待验证计算 ${i + 1} · ${linked.source}` : `待验证计算 ${i + 1}`,
          content: issue,
          url: linked?.url,
          path: linked?.path,
          line: linked?.line,
        };
      });
      return [...linkedUnsupported, ...linkedUnverified];
    }, [unsupported, unverified, evidenceFromArgs]);

    const sendFollowupMessage = (message: string) => {
      try {
        const threadId = getCurrentThreadIdFromStorage();
        window.dispatchEvent(
          new CustomEvent(EVENTS.FOLLOWUP_MESSAGE, {
            detail: { message, threadId: threadId || undefined },
          })
        );
      } catch {
        toast.error(t("toolCard.sendFailedManually"));
      }
    };
    const fillRevisionPrompt = (autoSend: boolean) => {
      const template = (() => {
        try {
          const v = getStorageItem("maibot_review_template");
          return v === "short" || v === "strict" ? v : "standard";
        } catch {
          return "standard";
        }
      })();
      const lines: string[] = [];
      lines.push("请根据结构化审查结果修订当前草稿。");
      lines.push(`- 待补证断言：${unsupported.length} 条`);
      lines.push(`- 待验证计算：${unverified.length} 条`);
      if (notes.length > 0) {
        lines.push("- 修订建议：");
        notes.forEach((n, i) => lines.push(`  ${i + 1}. ${n}`));
      }
      if (template === "short") {
        lines.push("要求：优先修复最高风险问题，输出一版可执行修订稿。");
      } else if (template === "strict") {
        lines.push("要求：逐条建立“问题 -> 证据 -> 修订动作”映射。");
        lines.push("要求：所有计算给出公式/参数/结果，可复核。");
        lines.push("要求：未补齐证据与计算前，不得输出“已完成”。");
      } else {
        lines.push("要求：先补齐证据与计算，再输出修订版。");
      }
      const prompt = lines.join("\n");
      try {
        const threadId = getCurrentThreadIdFromStorage();
        window.dispatchEvent(
          new CustomEvent(EVENTS.FILL_PROMPT, {
            detail: { prompt, autoSend, threadId: threadId || undefined },
          })
        );
      } catch {
        toast.error(t("common.actionFailedRetry"));
      }
    };
    useEffect(() => {
      if (!isComplete || !hasIssues || autoTriggeredRef.current) return;
      if (reviewPolicy === "auto" || reviewPolicy === "gate") {
        autoTriggeredRef.current = true;
        sendFollowupMessage(
          `结构化审查发现问题：待补证断言 ${unsupported.length} 条，待验证计算 ${unverified.length} 条。请先完成修订并给出修订版。`
        );
      }
    }, [isComplete, hasIssues, reviewPolicy, unsupported.length, unverified.length]);

    return (
      <div className="my-2.5 space-y-1.5">
        <div className="ml-1 flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="px-1.5 py-0.5 rounded border border-border/50 bg-muted/20">
            策略：{reviewPolicyLabel}
          </span>
          <span className="px-1.5 py-0.5 rounded border border-border/50 bg-muted/20">
            模板：{reviewTemplateLabel}
          </span>
        </div>
        <GenerativeUI
          ui={{
            type: "metrics",
            title: "结构化审查结果",
            columns: 3,
            metrics: [
              { label: "总体结论", value: qualityLabel },
              { label: "待补证断言", value: unsupported.length },
              { label: "待验证计算", value: unverified.length },
            ],
          }}
        />

        {notes.length > 0 ? (
          <GenerativeUI
            ui={{
              type: "steps",
              title: "修订建议",
              steps: notes.map((n) => ({
                title: n,
                status: "pending",
              })),
            }}
          />
        ) : (
          <GenerativeUI
            ui={{
              type: "markdown",
              title: "修订建议",
              content: "- 当前未发现明确修订项。",
            }}
          />
        )}

        {(unsupported.length > 0 || unverified.length > 0) && (
          <GenerativeUI
            ui={{
              type: "evidence",
              title: t("toolCard.reviewIssuesTitle"),
              evidences: issueEvidences,
            }}
          />
        )}
        {evidenceFromArgs.length > 0 && (
          <GenerativeUI
            ui={{
              type: "evidence",
              title: t("toolCard.reviewEvidenceTitle"),
              evidences: evidenceFromArgs,
            }}
          />
        )}

        <div className="ml-1">
          <ToolActionBar
            actions={[
              {
                label: t("toolCard.fillRevisionPrompt"),
                icon: <FileTextIcon className="size-3" />,
                onClick: () => fillRevisionPrompt(false),
              },
              {
                label: t("toolCard.sendRevisionTask"),
                icon: <MessageCircleIcon className="size-3" />,
                onClick: () => fillRevisionPrompt(true),
              },
              {
                label: "按审查结果修订",
                icon: <PencilIcon className="size-3" />,
                onClick: () =>
                  sendFollowupMessage(
                    `请按结构化审查结果修订当前草稿：待补证断言 ${unsupported.length} 条，待验证计算 ${unverified.length} 条。请先补证据与计算，再输出修订版。`
                  ),
              },
              {
                label: "继续下一步",
                icon: <PlayIcon className="size-3" />,
                disabled: reviewPolicy === "gate" && hasIssues,
                onClick: () =>
                  sendFollowupMessage(
                    hasIssues
                      ? "请在保留当前结论方向的前提下，先完成必要修订后继续下一步。"
                      : "结构化审查通过，请继续执行下一步。"
                  ),
              },
            ]}
          />
          {reviewPolicy === "gate" && hasIssues && (
            <p className="text-[11px] text-amber-600 mt-1">
              当前策略为“审查不过不继续”，请先执行修订。
            </p>
          )}
        </div>

        <div className="ml-1">
          <button
            type="button"
            onClick={() => setShowRaw((v) => !v)}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            {showRaw ? "隐藏原始 JSON" : "查看原始 JSON"}
          </button>
          {showRaw && displayResult && (
            <div className="mt-1 p-2 rounded bg-muted/30 text-[11px] font-mono overflow-x-auto text-muted-foreground whitespace-pre-wrap">
              {displayResult}
            </div>
          )}
        </div>
      </div>
    );
  },
});

// ============================================================
// Extended Thinking 工具 - 深度推理展示
// ============================================================
type ExtendedThinkingArgs = {
  problem?: string;
  constraints?: string;
  approach?: string;
  reasoning?: string;
  conclusion?: string;
};

export const ExtendedThinkingToolUI = makeAssistantToolUI<ExtendedThinkingArgs, string>({
  toolName: "extended_thinking",
  render: function ExtendedThinkingUI() {
    return null;
  },
});

// ============================================================
// 询问用户工具 - 真正可交互的对话框
// 支持：选项点击、自定义输入、快捷键
// ============================================================
type AskUserArgs = { 
  question?: string; 
  context?: string; 
  options?: string | string[];
  type?: 'choice' | 'input' | 'confirm';  // 问题类型
  default_value?: string;  // 默认值
};

const ASK_FALLBACK_OPTIONS = {
  confirm: ['是，继续', '否，停止'],
  input: {
    risk: ['先给我影响范围', '改为更安全方案', '继续执行（我已知风险）'],
    path: ['使用建议路径继续', '先列出候选路径', '我来指定路径'],
    config: ['使用默认配置继续', '先解释配置差异', '我来指定参数'],
    generic: ['按默认建议继续', '我需要更多说明', '我来补充输入'],
  },
  choice: ['继续执行', '先解释原因', '稍后再决定'],
} as const;

function buildAskFallbackOptions(
  questionType: 'choice' | 'input' | 'confirm',
  question: string,
  context: string
): string[] {
  if (questionType === 'confirm') return [...ASK_FALLBACK_OPTIONS.confirm];
  if (questionType === 'input') {
    const hint = `${question}\n${context}`.toLowerCase();
    if (hint.includes('删除') || hint.includes('覆盖') || hint.includes('危险') || hint.includes('风险')) {
      return [...ASK_FALLBACK_OPTIONS.input.risk];
    }
    if (hint.includes('文件') || hint.includes('路径') || hint.includes('目录')) {
      return [...ASK_FALLBACK_OPTIONS.input.path];
    }
    if (hint.includes('模型') || hint.includes('联网') || hint.includes('参数') || hint.includes('配置')) {
      return [...ASK_FALLBACK_OPTIONS.input.config];
    }
    return [...ASK_FALLBACK_OPTIONS.input.generic];
  }
  return [...ASK_FALLBACK_OPTIONS.choice];
}

export const AskUserToolUI = makeAssistantToolUI<AskUserArgs, string>({
  toolName: "ask_user",
  render: function AskUserUI({ args, result, status, addResult }) {
    const isRunning = status?.type === "running";
    const isComplete = status?.type === "complete";
    
    const question = args?.question || "";
    const context = args?.context || "";
    const options = args?.options;
    const questionType = args?.type || (options ? 'choice' : 'input');
    const defaultValue = args?.default_value || "";
    
    // 本地状态
    const [customInput, setCustomInput] = useState(defaultValue);
    const [selectedOption, setSelectedOption] = useState<number | null>(null);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const isSubmittingRef = React.useRef(false);
    const inputRef = React.useRef<HTMLInputElement>(null);
    const textareaRef = React.useRef<HTMLTextAreaElement>(null);
    const rootRef = React.useRef<HTMLDivElement>(null);
    const mountedRef = React.useRef(true);
    React.useEffect(() => {
      mountedRef.current = true;
      return () => { mountedRef.current = false; };
    }, []);
    
    // 解析选项（支持字符串或数组）
    const optionList = React.useMemo(() => {
      if (!options) return [];
      if (Array.isArray(options)) return options;
      // 尝试解析逗号分隔或换行分隔的字符串
      return options.split(/[,，\n]/).map(o => o.trim()).filter(Boolean);
    }, [options]);
    // Cursor 对齐：即使后端未提供 options，也给出低门槛推荐选项
    const effectiveOptions = React.useMemo(() => {
      if (optionList.length > 0) return optionList;
      return buildAskFallbackOptions(questionType, question, context);
    }, [context, optionList, question, questionType]);
    
    // 生成选项字母标签
    const getOptionLabel = (index: number) => String.fromCharCode(65 + index); // A, B, C, D...
    
    // 提交回复：先 resume 中断（使用户输入送达后端、run 继续），再更新本地结果；派发 INTERRUPT_RESOLVED 供 MyRuntimeProvider 接流续显
    const handleSubmit = useCallback(async (value: string) => {
      const trimmed = typeof value === "string" ? value.trim() : "";
      if (!trimmed || !isRunning || isSubmittingRef.current) return;
      const threadId = getCurrentThreadIdFromStorage();
      if (!threadId) {
        toast.error(t("askUser.noThread"));
        return;
      }
      isSubmittingRef.current = true;
      setIsSubmitting(true);
      try {
        const resumeResult = await resumeInterrupt(threadId, trimmed);
        if (!mountedRef.current) return;
        if (resumeResult?.run_id) {
          window.dispatchEvent(
            new CustomEvent(EVENTS.INTERRUPT_RESOLVED, {
              detail: { threadId, run_id: resumeResult.run_id },
            })
          );
        }
        await addResult(trimmed);
        if (!mountedRef.current) return;
        setSelectedOption(null);
        setCustomInput("");
      } catch (e) {
        if (mountedRef.current) toast.error(t("askUser.submitFailed"));
      } finally {
        isSubmittingRef.current = false;
        if (mountedRef.current) setIsSubmitting(false);
      }
    }, [addResult, isRunning]);
    
    // confirm 或 choice 且选项≤2 时点击选项即提交；否则先选入输入框再点发送
    const clickOptionSubmits = questionType === "confirm" || (questionType === "choice" && effectiveOptions.length <= 2);
    const handleOptionSelect = useCallback((index: number, optionText: string) => {
      if (!isRunning || isSubmittingRef.current) return;
      setSelectedOption(index);
      setCustomInput(optionText);
      if (questionType === "input") {
        textareaRef.current?.focus();
      } else if (clickOptionSubmits) {
        handleSubmit(optionText);
      } else {
        inputRef.current?.focus();
      }
    }, [isRunning, questionType, clickOptionSubmits, handleSubmit, effectiveOptions.length]);

    const submitDraft = useCallback(() => {
      const draft = customInput.trim()
        ? customInput
        : (selectedOption != null && effectiveOptions[selectedOption] != null ? effectiveOptions[selectedOption] : "");
      if (!draft.trim()) return;
      handleSubmit(draft);
    }, [customInput, effectiveOptions, handleSubmit, selectedOption]);
    const hasValidDraft = !!(customInput.trim() || (selectedOption != null && effectiveOptions[selectedOption]));
    const canSubmitDraft = hasValidDraft && !isSubmitting && isRunning;
    const useTextareaInput = questionType === "input";
    
    // 键盘快捷键
    useEffect(() => {
      if (!isRunning || isComplete) return;
      
      const handleKeyDown = (e: KeyboardEvent) => {
        // ask 卡片未激活时，不接管全局快捷键
        const activeEl = document.activeElement as HTMLElement | null;
        const root = rootRef.current;
        const inAskCard = !!(root && activeEl && root.contains(activeEl));
        const target = e.target as HTMLElement | null;
        const targetIsInput = !!target && (
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable
        );
        const isInInput = activeEl === inputRef.current || activeEl === textareaRef.current;
        if (!inAskCard && targetIsInput) return;
        
        // 输入框提交：textarea 用 Cmd/Ctrl+Enter，input 用 Enter
        if (e.key === 'Enter' && isInInput && customInput.trim()) {
          const isTextareaActive = activeEl === textareaRef.current;
          if (isTextareaActive) {
            if (e.metaKey || e.ctrlKey) {
              e.preventDefault();
              submitDraft();
            }
          } else {
            e.preventDefault();
            submitDraft();
          }
          return;
        }
        
        // 仅当 ask 卡片活跃时处理字母快捷键
        if (!inAskCard || isInInput) return;
        
        // A-Z 快捷键选择选项
        const key = e.key.toUpperCase();
        const optionIndex = key.charCodeAt(0) - 65; // A=0, B=1, C=2...
        if (optionIndex >= 0 && optionIndex < effectiveOptions.length) {
          e.preventDefault();
          handleOptionSelect(optionIndex, effectiveOptions[optionIndex]);
        }
        
        // Y/N 快捷键用于确认类型
        if (questionType === 'confirm') {
          if (e.key.toLowerCase() === 'y') {
            e.preventDefault();
            handleSubmit('是');
          } else if (e.key.toLowerCase() === 'n') {
            e.preventDefault();
            handleSubmit('否');
          }
        }
      };
      
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isRunning, isComplete, effectiveOptions, customInput, submitDraft, handleOptionSelect, questionType, handleSubmit]);
    
    // 自动聚焦输入框
    useEffect(() => {
      if (isRunning && questionType === 'input') {
        setTimeout(() => {
          if (textareaRef.current) {
            textareaRef.current.focus();
          } else if (inputRef.current) {
            inputRef.current.focus();
          }
        }, 100);
      }
    }, [isRunning, questionType]);
    
    // 已完成状态 - 仅显示“已回复”，不重复展示 result（已在用户气泡中可见）
    if (isComplete) {
      return (
        <div className="my-2 p-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 flex items-center gap-2">
          <CheckCircleIcon className="size-3.5 text-emerald-500 shrink-0" />
          <span className="text-xs text-emerald-600 dark:text-emerald-400">已回复</span>
        </div>
      );
    }
    
    // 等待输入状态 - 交互式界面
    return (
      <div ref={rootRef} className={cn(
        "my-3 rounded-xl overflow-hidden transition-all duration-200",
        "border border-border/60 bg-background shadow-sm"
      )}>
        {/* 头部 */}
        <div className="px-4 py-2 bg-muted/30 border-b border-border/40 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative">
              <MessageCircleIcon className="size-4 text-primary" />
              <span className="absolute -top-0.5 -right-0.5 size-1.5 bg-primary rounded-full animate-ping" />
            </div>
            <span className="text-sm font-medium text-foreground">
              等待您的输入
            </span>
          </div>
          {effectiveOptions.length > 0 && (
            <span className="text-xs text-muted-foreground/80">
              按 {effectiveOptions.map((_, i) => getOptionLabel(i)).join('/')} 选择，{useTextareaInput ? "Cmd/Ctrl + Enter" : "Enter"} 发送
            </span>
          )}
        </div>
        
        {/* 问题内容 */}
        <div className="px-4 py-3">
          <div className="text-sm text-foreground font-medium leading-relaxed">
            {question}
          </div>
          
          {/* 背景信息 */}
          {context && (
            <div className="mt-2 text-xs text-muted-foreground p-2 bg-muted/30 rounded-lg">
              <span className="text-muted-foreground/60">背景：</span>
              <span className="ml-1">{context}</span>
            </div>
          )}
        </div>
        
        {/* 选项区域 */}
        {effectiveOptions.length > 0 && (
          <div className="px-4 pb-3">
            <div className="space-y-1.5">
              {effectiveOptions.map((opt, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    handleOptionSelect(i, opt);
                  }}
                  disabled={isSubmitting}
                  className={cn(
                    "w-full flex items-center gap-3 p-2.5 rounded-lg border transition-all text-left",
                    "hover:border-primary/50 hover:bg-primary/5",
                    selectedOption === i 
                      ? "border-primary/60 bg-primary/10" 
                      : "border-border/50 bg-muted/20",
                    isSubmitting && "opacity-50 cursor-not-allowed"
                  )}
                >
                  {/* 选项标签 */}
                  <span className={cn(
                    "size-6 rounded flex items-center justify-center text-xs font-bold shrink-0",
                    selectedOption === i 
                      ? "bg-primary text-primary-foreground" 
                      : "bg-muted text-muted-foreground"
                  )}>
                    {getOptionLabel(i)}
                  </span>
                  {/* 选项内容 */}
                  <span className="text-sm text-foreground flex-1">{opt}</span>
                  {/* 选中指示 */}
                  {selectedOption === i && (
                    <CheckIcon className="size-4 text-primary shrink-0" />
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
        
        {/* 自定义输入区域 */}
        <div className="px-4 pb-3">
          {effectiveOptions.length > 0 && (
            <div className="text-xs text-muted-foreground mb-1.5 flex items-center gap-1">
              <span>可直接发送选项，或编辑为自定义回复：</span>
            </div>
          )}
          {selectedOption != null && effectiveOptions[selectedOption] && (
            <div className="mb-1.5 inline-flex items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-2 py-0.5 text-[11px] text-primary">
              <span>已选 {getOptionLabel(selectedOption)}</span>
              <span className="truncate max-w-[220px]">{effectiveOptions[selectedOption]}</span>
            </div>
          )}
          <div className="mb-1.5">
            <button
              type="button"
              onClick={() => {
                setSelectedOption(null);
                setCustomInput("");
                if (inputRef.current) inputRef.current.focus();
                if (textareaRef.current) textareaRef.current.focus();
              }}
              className="rounded-md border border-border/50 bg-muted/20 px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
            >
              其他（手动输入）
            </button>
          </div>
          <div className="flex gap-2">
            {useTextareaInput ? (
              // 输入模式使用 textarea：Enter 换行，Cmd/Ctrl+Enter 提交
              <textarea
                ref={textareaRef}
                value={customInput}
                onChange={(e) => setCustomInput(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && customInput.trim()) {
                    e.preventDefault();
                    submitDraft();
                  }
                }}
                placeholder="输入您的回复..."
                disabled={isSubmitting}
                rows={2}
                className={cn(
                  "flex-1 px-3 py-2 text-sm rounded-lg border bg-background resize-none",
                  "focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/50",
                  "placeholder:text-muted-foreground/50",
                  isSubmitting && "opacity-50 cursor-not-allowed"
                )}
              />
            ) : (
              // 选项模式 - 使用单行 input
              <input
                ref={inputRef}
                type="text"
                value={customInput}
                onChange={(e) => setCustomInput(e.target.value)}
                placeholder="或输入自定义回复..."
                disabled={isSubmitting}
                className={cn(
                  "flex-1 px-3 py-2 text-sm rounded-lg border bg-background",
                  "focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/50",
                  "placeholder:text-muted-foreground/50",
                  isSubmitting && "opacity-50 cursor-not-allowed"
                )}
              />
            )}
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                submitDraft();
              }}
              disabled={!canSubmitDraft}
              className={cn(
                "px-4 py-2 rounded-lg font-medium text-sm transition-all shrink-0 inline-flex items-center gap-2",
                canSubmitDraft
                  ? "bg-primary text-primary-foreground hover:bg-primary/90"
                  : "bg-muted text-muted-foreground cursor-not-allowed"
              )}
            >
              {isSubmitting ? (
                <>
                  <LoaderIcon className="size-4 animate-spin shrink-0" />
                  <span>发送中…</span>
                </>
              ) : (
                "发送回复"
              )}
            </button>
          </div>
          <div className="mt-1.5 text-xs text-muted-foreground/60">
            {useTextareaInput ? "按 Cmd/Ctrl + Enter 发送" : "按 Enter 发送"}
            {!canSubmitDraft ? "（请先选择或输入）" : ""}
          </div>
        </div>
      </div>
    );
  },
});

// ============================================================
// 简单工具 UI - 使用 createSimpleToolUI 工厂函数
// ============================================================

// 获取库列表工具（hidden tier）
export const GetLibrariesToolUI = createSimpleToolUI<Record<string, never>>("get_libraries", {
  icon: <PackageIcon className="size-3.5" />,
  iconColor: "text-blue-500",
  displayName: "Python 库列表",
  hidden: true,
  getCount: (result) => {
    const match = result.match(/已加载:\s*(\d+)/);
    return { count: match ? parseInt(match[1]) : 0, unit: "个可用" };
  },
});

// 知识检索工具（支持系统状态/健康巡检结果的结构化展示）
type SearchKnowledgeArgs = { query?: string; top_k?: number };
type StructuredStatusSnapshot = {
  healthScore: number;
  statuses: Array<{ name: string; status: "healthy" | "degraded" | "down"; detail: string }>;
  summary: string;
};
type StatusCommandRegressionSnapshot = {
  total: number;
  failed: number;
  passed: boolean;
  generatedAt: string;
};
type PathNormalizationSnapshot = {
  passed: boolean;
  changedFiles: number;
  changedReferences: number;
};
type SearchKnowledgeSnapshot = {
  parsedJson: Record<string, unknown> | null;
  section: string;
  badgeLabel: string | null;
  rerankLabel: string | null;
  statusTitle: string;
  structuredStatus: StructuredStatusSnapshot | null;
  statusCommandRegressionMeta: StatusCommandRegressionSnapshot | null;
  pathNormalizationMeta: PathNormalizationSnapshot | null;
};

const DEFAULT_SEARCH_STATUS_TITLE = "系统健康巡检";
const SEARCH_STATUS_SECTION_UI: Record<string, { badge: string; title: string }> = {
  all: { badge: "全量状态快照", title: "系统全量状态" },
  health: { badge: "健康快照", title: "系统健康巡检" },
  rollout: { badge: "发布快照", title: "灰度发布状态" },
  gate: { badge: "门禁快照", title: "门禁状态" },
  prompt_modules: { badge: "模块快照", title: "提示词模块健康" },
  status_commands: { badge: "命令回归快照", title: "命令回归状态" },
};
const SEARCH_STATUS_SECTION_ALIASES: Record<string, string> = {
  prompt: "prompt_modules",
  module: "prompt_modules",
  modules: "prompt_modules",
  command: "status_commands",
  commands: "status_commands",
};

function normalizeSearchStatusSection(sectionRaw: unknown, hasStatusCommandMeta: boolean): string {
  const section = typeof sectionRaw === "string" ? sectionRaw.trim().toLowerCase() : "";
  if (SEARCH_STATUS_SECTION_ALIASES[section]) return SEARCH_STATUS_SECTION_ALIASES[section];
  if (section) return section;
  // 当后端未显式返回 section，但包含命令回归元数据时，按 status_commands 渲染
  if (hasStatusCommandMeta) return "status_commands";
  return "";
}

function parseSearchKnowledgeSnapshot(result: string): SearchKnowledgeSnapshot {
  let parsedJson: Record<string, unknown> | null = null;
  try {
    const data = JSON.parse(result);
    if (data && typeof data === "object") parsedJson = data as Record<string, unknown>;
  } catch {
    // 非 JSON 结果走文本渲染
  }
  if (!parsedJson) {
    const rerankLineMatch = result.match(/\*\*\[检索链路\]\*\*.*?重排:\s*([^\n]+)/);
    return {
      parsedJson: null,
      section: "",
      badgeLabel: null,
      rerankLabel: rerankLineMatch ? rerankLineMatch[1].trim() : null,
      statusTitle: DEFAULT_SEARCH_STATUS_TITLE,
      structuredStatus: null,
      statusCommandRegressionMeta: null,
      pathNormalizationMeta: null,
    };
  }

  const healthScore = parsedJson.health_score;
  const components = parsedJson.components;
  const summary = parsedJson.summary;
  const structuredStatus: StructuredStatusSnapshot | null =
    (typeof healthScore === "number" || Array.isArray(components))
      ? {
          healthScore: typeof healthScore === "number" ? healthScore : 0,
          statuses: Array.isArray(components)
            ? components
                .filter((x) => x && typeof x === "object")
                .map((x) => {
                  const item = x as Record<string, unknown>;
                  const statusRaw = String(item.status || "").toLowerCase();
                  const status = statusRaw === "healthy" || statusRaw === "degraded" || statusRaw === "down"
                    ? statusRaw
                    : "degraded";
                  return {
                    name: String(item.name || item.component || "unknown"),
                    status: status as "healthy" | "degraded" | "down",
                    detail: String(item.detail || item.message || ""),
                  };
                })
            : [],
          summary: typeof summary === "string" ? summary : "",
        }
      : null;

  const rawMeta = parsedJson.status_command_regression_meta;
  let statusCommandRegressionMeta: StatusCommandRegressionSnapshot | null = null;
  if (rawMeta && typeof rawMeta === "object") {
    const meta = rawMeta as Record<string, unknown>;
    const total = Number(meta.total ?? 0);
    const failed = Number(meta.failed ?? 0);
    if (Number.isFinite(total) && Number.isFinite(failed)) {
      statusCommandRegressionMeta = {
        total: Math.max(0, Math.trunc(total)),
        failed: Math.max(0, Math.trunc(failed)),
        passed: Boolean(meta.passed),
        generatedAt: typeof meta.generated_at === "string" ? meta.generated_at : "",
      };
    }
  }
  const rawPathMeta = parsedJson.path_normalization_meta;
  let pathNormalizationMeta: PathNormalizationSnapshot | null = null;
  if (rawPathMeta && typeof rawPathMeta === "object") {
    const meta = rawPathMeta as Record<string, unknown>;
    const changedFiles = Number(meta.changed_files ?? 0);
    const changedReferences = Number(meta.changed_references ?? 0);
    if (Number.isFinite(changedFiles) && Number.isFinite(changedReferences)) {
      pathNormalizationMeta = {
        passed: Boolean(meta.passed),
        changedFiles: Math.max(0, Math.trunc(changedFiles)),
        changedReferences: Math.max(0, Math.trunc(changedReferences)),
      };
    }
  }

  const rerankLineMatch = result.match(/\*\*\[检索链路\]\*\*.*?重排:\s*([^\n]+)/);
  const rerankLabel = rerankLineMatch ? rerankLineMatch[1].trim() : null;

  const section = normalizeSearchStatusSection(parsedJson.section, Boolean(statusCommandRegressionMeta));
  const sectionUi = SEARCH_STATUS_SECTION_UI[section];

  return {
    parsedJson,
    section,
    badgeLabel: sectionUi?.badge ?? (structuredStatus ? "系统状态快照" : null),
    rerankLabel,
    statusTitle: sectionUi?.title ?? DEFAULT_SEARCH_STATUS_TITLE,
    structuredStatus,
    statusCommandRegressionMeta,
    pathNormalizationMeta,
  };
}

export const SearchKnowledgeToolUI = makeAssistantToolUI<SearchKnowledgeArgs, string>({
  toolName: "search_knowledge",
  render: function SearchKnowledgeUI({ args, result, status, toolCallId }) {
    const { retryTool } = React.useContext(ToolActionContext);
    const messageId = useMessage((s) => (s as { id?: string }).id);
    const toolResultsMap = useContext(ToolResultsByMessageIdContext);
    const fallbackResult = messageId && toolCallId ? (toolResultsMap.get(messageId)?.[toolCallId]) : undefined;
    const displayResult = (result != null && result !== "") ? result : (fallbackResult ?? "");
    const isRunning = status?.type === "running";
    const isComplete = status?.type === "complete";
    const [showDetails, setShowDetails] = useState(false);
    const query = args?.query ?? (args as Record<string, unknown>)?.search_query ?? (args as Record<string, unknown>)?.q ?? "";
    const shortQuery = String(query).length > 40 ? `${String(query).slice(0, 40)}...` : String(query);

    const snapshot = React.useMemo(
      () => (displayResult ? parseSearchKnowledgeSnapshot(displayResult) : parseSearchKnowledgeSnapshot("")),
      [displayResult]
    );
    const parsedJson = snapshot.parsedJson;
    const structuredStatus = snapshot.structuredStatus;
    const statusCommandRegressionMeta = snapshot.statusCommandRegressionMeta;
    const pathNormalizationMeta = snapshot.pathNormalizationMeta;
    const triggerStatusCommand = React.useCallback((command: string) => {
      try {
        const threadId = getCurrentThreadIdFromStorage();
        window.dispatchEvent(
          new CustomEvent(EVENTS.FILL_PROMPT, {
            detail: { prompt: command, autoSend: true, threadId: threadId || undefined },
          })
        );
      } catch {
        toast.error(t("common.actionFailedRetry"));
      }
    }, []);
    const handleStatusCardAction = React.useCallback((action: string) => {
      if (action === "refresh_system_status") {
        triggerStatusCommand("/status all");
        return;
      }
      if (action === "check_path_normalization") {
        triggerStatusCommand("/status commands");
      }
    }, [triggerStatusCommand]);

    const resultCount = React.useMemo(() => {
      if (!displayResult) return 0;
      const match = displayResult.match(/(\d+)\s*(个|条|results)/i);
      return match ? parseInt(match[1]) : 0;
    }, [displayResult]);

    const firstLineSummary = React.useMemo(
      () => (displayResult && isComplete ? extractResultSummary(displayResult, "search_knowledge") : null),
      [displayResult, isComplete]
    );

    React.useEffect(() => {
      if (isComplete && displayResult && (resultCount <= 5 || parsedJson)) setShowDetails(true);
    }, [isComplete, displayResult, resultCount, parsedJson]);

    return (
      <div className="my-1.5">
        <button
          type="button"
          onClick={() => (displayResult != null || resultCount > 0) && setShowDetails((v) => !v)}
          className="inline-flex items-center gap-1.5 text-sm hover:bg-muted/30 rounded px-1.5 py-0.5 -ml-1.5 transition-colors max-w-full"
          aria-expanded={showDetails}
          aria-label={t("toolCard.expandCollapseResult")}
        >
          {isRunning ? (
            <LoaderIcon className="size-3.5 animate-spin text-purple-500" />
          ) : (
            <CheckIcon className="size-3.5 text-emerald-500" />
          )}
          <BrainIcon className="size-3.5 text-purple-500" />
          <span className="text-foreground">知识检索</span>
          {shortQuery && <span className="text-muted-foreground truncate max-w-[220px]">"{shortQuery}"</span>}
          {isRunning ? (
            <span className="text-xs text-muted-foreground"><ProgressDots text="检索" /></span>
          ) : isComplete && (
            <span className="text-xs text-muted-foreground shrink-0">
              · {snapshot.badgeLabel ?? (displayResult ? `${resultCount || 0} 条结果` : t("toolCard.resultNotReturned"))}
              {snapshot.rerankLabel ? ` · 重排: ${snapshot.rerankLabel}` : ""}
              {displayResult && (showDetails ? <ChevronDownIcon className="size-3 inline ml-1" /> : <ChevronRightIcon className="size-3 inline ml-1" />)}
            </span>
          )}
        </button>
        {isComplete && !displayResult && (
          <div className="mt-1 ml-5 text-[12px] text-muted-foreground/90">
            {t("toolCard.resultNotReturned")}
          </div>
        )}
        {isComplete && firstLineSummary && !showDetails && (
          <div className="mt-1 ml-5 text-[12px] text-muted-foreground/90 line-clamp-2">
            {firstLineSummary}
          </div>
        )}

        {showDetails && isComplete && displayResult && (
          <div className="mt-1.5 ml-5 space-y-1.5">
            <ToolActionBar
              actions={[
                { label: t("toolCard.runAgain"), icon: <RefreshCwIcon className="size-3" />, onClick: () => retryTool("search_knowledge", (args ?? {}) as Record<string, unknown>) },
                { label: t("toolCard.copyResult"), icon: <CopyIcon className="size-3" />, onClick: () => copyToClipboard(displayResult) },
              ]}
            />
            {statusCommandRegressionMeta && (
              <div className="rounded-md border border-border/60 bg-muted/20 p-2.5 text-xs">
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <span className="font-medium text-foreground">/status 命令回归</span>
                  <span
                    className={cn(
                      "rounded px-1.5 py-0.5",
                      statusCommandRegressionMeta.passed
                        ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                        : "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                    )}
                  >
                    {statusCommandRegressionMeta.passed ? "通过" : "异常"}
                  </span>
                </div>
                <div className="text-muted-foreground">
                  通过率：{Math.max(0, statusCommandRegressionMeta.total - statusCommandRegressionMeta.failed)}/
                  {statusCommandRegressionMeta.total}
                </div>
                {!!statusCommandRegressionMeta.generatedAt && (
                  <div className="mt-1 text-muted-foreground/80">
                    生成时间：{statusCommandRegressionMeta.generatedAt}
                  </div>
                )}
                {pathNormalizationMeta && (
                  <div className="mt-1.5 border-t border-border/40 pt-1.5 text-muted-foreground">
                    <div className="flex items-center justify-between gap-2">
                      <span>路径口径漂移</span>
                      <span
                        className={cn(
                          "rounded px-1.5 py-0.5",
                          pathNormalizationMeta.passed
                            ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                            : "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                        )}
                      >
                        {pathNormalizationMeta.changedReferences}
                      </span>
                    </div>
                    <div className="mt-0.5 text-muted-foreground/80">
                      影响文件：{pathNormalizationMeta.changedFiles} · 需归一化引用：{pathNormalizationMeta.changedReferences}
                    </div>
                  </div>
                )}
              </div>
            )}
            {structuredStatus ? (
              <GenerativeUI
                ui={{
                  type: "system_status",
                  title: snapshot.statusTitle,
                  healthScore: structuredStatus.healthScore,
                  statuses: structuredStatus.statuses,
                  summary: structuredStatus.summary,
                }}
                onAction={handleStatusCardAction}
              />
            ) : parsedJson ? (
              <GenerativeUI ui={{ type: "json_viewer", title: "结构化结果", data: parsedJson }} />
            ) : (
              <ExpandableResult result={displayResult} toolName="search_knowledge" />
            )}
          </div>
        )}
      </div>
    );
  },
});

// 知识图谱统一工具（少工具原则：extract + query）
export const KnowledgeGraphToolUI = createSimpleToolUI<{
  action?: string;
  text?: string;
  source?: string;
  query?: string;
}>("knowledge_graph", {
  icon: <GlobeIcon className="size-3.5" />,
  iconColor: "text-indigo-500",
  displayName: "知识图谱",
  getQuery: (args) => args?.query || (args?.action === "extract" ? args?.text?.slice(0, 80) : ""),
});

// 兼容旧引用（若后端仍返回旧名）
export const ExtractEntitiesToolUI = createSimpleToolUI<{ text?: string; doc_path?: string }>("extract_entities", {
  icon: <SparklesIcon className="size-3.5" />,
  iconColor: "text-cyan-500",
  displayName: "实体提取",
  getCount: (result) => {
    const match = result?.match(/(\d+)\s*(个|entities)/i);
    return { count: match ? parseInt(match[1]) : 0, unit: "个实体" };
  },
});

export const QueryKGToolUI = createSimpleToolUI<{ query?: string; entity?: string }>("query_kg", {
  icon: <GlobeIcon className="size-3.5" />,
  iconColor: "text-indigo-500",
  displayName: "知识图谱",
  getQuery: (args) => args?.query || args?.entity || "",
});

// ============================================================
// 学习工具 - Cursor 风格
// ============================================================
type LearnFromDocArgs = { doc_path?: string; content?: string };

export const LearnFromDocToolUI = makeAssistantToolUI<LearnFromDocArgs, string>({
  toolName: "learn_from_doc",
  render: function LearnFromDocUI({ args, result, status, toolCallId }) {
    const messageId = useMessage((s) => (s as { id?: string }).id);
    const toolResultsMap = useContext(ToolResultsByMessageIdContext);
    const fallbackResult = messageId && toolCallId ? toolResultsMap.get(messageId)?.[toolCallId] : undefined;
    const displayResult = (result != null && result !== "") ? result : (fallbackResult ?? "");
    const { retryTool } = React.useContext(ToolActionContext);
    const isRunning = status?.type === "running";
    const isComplete = status?.type === "complete";
    const isSuccess = displayResult?.includes("✅") || displayResult?.includes("成功");
    
    const docPath = args?.doc_path || "";
    const fileName = docPath.split('/').pop() || "文档";
    
    return (
      <div className="my-1.5">
        <div className="inline-flex items-center gap-1.5 text-sm">
          {isRunning ? (
            <LoaderIcon className="size-3.5 animate-spin text-green-500" />
          ) : isSuccess ? (
            <CheckIcon className="size-3.5 text-emerald-500" />
          ) : (
            <AlertCircleIcon className="size-3.5 text-amber-500" />
          )}
          <BrainIcon className="size-3.5 text-green-500" />
          <span className="text-foreground">学习文档</span>
          <span className="text-muted-foreground font-mono text-xs">{fileName}</span>
          
          {isRunning ? (
            <span className="text-xs text-muted-foreground"><ProgressDots text="学习" /></span>
          ) : isComplete && (
            <span className="text-xs text-muted-foreground">· {isSuccess ? "已学习" : displayResult ? "学习失败" : t("toolCard.resultNotReturned")}</span>
          )}
        </div>
        {isComplete && !displayResult && (
          <div className="mt-1 ml-5 text-[12px] text-muted-foreground/90">
            {t("toolCard.resultNotReturned")}
          </div>
        )}
        {isComplete && (args || displayResult) && (
          <div className="mt-1.5 ml-5">
            <ToolActionBar
              actions={[
                { label: t("toolCard.runAgain"), icon: <RefreshCwIcon className="size-3" />, onClick: () => retryTool("learn_from_doc", (args ?? {}) as Record<string, unknown>) },
                ...(displayResult ? [{ label: t("toolCard.copyResult"), icon: <CopyIcon className="size-3" />, onClick: () => copyToClipboard(displayResult) }] : []),
              ]}
            />
          </div>
        )}
      </div>
    );
  },
});

// ============================================================
// 任务反馈工具 - Cursor 风格
// ============================================================
type ReportTaskResultArgs = { task_id?: string; success?: boolean; feedback?: string };

export const ReportTaskResultToolUI = makeAssistantToolUI<ReportTaskResultArgs, string>({
  toolName: "report_task_result",
  render: function ReportTaskResultUI() {
    return null;
  },
});

// 学习统计工具（hidden tier）
export const GetLearningStatsToolUI = createSimpleToolUI<Record<string, never>>("get_learning_stats", {
  icon: <BrainIcon className="size-3.5" />,
  iconColor: "text-blue-500",
  displayName: "学习统计",
  hidden: true,
});

// ============================================================
// 失败记录工具 - Cursor 风格
// ============================================================
type RecordFailureArgs = { error_type?: string; context?: string };

export const RecordFailureToolUI = makeAssistantToolUI<RecordFailureArgs, string>({
  toolName: "record_failure",
  render: function RecordFailureUI() {
    return null;
  },
});

// ============================================================
// 图表创建工具 - Cursor 风格
// ============================================================
type CreateChartArgs = { chart_type?: string; data?: any; title?: string };

export const CreateChartToolUI = makeAssistantToolUI<CreateChartArgs, string>({
  toolName: "create_chart",
  render: function CreateChartUI({ args, result, status, toolCallId }) {
    const messageId = useMessage((s) => (s as { id?: string }).id);
    const toolResultsMap = useContext(ToolResultsByMessageIdContext);
    const fallbackResult = messageId && toolCallId ? toolResultsMap.get(messageId)?.[toolCallId] : undefined;
    const displayResult = (result != null && result !== "") ? result : (fallbackResult ?? "");
    const isRunning = status?.type === "running";
    const isComplete = status?.type === "complete";
    const isSuccess = displayResult?.includes("✅") || displayResult?.includes("成功");
    const [showResult, setShowResult] = useState(false);
    
    const chartType = args?.chart_type || "图表";
    const title = args?.title || "";
    
    return (
      <div className="my-1.5">
        <button
          onClick={() => (displayResult || isSuccess) && setShowResult(!showResult)}
          className="inline-flex items-center gap-1.5 text-sm hover:bg-muted/30 rounded px-1.5 py-0.5 -ml-1.5 transition-colors"
        >
          {isRunning ? (
            <LoaderIcon className="size-3.5 animate-spin text-violet-500" />
          ) : isSuccess ? (
            <CheckIcon className="size-3.5 text-emerald-500" />
          ) : (
            <AlertCircleIcon className="size-3.5 text-amber-500" />
          )}
          <CodeIcon className="size-3.5 text-blue-500" />
          <span className="text-foreground">创建{chartType}</span>
          {title && <span className="text-muted-foreground text-xs">{title}</span>}
          
          {isRunning ? (
            <span className="text-xs text-muted-foreground"><ProgressDots /></span>
          ) : isComplete && (
            <span className="text-xs text-muted-foreground">
              · {isSuccess ? "已创建" : displayResult ? "创建失败" : t("toolCard.resultNotReturned")}
              {(displayResult || isSuccess) && (showResult ? <ChevronDownIcon className="size-3 inline ml-1" /> : <ChevronRightIcon className="size-3 inline ml-1" />)}
            </span>
          )}
        </button>
        {isComplete && !displayResult && (
          <div className="mt-1 ml-5 text-[12px] text-muted-foreground/90">
            {t("toolCard.resultNotReturned")}
          </div>
        )}
        {showResult && displayResult && isComplete && (
          <div className="mt-1 ml-5 text-xs text-muted-foreground whitespace-pre-wrap">
            {displayResult}
          </div>
        )}
      </div>
    );
  },
});

// ============================================================
// 注意：专业文档生成不需要专用工具 UI
// Claude 设计哲学：通过 python_run + SKILL.md 工作流实现
// python_run 的输出会通过 PythonRunToolUI 显示
// ============================================================
