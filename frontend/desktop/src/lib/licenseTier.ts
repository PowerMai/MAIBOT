export type LicenseTier = "free" | "pro" | "enterprise";
import { EVENTS } from "./constants";

const STORAGE_KEY = "maibot_license_tier";

export interface TierCapabilities {
  maxAutonomyLevel: string;
  cloudModelEnabled: boolean;
  evolutionEnabled: boolean;
  maxPlugins: number;
  maxCustomSkills: number;
}

export function normalizeLicenseTier(value?: string | null): LicenseTier {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "enterprise" || raw === "business") return "enterprise";
  if (raw === "pro") return "pro";
  return "free";
}

export function getLicenseTier(): LicenseTier {
  try {
    return normalizeLicenseTier(localStorage.getItem(STORAGE_KEY));
  } catch {
    return "free";
  }
}

export function setLicenseTier(tier: string, source = "app"): LicenseTier {
  const normalized = normalizeLicenseTier(tier);
  try {
    localStorage.setItem(STORAGE_KEY, normalized);
    window.dispatchEvent(
      new CustomEvent(EVENTS.LICENSE_TIER_CHANGED, { detail: { tier: normalized, source } }),
    );
    window.dispatchEvent(new CustomEvent(EVENTS.COMPOSER_PREFS_CHANGED));
  } catch {
    // ignore
  }
  return normalized;
}

export function licenseTierRank(tier: string): number {
  const t = normalizeLicenseTier(tier);
  if (t === "enterprise") return 3;
  if (t === "pro") return 2;
  return 1;
}

export function getTierCapabilities(tier: LicenseTier): TierCapabilities {
  if (tier === "enterprise") {
    return {
      maxAutonomyLevel: "L3",
      cloudModelEnabled: true,
      evolutionEnabled: true,
      maxPlugins: -1,
      maxCustomSkills: -1,
    };
  }
  if (tier === "pro") {
    return {
      maxAutonomyLevel: "L2",
      cloudModelEnabled: true,
      evolutionEnabled: true,
      maxPlugins: 20,
      maxCustomSkills: 50,
    };
  }
  return {
    maxAutonomyLevel: "L1",
    cloudModelEnabled: false,
    evolutionEnabled: false,
    maxPlugins: 2,
    maxCustomSkills: 5,
  };
}
