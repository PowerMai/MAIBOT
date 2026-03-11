/**
 * 仪表盘元数据（角色、特性开关、许可、发布门禁等），与 briefing/tasks 分离以降低重渲染。
 */
import { create } from "zustand";
import type { RoleDefinition } from "../lib/api/boardApi";
import type { ReleaseGateSummary } from "../lib/api/boardApi";

export interface FeatureFlags {
  organization_mode: boolean;
  tradeable_mode: boolean;
  wallet_enabled: boolean;
}

interface DashboardMetaState {
  featureFlags: FeatureFlags;
  roles: RoleDefinition[];
  activeRoleId: string;
  currentLicenseTier: string;
  latestReleaseGateSummary: ReleaseGateSummary | null;
  showReleaseGateDetail: boolean;
  recoveryStats: Record<string, number>;
  setFeatureFlags: (v: FeatureFlags) => void;
  setRoles: (v: RoleDefinition[]) => void;
  setActiveRoleId: (v: string) => void;
  setCurrentLicenseTier: (v: string) => void;
  setLatestReleaseGateSummary: (v: ReleaseGateSummary | null) => void;
  setShowReleaseGateDetail: (v: boolean) => void;
  setRecoveryStats: (v: Record<string, number>) => void;
}

const defaultFeatureFlags: FeatureFlags = {
  organization_mode: false,
  tradeable_mode: false,
  wallet_enabled: false,
};

export const useDashboardMetaStore = create<DashboardMetaState>((set) => ({
  featureFlags: defaultFeatureFlags,
  roles: [],
  activeRoleId: "",
  currentLicenseTier: "free",
  latestReleaseGateSummary: null,
  showReleaseGateDetail: false,
  recoveryStats: {},
  setFeatureFlags: (v) => set({ featureFlags: v }),
  setRoles: (v) => set({ roles: v }),
  setActiveRoleId: (v) => set({ activeRoleId: v }),
  setCurrentLicenseTier: (v) => set({ currentLicenseTier: v }),
  setLatestReleaseGateSummary: (v) => set({ latestReleaseGateSummary: v }),
  setShowReleaseGateDetail: (v) => set({ showReleaseGateDetail: v }),
  setRecoveryStats: (v) => set({ recoveryStats: v }),
}));
