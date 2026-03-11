/**
 * 仪表盘简报与工作建议状态，与 meta/tasks 分离以降低无关更新导致的重渲染。
 */
import { create } from "zustand";
import type { BriefingPayload, WorkSuggestion } from "../lib/api/systemApi";

interface DashboardBriefingState {
  briefing: BriefingPayload | null;
  briefingLoading: boolean;
  briefingError: boolean;
  workSuggestions: WorkSuggestion[];
  workSuggestionsReady: boolean;
  setBriefing: (v: BriefingPayload | null) => void;
  setBriefingLoading: (v: boolean) => void;
  setBriefingError: (v: boolean) => void;
  setWorkSuggestions: (v: WorkSuggestion[]) => void;
  setWorkSuggestionsReady: (v: boolean) => void;
}

export const useDashboardBriefingStore = create<DashboardBriefingState>((set) => ({
  briefing: null,
  briefingLoading: false,
  briefingError: false,
  workSuggestions: [],
  workSuggestionsReady: false,
  setBriefing: (v) => set({ briefing: v }),
  setBriefingLoading: (v) => set({ briefingLoading: v }),
  setBriefingError: (v) => set({ briefingError: v }),
  setWorkSuggestions: (v) => set({ workSuggestions: v }),
  setWorkSuggestionsReady: (v) => set({ workSuggestionsReady: v }),
}));
