/**
 * 仪表盘数据与 UI 状态（第 3 个 slice），与 meta/briefing 分离以降低重渲染。
 * 存放：rawThreads、协作行、推荐技能、配额、运行摘要、面板开关等。
 */
import { create } from "zustand";
import type { CollaborationMetricRow } from "../lib/api/boardApi";
import type { MarketSkillItem } from "../lib/api/skillsApi";

export type RawThread = {
  thread_id: string;
  metadata?: Record<string, unknown> | null;
  values?: { messages?: unknown[] };
  created_at?: string;
};

export interface LastRunSummary {
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

interface DashboardDataState {
  rawThreads: RawThread[];
  showCommandPalette: boolean;
  collaborationRows: CollaborationMetricRow[];
  recommendedSkills: MarketSkillItem[];
  installedPluginNames: string[];
  loadingRecommendedSkills: boolean;
  trialingSkillId: string | null;
  trialedSkillIds: string[];
  showAdvancedSections: boolean;
  orgQuotaHint: string;
  orgLearningHint: string;
  workerQuotaCpuSlots: Record<string, number>;
  cloudQuotaLimit: number;
  cloudQuotaUsed: number;
  autonomousQuotaLimit: number;
  autonomousQuotaUsed: number;
  focusModeEnabled: boolean;
  lastRunSummary: LastRunSummary | null;
  isLoading: boolean;
  showMarkdownReport: boolean;
  refreshTrigger: number;
  taskCreating: boolean;
  setRawThreads: (v: RawThread[]) => void;
  setShowCommandPalette: (v: boolean) => void;
  setCollaborationRows: (v: CollaborationMetricRow[]) => void;
  setRecommendedSkills: (v: MarketSkillItem[]) => void;
  setInstalledPluginNames: (v: string[]) => void;
  setLoadingRecommendedSkills: (v: boolean) => void;
  setTrialingSkillId: (v: string | null) => void;
  setTrialedSkillIds: (v: string[] | Set<string>) => void;
  setShowAdvancedSections: (v: boolean) => void;
  setOrgQuotaHint: (v: string) => void;
  setOrgLearningHint: (v: string) => void;
  setWorkerQuotaCpuSlots: (v: Record<string, number>) => void;
  setCloudQuotaLimit: (v: number) => void;
  setCloudQuotaUsed: (v: number) => void;
  setAutonomousQuotaLimit: (v: number) => void;
  setAutonomousQuotaUsed: (v: number) => void;
  setFocusModeEnabled: (v: boolean) => void;
  setLastRunSummary: (v: LastRunSummary | null) => void;
  setIsLoading: (v: boolean) => void;
  setShowMarkdownReport: (v: boolean) => void;
  incRefreshTrigger: () => void;
  setTaskCreating: (v: boolean) => void;
}

export const useDashboardDataStore = create<DashboardDataState>((set) => ({
  rawThreads: [],
  showCommandPalette: false,
  collaborationRows: [],
  recommendedSkills: [],
  installedPluginNames: [],
  loadingRecommendedSkills: false,
  trialingSkillId: null,
  trialedSkillIds: [],
  showAdvancedSections: false,
  orgQuotaHint: "",
  orgLearningHint: "",
  workerQuotaCpuSlots: {},
  cloudQuotaLimit: 0,
  cloudQuotaUsed: 0,
  autonomousQuotaLimit: 0,
  autonomousQuotaUsed: 0,
  focusModeEnabled: false,
  lastRunSummary: null,
  isLoading: true,
  showMarkdownReport: false,
  refreshTrigger: 0,
  taskCreating: false,
  setRawThreads: (v) => set({ rawThreads: v }),
  setShowCommandPalette: (v) => set({ showCommandPalette: v }),
  setCollaborationRows: (v) => set({ collaborationRows: v }),
  setRecommendedSkills: (v) => set({ recommendedSkills: v }),
  setInstalledPluginNames: (v) => set({ installedPluginNames: v }),
  setLoadingRecommendedSkills: (v) => set({ loadingRecommendedSkills: v }),
  setTrialingSkillId: (v) => set({ trialingSkillId: v }),
  setTrialedSkillIds: (v) => set({ trialedSkillIds: Array.isArray(v) ? v : [...v] }),
  setShowAdvancedSections: (v) => set({ showAdvancedSections: v }),
  setOrgQuotaHint: (v) => set({ orgQuotaHint: v }),
  setOrgLearningHint: (v) => set({ orgLearningHint: v }),
  setWorkerQuotaCpuSlots: (v) => set({ workerQuotaCpuSlots: v }),
  setCloudQuotaLimit: (v) => set({ cloudQuotaLimit: v }),
  setCloudQuotaUsed: (v) => set({ cloudQuotaUsed: v }),
  setAutonomousQuotaLimit: (v) => set({ autonomousQuotaLimit: v }),
  setAutonomousQuotaUsed: (v) => set({ autonomousQuotaUsed: v }),
  setFocusModeEnabled: (v) => set({ focusModeEnabled: v }),
  setLastRunSummary: (v) => set({ lastRunSummary: v }),
  setIsLoading: (v) => set({ isLoading: v }),
  setShowMarkdownReport: (v) => set({ showMarkdownReport: v }),
  incRefreshTrigger: () => set((s) => ({ refreshTrigger: s.refreshTrigger + 1 })),
  setTaskCreating: (v) => set({ taskCreating: v }),
}));
