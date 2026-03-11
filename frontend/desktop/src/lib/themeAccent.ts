/**
 * 主题色（主色/强调色）应用与持久化
 * 供 SettingsView 与 App 启动时恢复使用
 * 支持浅色/深色两套 secondary、accent 调色板
 */

type Palette = { primary: string; primaryFg: string; secondary: string; secondaryFg: string; accent: string; accentFg: string; ring: string };

const THEME_ACCENT_MAP: Record<string, Palette> = {
  emerald: { primary: '#10b981', primaryFg: '#ffffff', secondary: '#d1fae5', secondaryFg: '#047857', accent: '#d1fae5', accentFg: '#10b981', ring: '#10b981' },
  blue: { primary: '#3b82f6', primaryFg: '#ffffff', secondary: '#dbeafe', secondaryFg: '#1d4ed8', accent: '#dbeafe', accentFg: '#3b82f6', ring: '#3b82f6' },
  purple: { primary: '#8b5cf6', primaryFg: '#ffffff', secondary: '#ede9fe', secondaryFg: '#5b21b6', accent: '#ede9fe', accentFg: '#8b5cf6', ring: '#8b5cf6' },
  pink: { primary: '#ec4899', primaryFg: '#ffffff', secondary: '#fce7f3', secondaryFg: '#9d174d', accent: '#fce7f3', accentFg: '#ec4899', ring: '#ec4899' },
  orange: { primary: '#f97316', primaryFg: '#ffffff', secondary: '#ffedd5', secondaryFg: '#c2410c', accent: '#ffedd5', accentFg: '#f97316', ring: '#f97316' },
  cyan: { primary: '#06b6d4', primaryFg: '#ffffff', secondary: '#cffafe', secondaryFg: '#0e7490', accent: '#cffafe', accentFg: '#06b6d4', ring: '#06b6d4' },
};

const THEME_ACCENT_MAP_DARK: Record<string, Palette> = {
  emerald: { primary: '#10b981', primaryFg: '#ffffff', secondary: '#064e3b', secondaryFg: '#6ee7b7', accent: '#064e3b', accentFg: '#10b981', ring: '#10b981' },
  blue: { primary: '#3b82f6', primaryFg: '#ffffff', secondary: '#1e3a8a', secondaryFg: '#93c5fd', accent: '#1e3a8a', accentFg: '#3b82f6', ring: '#3b82f6' },
  purple: { primary: '#8b5cf6', primaryFg: '#ffffff', secondary: '#4c1d95', secondaryFg: '#c4b5fd', accent: '#4c1d95', accentFg: '#8b5cf6', ring: '#8b5cf6' },
  pink: { primary: '#ec4899', primaryFg: '#ffffff', secondary: '#831843', secondaryFg: '#f9a8d4', accent: '#831843', accentFg: '#ec4899', ring: '#ec4899' },
  orange: { primary: '#f97316', primaryFg: '#ffffff', secondary: '#7c2d12', secondaryFg: '#fdba74', accent: '#7c2d12', accentFg: '#f97316', ring: '#f97316' },
  cyan: { primary: '#06b6d4', primaryFg: '#ffffff', secondary: '#164e63', secondaryFg: '#67e8f9', accent: '#164e63', accentFg: '#06b6d4', ring: '#06b6d4' },
};

export const THEME_ACCENT_KEYS = ['emerald', 'blue', 'purple', 'pink', 'orange', 'cyan'] as const;
export const STORAGE_KEY = 'maibot_theme_accent';

export function applyThemeAccent(key: string): void {
  const isDark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
  const map = isDark ? THEME_ACCENT_MAP_DARK : THEME_ACCENT_MAP;
  const palette = map[key];
  if (!palette) return;
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.style.setProperty('--primary', palette.primary);
  root.style.setProperty('--primary-foreground', palette.primaryFg);
  root.style.setProperty('--secondary', palette.secondary);
  root.style.setProperty('--secondary-foreground', palette.secondaryFg);
  root.style.setProperty('--accent', palette.accent);
  root.style.setProperty('--accent-foreground', palette.accentFg);
  root.style.setProperty('--ring', palette.ring);
  root.style.setProperty('--sidebar-primary', palette.primary);
  root.style.setProperty('--sidebar-primary-foreground', palette.primaryFg);
  root.style.setProperty('--sidebar-accent', palette.secondary);
  root.style.setProperty('--sidebar-ring', palette.ring);
}

const FONT_SIZE_STORAGE_KEY = 'maibot_font_size';

/** 从 localStorage 读取并应用已保存的字号（App 启动时调用） */
export function applySavedFontSize(): void {
  try {
    const v = localStorage.getItem(FONT_SIZE_STORAGE_KEY);
    const size = v ? parseInt(v, 10) : 14;
    const px = Number.isNaN(size) || size < 12 || size > 24 ? 14 : size;
    document.documentElement.style.setProperty('--font-size', `${px}px`);
  } catch { /* ignore */ }
}

/** 从 localStorage 读取并应用已保存的主题色（App 启动时调用） */
export function applySavedThemeAccent(): void {
  try {
    applySavedFontSize();
    const v = localStorage.getItem(STORAGE_KEY);
    const key = v && THEME_ACCENT_KEYS.includes(v as (typeof THEME_ACCENT_KEYS)[number]) ? v : 'emerald';
    applyThemeAccent(key);
  } catch { /* ignore */ }
}
