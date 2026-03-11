/**
 * SettingsView - 编辑器内联设置（Cursor/VSCode 风格）
 * 左侧导航 + 右侧内容，合并原 SettingsDialog 与 SettingsPanel 功能
 */

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Badge } from './ui/badge';
import { ScrollArea } from './ui/scroll-area';
import { Progress } from './ui/progress';
import { Label } from './ui/label';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { Switch } from './ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Separator } from './ui/separator';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog';
import {
  Settings,
  Palette,
  Shield,
  Server,
  MessageSquare,
  FolderOpen,
  Brain,
  Database,
  RefreshCw,
  Trash2,
  History,
  Clock,
  CheckCircle,
  XCircle,
  X,
  Keyboard,
  Search,
  Copy,
  Download,
  Wrench,
  ArrowRight,
  Cpu,
  FileText,
} from 'lucide-react';
import { toast } from 'sonner';
import { MCPManager } from './MCPManager';
import { RoleContextBadgeGroup } from './RoleContextBadgeGroup';
import {
  listThreads,
  deleteThread,
  cleanupExpiredThreads,
  getRunHistory,
  getUserMemories,
  deleteUserMemory,
  checkHealth,
  getApiBase,
  invalidateLangGraphClient,
  type HealthStatus,
} from '../lib/api/langserveChat';
import { workspaceService, workspaceAPI } from '../lib/api/workspace';
import { boardApi, type AgentProfile } from '../lib/api/boardApi';
import { rolesApi, type RoleDefinition } from '../lib/api/rolesApi';
import { skillsAPI, type SkillItem } from '../lib/api/skillsApi';
import { modelsApi } from '../lib/api/modelsApi';
import { configApi } from '../lib/api/configApi';
import { personaApi, type PersonaConfig } from '../lib/api/personaApi';
import { userModelApi, type UserProfileDto } from '../lib/api/userModelApi';
import {
  listPlugins,
  installPlugin,
  uninstallPlugin,
  getLicenseStatus,
  activateLicense,
  getEvolutionStatus,
  createEvolutionProposal,
  runEvolutionPipeline,
  type PluginListItem,
  type EvolutionRunResponse,
} from '../lib/api/systemApi';
import { useUserContext } from '../lib/hooks/useUserContext';
import { applyThemeAccent, applySavedFontSize, THEME_ACCENT_KEYS, STORAGE_KEY } from '../lib/themeAccent';
import { getLocale, setLocale, t, type Locale } from '../lib/i18n';
import { getLicenseTier, getTierCapabilities, setLicenseTier as persistLicenseTier, type LicenseTier } from '../lib/licenseTier';
import { cn } from './ui/utils';
import { EVENTS } from '../lib/constants';
import { DEFAULT_PROMPT_TEMPLATES, getPromptTemplates, resetPromptTemplatesToDefault, setPromptTemplates, type PromptTemplate } from '../lib/promptTemplates';
import { fileEventBus } from '../lib/events/fileEvents';
import { getItem as getStorageItem, setItem as setStorageItem, removeItem as removeStorageItem } from '../lib/safeStorage';
import { getCurrentThreadIdFromStorage, getCurrentWorkspacePathFromStorage } from '../lib/sessionState';
import { validServerThreadIdOrUndefined } from '../lib/api/langserveChat';
import { getScopedActiveRoleIdFromStorage, setScopedActiveRoleIdInStorage } from '../lib/roleIdentity';
import { setGlobalDefaultChatMode, CHAT_MODE_DEFAULT_STORAGE_KEY, type ChatMode } from '../lib/chatModeState';
import {
  ExecutionLogsCard,
  LangSmithStatusCard,
  LangSmithEvalsCard,
  SETTINGS_PREFILL_EXEC_THREAD_EVENT,
  UpgradeControlCard,
  AutonomousWatcherCard,
  OrganizationPolicyCard,
  DailyInsightsCard,
  SensitiveFilesCard,
  VisionAnalyzeCard,
  AutonomyLevelCard,
  SkillFeedbackStatsCard,
} from './Settings';

const CLOUD_CONSENT_KEY = 'maibot_cloud_model_consent_v1';
const PLUGIN_FILTER_KEY = 'maibot_plugin_filter';
const PLUGIN_SEARCH_KEY = 'maibot_plugin_search';
const EVOLUTION_REVIEW_AUTOSEND_KEY = 'maibot_evolution_review_autosend';
const EVOLUTION_TARGET_KEY = 'maibot_evolution_target';
const EVOLUTION_TITLE_KEY = 'maibot_evolution_title';
const EVOLUTION_MOTIVATION_KEY = 'maibot_evolution_motivation';
const EVOLUTION_PLAN_KEY = 'maibot_evolution_plan';
const EVOLUTION_DEFAULT_TARGET = 'core_engine';
const EVOLUTION_DEFAULT_TITLE = '提升任务拆解策略';
const EVOLUTION_DEFAULT_MOTIVATION = '减少复杂任务的重试次数并提升一次成功率';
const EVOLUTION_DEFAULT_PLAN = '1) 调整任务画像权重\n2) 增加评审反馈闭环\n3) 运行回归测试并评估指标';
const EVOLUTION_TARGET_DESCRIPTIONS: Record<string, string> = {
  core_engine: '核心执行与调度能力（路由、编排、运行时）',
  skills: '技能体系（发现、匹配、安装与质量提升）',
  knowledge: '知识体系（沉淀、检索、结构化更新）',
  tools: '工具链能力（MCP/本地工具接入与稳定性）',
  ontology: '本体与概念关系（术语、实体、关系约束）',
};

function isCloudDiscoveredModel(m: { id?: string; tier?: string; provider?: string } | undefined): boolean {
  if (!m) return false;
  const id = (m as { id?: string }).id;
  if (typeof id === 'string' && id.startsWith('cloud/')) return true;
  const tier = (m.tier ?? '').toString().toLowerCase();
  return tier.startsWith('cloud') || m.provider === 'cloud';
}

export type SettingsSectionId =
  | 'general'
  | 'appearance'
  | 'models'
  | 'rules'
  | 'extensions'
  | 'shortcuts'
  | 'agent_profile'
  | 'threads'
  | 'workspaces'
  | 'memories'
  | 'connection'
  | 'network'
  | 'advanced'
  | 'about';

function SettingsSectionHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="space-y-1">
      <h2 className="text-base font-semibold">{title}</h2>
      {description && <p className="text-[11px] text-muted-foreground">{description}</p>}
    </div>
  );
}

const THEME_ACCENT_CLASSES = ['bg-emerald-500', 'bg-blue-500', 'bg-purple-500', 'bg-pink-500', 'bg-orange-500', 'bg-cyan-500'] as const;

const SHORTCUT_GROUPS: { group: string; items: { label: string; keys: string }[] }[] = [
  { group: 'settings.shortcut.groupFile', items: [
    { label: 'settings.shortcut.newFile', keys: '⌘N' },
    { label: 'settings.shortcut.openFile', keys: '⌘O' },
    { label: 'settings.shortcut.saveFile', keys: '⌘S' },
    { label: 'settings.shortcut.saveAllFiles', keys: '⌘⇧S' },
    { label: 'settings.shortcut.closeFile', keys: '⌘W' },
    { label: 'settings.shortcut.switchLeftTab', keys: '⌘⇧[' },
    { label: 'settings.shortcut.switchRightTab', keys: '⌘⇧]' },
    { label: 'settings.shortcut.recentFiles', keys: 'Ctrl+Tab' },
  ]},
  { group: 'settings.shortcut.groupPanel', items: [
    { label: 'settings.shortcut.toggleSidebar', keys: '⌘B' },
    { label: 'settings.shortcut.openExplorer', keys: '⌘⇧E' },
    { label: 'settings.shortcut.openKnowledge', keys: '⌘⇧K' },
    { label: 'settings.shortcut.toggleAIPanel', keys: '⌘J' },
    { label: 'settings.shortcut.quickOpen', keys: '⌘P' },
    { label: 'settings.shortcut.fullscreen', keys: 'F11 或 ⌘⇧F' },
  ]},
  { group: 'settings.shortcut.groupEditor', items: [
    { label: 'settings.shortcut.editorCommandPalette', keys: '⌘K' },
    { label: 'settings.shortcut.globalCommandPalette', keys: '⌘⇧P' },
    { label: 'settings.shortcut.toggleMarkdownPreview', keys: '⌘\\' },
  ]},
  { group: 'settings.shortcut.groupChat', items: [
    { label: 'settings.shortcut.newThread', keys: '⌘⇧O' },
    { label: 'settings.shortcut.focusInput', keys: '⌘L' },
    { label: 'settings.shortcut.openTaskPanel', keys: '⌘⇧T' },
  ]},
  { group: 'settings.shortcut.groupMode', items: [
    { label: 'settings.shortcut.agent', keys: '⌘1' },
    { label: 'settings.shortcut.ask', keys: '⌘2' },
    { label: 'settings.shortcut.plan', keys: '⌘3' },
    { label: 'settings.shortcut.debugReview', keys: '⌘4' },
    { label: 'settings.shortcut.addContext', keys: '⌘/' },
  ]},
];

const NAV_GROUPS: { label: string; items: { id: SettingsSectionId; label: string; icon: React.ReactNode }[] }[] = [
  {
    label: 'settings.nav.groupGeneral',
    items: [
      { id: 'general', label: 'settings.nav.general', icon: <Settings className="h-3.5 w-3.5" /> },
      { id: 'appearance', label: 'settings.nav.appearance', icon: <Palette className="h-3.5 w-3.5" /> },
      { id: 'models', label: 'settings.nav.models', icon: <Cpu className="h-3.5 w-3.5" /> },
      { id: 'rules', label: 'settings.nav.rules', icon: <FileText className="h-3.5 w-3.5" /> },
      { id: 'extensions', label: 'settings.nav.extensions', icon: <Server className="h-3.5 w-3.5" /> },
      { id: 'shortcuts', label: 'settings.nav.shortcuts', icon: <Keyboard className="h-3.5 w-3.5" /> },
    ],
  },
  {
    label: 'settings.nav.groupData',
    items: [
      { id: 'agent_profile', label: 'settings.nav.agentProfile', icon: <Brain className="h-3.5 w-3.5" /> },
      { id: 'threads', label: 'settings.nav.threads', icon: <MessageSquare className="h-3.5 w-3.5" /> },
      { id: 'workspaces', label: 'settings.nav.workspaces', icon: <FolderOpen className="h-3.5 w-3.5" /> },
      { id: 'memories', label: 'settings.nav.memories', icon: <Brain className="h-3.5 w-3.5" /> },
    ],
  },
  {
    label: 'settings.nav.groupSystem',
    items: [
      { id: 'connection', label: 'settings.nav.connection', icon: <Database className="h-3.5 w-3.5" /> },
      { id: 'network', label: 'settings.nav.network', icon: <Server className="h-3.5 w-3.5" /> },
      { id: 'advanced', label: 'settings.nav.advanced', icon: <Shield className="h-3.5 w-3.5" /> },
      { id: 'about', label: 'settings.nav.about', icon: <Settings className="h-3.5 w-3.5" /> },
    ],
  },
];

interface SettingsViewProps {
  onClose: () => void;
  initialSection?: SettingsSectionId;
}

export function SettingsView({ onClose, initialSection }: SettingsViewProps) {
  const [section, setSection] = useState<SettingsSectionId>('general');
  const mountedRef = useRef(true);

  useEffect(() => {
    if (initialSection) {
      setSection(initialSection);
    }
  }, [initialSection]);

  useEffect(() => () => { mountedRef.current = false; }, []);

  // 常规/外观/高级 (原 SettingsDialog) — 从 localStorage 恢复
  const [isDarkMode, setIsDarkMode] = useState(() => {
    try { return getStorageItem('maibot_settings_darkMode') === 'true'; } catch { return false; }
  });
  const [autoDetectColorScheme, setAutoDetectColorScheme] = useState(() => {
    try { return getStorageItem('maibot_auto_detect_color_scheme') === 'true'; } catch { return false; }
  });
  const [autoSave, setAutoSave] = useState(() => {
    try { return getStorageItem('maibot_settings_autoSave') !== 'false'; } catch { return true; }
  });
  const [enableNotifications, setEnableNotifications] = useState(() => {
    try { return getStorageItem('maibot_settings_notifications') !== 'false'; } catch { return true; }
  });
  const [defaultModel, setDefaultModel] = useState(() => {
    try {
      const v = getStorageItem('maibot_settings_defaultModel');
      if (v === '__no_models__') return 'auto';
      return v || 'gpt-4';
    } catch { return 'gpt-4'; }
  });
  const [allowCloudWithoutConfirm, setAllowCloudWithoutConfirm] = useState(() => {
    try { return getStorageItem('maibot_allow_cloud_without_confirm') === 'true'; } catch { return false; }
  });
  const [baseURL, setBaseURL] = useState<string>(() => {
    try { return getStorageItem('maibot_settings_baseURL') || import.meta.env?.VITE_API_BASE_URL || 'http://127.0.0.1:2024'; } catch { return 'http://127.0.0.1:2024'; }
  });
  const [themeAccent, setThemeAccent] = useState<string>(() => {
    try {
      const v = getStorageItem(STORAGE_KEY);
      return v && THEME_ACCENT_KEYS.includes(v as (typeof THEME_ACCENT_KEYS)[number]) ? v : 'emerald';
    } catch { return 'emerald'; }
  });
  const [fontSize, setFontSize] = useState<number>(() => {
    try {
      const v = getStorageItem('maibot_font_size');
      const n = v ? parseInt(v, 10) : 14;
      return Number.isNaN(n) || n < 12 || n > 24 ? 14 : n;
    } catch { return 14; }
  });
  const [locale, setLocaleState] = useState<Locale>(() => getLocale());
  const [apiKey, setApiKey] = useState<string>(() => {
    try { return getStorageItem('maibot_api_key') || ''; } catch { return ''; }
  });
  const [apiKeySaving, setApiKeySaving] = useState(false);
  const [editorTabSize, setEditorTabSize] = useState<number>(() => {
    const raw = getStorageItem('maibot_editor_tab_size');
    const n = raw ? parseInt(raw, 10) : 2;
    return Number.isNaN(n) ? 2 : n;
  });
  const [editorWordWrap, setEditorWordWrap] = useState<'on' | 'off'>(() => {
    const raw = (getStorageItem('maibot_editor_word_wrap') || 'on').toLowerCase();
    return raw === 'off' ? 'off' : 'on';
  });
  const [leftPanelOpenByDefault, setLeftPanelOpenByDefault] = useState(() => {
    try { return getStorageItem('maibot_left_panel_open_by_default') === 'true'; } catch { return false; }
  });
  const [rightPanelOpenByDefault, setRightPanelOpenByDefault] = useState(() => {
    try { return getStorageItem('maibot_right_panel_open_by_default') !== 'false'; } catch { return true; }
  });
  const [chatAutoScroll, setChatAutoScroll] = useState(() => {
    try { return getStorageItem('maibot_chat_auto_scroll') !== 'false'; } catch { return true; }
  });
  const [showChatHistoryOnNew, setShowChatHistoryOnNew] = useState(() => {
    try { return getStorageItem('maibot_show_chat_history_on_new') === 'true'; } catch { return false; }
  });
  const [defaultWebSearch, setDefaultWebSearch] = useState(() => {
    try { return getStorageItem('maibot_web_search') === 'true'; } catch { return false; }
  });
  const [telemetryOptOut, setTelemetryOptOut] = useState(() => {
    try { return getStorageItem('maibot_telemetry_opt_out') === 'true'; } catch { return false; }
  });
  const [defaultChatMode, setDefaultChatModeState] = useState<ChatMode>(() => {
    try {
      const v = (getStorageItem(CHAT_MODE_DEFAULT_STORAGE_KEY) || 'agent').trim().toLowerCase();
      return (['agent', 'plan', 'ask', 'debug', 'review'].includes(v) ? v as ChatMode : 'agent');
    } catch { return 'agent'; }
  });
  const [editorMinimap, setEditorMinimap] = useState(() => {
    try { return getStorageItem('maibot_editor_minimap') !== 'false'; } catch { return true; }
  });
  const [noContextByDefault, setNoContextByDefault] = useState(() => {
    try { return getStorageItem('maibot_no_context_by_default') === 'true'; } catch { return false; }
  });
  const [chatFadingAnimation, setChatFadingAnimation] = useState(() => {
    try { return getStorageItem('maibot_chat_fading_animation') !== 'false'; } catch { return true; }
  });
  const [chatNarrowScrollbar, setChatNarrowScrollbar] = useState(() => {
    try { return getStorageItem('maibot_chat_narrow_scrollbar') === 'true'; } catch { return false; }
  });
  const [toolToggles, setToolToggles] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(getStorageItem('maibot_tool_toggles') || '{}');
    } catch {
      return {};
    }
  });
  const [reviewPolicy, setReviewPolicy] = useState<'notify' | 'auto' | 'gate'>(() => {
    try {
      const v = getStorageItem('maibot_review_policy');
      return v === 'auto' || v === 'gate' ? v : 'notify';
    } catch {
      return 'notify';
    }
  });
  const [reviewTemplate, setReviewTemplate] = useState<'short' | 'standard' | 'strict'>(() => {
    try {
      const v = getStorageItem('maibot_review_template');
      return v === 'short' || v === 'strict' ? v : 'standard';
    } catch {
      return 'standard';
    }
  });
  const [planConfirmSwitchToAgent, setPlanConfirmSwitchToAgent] = useState<boolean>(() => {
    try {
      const v = getStorageItem('maibot_plan_confirm_switch_to_agent');
      return v == null ? true : v !== 'false';
    } catch {
      return true;
    }
  });
  const [bookmarkListVersion, setBookmarkListVersion] = useState(0);
  const [bookmarkAddOpen, setBookmarkAddOpen] = useState(false);
  const [newBookmarkLabel, setNewBookmarkLabel] = useState('');
  const [newBookmarkText, setNewBookmarkText] = useState('');
  const [newBookmarkModes, setNewBookmarkModes] = useState<string[]>(['agent']);
  const BOOKMARK_MODES = ['agent', 'plan', 'ask', 'debug', 'review'] as const;

  useEffect(() => {
    let cancelled = false;
    const loadSecureKey = async () => {
      const electron = window.electron;
      if (!electron?.secureStoreGet) return;
      try {
        const res = await electron.secureStoreGet({ key: 'maibot_api_key' });
        if (cancelled) return;
        if (res?.success && typeof res.value === 'string' && res.value) {
          setApiKey(res.value);
        }
      } catch {
        // ignore
      }
    };
    void loadSecureKey();
    return () => { cancelled = true; };
  }, []);

  // 数据管理 (原 SettingsPanel)
  const [loading, setLoading] = useState(false);
  const [loadErrorSection, setLoadErrorSection] = useState<SettingsSectionId | null>(null);
  const [threads, setThreads] = useState<any[]>([]);
  const [threadCount, setThreadCount] = useState(0);
  const [recentWorkspaces, setRecentWorkspaces] = useState<any[]>([]);
  const [workspaceCount, setWorkspaceCount] = useState(0);
  const [memories, setMemories] = useState<any[]>([]);
  const [runHistory, setRunHistory] = useState<any[]>([]);
  const [selectedThreadForHistory, setSelectedThreadForHistory] = useState<string | null>(null);
  const [healthStatus, setHealthStatus] = useState<'checking' | 'healthy' | 'unhealthy'>('checking');
  const [projectFolder, setProjectFolder] = useState<string>('');
  const [pendingWorkspacePath, setPendingWorkspacePath] = useState<string | null>(null);
  const [pendingDeleteModelId, setPendingDeleteModelId] = useState<string | null>(null);
  const [cleanThreadsConfirm, setCleanThreadsConfirm] = useState<{ days: number } | null>(null);
  const [cloudConsentPending, setCloudConsentPending] = useState<{ modelId: string } | null>(null);
  const [confirmAction, setConfirmAction] = useState<
    | { type: "deleteThread"; threadId: string }
    | { type: "cleanupWorkspaces" }
    | { type: "clearRecent" }
    | { type: "deleteMemory"; memory: { key?: string } }
    | { type: "deleteSkill"; skill: { name: string; display_name?: string } }
    | { type: "resetToDefault" }
    | null
  >(null);
  const [agentProfile, setAgentProfile] = useState<AgentProfile | null>(null);
  const [agentProfileSkills, setAgentProfileSkills] = useState<SkillItem[]>([]);
  const [disabledSkillKeys, setDisabledSkillKeys] = useState<string[]>([]);
  const [agentProfileSaving, setAgentProfileSaving] = useState(false);
  const [licenseTier, setLicenseTier] = useState<LicenseTier>(() => getLicenseTier());
  const [licenseStatus, setLicenseStatus] = useState<Awaited<ReturnType<typeof getLicenseStatus>> | null>(null);
  const [licenseKeyInput, setLicenseKeyInput] = useState('');
  const [licenseActivating, setLicenseActivating] = useState(false);
  const tierCapabilities = getTierCapabilities(licenseTier);
  const [evolutionEngineKind, setEvolutionEngineKind] = useState<string>('noop');
  const [evolutionGatedAllowed, setEvolutionGatedAllowed] = useState<boolean>(false);
  const [evolutionIdleAllowed, setEvolutionIdleAllowed] = useState<boolean>(false);
  const [evolutionTitle, setEvolutionTitle] = useState<string>(() => {
    try {
      return getStorageItem(EVOLUTION_TITLE_KEY) || EVOLUTION_DEFAULT_TITLE;
    } catch {
      return EVOLUTION_DEFAULT_TITLE;
    }
  });
  const [evolutionMotivation, setEvolutionMotivation] = useState<string>(() => {
    try {
      return getStorageItem(EVOLUTION_MOTIVATION_KEY) || EVOLUTION_DEFAULT_MOTIVATION;
    } catch {
      return EVOLUTION_DEFAULT_MOTIVATION;
    }
  });
  const [evolutionPlan, setEvolutionPlan] = useState<string>(() => {
    try {
      return getStorageItem(EVOLUTION_PLAN_KEY) || EVOLUTION_DEFAULT_PLAN;
    } catch {
      return EVOLUTION_DEFAULT_PLAN;
    }
  });
  const [evolutionTarget, setEvolutionTarget] = useState<string>(() => {
    try {
      const v = (getStorageItem(EVOLUTION_TARGET_KEY) || EVOLUTION_DEFAULT_TARGET).trim();
      return v || EVOLUTION_DEFAULT_TARGET;
    } catch {
      return EVOLUTION_DEFAULT_TARGET;
    }
  });
  const [evolutionReviewAutoSend, setEvolutionReviewAutoSend] = useState<boolean>(() => {
    try {
      return getStorageItem(EVOLUTION_REVIEW_AUTOSEND_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [evolutionRunning, setEvolutionRunning] = useState<boolean>(false);
  const [evolutionLastResult, setEvolutionLastResult] = useState<EvolutionRunResponse | null>(null);
  const [plugins, setPlugins] = useState<PluginListItem[]>([]);
  const [pluginsTier, setPluginsTier] = useState<string>('free');
  const [pluginsMaxAllowed, setPluginsMaxAllowed] = useState<number>(0);
  const [pluginsInstalledCount, setPluginsInstalledCount] = useState<number>(0);
  const [pluginsLoading, setPluginsLoading] = useState(false);
  const [pluginActionName, setPluginActionName] = useState<string>('');
  const [pluginDetailName, setPluginDetailName] = useState<string>('');
  const [cloudQuotaLimit, setCloudQuotaLimit] = useState<number>(0);
  const [cloudQuotaUsed, setCloudQuotaUsed] = useState<number>(0);
  const [autonomousQuotaLimit, setAutonomousQuotaLimit] = useState<number>(0);
  const [autonomousQuotaUsed, setAutonomousQuotaUsed] = useState<number>(0);
  const [pluginFilter, setPluginFilter] = useState<'all' | 'installed' | 'installable'>(() => {
    try {
      const v = (getStorageItem(PLUGIN_FILTER_KEY) || 'all').trim();
      return (v === 'installed' || v === 'installable') ? v : 'all';
    } catch {
      return 'all';
    }
  });
  const [pluginSearch, setPluginSearch] = useState<string>(() => {
    try {
      return getStorageItem(PLUGIN_SEARCH_KEY) || '';
    } catch {
      return '';
    }
  });
  const [roles, setRoles] = useState<RoleDefinition[]>([]);
  const [roleActivating, setRoleActivating] = useState(false);
  const [scopedActiveRoleId, setScopedActiveRoleId] = useState<string>(() => getScopedActiveRoleIdFromStorage());
  const [networkNodes, setNetworkNodes] = useState<{ node_id: string; base_url: string; name?: string }[]>([]);
  const [modelList, setModelList] = useState<Array<{
    id: string;
    name: string;
    provider?: string;
    tier?: string;
    url?: string;
    api_key_env?: string;
    has_api_key?: boolean;
    context_length?: number;
    config?: Record<string, any>;
    available?: boolean;
    enabled?: boolean;
  }>>([]);
  const [modelTestLoadingId, setModelTestLoadingId] = useState<string | null>(null);
  const [editingModel, setEditingModel] = useState<{ id: string; field: 'name' | 'endpoint'; value: string } | null>(null);
  const [capabilityModels, setCapabilityModels] = useState<{
    embedding?: { id?: string | null; enabled?: boolean; available?: boolean; provider_ready?: boolean; base_url?: string | null };
    rerank?: { id?: string | null; enabled?: boolean; available?: boolean; provider_ready?: boolean; base_url?: string | null };
  }>({});
  const [subagentModel, setSubagentModel] = useState<string>('same_as_main');
  const [subagentModelMapping, setSubagentModelMapping] = useState<Record<string, string>>({});
  const [modelDraft, setModelDraft] = useState<{
    endpoint_url: string;
    context_length: string;
    temperature: string;
    top_p: string;
    min_p: string;
    presence_penalty: string;
    max_tokens_default: string;
    max_tokens_analysis: string;
    max_tokens_doc: string;
    max_tokens_fast: string;
    enable_thinking: boolean;
    parallel_tool_calls: boolean;
    enable_endpoint_discovery: boolean;
    api_key_env: string;
  }>({
    endpoint_url: '',
    context_length: '',
    temperature: '',
    top_p: '',
    min_p: '',
    presence_penalty: '',
    max_tokens_default: '',
    max_tokens_analysis: '',
    max_tokens_doc: '',
    max_tokens_fast: '',
    enable_thinking: true,
    parallel_tool_calls: true,
    enable_endpoint_discovery: false,
    api_key_env: '',
  });
  const [modelLoading, setModelLoading] = useState(false);
  const [showAddModel, setShowAddModel] = useState(false);
  const [newModelForm, setNewModelForm] = useState({ id: '', name: '', provider: 'openai', url: '', api_key_env: '', tier: 'local' as 'local' | 'cloud' });
  const [showCreateSkillModal, setShowCreateSkillModal] = useState(false);
  const [newSkillForm, setNewSkillForm] = useState({ name: '', domain: 'general', description: '' });
  const [configFiles, setConfigFiles] = useState<Array<{ key: string; path: string; exists: boolean; size?: number; updated_at?: string | null }>>([]);
  const [configLoading, setConfigLoading] = useState(false);
  const [cloudEndpoints, setCloudEndpoints] = useState<Array<{ base_url: string; api_key_env: string }>>([]);
  const [endpointsWithModels, setEndpointsWithModels] = useState<Array<{ base_url: string; api_key_env: string; has_key: boolean; model_ids: string[] }>>([]);
  const endpointMetaByBaseUrl = useMemo(() => {
    const norm = (s: string) => (s || '').trim().replace(/\/+$/, '');
    const map = new Map<string, { has_key: boolean; model_ids: string[] }>();
    endpointsWithModels.forEach((ewm) => {
      map.set(norm(ewm.base_url), { has_key: ewm.has_key, model_ids: ewm.model_ids || [] });
    });
    return map;
  }, [endpointsWithModels]);
  const [cloudEndpointsLoading, setCloudEndpointsLoading] = useState(false);
  const [cloudEndpointsAuthError, setCloudEndpointsAuthError] = useState(false);
  const [cloudRefreshLoading, setCloudRefreshLoading] = useState(false);
  const [showAddCloudEndpoint, setShowAddCloudEndpoint] = useState(false);
  const [newCloudEndpoint, setNewCloudEndpoint] = useState({ base_url: '', api_key_env: '' });
  const [editingCloudEndpointIndex, setEditingCloudEndpointIndex] = useState<number | null>(null);
  const [editingCloudEndpointDraft, setEditingCloudEndpointDraft] = useState({ base_url: '', api_key_env: '' });

  useEffect(() => {
    const syncScopedRole = () => setScopedActiveRoleId(getScopedActiveRoleIdFromStorage());
    syncScopedRole();
    window.addEventListener('storage', syncScopedRole);
    window.addEventListener(EVENTS.SESSION_CHANGED, syncScopedRole as EventListener);
    window.addEventListener(EVENTS.ROLE_CHANGED, syncScopedRole);
    window.addEventListener(EVENTS.COMPOSER_PREFS_CHANGED, syncScopedRole);
    return () => {
      window.removeEventListener('storage', syncScopedRole);
      window.removeEventListener(EVENTS.SESSION_CHANGED, syncScopedRole as EventListener);
      window.removeEventListener(EVENTS.ROLE_CHANGED, syncScopedRole);
      window.removeEventListener(EVENTS.COMPOSER_PREFS_CHANGED, syncScopedRole);
    };
  }, []);
  const [configEditorOpen, setConfigEditorOpen] = useState(false);
  const [configSelectedKey, setConfigSelectedKey] = useState('');
  const [configContent, setConfigContent] = useState('');
  const [configSaving, setConfigSaving] = useState(false);
  const [persona, setPersona] = useState<PersonaConfig>({
    name: 'MAIBOT',
    tone: 'professional',
    relationship: 'assistant',
    language: 'zh-CN',
    communication_style: 'concise',
    empathy: 'balanced',
    preference_focus: 'task_first',
  });
  const [personaSaving, setPersonaSaving] = useState(false);
  const [userProfile, setUserProfile] = useState<Pick<UserProfileDto, 'expertise_areas' | 'custom_rules' | 'communication_style' | 'detail_level' | 'domain_expertise' | 'learning_trajectory'>>({
    expertise_areas: {},
    custom_rules: [],
    communication_style: '',
    detail_level: '',
    domain_expertise: '',
    learning_trajectory: [],
  });
  const [userProfileSaving, setUserProfileSaving] = useState(false);
  const { userId } = useUserContext();

  useEffect(() => {
    if (section !== 'connection') return;
    try {
      setProjectFolder(getCurrentWorkspacePathFromStorage() || '');
    } catch {
      // 无存储环境（如 SSR）
    }
  }, [section]);

  // 工作区切换：先调后端 /workspace/switch（含 path 为空表示清空），成功后再写本地并派发事件，失败时 toast 并保持原工作区
  const doSwitchWorkspace = useCallback(async (path: string) => {
    try {
      const resp = await fetch(`${getApiBase()}/workspace/switch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: path || '' }),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(text || `HTTP ${resp.status}`);
      }
      if (path) {
        setStorageItem('maibot_workspace_path', path);
        setProjectFolder(path);
        window.dispatchEvent(new CustomEvent(EVENTS.WORKSPACE_CONTEXT_CHANGED, { detail: { workspacePath: path } }));
        toast.success(t('settings.workspaceFolderSaved'));
      } else {
        removeStorageItem('maibot_workspace_path');
        setProjectFolder('');
        window.dispatchEvent(new CustomEvent(EVENTS.WORKSPACE_CONTEXT_CHANGED, { detail: { workspacePath: '' } }));
        toast.success(t('settings.cleared'));
      }
    } catch (err) {
      toast.error(t('settings.workspaceSwitchFailed', { msg: err instanceof Error ? err.message : 'unknown error' }));
      setPendingWorkspacePath(null);
      return;
    } finally {
      setPendingWorkspacePath(null);
    }
  }, []);

  useEffect(() => {
    const sync = () => {
      try {
        setLicenseTier(getLicenseTier());
      } catch {
        setLicenseTier('free');
      }
    };
    sync();
    window.addEventListener('storage', sync);
    window.addEventListener(EVENTS.COMPOSER_PREFS_CHANGED, sync);
    window.addEventListener(EVENTS.LICENSE_TIER_CHANGED, sync);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener(EVENTS.COMPOSER_PREFS_CHANGED, sync);
      window.removeEventListener(EVENTS.LICENSE_TIER_CHANGED, sync);
    };
  }, []);

  const loadModels = async () => {
    setModelLoading(true);
    try {
      const data = await modelsApi.list();
      if (data.ok && Array.isArray(data.models)) {
        setModelList(data.models.map((m: any) => ({
          id: m.id,
          name: m.name || m.id,
          provider: m.provider,
          tier: m.tier,
          url: m.url,
          api_key_env: m.api_key_env,
          has_api_key: Boolean(m.has_api_key),
          context_length: Number(m.context_length || 0) || undefined,
          config: (m.config && typeof m.config === 'object') ? m.config : undefined,
          available: Boolean(m.available),
          enabled: m.id === 'auto' ? true : Boolean(m.enabled !== false),
        })));
        setCapabilityModels(data.capability_models ?? {});
        setSubagentModel(typeof data.subagent_model === 'string' ? data.subagent_model : 'same_as_main');
        setSubagentModelMapping(typeof data.subagent_model_mapping === 'object' && data.subagent_model_mapping != null ? data.subagent_model_mapping : {});
        // 无本地默认时用后端 default_model 初始化，实现后端配置驱动
        const hadNoStoredDefault = !getStorageItem('maibot_settings_defaultModel');
        if (data.models.length > 0 && data.default_model && data.models.some((m: any) => m.id === data.default_model) && hadNoStoredDefault) {
          setDefaultModel(data.default_model);
          setStorageItem('maibot_selected_model', data.default_model);
          setStorageItem('maibot_settings_defaultModel', data.default_model);
        }
        // 如果当前选中的模型不在列表中，提示并自动选择第一个，同步存储与后端（若上一步已用后端默认初始化则跳过）
        const effectiveDefault = hadNoStoredDefault && data.default_model && data.models.some((m: any) => m.id === data.default_model) ? data.default_model : defaultModel;
        if (data.models.length > 0 && !data.models.some((m: any) => m.id === effectiveDefault)) {
          const fallbackId = data.models[0].id;
          const fallbackName = (data.models[0].name || data.models[0].id) as string;
          toast.info(t('settings.defaultModelNotInList', { name: fallbackName }));
          setDefaultModel(fallbackId);
          setStorageItem('maibot_selected_model', fallbackId);
          setStorageItem('maibot_settings_defaultModel', fallbackId);
          window.dispatchEvent(new CustomEvent(EVENTS.COMPOSER_PREFS_CHANGED));
          try {
            await modelsApi.switch(fallbackId);
            window.dispatchEvent(new CustomEvent('model_changed', { detail: { modelId: fallbackId } }));
          } catch {
            toast.error(t('settings.syncDefaultModelFailed'), { description: t('settings.syncDefaultModelFailedDesc') });
          }
        }
      } else {
        setModelList([]);
        setDefaultModel('__no_models__');
      }
    } catch {
      toast.error(t('settings.loadModelsFailed'));
      setModelList([]);
      setDefaultModel('__no_models__');
    } finally {
      setModelLoading(false);
    }
  };

  const loadCloudEndpoints = async () => {
    setCloudEndpointsLoading(true);
    setCloudEndpointsAuthError(false);
    try {
      const data = await modelsApi.getCloudEndpoints();
      if (data.ok && Array.isArray(data.cloud_endpoints)) setCloudEndpoints(data.cloud_endpoints);
      if (data.ok && Array.isArray(data.endpoints_with_models)) setEndpointsWithModels(data.endpoints_with_models);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isAuthError = /401|unauthorized|internal token|invalid or missing/i.test(msg);
      if (isAuthError) {
        setCloudEndpointsAuthError(true);
        if (import.meta.env?.DEV) console.warn('[SettingsView] 云端端点鉴权失败，请确保后端 INTERNAL_API_TOKEN 与前端 VITE_INTERNAL_API_TOKEN（或 VITE_LOCAL_AGENT_TOKEN）一致:', msg);
      }
    } finally {
      setCloudEndpointsLoading(false);
    }
  };

  const confirmCloudModelSwitch = (modelId: string): boolean => {
    const model = modelList.find((m) => m.id === modelId);
    if (!model) return true;
    if (!isCloudDiscoveredModel(model)) return true;
    if (getStorageItem(CLOUD_CONSENT_KEY) === 'true') return true;
    try {
      const raw = getStorageItem('maibot_cloud_model_consented');
      const arr = raw ? JSON.parse(raw) : [];
      if (Array.isArray(arr) && arr.length > 0) return true;
    } catch {
      // ignore
    }
    if (getStorageItem('maibot_allow_cloud_without_confirm') === 'true') {
      setStorageItem(CLOUD_CONSENT_KEY, 'true');
      try {
        const raw = getStorageItem('maibot_cloud_model_consented');
        const arr = raw ? JSON.parse(raw) : [];
        const next = Array.isArray(arr) ? Array.from(new Set([...arr.filter((x: unknown) => typeof x === 'string'), modelId])) : [modelId];
        setStorageItem('maibot_cloud_model_consented', JSON.stringify(next));
      } catch {
        setStorageItem('maibot_cloud_model_consented', JSON.stringify([modelId]));
      }
      return true;
    }
    setCloudConsentPending({ modelId });
    return false;
  };

  const performCloudConsentAndSwitch = async () => {
    const modelId = cloudConsentPending?.modelId;
    setCloudConsentPending(null);
    if (!modelId) return;
    setStorageItem(CLOUD_CONSENT_KEY, 'true');
    try {
      const raw = getStorageItem('maibot_cloud_model_consented');
      const arr = raw ? JSON.parse(raw) : [];
      const next = Array.isArray(arr) ? Array.from(new Set([...arr.filter((x: unknown) => typeof x === 'string'), modelId])) : [modelId];
      setStorageItem('maibot_cloud_model_consented', JSON.stringify(next));
    } catch {
      setStorageItem('maibot_cloud_model_consented', JSON.stringify([modelId]));
    }
    setDefaultModel(modelId);
    setStorageItem('maibot_selected_model', modelId);
    window.dispatchEvent(new CustomEvent(EVENTS.COMPOSER_PREFS_CHANGED));
    try {
      await modelsApi.switch(modelId);
      window.dispatchEvent(new CustomEvent('model_changed', { detail: { modelId } }));
    } catch {
      toast.error(t('settings.syncDefaultModelFailed'), { description: t('settings.syncDefaultModelFailedDesc') });
    }
  };

  useEffect(() => {
    const selected = modelList.find((m) => m.id === defaultModel);
    if (!selected) {
      setModelDraft({
        endpoint_url: '',
        context_length: '',
        temperature: '',
        top_p: '',
        min_p: '',
        presence_penalty: '',
        max_tokens_default: '',
        max_tokens_analysis: '',
        max_tokens_doc: '',
        max_tokens_fast: '',
        enable_thinking: true,
        parallel_tool_calls: true,
        enable_endpoint_discovery: false,
        api_key_env: '',
      });
      return;
    }
    setModelDraft({
      endpoint_url: selected.url || '',
      context_length: selected.context_length ? String(selected.context_length) : '',
      temperature: selected.config?.temperature != null ? String(selected.config.temperature) : '',
      top_p: selected.config?.top_p != null ? String(selected.config.top_p) : '',
      min_p: selected.config?.min_p != null ? String(selected.config.min_p) : '',
      presence_penalty: selected.config?.presence_penalty != null ? String(selected.config.presence_penalty) : '',
      max_tokens_default: selected.config?.max_tokens_default != null ? String(selected.config.max_tokens_default) : '',
      max_tokens_analysis: selected.config?.max_tokens_analysis != null ? String(selected.config.max_tokens_analysis) : '',
      max_tokens_doc: selected.config?.max_tokens_doc != null ? String(selected.config.max_tokens_doc) : '',
      max_tokens_fast: selected.config?.max_tokens_fast != null ? String(selected.config.max_tokens_fast) : '',
      enable_thinking: selected.config?.enable_thinking != null ? Boolean(selected.config.enable_thinking) : true,
      parallel_tool_calls: selected.config?.parallel_tool_calls != null ? Boolean(selected.config.parallel_tool_calls) : true,
      enable_endpoint_discovery: selected.config?.enable_endpoint_discovery != null ? Boolean(selected.config.enable_endpoint_discovery) : false,
      api_key_env: selected.api_key_env || '',
    });
  }, [defaultModel, modelList]);

  const selectedDefaultModel = useMemo(() => modelList.find((m) => m.id === defaultModel), [modelList, defaultModel]);
  const isDefaultModelCloudReadOnly = isCloudDiscoveredModel(selectedDefaultModel);

  // 从后端加载模型列表与云端端点（常规与模型页共用）
  useEffect(() => {
    if (section === 'general' || section === 'models') {
      void loadModels();
      void loadCloudEndpoints();
    } else {
      setShowAddCloudEndpoint(false);
      setEditingCloudEndpointIndex(null);
      setNewCloudEndpoint({ base_url: '', api_key_env: '' });
    }
  }, [section]);

  // 深色模式 / 跟随系统外观 即时应用到 DOM
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (autoDetectColorScheme) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const apply = () => document.documentElement.classList.toggle('dark', mq.matches);
      apply();
      mq.addEventListener('change', apply);
      return () => mq.removeEventListener('change', apply);
    }
    document.documentElement.classList.toggle('dark', isDarkMode);
  }, [autoDetectColorScheme, isDarkMode]);

  // 主题色：从 localStorage 恢复并应用到 DOM；切换深色模式时重新应用以使用对应调色板
  useEffect(() => {
    applyThemeAccent(themeAccent);
  }, [themeAccent, isDarkMode]);

  const loadThreads = useCallback(async (getCancelled?: () => boolean) => {
    setLoading(true);
    setLoadErrorSection(null);
    try {
      const list = await listThreads({ limit: 100 });
      if (getCancelled?.()) return;
      setThreads(list);
      setThreadCount(list.length);
    } catch (e) {
      if (getCancelled?.()) return;
      setLoadErrorSection('threads');
      setThreads([]);
      console.error('加载对话列表失败:', e);
      toast.error(t('settings.loadDataFailed'));
    } finally {
      if (!getCancelled?.()) setLoading(false);
    }
  }, []);

  const loadWorkspaces = useCallback(async (getCancelled?: () => boolean) => {
    setLoading(true);
    setLoadErrorSection(null);
    try {
      const recent = workspaceService.getRecentWorkspaces();
      setRecentWorkspaces(recent);
      const all = await workspaceAPI.listWorkspaces();
      if (getCancelled?.()) return;
      setWorkspaceCount(all.length);
    } catch (e) {
      if (getCancelled?.()) return;
      setLoadErrorSection('workspaces');
      console.error('加载工作区失败:', e);
      toast.error(t('settings.loadDataFailed'));
    } finally {
      if (!getCancelled?.()) setLoading(false);
    }
  }, []);

  const loadMemories = useCallback(async (getCancelled?: () => boolean) => {
    if (!userId) return;
    setLoading(true);
    setLoadErrorSection(null);
    try {
      const m = await getUserMemories(userId);
      if (getCancelled?.()) return;
      const list = Array.isArray(m) ? m : (m && typeof m === 'object' && 'items' in m ? (m as { items: any[] }).items : []);
      setMemories(list);
    } catch (e) {
      if (getCancelled?.()) return;
      setLoadErrorSection('memories');
      setMemories([]);
      console.error('加载记忆失败:', e);
      toast.error(t('settings.loadDataFailed'));
    } finally {
      if (!getCancelled?.()) setLoading(false);
    }
  }, [userId]);

  const loadConnection = useCallback(async (getCancelled?: () => boolean) => {
    setLoading(true);
    setLoadErrorSection(null);
    try {
      const res: HealthStatus = await checkHealth(true);
      if (getCancelled?.()) return;
      setHealthStatus(res?.healthy ? 'healthy' : 'unhealthy');
    } catch (e) {
      if (getCancelled?.()) return;
      setLoadErrorSection('connection');
      console.error('连接检查失败:', e);
      toast.error(t('settings.loadDataFailed'));
    } finally {
      if (!getCancelled?.()) setLoading(false);
    }
  }, []);

  const loadNetwork = useCallback(async (getCancelled?: () => boolean) => {
    setLoading(true);
    setLoadErrorSection(null);
    try {
      const res = await fetch(`${getApiBase()}/network/nodes`);
      if (getCancelled?.()) return;
      if (!res.ok) {
        setNetworkNodes([]);
        setLoadErrorSection('network');
        toast.error(t('settings.loadNetworkNodesFailed'));
        return;
      }
      const data = await res.json().catch(() => ({ __parseError: true } as const));
      if (getCancelled?.()) return;
      if ((data as { __parseError?: boolean })?.__parseError) {
        setNetworkNodes([]);
        setLoadErrorSection('network');
        toast.error(t("composer.responseParseFailed"));
        return;
      }
      if (data?.ok && Array.isArray(data.nodes)) {
        const raw = data.nodes as unknown[];
        const valid = raw.filter((n): n is { node_id: string; base_url: string; name?: string } =>
          n != null && typeof n === 'object' && typeof (n as Record<string, unknown>).node_id === 'string' && typeof (n as Record<string, unknown>).base_url === 'string'
        ).map((n) => ({ node_id: n.node_id, base_url: n.base_url, name: n.name }));
        setNetworkNodes(valid);
      } else setNetworkNodes([]);
    } catch {
      if (getCancelled?.()) return;
      setNetworkNodes([]);
      setLoadErrorSection('network');
      toast.error(t('settings.loadNetworkNodesFailed'));
    } finally {
      if (!getCancelled?.()) setLoading(false);
    }
  }, []);

  const loadExtensions = useCallback(async (getCancelled?: () => boolean) => {
    setPluginsLoading(true);
    setLoadErrorSection(null);
    try {
      const [pluginsRes, licenseRes] = await Promise.all([listPlugins(), getLicenseStatus()]);
      if (getCancelled?.()) return;
      if (pluginsRes.ok) {
        setPlugins(Array.isArray(pluginsRes.plugins) ? pluginsRes.plugins : []);
        setPluginsTier(String(pluginsRes.tier || 'free'));
        setPluginsMaxAllowed(Number(pluginsRes.limits?.max_plugins ?? 0));
        setPluginsInstalledCount(Number(pluginsRes.usage?.installed_plugins ?? 0));
      } else {
        setPlugins([]);
        setPluginsMaxAllowed(0);
        setPluginsInstalledCount(0);
        setLoadErrorSection('extensions');
        toast.error(t('settings.loadPluginsFailed'), { description: pluginsRes.error || t('settings.pleaseRetry') });
      }
      if (licenseRes.ok) {
        setCloudQuotaLimit(Number(licenseRes.limits?.cloud_model_requests_daily ?? 0));
        setCloudQuotaUsed(Number(licenseRes.usage?.cloud_model_requests_today ?? 0));
        setAutonomousQuotaLimit(Number(licenseRes.limits?.max_daily_autonomous_tasks ?? 0));
        setAutonomousQuotaUsed(Number(licenseRes.usage?.autonomous_tasks_today ?? 0));
      }
    } catch (e) {
      if (getCancelled?.()) return;
      setLoadErrorSection('extensions');
      toast.error(t('settings.loadDataFailed'));
    } finally {
      if (!getCancelled?.()) setPluginsLoading(false);
    }
  }, []);

  const loadAgentProfile = useCallback(async (getCancelled?: () => boolean) => {
    setLoading(true);
    setLoadErrorSection(null);
    try {
      const wsId = getCurrentWorkspacePathFromStorage() || undefined;
      const [profileRes, skillsRes, disabledRes, rolesRes, personaRes, evolutionRes, userModelRes, licenseRes] = await Promise.all([
        boardApi.getAgentProfile(),
        skillsAPI.getAllSkills(),
        skillsAPI.getDisabledSkills(),
        rolesApi.listRoles(),
        personaApi.get().catch(() => ({ ok: false, persona: {} })),
        getEvolutionStatus(),
        userModelApi.get(wsId).catch(() => ({ ok: false, profile: null })),
        getLicenseStatus(),
      ]);
      if (getCancelled?.()) return;
      setLicenseStatus(licenseRes);
      if (profileRes.ok && profileRes.profile) setAgentProfile(profileRes.profile);
      else setAgentProfile(null);
      if (skillsRes.ok && skillsRes.skills) setAgentProfileSkills(skillsRes.skills);
      else setAgentProfileSkills([]);
      if (disabledRes.ok && Array.isArray(disabledRes.disabled)) setDisabledSkillKeys(disabledRes.disabled);
      else setDisabledSkillKeys([]);
      if (rolesRes.ok && rolesRes.roles) setRoles(rolesRes.roles);
      else setRoles([]);
      if (personaRes.ok && personaRes.persona) setPersona(personaRes.persona);
      if (evolutionRes.ok) {
        setEvolutionEngineKind(String(evolutionRes.engine_kind || 'noop'));
        setEvolutionGatedAllowed(Boolean(evolutionRes.status?.allow_gated_code_changes));
        setEvolutionIdleAllowed(Boolean(evolutionRes.status?.allow_idle_loop));
      }
      if (userModelRes.ok && userModelRes.profile) {
        const p = userModelRes.profile;
        setUserProfile({
          expertise_areas: p.expertise_areas ?? {},
          custom_rules: p.custom_rules ?? [],
          communication_style: p.communication_style ?? '',
          detail_level: p.detail_level ?? '',
          domain_expertise: p.domain_expertise ?? '',
          learning_trajectory: p.learning_trajectory ?? [],
        });
      } else {
        setUserProfile({ expertise_areas: {}, custom_rules: [], communication_style: '', detail_level: '', domain_expertise: '', learning_trajectory: [] });
      }
    } catch (e) {
      if (getCancelled?.()) return;
      setLoadErrorSection('agent_profile');
      console.error('加载 Agent 档案失败:', e);
      toast.error(t('settings.loadDataFailed'));
    } finally {
      if (!getCancelled?.()) setLoading(false);
    }
  }, []);

  const loadAdvanced = useCallback(async (getCancelled?: () => boolean) => {
    setConfigLoading(true);
    setLoadErrorSection(null);
    try {
      const res = await configApi.list();
      if (getCancelled?.()) return;
      setConfigFiles(Array.isArray(res.files) ? res.files : []);
    } catch (e) {
      if (getCancelled?.()) return;
      setConfigFiles([]);
      setLoadErrorSection('advanced');
      toast.error(t('settings.loadConfigFailed'), { description: e instanceof Error ? e.message : String(e) });
    } finally {
      if (!getCancelled?.()) setConfigLoading(false);
    }
  }, []);

  const loadDataForSection = useCallback((s: SettingsSectionId) => {
    if (s === 'threads') void loadThreads();
    else if (s === 'workspaces') void loadWorkspaces();
    else if (s === 'memories' && userId) void loadMemories();
    else if (s === 'connection') void loadConnection();
    else if (s === 'network') void loadNetwork();
    else if (s === 'extensions') void loadExtensions();
    else if (s === 'agent_profile') void loadAgentProfile();
    else if (s === 'advanced') void loadAdvanced();
  }, [userId, loadThreads, loadWorkspaces, loadMemories, loadConnection, loadNetwork, loadExtensions, loadAgentProfile, loadAdvanced]);

  useEffect(() => {
    if (section === 'threads') {
      let cancelled = false;
      loadThreads(() => cancelled);
      return () => { cancelled = true; };
    }
    if (section === 'workspaces') {
      let cancelled = false;
      loadWorkspaces(() => cancelled);
      return () => { cancelled = true; };
    }
    if (section === 'memories' && userId) {
      let cancelled = false;
      loadMemories(() => cancelled);
      return () => { cancelled = true; };
    }
    if (section === 'connection') {
      let cancelled = false;
      loadConnection(() => cancelled);
      return () => { cancelled = true; };
    }
    if (section === 'network') {
      let cancelled = false;
      loadNetwork(() => cancelled);
      return () => { cancelled = true; };
    }
    if (section === 'extensions') {
      let cancelled = false;
      loadExtensions(() => cancelled);
      return () => { cancelled = true; };
    }
    if (section === 'agent_profile') {
      let cancelled = false;
      loadAgentProfile(() => cancelled);
      return () => { cancelled = true; };
    }
    if (section === 'advanced') {
      let cancelled = false;
      loadAdvanced(() => cancelled);
      return () => { cancelled = true; };
    }
  }, [section, userId, loadThreads, loadWorkspaces, loadMemories, loadConnection, loadNetwork, loadExtensions, loadAgentProfile, loadAdvanced]);

  const handleInstallPlugin = async (name: string) => {
    const target = String(name || '').trim();
    if (!target) return;
    const targetPlugin = plugins.find((p) => p.name === target);
    if (targetPlugin && !targetPlugin.eligible) {
      toast.error(t('settings.licenseNoInstallPlugin'), {
        description: `需要 ${targetPlugin.requires_tier || 'free'} 版本`,
        action: {
          label: t('settings.upgradeLicense'),
          onClick: () => setSection('agent_profile'),
        },
      });
      return;
    }
    if (pluginsMaxAllowed >= 0 && pluginsInstalledCount >= pluginsMaxAllowed && pluginsMaxAllowed !== 0) {
      toast.error(t('settings.pluginLimitReached'), {
        description: `当前最多可安装 ${pluginsMaxAllowed} 个插件`,
        action: {
          label: t('settings.upgradeLicense'),
          onClick: () => setSection('agent_profile'),
        },
      });
      return;
    }
    try {
      setPluginActionName(target);
      const res = await installPlugin(target);
      if (!res.ok) {
        toast.error(t('settings.installPluginFailed'), { description: res.error || t('settings.pleaseRetry') });
        return;
      }
      toast.success(t('settings.pluginInstalled', { name: target }));
      await loadExtensions();
    } finally {
      setPluginActionName('');
    }
  };

  const handleUninstallPlugin = async (name: string) => {
    const target = String(name || '').trim();
    if (!target) return;
    try {
      setPluginActionName(target);
      const res = await uninstallPlugin(target);
      if (!res.ok) {
        toast.error(t('settings.uninstallPluginFailed'), { description: res.error || t('settings.pleaseRetry') });
        return;
      }
      toast.success(t('settings.pluginUninstalled', { name: target }));
      await loadExtensions();
    } finally {
      setPluginActionName('');
    }
  };

  const handleCreateEvolutionProposal = async () => {
    const title = evolutionTitle.trim();
    const motivation = evolutionMotivation.trim();
    const plan = evolutionPlan.trim();
    if (!title || !motivation || !plan) {
      toast.error(t('settings.evolution.fillRequired'));
      return;
    }
    try {
      setEvolutionRunning(true);
      const res = await createEvolutionProposal({
        title,
        motivation,
        plan,
        target: evolutionTarget,
      });
      setEvolutionLastResult(res);
      if (!res.ok) {
        toast.error(t('settings.evolution.createFailed'), { description: res.error || t('settings.pleaseRetry') });
        return;
      }
      toast.success(t('settings.evolution.created'), { description: res.proposal_path || undefined });
    } finally {
      setEvolutionRunning(false);
    }
  };

  const handleRunEvolutionPipeline = async () => {
    const title = evolutionTitle.trim();
    const motivation = evolutionMotivation.trim();
    const plan = evolutionPlan.trim();
    if (!title || !motivation || !plan) {
      toast.error(t('settings.evolution.fillRequired'));
      return;
    }
    try {
      setEvolutionRunning(true);
      const res = await runEvolutionPipeline({
        title,
        motivation,
        plan,
        target: evolutionTarget,
      });
      setEvolutionLastResult(res);
      if (!res.ok) {
        toast.error(t('settings.evolution.pipelineFailed'), { description: res.error || t('settings.pleaseRetry') });
        return;
      }
      const ok = Boolean(res.result?.ok);
      toast[ok ? 'success' : 'warning'](ok ? t('settings.evolution.pipelineDone') : t('settings.evolution.pipelineDoneWithWarnings'));
    } finally {
      setEvolutionRunning(false);
    }
  };

  const handleOpenEvolutionProposal = async () => {
    const path = String(
      evolutionLastResult?.proposal_path
      || evolutionLastResult?.result?.proposal_path
      || ''
    ).trim();
    if (!path) {
      toast.error(t("settings.noProposalPathToOpen"));
      return;
    }
    try {
      fileEventBus.openFile(path);
      toast.success(t('settings.evolution.proposalOpened'));
    } catch (e) {
      toast.error(t('settings.evolution.openProposalFailed'), { description: e instanceof Error ? e.message : String(e) });
    }
  };

  const handleCopyEvolutionProposalPath = async () => {
    const path = String(
      evolutionLastResult?.proposal_path
      || evolutionLastResult?.result?.proposal_path
      || ''
    ).trim();
    if (!path) {
      toast.error(t("settings.noProposalPathToCopy"));
      return;
    }
    try {
      await navigator.clipboard.writeText(path);
      toast.success(t('settings.evolution.pathCopied'));
    } catch (e) {
      toast.error(t('settings.evolution.copyPathFailed'), { description: e instanceof Error ? e.message : String(e) });
    }
  };

  const handleSendEvolutionForReview = () => {
    const proposalPath = String(
      evolutionLastResult?.proposal_path
      || evolutionLastResult?.result?.proposal_path
      || ''
    ).trim();
    const stageSummary = (evolutionLastResult?.result?.stages ?? [])
      .map((s) => `${s.stage}:${s.ok ? 'ok' : 'fail'}`)
      .join(' | ');
    const targetDescription = EVOLUTION_TARGET_DESCRIPTIONS[evolutionTarget] ?? '';
    const prompt = [
      '请对这份进化提案做结构化审阅，并给出可执行改进建议：',
      proposalPath ? `- 提案路径: ${proposalPath}` : '- 提案路径: （未返回）',
      `- 目标域: ${evolutionTarget}`,
      targetDescription ? `- 目标域说明: ${targetDescription}` : '',
      stageSummary ? `- 最近流水线状态: ${stageSummary}` : '',
      '',
      '请输出：',
      '1) 风险点（按高/中/低）',
      '2) 需要补充的测试清单',
      '3) 是否建议进入 commit 阶段（是/否 + 理由）',
    ]
      .filter(Boolean)
      .join('\n');

    window.dispatchEvent(new CustomEvent(EVENTS.OPEN_CHAT_PANEL));
    const threadId = getCurrentThreadIdFromStorage();
    window.dispatchEvent(new CustomEvent(EVENTS.FILL_PROMPT, { detail: { prompt, autoSend: evolutionReviewAutoSend, threadId: threadId || undefined } }));
    toast.success(evolutionReviewAutoSend ? t('settings.evolution.reviewSent') : t('settings.evolution.reviewFilled'));
  };

  const handleResetEvolutionDraft = () => {
    setEvolutionTarget(EVOLUTION_DEFAULT_TARGET);
    setEvolutionTitle(EVOLUTION_DEFAULT_TITLE);
    setEvolutionMotivation(EVOLUTION_DEFAULT_MOTIVATION);
    setEvolutionPlan(EVOLUTION_DEFAULT_PLAN);
    toast.success(t('settings.evolution.templateRestored'));
  };

  const handleClearEvolutionDraft = () => {
    setEvolutionTitle('');
    setEvolutionMotivation('');
    setEvolutionPlan('');
    toast.success(t('settings.evolution.draftCleared'));
  };

  const evolutionDraftReady =
    evolutionTitle.trim().length > 0 &&
    evolutionMotivation.trim().length > 0 &&
    evolutionPlan.trim().length > 0;
  const evolutionTitleValid = evolutionTitle.trim().length > 0;
  const evolutionMotivationValid = evolutionMotivation.trim().length > 0;
  const evolutionPlanValid = evolutionPlan.trim().length > 0;
  const evolutionTargetDescription =
    EVOLUTION_TARGET_DESCRIPTIONS[evolutionTarget] ?? '请选择与你本次进化目标最匹配的域。';

  const pluginComponentsSummary = (components?: Record<string, unknown>) => {
    if (!components || typeof components !== 'object') return t('settings.noComponentDecl');
    const keys = ['tools', 'middleware', 'skills', 'mcp', 'roles'];
    const parts: string[] = [];
    for (const key of keys) {
      const items = components[key];
      if (Array.isArray(items) && items.length > 0) {
        parts.push(`${key}:${items.length}`);
      }
    }
    return parts.length > 0 ? parts.join(' · ') : t('settings.noComponentDecl');
  };

  const quotaPercent = (used: number, limit: number): number => {
    if (limit <= 0) return 0;
    return Math.max(0, Math.min(100, (used / limit) * 100));
  };

  const quotaText = (used: number, limit: number): string => {
    if (limit < 0) return `${used} / ${t('settings.unlimited')}`;
    return `${used} / ${limit}`;
  };

  const sortedPlugins = [...plugins].sort((a, b) => {
    if (Boolean(a.loaded) !== Boolean(b.loaded)) return a.loaded ? -1 : 1;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
  const filteredPlugins = sortedPlugins.filter((p) => {
    const q = pluginSearch.trim().toLowerCase();
    if (q) {
      const text = `${p.name || ''} ${p.display_name || ''} ${p.description || ''}`.toLowerCase();
      if (!text.includes(q)) return false;
    }
    if (pluginFilter === 'installed') return Boolean(p.loaded);
    if (pluginFilter === 'installable') return !p.loaded && Boolean(p.eligible);
    return true;
  });
  const selectedPlugin = useMemo(
    () => filteredPlugins.find((p) => p.name === pluginDetailName) || filteredPlugins[0] || null,
    [filteredPlugins, pluginDetailName]
  );

  useEffect(() => {
    try {
      setStorageItem(PLUGIN_FILTER_KEY, pluginFilter);
    } catch {
      // ignore
    }
  }, [pluginFilter]);

  useEffect(() => {
    try {
      setStorageItem(PLUGIN_SEARCH_KEY, pluginSearch);
    } catch {
      // ignore
    }
  }, [pluginSearch]);

  useEffect(() => {
    if (!filteredPlugins.length) {
      setPluginDetailName('');
      return;
    }
    if (!filteredPlugins.some((p) => p.name === pluginDetailName)) {
      setPluginDetailName(filteredPlugins[0].name);
    }
  }, [filteredPlugins, pluginDetailName]);

  useEffect(() => {
    try {
      setStorageItem(EVOLUTION_REVIEW_AUTOSEND_KEY, evolutionReviewAutoSend ? '1' : '0');
    } catch {
      // ignore
    }
  }, [evolutionReviewAutoSend]);

  useEffect(() => {
    try {
      setStorageItem(EVOLUTION_TARGET_KEY, evolutionTarget);
    } catch {
      // ignore
    }
  }, [evolutionTarget]);

  useEffect(() => {
    try {
      setStorageItem(EVOLUTION_TITLE_KEY, evolutionTitle);
    } catch {
      // ignore
    }
  }, [evolutionTitle]);

  useEffect(() => {
    try {
      setStorageItem(EVOLUTION_MOTIVATION_KEY, evolutionMotivation);
    } catch {
      // ignore
    }
  }, [evolutionMotivation]);

  useEffect(() => {
    try {
      setStorageItem(EVOLUTION_PLAN_KEY, evolutionPlan);
    } catch {
      // ignore
    }
  }, [evolutionPlan]);

  const openConfigEditor = async (key: string) => {
    try {
      setConfigLoading(true);
      const res = await configApi.read(key);
      setConfigSelectedKey(res.key);
      setConfigContent(res.content || '');
      setConfigEditorOpen(true);
    } catch (e) {
      toast.error(t('settings.loadConfigError'), { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setConfigLoading(false);
    }
  };

  const handleSaveConfig = async () => {
    if (!configSelectedKey) return;
    setConfigSaving(true);
    try {
      await configApi.write(configSelectedKey, configContent);
      toast.success(t('settings.configSaved', { key: configSelectedKey }));
      const res = await configApi.list();
      setConfigFiles(Array.isArray(res.files) ? res.files : []);
      setConfigEditorOpen(false);
    } catch (e) {
      toast.error(t('settings.saveConfigFailed'), { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setConfigSaving(false);
    }
  };

  const handleSavePersona = async () => {
    try {
      setPersonaSaving(true);
      const payload: PersonaConfig = {
        name: (persona.name || '').trim(),
        tone: (persona.tone || '').trim(),
        relationship: (persona.relationship || '').trim(),
        language: (persona.language || '').trim(),
        communication_style: (persona.communication_style || '').trim(),
        empathy: (persona.empathy || '').trim(),
        preference_focus: (persona.preference_focus || '').trim(),
      };
      const res = await personaApi.update(payload);
      setPersona(res.persona || payload);
      window.dispatchEvent(new CustomEvent(EVENTS.PERSONA_CHANGED, { detail: { persona: res.persona || payload } }));
      // 助理名单源：同步显示名到 agent profile，欢迎区/状态栏等均以 profile 为准
      const nameToSync = (payload.name || '').trim();
      const profileRes = await boardApi.updateAgentProfile({ name: nameToSync });
      if (profileRes.ok && profileRes.profile) {
        setAgentProfile((prev) => (prev ? { ...prev, name: profileRes.profile!.name } : profileRes.profile!));
        window.dispatchEvent(new CustomEvent(EVENTS.AGENT_PROFILE_CHANGED, { detail: { profile: profileRes.profile } }));
      }
      toast.success(t('settings.personaSaved'));
    } catch (e) {
      toast.error(t('settings.personaSaveFailed'), { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setPersonaSaving(false);
    }
  };

  const handleSaveUserProfile = async () => {
    try {
      setUserProfileSaving(true);
      const wsId = getCurrentWorkspacePathFromStorage() || undefined;
      const expertiseAreas = userProfile.expertise_areas ?? {};
      const res = await userModelApi.put(
        {
          ...(Object.keys(expertiseAreas).length > 0 && { expertise_areas: expertiseAreas }),
          custom_rules: userProfile.custom_rules,
          communication_style: (userProfile.communication_style || '').trim(),
          detail_level: (userProfile.detail_level || '').trim(),
          domain_expertise: (userProfile.domain_expertise || '').trim(),
        },
        wsId
      );
      if (res?.ok && res.profile) {
        setUserProfile({
          expertise_areas: res.profile.expertise_areas ?? {},
          custom_rules: res.profile.custom_rules ?? [],
          communication_style: res.profile.communication_style ?? '',
          detail_level: res.profile.detail_level ?? '',
          domain_expertise: res.profile.domain_expertise ?? '',
          learning_trajectory: res.profile.learning_trajectory ?? [],
        });
        toast.success(t('settings.preferencesSaved'));
      } else {
        toast.warning(t('settings.preferencesSaveNoData'));
      }
    } catch (e) {
      toast.error(t('settings.savePreferencesFailed'), { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setUserProfileSaving(false);
    }
  };

  const handleCleanupThreads = (days: number = 7) => {
    setCleanThreadsConfirm({ days });
  };

  const performCleanupThreads = async () => {
    const days = cleanThreadsConfirm?.days ?? 7;
    setCleanThreadsConfirm(null);
    setLoading(true);
    try {
      const count = await cleanupExpiredThreads(days);
      toast.success(t('settings.clearedExpiredThreads', { count }));
      await loadThreads();
    } catch {
      toast.error(t('settings.cleanupFailed'));
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteThread = (threadId: string) => {
    setConfirmAction({ type: "deleteThread", threadId });
  };

  const performDeleteThread = async () => {
    const threadId = confirmAction?.type === "deleteThread" ? confirmAction.threadId : null;
    setConfirmAction(null);
    if (!threadId) return;
    try {
      await deleteThread(threadId);
      window.dispatchEvent(new CustomEvent(EVENTS.THREAD_DELETED, { detail: { threadId } }));
      toast.success(t('settings.threadDeleted'));
      await loadThreads();
    } catch {
      toast.error(t('settings.deleteFailed'));
    }
  };

  const handleLoadRunHistory = async (threadId: string) => {
    setSelectedThreadForHistory(threadId);
    try {
      const history = await getRunHistory(threadId, 20);
      setRunHistory(history);
    } catch {
      toast.error(t('settings.loadRunHistoryFailed'));
      setRunHistory([]);
    }
  };

  const handleCleanupWorkspaces = () => {
    setConfirmAction({ type: "cleanupWorkspaces" });
  };

  const performCleanupWorkspaces = async () => {
    setConfirmAction(null);
    setLoading(true);
    try {
      const count = await workspaceService.cleanupInvalidData();
      toast.success(t('settings.clearedInvalidData', { count }));
      await loadWorkspaces();
    } catch {
      toast.error(t('settings.cleanupFailed'));
    } finally {
      setLoading(false);
    }
  };

  const handleClearRecentWorkspaces = () => {
    setConfirmAction({ type: "clearRecent" });
  };

  const performClearRecentWorkspaces = () => {
    setConfirmAction(null);
    workspaceService.clearRecentWorkspaces();
    setRecentWorkspaces([]);
    toast.success(t('settings.recentListCleared'));
  };

  const handleDeleteMemory = (memory: any) => {
    if (!userId) return;
    const key = String(memory?.key || "").trim();
    if (!key) return;
    setConfirmAction({ type: "deleteMemory", memory: { key, ...memory } });
  };

  const performDeleteMemory = async () => {
    const memory = confirmAction?.type === "deleteMemory" ? confirmAction.memory : null;
    setConfirmAction(null);
    if (!userId || !memory) return;
    const key = String(memory?.key || "").trim();
    if (!key) return;
    try {
      await deleteUserMemory(userId, key);
      toast.success(t('settings.memoryDeleted'));
      await loadMemories();
    } catch {
      toast.error(t('settings.deleteFailed'));
    }
  };

  const handleDeleteSkill = (skill: { name: string; display_name?: string }) => {
    setConfirmAction({ type: "deleteSkill", skill });
  };

  const performDeleteSkill = async () => {
    const skill = confirmAction?.type === "deleteSkill" ? confirmAction.skill : null;
    setConfirmAction(null);
    if (!skill) return;
    try {
      await skillsAPI.deleteSkill({ relative_path: skill.name });
      toast.success(t('settings.skillDeleted', { name: skill.name }));
      await loadAgentProfile();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const handleSaveAgentProfile = async (updates: Partial<AgentProfile>) => {
    setAgentProfileSaving(true);
    try {
      const res = await boardApi.updateAgentProfile(updates);
      if (res.ok) {
        toast.success(t('settings.agentProfileSaved'));
        const profileRes = await boardApi.getAgentProfile();
        if (profileRes.ok && profileRes.profile) {
          setAgentProfile(profileRes.profile);
          window.dispatchEvent(new CustomEvent(EVENTS.AGENT_PROFILE_CHANGED, { detail: { profile: profileRes.profile } }));
        }
      } else {
        toast.error(t('settings.saveFailed'), { description: res.error });
      }
    } catch (e) {
      toast.error(t('settings.saveFailed'), { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setAgentProfileSaving(false);
    }
  };

  const handleDarkModeChange = (checked: boolean) => {
    setIsDarkMode(checked);
    try {
      setStorageItem('maibot_settings_darkMode', String(checked));
    } catch { /* ignore */ }
  };

  // 仅持久化「常规」页配置（外观/高级项在各页即时生效，不在此保存）
  const handleSave = () => {
    try {
      setStorageItem('maibot_settings_autoSave', String(autoSave));
      setStorageItem('maibot_settings_notifications', String(enableNotifications));
      window.dispatchEvent(
        new CustomEvent(EVENTS.SETTINGS_AUTO_SAVE_CHANGED, { detail: { enabled: autoSave } }),
      );
      toast.success(t('settings.settingsSaved'), { description: t('settings.settingsSavedDesc') });
    } catch { /* ignore */ }
  };

  const handleResetToDefault = () => {
    setIsDarkMode(false);
    setAutoDetectColorScheme(false);
    setAutoSave(true);
    setEnableNotifications(true);
    setDefaultModel('gpt-4');
    setThemeAccent('emerald');
    setFontSize(14);
    setReviewPolicy('notify');
    setReviewTemplate('standard');
    setPlanConfirmSwitchToAgent(true);
    setChatAutoScroll(true);
    setShowChatHistoryOnNew(false);
    setDefaultWebSearch(false);
    setTelemetryOptOut(false);
    setDefaultChatModeState('agent');
    setGlobalDefaultChatMode('agent');
    setEditorMinimap(true);
    setNoContextByDefault(false);
    setChatFadingAnimation(true);
    setChatNarrowScrollbar(false);
    try {
      removeStorageItem('maibot_settings_darkMode');
      removeStorageItem('maibot_auto_detect_color_scheme');
      removeStorageItem('maibot_settings_autoSave');
      removeStorageItem('maibot_settings_notifications');
      removeStorageItem('maibot_settings_defaultModel');
      removeStorageItem(STORAGE_KEY);
      removeStorageItem('maibot_font_size');
      removeStorageItem('maibot_review_policy');
      removeStorageItem('maibot_review_template');
      removeStorageItem('maibot_plan_confirm_switch_to_agent');
      removeStorageItem('maibot_chat_auto_scroll');
      removeStorageItem('maibot_show_chat_history_on_new');
      removeStorageItem('maibot_web_search');
      removeStorageItem('maibot_telemetry_opt_out');
      removeStorageItem(CHAT_MODE_DEFAULT_STORAGE_KEY);
      removeStorageItem('maibot_editor_minimap');
      removeStorageItem('maibot_no_context_by_default');
      removeStorageItem('maibot_chat_fading_animation');
      removeStorageItem('maibot_chat_narrow_scrollbar');
      window.dispatchEvent(
        new CustomEvent(EVENTS.SETTINGS_AUTO_SAVE_CHANGED, { detail: { enabled: true } }),
      );
      applyThemeAccent('emerald');
      applySavedFontSize();
      document.documentElement.classList.remove('dark');
      invalidateLangGraphClient();
      window.dispatchEvent(new CustomEvent(EVENTS.COMPOSER_PREFS_CHANGED));
      toast.success(t('settings.defaultRestored'));
    } catch { /* ignore */ }
  };

  return (
    <div className="h-full flex flex-col bg-background">
      <div className="shrink-0 h-9 px-3 flex items-center justify-between border-b border-border/20">
        <div className="flex items-center gap-2">
          <Settings className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">{t('settings.title')}</span>
        </div>
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onClose} aria-label={t('settings.closeAria')}>
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className="flex-1 flex min-h-0">
        <aside className="w-52 shrink-0 border-r border-border/20 py-2 bg-muted/30">
          <ScrollArea className="h-full">
            {NAV_GROUPS.map((group) => (
              <div key={group.label} className="px-2 pb-2">
                <div className="px-2 py-1 text-[11px] font-semibold tracking-wider text-muted-foreground">
                  {t(group.label)}
                </div>
                {group.items.map((item) => (
                  <button
                    key={item.id}
                    className={cn(
                      'w-full flex items-center gap-2 h-8 px-2 rounded-md text-left text-xs transition-colors',
                      section === item.id
                        ? 'bg-accent text-accent-foreground'
                        : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                    )}
                    onClick={() => setSection(item.id)}
                  >
                    {item.icon}
                    {t(item.label)}
                  </button>
                ))}
              </div>
            ))}
          </ScrollArea>
        </aside>
        <main className="flex-1 min-w-0 overflow-auto">
          <ScrollArea className="h-full">
            <div className="p-4 max-w-3xl space-y-6">
              {section === 'general' && (
                <>
                  <SettingsSectionHeader title={t('settings.sectionTitle.general')} description={t('settings.sectionDesc.general')} />
                  {typeof window !== 'undefined' && (!getStorageItem('maibot_onboarding_sample_created') || getStorageItem('maibot_onboarding_sample_status') === 'failed') && (
                    <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 space-y-2">
                      <p className="text-xs font-medium">{t('onboarding.createSampleTask')}</p>
                      <p className="text-[11px] text-muted-foreground">{t('onboarding.createSampleTaskHint')}</p>
                      <Button
                        size="sm"
                        variant="outline"
                        className="border-amber-500/50 hover:bg-amber-500/10"
                        onClick={() => window.dispatchEvent(new CustomEvent(EVENTS.CREATE_ONBOARDING_SAMPLE_TASK))}
                      >
                        {t('onboarding.createSampleTask')}
                      </Button>
                    </div>
                  )}
                  {section === 'general' && (
                    <div className="space-y-6">
                      <Card className="rounded-lg border border-border/60">
                        <CardHeader className="pb-2">
                          <CardTitle className="text-sm">{t('settings.rulesForAITitle')}</CardTitle>
                          <CardDescription>{t('settings.rulesForAIDesc')}</CardDescription>
                        </CardHeader>
                        <CardContent className="pt-0">
                          <p className="text-[11px] text-muted-foreground mb-2">{t('settings.rulesForAIHint')}</p>
                          <Button size="sm" variant="outline" onClick={() => setSection('advanced')} className="text-xs">
                            {t('settings.rulesOpenConfig')}
                          </Button>
                        </CardContent>
                      </Card>
                      <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <div>
                          <Label className="text-xs font-medium">{t('settings.autoSaveLabel')}</Label>
                          <p className="text-[11px] text-muted-foreground">{t('settings.autoSaveDesc')}</p>
                        </div>
                        <Switch
                          checked={autoSave}
                          onCheckedChange={(checked) => {
                            setAutoSave(!!checked);
                            try {
                              setStorageItem('maibot_settings_autoSave', String(!!checked));
                              window.dispatchEvent(new CustomEvent(EVENTS.SETTINGS_AUTO_SAVE_CHANGED, { detail: { enabled: !!checked } }));
                            } catch { /* ignore */ }
                          }}
                        />
                      </div>
                      <div className="flex items-center justify-between">
                        <div>
                          <Label className="text-xs font-medium">{t('settings.notificationsLabel')}</Label>
                          <p className="text-[11px] text-muted-foreground">{t('settings.notificationsDesc')}</p>
                        </div>
                        <Switch
                          checked={enableNotifications}
                          onCheckedChange={(checked) => {
                            setEnableNotifications(!!checked);
                            try { setStorageItem('maibot_settings_notifications', String(!!checked)); } catch { /* ignore */ }
                          }}
                        />
                      </div>
                      <div className="flex gap-2">
                        <Button size="sm" variant="outline" onClick={() => setConfirmAction({ type: 'resetToDefault' })} className="gap-1">
                          <RefreshCw className="h-3 w-3" />
                          {t('settings.resetToDefault')}
                        </Button>
                      </div>
                      </div>

                      <Card className="rounded-lg border border-border/60">
                        <CardHeader className="pb-2">
                          <CardTitle className="text-sm">{t('settings.chatBehaviorTitle')}</CardTitle>
                          <CardDescription>{t('settings.chatBehaviorDesc')}</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-3 pt-0">
                          <div className="flex items-center justify-between">
                            <div>
                              <Label className="text-xs font-medium">{t('settings.chatAutoScroll')}</Label>
                              <p className="text-[11px] text-muted-foreground">{t('settings.chatAutoScrollDesc')}</p>
                            </div>
                            <Switch
                              checked={chatAutoScroll}
                              onCheckedChange={(checked) => {
                                setChatAutoScroll(!!checked);
                                try { setStorageItem('maibot_chat_auto_scroll', String(!!checked)); } catch { /* ignore */ }
                              }}
                            />
                          </div>
                          <div className="flex items-center justify-between">
                            <div>
                              <Label className="text-xs font-medium">{t('settings.showChatHistoryOnNew')}</Label>
                              <p className="text-[11px] text-muted-foreground">{t('settings.showChatHistoryOnNewDesc')}</p>
                            </div>
                            <Switch
                              checked={showChatHistoryOnNew}
                              onCheckedChange={(checked) => {
                                setShowChatHistoryOnNew(!!checked);
                                try { setStorageItem('maibot_show_chat_history_on_new', String(!!checked)); } catch { /* ignore */ }
                              }}
                            />
                          </div>
                          <div className="flex items-center justify-between">
                            <div>
                              <Label className="text-xs font-medium">{t('settings.defaultWebSearch')}</Label>
                              <p className="text-[11px] text-muted-foreground">{t('settings.defaultWebSearchDesc')}</p>
                            </div>
                            <Switch
                              checked={defaultWebSearch}
                              onCheckedChange={(checked) => {
                                setDefaultWebSearch(!!checked);
                                try {
                                  setStorageItem('maibot_web_search', String(!!checked));
                                  window.dispatchEvent(new CustomEvent(EVENTS.COMPOSER_PREFS_CHANGED));
                                } catch { /* ignore */ }
                              }}
                            />
                          </div>
                          <div className="flex items-center justify-between">
                            <div>
                              <Label className="text-xs font-medium">{t('settings.noContextByDefault')}</Label>
                              <p className="text-[11px] text-muted-foreground">{t('settings.noContextByDefaultDesc')}</p>
                            </div>
                            <Switch
                              checked={noContextByDefault}
                              onCheckedChange={(checked) => {
                                setNoContextByDefault(!!checked);
                                try {
                                  setStorageItem('maibot_no_context_by_default', String(!!checked));
                                  window.dispatchEvent(new CustomEvent(EVENTS.COMPOSER_PREFS_CHANGED));
                                } catch { /* ignore */ }
                              }}
                            />
                          </div>
                          <div className="flex items-center justify-between">
                            <div>
                              <Label className="text-xs font-medium">{t('settings.chatFadingAnimation')}</Label>
                              <p className="text-[11px] text-muted-foreground">{t('settings.chatFadingAnimationDesc')}</p>
                            </div>
                            <Switch
                              checked={chatFadingAnimation}
                              onCheckedChange={(checked) => {
                                setChatFadingAnimation(!!checked);
                                try {
                                  setStorageItem('maibot_chat_fading_animation', String(!!checked));
                                  window.dispatchEvent(new CustomEvent(EVENTS.COMPOSER_PREFS_CHANGED));
                                } catch { /* ignore */ }
                              }}
                            />
                          </div>
                          <div className="flex items-center justify-between">
                            <div>
                              <Label className="text-xs font-medium">{t('settings.chatNarrowScrollbar')}</Label>
                              <p className="text-[11px] text-muted-foreground">{t('settings.chatNarrowScrollbarDesc')}</p>
                            </div>
                            <Switch
                              checked={chatNarrowScrollbar}
                              onCheckedChange={(checked) => {
                                setChatNarrowScrollbar(!!checked);
                                try {
                                  setStorageItem('maibot_chat_narrow_scrollbar', String(!!checked));
                                  window.dispatchEvent(new CustomEvent(EVENTS.COMPOSER_PREFS_CHANGED));
                                } catch { /* ignore */ }
                              }}
                            />
                          </div>
                          <div className="space-y-2">
                            <Label className="text-xs font-medium">{t('settings.defaultChatModeLabel')}</Label>
                            <p className="text-[11px] text-muted-foreground">{t('settings.defaultChatModeDesc')}</p>
                            <Select
                              value={defaultChatMode}
                              onValueChange={(v) => {
                                const next = (['agent', 'plan', 'ask', 'debug', 'review'].includes(v) ? v : 'agent') as ChatMode;
                                setDefaultChatModeState(next);
                                setGlobalDefaultChatMode(next);
                                toast.success(t('settings.settingsSaved'));
                              }}
                            >
                              <SelectTrigger className="h-8 w-[160px] text-xs">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="agent">{t('modes.agent')}</SelectItem>
                                <SelectItem value="plan">{t('modes.plan')}</SelectItem>
                                <SelectItem value="ask">{t('modes.ask')}</SelectItem>
                                <SelectItem value="debug">{t('modes.debug')}</SelectItem>
                                <SelectItem value="review">{t('modes.review')}</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                        </CardContent>
                      </Card>

                      <Card className="rounded-lg border border-border/60">
                        <CardHeader className="pb-2">
                          <CardTitle className="text-sm">{t('settings.privacyTitle')}</CardTitle>
                          <CardDescription>{t('settings.privacyDesc')}</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-3 pt-0">
                          <p className="text-[11px] text-muted-foreground">{t('settings.dataRetentionNote')}</p>
                          <div className="flex items-center justify-between">
                            <div>
                              <Label className="text-xs font-medium">{t('settings.telemetryOptOut')}</Label>
                              <p className="text-[11px] text-muted-foreground">{t('settings.telemetryOptOutDesc')}</p>
                            </div>
                            <Switch
                              checked={telemetryOptOut}
                              onCheckedChange={(checked) => {
                                setTelemetryOptOut(!!checked);
                                try { setStorageItem('maibot_telemetry_opt_out', String(!!checked)); } catch { /* ignore */ }
                              }}
                            />
                          </div>
                        </CardContent>
                      </Card>
                    </div>
                  )}
                </>
              )}

              {section === 'models' && (
                <>
                  <SettingsSectionHeader title={t('settings.sectionTitle.models')} description={t('settings.sectionDesc.models')} />
                  {/* 模型与连接：默认模型 + 云端端点 + 已配置模型 */}
                  <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5 space-y-3">
                    <p className="text-xs font-medium text-muted-foreground">{t('settings.modelAndConnection')}</p>
                  <div>
                    <Label className="text-xs font-medium">{t('settings.defaultModelLabel')}</Label>
                    <Select
                      value={modelList.length === 0 ? '__no_models__' : defaultModel}
                      onValueChange={async (modelId) => {
                        if (modelId === '__no_models__') return;
                        if (!confirmCloudModelSwitch(modelId)) return;
                        setDefaultModel(modelId);
                        setStorageItem('maibot_selected_model', modelId);
                        window.dispatchEvent(new CustomEvent(EVENTS.COMPOSER_PREFS_CHANGED));
                        try {
                          await modelsApi.switch(modelId);
                          window.dispatchEvent(new CustomEvent("model_changed", { detail: { modelId } }));
                          try {
                            await modelsApi.setDefaultModel(modelId);
                          } catch {
                            toast.warning(t('settings.defaultModelSwitchSavedFailed'));
                          }
                        } catch (e) {
                          toast.error(t('settings.switchDefaultModelFailed'), { description: e instanceof Error ? e.message : String(e) });
                        }
                      }}
                    >
                      <SelectTrigger className="h-8 text-xs mt-1">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {modelList.length > 0
                          ? modelList.map(m => (
                              <SelectItem key={m.id} value={m.id}>
                                {m.name}{m.provider ? ` (${m.provider})` : ''}{m.context_length ? ` · ${m.context_length >= 1000 ? Math.round(m.context_length / 1000) + 'K' : m.context_length}` : ''}
                              </SelectItem>
                            ))
                          : (
                              <SelectItem value="__no_models__">{t('settings.noModelsHint')}</SelectItem>
                            )
                        }
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex items-center justify-between gap-2 rounded bg-muted/30 px-2 py-2">
                    <div>
                      <Label className="text-xs font-medium">{t('settings.allowCloudWithoutConfirm')}</Label>
                      <p className="text-[11px] text-muted-foreground mt-0.5">{t('settings.allowCloudWithoutConfirmDesc')}</p>
                    </div>
                    <Switch
                      checked={allowCloudWithoutConfirm}
                      onCheckedChange={(checked) => {
                        setAllowCloudWithoutConfirm(!!checked);
                        setStorageItem('maibot_allow_cloud_without_confirm', checked ? 'true' : 'false');
                        window.dispatchEvent(new CustomEvent(EVENTS.COMPOSER_PREFS_CHANGED));
                      }}
                    />
                  </div>

                  {/* 云端模型确认：设置页内联确认块（无弹窗），仅在未勾选「允许使用云端」且未已同意时出现 */}
                  {cloudConsentPending !== null && (
                    <div className="rounded-lg border border-border shadow-sm bg-blue-500/5 dark:bg-blue-500/10 p-3 flex flex-col gap-2">
                      <h3 className="text-xs font-medium text-blue-600 dark:text-blue-400">{t('cloudConfirm.inlineTitle')}</h3>
                      <p className="text-[11px] text-muted-foreground">{t('modelSelector.cloudConfirmMsg')}</p>
                      <div className="flex gap-2 justify-end">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => setCloudConsentPending(null)}
                        >
                          {t('common.cancel')}
                        </Button>
                        <Button
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => void performCloudConsentAndSwitch()}
                        >
                          {t('cloudConfirm.continue')}
                        </Button>
                      </div>
                    </div>
                  )}

                  {/* 云端端点（动态发现：配置后自动拉取该端点下的所有模型到可用列表） */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <div>
                        <Label className="text-xs font-medium">{t('settings.cloudEndpointLabel')}</Label>
                        <p className="text-[11px] text-muted-foreground mt-0.5">{t('settings.cloudEndpointDesc')}</p>
                      </div>
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-xs"
                          disabled={cloudRefreshLoading}
                          onClick={async () => {
                            setCloudRefreshLoading(true);
                            try {
                              const r = await modelsApi.refreshCloud();
                              const epData = await modelsApi.getCloudEndpoints();
                              if (epData.ok && Array.isArray(epData.endpoints_with_models)) setEndpointsWithModels(epData.endpoints_with_models);
                              await loadModels();
                              toast.success(t('settings.cloudModelsRefreshed', { count: r.discovered }));
                            } catch (e) {
                              toast.error(t('settings.refreshCloudModelsFailed'), { description: e instanceof Error ? e.message : String(e) });
                            } finally {
                              setCloudRefreshLoading(false);
                            }
                          }}
                        >
                          {cloudRefreshLoading ? <RefreshCw className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                          {t('settings.refreshCloudModels')}
                        </Button>
                        {!showAddCloudEndpoint ? (
                          <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={() => { setEditingCloudEndpointIndex(null); setShowAddCloudEndpoint(true); }}>
                            {t('settings.addEndpoint')}
                          </Button>
                        ) : null}
                      </div>
                    </div>
                    {cloudEndpointsLoading ? (
                      <p className="text-[11px] text-muted-foreground">{t('settings.loading')}</p>
                    ) : (
                      <>
                        {cloudEndpoints.length > 0 && (
                          <div className="space-y-1">
                            {cloudEndpoints.map((ep, i) => (
                              <div key={i} className="rounded bg-muted/50">
                                {editingCloudEndpointIndex === i ? (
                                  <div className="p-2 space-y-2">
                                    <Input
                                      className="h-8 text-xs"
                                      placeholder={t('settings.baseUrlPlaceholder')}
                                      value={editingCloudEndpointDraft.base_url}
                                      onChange={e => setEditingCloudEndpointDraft(d => ({ ...d, base_url: e.target.value }))}
                                    />
                                    <Input
                                      className="h-8 text-xs"
                                      placeholder={t('settings.apiKeyEnvPlaceholder')}
                                      value={editingCloudEndpointDraft.api_key_env}
                                      onChange={e => setEditingCloudEndpointDraft(d => ({ ...d, api_key_env: e.target.value }))}
                                    />
                                    <div className="flex gap-2">
                                      <Button
                                        size="sm"
                                        className="text-xs"
                                        disabled={!editingCloudEndpointDraft.base_url.trim() && !editingCloudEndpointDraft.api_key_env.trim()}
                                        onClick={async () => {
                                          const base = editingCloudEndpointDraft.base_url.trim();
                                          const keyEnv = (editingCloudEndpointDraft.api_key_env || '').trim();
                                          if (!base && !keyEnv) {
                                            toast.error(t('settings.fillBaseUrlOrKey'));
                                            return;
                                          }
                                          const next = cloudEndpoints.map((e, j) => j === i ? { base_url: base, api_key_env: keyEnv } : e);
                                          try {
                                            await modelsApi.updateCloudEndpoints(next);
                                            setCloudEndpoints(next);
                                            setEditingCloudEndpointIndex(null);
                                            const refreshed = await modelsApi.getCloudEndpoints();
                                            if (refreshed.ok && Array.isArray(refreshed.endpoints_with_models)) setEndpointsWithModels(refreshed.endpoints_with_models);
                                            await loadModels();
                                            toast.success(base ? t('settings.endpointUpdated') : t('settings.endpointUpdatedNoBase'));
                                          } catch (e) {
                                            toast.error(t('settings.updateEndpointFailed'), { description: e instanceof Error ? e.message : String(e) });
                                          }
                                        }}
                                      >
                                        {t('settings.save')}
                                      </Button>
                                      <Button size="sm" variant="ghost" className="text-xs" onClick={() => { setEditingCloudEndpointIndex(null); }}>
                                        {t('settings.cancel')}
                                      </Button>
                                    </div>
                                  </div>
                                ) : (() => {
                                  const norm = (s: string) => (s || '').trim().replace(/\/+$/, '');
                                  const meta = endpointMetaByBaseUrl.get(norm(ep.base_url));
                                  const modelIds = meta?.model_ids ?? [];
                                  const showCount = 5;
                                  const displayIds = modelIds.length > showCount ? modelIds.slice(0, showCount).join(', ') + t('settings.cloudEndpointModelsMore', { count: modelIds.length }) : modelIds.join(', ');
                                  return (
                                  <div className="p-1.5 space-y-1">
                                    <div className="flex items-center justify-between text-xs">
                                      <span className="truncate min-w-0">
                                        {ep.base_url || `(${t('settings.unset')})`}
                                        {!ep.base_url?.trim() && (
                                          <span className="ml-1 text-[10px] text-amber-600 dark:text-amber-400">{t('settings.noBaseUrlWarning')}</span>
                                        )}
                                      </span>
                                      <div className="flex items-center gap-2 shrink-0">
                                        <span className="text-muted-foreground">
                                          {meta?.has_key ? t('settings.cloudEndpointKeyStatus') : t('settings.cloudEndpointKeyStatusNone')}
                                        </span>
                                        <span className="text-muted-foreground text-[10px]">
                                          {(ep.api_key_env || '').trim().startsWith('sk-') ? '· · ·' : (ep.api_key_env || t('settings.noKeyEnv'))}
                                        </span>
                                        <div className="flex gap-0.5">
                                          <Button
                                            size="sm"
                                            variant="ghost"
                                            className="h-6 px-2 text-xs"
                                            onClick={() => {
                                              setShowAddCloudEndpoint(false);
                                              setEditingCloudEndpointIndex(i);
                                              setEditingCloudEndpointDraft({ base_url: ep.base_url || '', api_key_env: ep.api_key_env || '' });
                                            }}
                                          >
                                            {t('settings.edit')}
                                          </Button>
                                          <Button
                                            size="sm"
                                            variant="ghost"
                                            className="h-6 px-2 text-xs text-destructive"
                                            onClick={() => {
                                              const prev = cloudEndpoints;
                                              const next = cloudEndpoints.filter((_, j) => j !== i);
                                              setCloudEndpoints(next);
                                              modelsApi.updateCloudEndpoints(next).then(async () => {
                                                if (!mountedRef.current) return;
                                                const refreshed = await modelsApi.getCloudEndpoints();
                                                if (refreshed.ok && Array.isArray(refreshed.endpoints_with_models)) setEndpointsWithModels(refreshed.endpoints_with_models);
                                                await loadModels();
                                              }).catch(() => {
                                                if (!mountedRef.current) return;
                                                toast.error(t('settings.updateEndpointsFailed'));
                                                setCloudEndpoints(prev);
                                              });
                                            }}
                                          >
                                            {t('settings.delete')}
                                          </Button>
                                        </div>
                                      </div>
                                    </div>
                                    {meta && (
                                      <p className="text-[10px] text-muted-foreground truncate" title={modelIds.length > 0 ? modelIds.join(', ') : undefined}>
                                        {t('settings.cloudEndpointModelsCount', { count: modelIds.length })}
                                        {modelIds.length > 0 && ` — ${displayIds}`}
                                      </p>
                                    )}
                                  </div>
                                  );
                                })()}
                              </div>
                            ))}
                          </div>
                        )}
                        {showAddCloudEndpoint && (
                          <div className="p-2 border rounded-md space-y-2">
                            <Input
                              className="h-8 text-xs"
                              placeholder={t('settings.baseUrlPlaceholder')}
                              value={newCloudEndpoint.base_url}
                              onChange={e => setNewCloudEndpoint(f => ({ ...f, base_url: e.target.value }))}
                            />
                            <Input
                              className="h-8 text-xs"
                              placeholder={t('settings.apiKeyEnvPlaceholder')}
                              value={newCloudEndpoint.api_key_env}
                              onChange={e => setNewCloudEndpoint(f => ({ ...f, api_key_env: e.target.value }))}
                            />
                            <div className="flex gap-2">
                              <Button
                                size="sm"
                                className="text-xs"
                                disabled={!newCloudEndpoint.base_url.trim() && !newCloudEndpoint.api_key_env.trim()}
                                onClick={async () => {
                                  const base = newCloudEndpoint.base_url.trim();
                                  const keyEnv = (newCloudEndpoint.api_key_env || '').trim();
                                  const next = [...cloudEndpoints, { base_url: base, api_key_env: keyEnv }];
                                  try {
                                    await modelsApi.updateCloudEndpoints(next);
                                    setCloudEndpoints(next);
                                    setNewCloudEndpoint({ base_url: '', api_key_env: '' });
                                    setShowAddCloudEndpoint(false);
                                    const refreshed = await modelsApi.getCloudEndpoints();
                                    if (refreshed.ok && Array.isArray(refreshed.endpoints_with_models)) setEndpointsWithModels(refreshed.endpoints_with_models);
                                    await loadModels();
                                    if (base) {
                                      toast.success(t('settings.endpointUpdated'));
                                    } else {
                                      toast.success(t('settings.endpointUpdatedNoBase'));
                                    }
                                  } catch (e) {
                                    toast.error(t('settings.updateEndpointFailed'), { description: e instanceof Error ? e.message : String(e) });
                                  }
                                }}
                              >
                                {t('settings.saveAndRefresh')}
                              </Button>
                              <Button size="sm" variant="ghost" className="text-xs" onClick={() => { setShowAddCloudEndpoint(false); setNewCloudEndpoint({ base_url: '', api_key_env: '' }); }}>
                                {t('settings.cancel')}
                              </Button>
                            </div>
                          </div>
                        )}
                        {cloudEndpoints.length === 0 && !showAddCloudEndpoint && (
                          <>
                            {cloudEndpointsAuthError ? (
                              <p className="text-[11px] text-amber-600 dark:text-amber-400">{t('settings.cloudEndpointAuthHint')}</p>
                            ) : (
                              <p className="text-[11px] text-muted-foreground">{t('settings.cloudEndpointKeyHint')}</p>
                            )}
                          </>
                        )}
                      </>
                    )}
                  </div>

                  {/* 模型管理 */}
                  {modelList.length > 0 && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <div>
                          <Label className="text-xs font-medium">{t('settings.configuredModels')}</Label>
                          <p className="text-[11px] text-muted-foreground mt-0.5">{t('settings.configuredModelsDesc')}</p>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-xs"
                          disabled={modelLoading}
                          onClick={async () => {
                            try {
                              await modelsApi.refresh();
                              await loadModels();
                            } catch (e) {
                              toast.error(t('settings.refreshModelsFailed'), { description: e instanceof Error ? e.message : String(e) });
                            }
                          }}
                        >
                          {modelLoading ? <RefreshCw className="h-3 w-3 animate-spin" /> : t('settings.refreshDiscover')}
                        </Button>
                      </div>
                      <div className="space-y-1">
                        {modelList.map(m => (
                          <div
                            key={m.id}
                            className={cn(
                              "flex items-center justify-between text-xs p-1.5 rounded bg-muted/50",
                              isCloudDiscoveredModel(m) && "opacity-80"
                            )}
                          >
                            <span className="min-w-0">
                              <span className="truncate">
                                {m.name} <span className="text-muted-foreground">({m.provider || 'unknown'})</span>
                                {m.enabled === false ? (
                                  <span className="ml-1 rounded bg-amber-500/20 text-amber-700 dark:text-amber-400 px-1 py-0.5 text-[11px]">{t('settings.notEnabled')}</span>
                                ) : null}
                                {isCloudDiscoveredModel(m) ? (
                                  <span className="ml-1 rounded border border-border/60 px-1 py-0.5 text-[11px] text-muted-foreground">
                                    {m.has_api_key ? t('settings.cloudKeyConfigured') : t('settings.cloudKeyNotConfigured')}
                                  </span>
                                ) : null}
                              </span>
                              {m.url ? <span className="block text-[11px] text-muted-foreground truncate">{m.url}</span> : null}
                            </span>
                            <div className="flex items-center gap-1">
                              {m.enabled === false && !isCloudDiscoveredModel(m) ? (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-6 px-2 text-xs"
                                  onClick={async () => {
                                    try {
                                      await modelsApi.update(m.id, { enabled: true });
                                      await loadModels();
                                      toast.success(t('settings.modelEnabled', { name: m.name }));
                                    } catch (e) {
                                      toast.error(t('settings.enableFailed'), { description: e instanceof Error ? e.message : String(e) });
                                    }
                                  }}
                                >
                                  {t('settings.enable')}
                                </Button>
                              ) : null}
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 px-2"
                                title={t('settings.testConnectionTitle')}
                                disabled={modelTestLoadingId != null}
                                onClick={async () => {
                                  setModelTestLoadingId(m.id);
                                  try {
                                    await modelsApi.refresh();
                                    const data = await modelsApi.list();
                                    await loadModels();
                                    const item = data.ok && data.models ? data.models.find((x: { id: string }) => x.id === m.id) : null;
                                    const available = (item as { available?: boolean } | undefined)?.available;
                                    if (available) toast.success(t('settings.modelConnectionOk', { name: m.name }));
                                    else toast.error(t('settings.modelUnavailable', { name: m.name }));
                                  } catch (e) {
                                    toast.error(t('settings.testConnectionFailed'), { description: e instanceof Error ? e.message : String(e) });
                                  } finally {
                                    setModelTestLoadingId(null);
                                  }
                                }}
                              >
                                {modelTestLoadingId === m.id ? <RefreshCw className="h-3 animate-spin" /> : <Wrench className="h-3" />}
                                <span className="ml-0.5">{t('settings.testConnection')}</span>
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 px-2"
                                title={isCloudDiscoveredModel(m) ? t('settings.cloudModelReadOnlyHint') : undefined}
                                disabled={isCloudDiscoveredModel(m)}
                                onClick={() => !isCloudDiscoveredModel(m) && setEditingModel({ id: m.id, field: 'name', value: m.name })}
                              >
                                {t('settings.edit')}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 px-2"
                                title={isCloudDiscoveredModel(m) ? t('settings.cloudModelReadOnlyHint') : undefined}
                                disabled={isCloudDiscoveredModel(m)}
                                onClick={() => !isCloudDiscoveredModel(m) && setEditingModel({ id: m.id, field: 'endpoint', value: m.url || '' })}
                              >
                                {t('settings.endpointLabel')}
                              </Button>
                              {m.id !== defaultModel && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-6 px-2 text-destructive hover:text-destructive"
                                  title={isCloudDiscoveredModel(m) ? t('settings.cloudModelReadOnlyHint') : undefined}
                                  disabled={isCloudDiscoveredModel(m)}
                                  onClick={() => !isCloudDiscoveredModel(m) && setPendingDeleteModelId(m.id)}
                                >
{t('settings.delete')}
                                        </Button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  </div>
                  {/* 模型与连接 分组结束 */}

                  <div className="space-y-2 rounded-md border border-border/40 p-3">
                    <Label className="text-xs font-medium">{t('settings.subAgentStrategyLabel')}</Label>
                    <p className="text-[11px] text-muted-foreground">
                      {subagentModel === 'same_as_main'
                        ? t('settings.subAgentSameAsMain')
                        : t('settings.subAgentMapped')}
                    </p>
                    {Object.keys(subagentModelMapping).length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {Object.entries(subagentModelMapping).map(([k, v]) => (
                          <span key={k} className="inline-flex items-center rounded bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                            {k}: {v === 'same_as_main' ? t('settings.sameAsMain') : v}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  {(capabilityModels.embedding || capabilityModels.rerank) && (
                    <div className="space-y-2 rounded-md border border-border/40 p-3">
                      <Label className="text-xs font-medium">{t('settings.retrievalModelStatus')}</Label>
                      {(["embedding", "rerank"] as const).map((kind) => {
                        const m = capabilityModels[kind];
                        if (!m) return null;
                        const healthy = Boolean(m.enabled && m.available && m.provider_ready);
                        const enabled = Boolean(m.enabled);
                        const stateText = !enabled ? t('settings.statusDisabled') : healthy ? t('settings.statusAvailable') : t('settings.statusDegraded');
                        return (
                          <div key={kind} className="flex items-center justify-between rounded border border-border/40 px-2 py-1.5 text-xs">
                            <div className="space-y-0.5">
                              <div className="font-medium">{kind}</div>
                              <div className="text-muted-foreground">
                                {m.id || t('settings.notConfigured')}{m.base_url ? ` · ${m.base_url}` : ""}
                              </div>
                            </div>
                            <Badge variant={healthy ? "default" : "outline"} className={healthy ? "" : "text-amber-700 dark:text-amber-300"}>
                              {stateText}
                            </Badge>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {modelList.length > 0 && (
                    <div className="space-y-2 rounded-md border border-border/40 p-3">
                      {isDefaultModelCloudReadOnly && (
                        <p className="text-[11px] text-muted-foreground">{t('settings.cloudModelReadOnlyHint')}</p>
                      )}
                      <div className="flex items-center justify-between">
                        <Label className="text-xs font-medium">{t('settings.currentModelParams', { model: defaultModel })}</Label>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-xs"
                          title={isDefaultModelCloudReadOnly ? t('settings.cloudModelReadOnlyHint') : undefined}
                          disabled={isDefaultModelCloudReadOnly}
                          onClick={async () => {
                            if (isDefaultModelCloudReadOnly) return;
                            const parseNum = (raw: string, fallback?: number): number | undefined => {
                              const v = raw.trim();
                              if (!v) return fallback;
                              const n = Number(v);
                              return Number.isFinite(n) ? n : fallback;
                            };
                            const selected = modelList.find((m) => m.id === defaultModel);
                            const mergedConfig = {
                              ...(selected?.config || {}),
                              temperature: parseNum(modelDraft.temperature, selected?.config?.temperature),
                              top_p: parseNum(modelDraft.top_p, selected?.config?.top_p),
                              min_p: parseNum(modelDraft.min_p, selected?.config?.min_p),
                              presence_penalty: parseNum(modelDraft.presence_penalty, selected?.config?.presence_penalty),
                              max_tokens_default: parseNum(modelDraft.max_tokens_default, selected?.config?.max_tokens_default),
                              max_tokens_analysis: parseNum(modelDraft.max_tokens_analysis, selected?.config?.max_tokens_analysis),
                              max_tokens_doc: parseNum(modelDraft.max_tokens_doc, selected?.config?.max_tokens_doc),
                              max_tokens_fast: parseNum(modelDraft.max_tokens_fast, selected?.config?.max_tokens_fast),
                              enable_thinking: Boolean(modelDraft.enable_thinking),
                              parallel_tool_calls: Boolean(modelDraft.parallel_tool_calls),
                              enable_endpoint_discovery: Boolean(modelDraft.enable_endpoint_discovery),
                            };
                            try {
                              await modelsApi.update(defaultModel, {
                                url: modelDraft.endpoint_url.trim() || undefined,
                                context_length: parseNum(modelDraft.context_length, selected?.context_length),
                                config: mergedConfig,
                                api_key_env: modelDraft.api_key_env.trim() || undefined,
                              });
                              await loadModels();
                              toast.success(t('settings.modelParamsSaved'));
                            } catch (e) {
                              toast.error(t('settings.modelParamsSaveFailed'), { description: e instanceof Error ? e.message : String(e) });
                            }
                          }}
                        >
                          {t('settings.saveParams')}
                        </Button>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div className="col-span-2">
                          <Label className="text-[11px] text-muted-foreground">模型端点 URL</Label>
                          <Input
                            className="h-8 text-xs mt-1"
                            value={modelDraft.endpoint_url}
                            onChange={(e) => setModelDraft((d) => ({ ...d, endpoint_url: e.target.value }))}
                            placeholder={t('settings.placeholder.defaultOllamaUrl')}
                            disabled={isDefaultModelCloudReadOnly}
                          />
                        </div>
                        <div>
                          <Label className="text-[11px] text-muted-foreground">上下文窗口</Label>
                          <Input
                            className="h-8 text-xs mt-1"
                            value={modelDraft.context_length}
                            onChange={(e) => setModelDraft((d) => ({ ...d, context_length: e.target.value }))}
                            placeholder="262144"
                            disabled={isDefaultModelCloudReadOnly}
                          />
                        </div>
                        <div>
                          <Label className="text-[11px] text-muted-foreground">Temperature</Label>
                          <Input
                            className="h-8 text-xs mt-1"
                            value={modelDraft.temperature}
                            onChange={(e) => setModelDraft((d) => ({ ...d, temperature: e.target.value }))}
                            placeholder="0.3"
                            disabled={isDefaultModelCloudReadOnly}
                          />
                        </div>
                        <div>
                          <Label className="text-[11px] text-muted-foreground">Top P</Label>
                          <Input
                            className="h-8 text-xs mt-1"
                            value={modelDraft.top_p}
                            onChange={(e) => setModelDraft((d) => ({ ...d, top_p: e.target.value }))}
                            placeholder="0.9"
                            disabled={isDefaultModelCloudReadOnly}
                          />
                        </div>
                        <div>
                          <Label className="text-[11px] text-muted-foreground">Min P</Label>
                          <Input
                            className="h-8 text-xs mt-1"
                            value={modelDraft.min_p}
                            onChange={(e) => setModelDraft((d) => ({ ...d, min_p: e.target.value }))}
                            placeholder="0.03"
                            disabled={isDefaultModelCloudReadOnly}
                          />
                        </div>
                        <div>
                          <Label className="text-[11px] text-muted-foreground">Presence Penalty</Label>
                          <Input
                            className="h-8 text-xs mt-1"
                            value={modelDraft.presence_penalty}
                            onChange={(e) => setModelDraft((d) => ({ ...d, presence_penalty: e.target.value }))}
                            placeholder="0.1"
                            disabled={isDefaultModelCloudReadOnly}
                          />
                        </div>
                        <div>
                          <Label className="text-[11px] text-muted-foreground">Max Tokens (Default)</Label>
                          <Input
                            className="h-8 text-xs mt-1"
                            value={modelDraft.max_tokens_default}
                            onChange={(e) => setModelDraft((d) => ({ ...d, max_tokens_default: e.target.value }))}
                            placeholder="32768"
                            disabled={isDefaultModelCloudReadOnly}
                          />
                        </div>
                        <div className="col-span-2">
                          <Label className="text-[11px] text-muted-foreground">Max Tokens (Analysis)</Label>
                          <Input
                            className="h-8 text-xs mt-1"
                            value={modelDraft.max_tokens_analysis}
                            onChange={(e) => setModelDraft((d) => ({ ...d, max_tokens_analysis: e.target.value }))}
                            placeholder="49152"
                            disabled={isDefaultModelCloudReadOnly}
                          />
                        </div>
                        <div>
                          <Label className="text-[11px] text-muted-foreground">Max Tokens (Doc)</Label>
                          <Input
                            className="h-8 text-xs mt-1"
                            value={modelDraft.max_tokens_doc}
                            onChange={(e) => setModelDraft((d) => ({ ...d, max_tokens_doc: e.target.value }))}
                            placeholder="131072"
                            disabled={isDefaultModelCloudReadOnly}
                          />
                        </div>
                        <div>
                          <Label className="text-[11px] text-muted-foreground">Max Tokens (Fast)</Label>
                          <Input
                            className="h-8 text-xs mt-1"
                            value={modelDraft.max_tokens_fast}
                            onChange={(e) => setModelDraft((d) => ({ ...d, max_tokens_fast: e.target.value }))}
                            placeholder="8192"
                            disabled={isDefaultModelCloudReadOnly}
                          />
                        </div>
                        <div className="col-span-2 flex items-center justify-between rounded-md border border-border/40 px-2 py-1.5">
                          <div>
                            <Label className="text-[11px] text-muted-foreground">Thinking 模式</Label>
                            <p className="text-[11px] text-muted-foreground/80">Qwen3.* 推理模型建议开启，fast 任务会自动降级关闭。</p>
                          </div>
                          <Switch
                            checked={modelDraft.enable_thinking}
                            onCheckedChange={(checked) => setModelDraft((d) => ({ ...d, enable_thinking: checked }))}
                            disabled={isDefaultModelCloudReadOnly}
                          />
                        </div>
                        <div className="col-span-2 flex items-center justify-between rounded-md border border-border/40 px-2 py-1.5">
                          <div>
                            <Label className="text-[11px] text-muted-foreground">并行工具调用</Label>
                            <p className="text-[11px] text-muted-foreground/80">复杂任务可更快完成；低配机器可关闭以换取稳定性。</p>
                          </div>
                          <Switch
                            checked={modelDraft.parallel_tool_calls}
                            onCheckedChange={(checked) => setModelDraft((d) => ({ ...d, parallel_tool_calls: checked }))}
                            disabled={isDefaultModelCloudReadOnly}
                          />
                        </div>
                        <div className="col-span-2 flex items-center justify-between rounded-md border border-border/40 px-2 py-1.5">
                          <div>
                            <Label className="text-[11px] text-muted-foreground">端点自动发现</Label>
                            <p className="text-[11px] text-muted-foreground/80">仅对本地模型生效。关闭时只使用当前配置的端点 URL；开启后会额外尝试 LM_STUDIO_BASE_URL 及 localhost/127.0.0.1:1234。</p>
                          </div>
                          <Switch
                            checked={modelDraft.enable_endpoint_discovery}
                            onCheckedChange={(checked) => setModelDraft((d) => ({ ...d, enable_endpoint_discovery: checked }))}
                            disabled={isDefaultModelCloudReadOnly}
                          />
                        </div>
                        <div className="col-span-2">
                          <Label className="text-[11px] text-muted-foreground">API Key 环境变量（可选）</Label>
                          <Input
                            className="h-8 text-xs mt-1"
                            value={modelDraft.api_key_env}
                            onChange={(e) => setModelDraft((d) => ({ ...d, api_key_env: e.target.value }))}
                            placeholder={t('settings.placeholder.apiKeyEnvExample')}
                            disabled={isDefaultModelCloudReadOnly}
                          />
                        </div>
                      </div>
                    </div>
                  )}

                  {!showAddModel ? (
                    <Button size="sm" variant="outline" className="text-xs" onClick={() => setShowAddModel(true)}>
                      + 添加模型
                    </Button>
                  ) : (
                    <div className="space-y-2 p-3 border rounded-md">
                      <Label className="text-xs font-medium">添加新模型</Label>
                      <div className="grid grid-cols-2 gap-2">
                        <Input
                          className="h-8 text-xs"
                          placeholder={t('settings.placeholder.modelIdExample')}
                          value={newModelForm.id}
                          onChange={e => setNewModelForm(f => ({ ...f, id: e.target.value }))}
                        />
                        <Input
                          className="h-8 text-xs"
                          placeholder={t('settings.placeholder.displayName')}
                          value={newModelForm.name}
                          onChange={e => setNewModelForm(f => ({ ...f, name: e.target.value }))}
                        />
                        <Select
                          value={newModelForm.provider}
                          onValueChange={v => setNewModelForm(f => ({ ...f, provider: v }))}
                        >
                          <SelectTrigger className="h-8 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="openai">OpenAI</SelectItem>
                            <SelectItem value="anthropic">Anthropic</SelectItem>
                            <SelectItem value="google_genai">Google GenAI</SelectItem>
                            <SelectItem value="ollama">Ollama</SelectItem>
                          </SelectContent>
                        </Select>
                        <Input
                          className="h-8 text-xs"
                          placeholder={t('settings.placeholder.apiUrlOptional')}
                          value={newModelForm.url}
                          onChange={e => setNewModelForm(f => ({ ...f, url: e.target.value }))}
                        />
                        <Select
                          value={newModelForm.tier}
                          onValueChange={(v: 'local' | 'cloud') => setNewModelForm(f => ({ ...f, tier: v }))}
                        >
                          <SelectTrigger className="h-8 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="local">本地 (local)</SelectItem>
                            <SelectItem value="cloud">云端 (cloud)</SelectItem>
                          </SelectContent>
                        </Select>
                        <Input
                          className="h-8 text-xs col-span-2"
                          placeholder={t('settings.placeholder.apiKeyEnvOptional')}
                          value={newModelForm.api_key_env}
                          onChange={e => setNewModelForm(f => ({ ...f, api_key_env: e.target.value }))}
                        />
                      </div>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          className="text-xs"
                          disabled={!newModelForm.id.trim() || !newModelForm.name.trim()}
                          onClick={async () => {
                            try {
                              const body: any = { id: newModelForm.id.trim(), name: newModelForm.name.trim(), provider: newModelForm.provider, tier: newModelForm.tier };
                              if (newModelForm.url.trim()) body.url = newModelForm.url.trim();
                              if (newModelForm.api_key_env.trim()) body.api_key_env = newModelForm.api_key_env.trim();
                              await modelsApi.add(body);
                              await loadModels();
                              setNewModelForm({ id: '', name: '', provider: 'openai', url: '', api_key_env: '', tier: 'local' });
                              setShowAddModel(false);
                            } catch (e) {
                              toast.error(t("settings.modelAddFailed"), { description: e instanceof Error ? e.message : String(e) });
                            }
                          }}
                        >
                          {t('settings.confirmAdd')}
                        </Button>
                        <Button size="sm" variant="ghost" className="text-xs" onClick={() => setShowAddModel(false)}>
                          {t('settings.cancel')}
                        </Button>
                      </div>
                    </div>
                  )}

                    </>
                  )}

              {section === 'appearance' && (
                <>
                  <div className="space-y-2">
                    <Label className="text-xs font-medium">{t('settings.language', locale)}</Label>
                    <Select
                      value={locale}
                      onValueChange={(v) => {
                        const next = v === 'en-US' ? 'en-US' : 'zh-CN';
                        setLocaleState(next);
                        setLocale(next);
                      }}
                    >
                      <SelectTrigger className="h-8 w-[140px] text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="zh-CN">简体中文</SelectItem>
                        <SelectItem value="en-US">English</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <Separator />
                  <div className="flex items-center justify-between">
                    <div>
                      <Label className="text-xs font-medium">{t('settings.autoDetectColorScheme')}</Label>
                      <p className="text-[11px] text-muted-foreground">{t('settings.autoDetectColorSchemeDesc')}</p>
                    </div>
                    <Switch
                      checked={autoDetectColorScheme}
                      onCheckedChange={(checked) => {
                        setAutoDetectColorScheme(!!checked);
                        try { setStorageItem('maibot_auto_detect_color_scheme', String(!!checked)); } catch { /* ignore */ }
                      }}
                    />
                  </div>
                  <Separator />
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Palette className="h-4 w-4" />
                      <div>
                        <Label className="text-xs font-medium">{t('settings.darkMode')}</Label>
                        <p className="text-[11px] text-muted-foreground">{t('settings.darkModeDesc')}</p>
                      </div>
                    </div>
                    <Switch checked={isDarkMode} onCheckedChange={handleDarkModeChange} disabled={autoDetectColorScheme} />
                  </div>
                  <Separator />
                  <div>
                    <Label className="text-xs font-medium">{t('settings.fontSize')}</Label>
                    <p className="text-[11px] text-muted-foreground mt-0.5">{t('settings.fontSizeDesc')}</p>
                    <Select
                      value={String(fontSize)}
                      onValueChange={(v) => {
                        const n = parseInt(v, 10);
                        if (Number.isNaN(n)) return;
                        setFontSize(n);
                        try {
                          setStorageItem('maibot_font_size', String(n));
                          document.documentElement.style.setProperty('--font-size', n + 'px');
                          toast.success(t('settings.fontSizeApplied'));
                        } catch { /* ignore */ }
                      }}
                    >
                      <SelectTrigger className="h-8 w-[100px] text-xs mt-1">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {[14, 15, 16, 18].map((n) => (
                          <SelectItem key={n} value={String(n)}>{n}px</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Separator />
                  <div className="space-y-2">
                    <Label className="text-xs font-medium">{t('settings.editorIndentWrap')}</Label>
                    <div className="flex items-center gap-2">
                      <Select
                        value={String(editorTabSize)}
                        onValueChange={(v) => {
                          const n = parseInt(v, 10);
                          if (Number.isNaN(n)) return;
                          setEditorTabSize(n);
                          setStorageItem('maibot_editor_tab_size', String(n));
                        }}
                      >
                        <SelectTrigger className="h-8 w-[120px] text-xs">
                          <SelectValue placeholder={t('settings.tabWidth')} />
                        </SelectTrigger>
                        <SelectContent>
                          {[2, 4, 8].map((n) => (
                            <SelectItem key={n} value={String(n)}>Tab {n}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Select
                        value={editorWordWrap}
                        onValueChange={(v) => {
                          const next = v === 'off' ? 'off' : 'on';
                          setEditorWordWrap(next);
                          setStorageItem('maibot_editor_word_wrap', next);
                        }}
                      >
                        <SelectTrigger className="h-8 w-[120px] text-xs">
                          <SelectValue placeholder={t('settings.wordWrap')} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="on">{t('settings.wordWrapOn')}</SelectItem>
                          <SelectItem value="off">{t('settings.wordWrapOff')}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <p className="text-[11px] text-muted-foreground">{t('settings.editorIndentWrapHint')}</p>
                  </div>
                  <Separator />
                  <div className="space-y-2">
                    <Label className="text-xs font-medium">{t('settings.layoutGroup')}</Label>
                    <div className="flex items-center justify-between">
                      <div>
                        <Label className="text-xs font-medium">{t('settings.leftPanelOpenByDefault')}</Label>
                        <p className="text-[11px] text-muted-foreground">{t('settings.leftPanelOpenByDefaultDesc')}</p>
                      </div>
                      <Switch
                        checked={leftPanelOpenByDefault}
                        onCheckedChange={(checked) => {
                          setLeftPanelOpenByDefault(!!checked);
                          try { setStorageItem('maibot_left_panel_open_by_default', String(!!checked)); } catch { /* ignore */ }
                          toast.success(t('settings.layoutApplied'));
                        }}
                      />
                    </div>
                    <div className="flex items-center justify-between">
                      <div>
                        <Label className="text-xs font-medium">{t('settings.rightPanelOpenByDefault')}</Label>
                        <p className="text-[11px] text-muted-foreground">{t('settings.rightPanelOpenByDefaultDesc')}</p>
                      </div>
                      <Switch
                        checked={rightPanelOpenByDefault}
                        onCheckedChange={(checked) => {
                          setRightPanelOpenByDefault(!!checked);
                          try { setStorageItem('maibot_right_panel_open_by_default', String(!!checked)); } catch { /* ignore */ }
                          toast.success(t('settings.layoutApplied'));
                        }}
                      />
                    </div>
                    <div className="flex items-center justify-between">
                      <div>
                        <Label className="text-xs font-medium">{t('settings.editorMinimap')}</Label>
                        <p className="text-[11px] text-muted-foreground">{t('settings.editorMinimapDesc')}</p>
                      </div>
                      <Switch
                        checked={editorMinimap}
                        onCheckedChange={(checked) => {
                          setEditorMinimap(!!checked);
                          try {
                            setStorageItem('maibot_editor_minimap', String(!!checked));
                            toast.success(t('settings.layoutApplied'));
                          } catch { /* ignore */ }
                        }}
                      />
                    </div>
                  </div>
                  <Separator />
                  <div>
                    <Label className="text-xs font-medium">{t('settings.themeAccent')}</Label>
                    <p className="text-[11px] text-muted-foreground mt-0.5">{t('settings.themeAccentDesc')}</p>
                    <div className="grid grid-cols-6 gap-2 mt-2">
                      {THEME_ACCENT_CLASSES.map((colorClass, i) => {
                        const key = THEME_ACCENT_KEYS[i];
                        const isSelected = themeAccent === key;
                        return (
                          <button
                            key={key}
                            type="button"
                            aria-label={`${t('settings.themeAccent')} ${key}`}
                            className={cn(
                              'h-8 rounded-md transition-all hover:ring-2 ring-offset-2 ring-offset-background',
                              colorClass,
                              isSelected && 'ring-2 ring-foreground/30'
                            )}
                            onClick={() => {
                              setThemeAccent(key);
                              applyThemeAccent(key);
                              try { setStorageItem(STORAGE_KEY, key); } catch { /* ignore */ }
                              toast.success(t('settings.themeAccentApplied'));
                            }}
                          />
                        );
                      })}
                    </div>
                  </div>
                </>
              )}

              {section === 'rules' && (
                <div className="space-y-6">
                  <SettingsSectionHeader title={t('settings.sectionTitle.rules')} description={t('settings.sectionDesc.rules')} />
                  <Card className="rounded-lg border border-border/60">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm">{t('settings.rulesForAITitle')}</CardTitle>
                      <CardDescription>{t('settings.rulesForAIDesc')}</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3 pt-0">
                      <p className="text-[11px] text-muted-foreground">{t('settings.rulesForAIHint')}</p>
                      <p className="text-[11px] text-muted-foreground">{t('settings.rulesHierarchy')}</p>
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" variant="outline" onClick={() => setSection('advanced')} className="text-xs">
                          {t('settings.rulesOpenConfig')}
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                </div>
              )}

              {section === 'extensions' && (
                <div className="space-y-6">
                  <SettingsSectionHeader title={t('settings.sectionTitle.extensions')} description={t('settings.sectionDesc.extensions')} />
                  {loadErrorSection === 'extensions' && (
                    <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 flex flex-col items-center gap-3 text-center">
                      <p className="text-sm text-muted-foreground">{t("settings.loadError")}</p>
                      <Button size="sm" variant="outline" onClick={() => void loadExtensions()}>{t("settings.loadErrorRetry")}</Button>
                    </div>
                  )}
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm">{t('settings.extensionsPluginsTitle')}</CardTitle>
                      <CardDescription className="text-[11px]">{t('settings.extensionsPluginsDesc')}</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3 pt-0">
                  <div className="rounded-md border p-3 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Server className="h-4 w-4" />
                        <div>
                          <Label className="text-xs font-medium">{t('settings.extensionsPluginsTitle')}</Label>
                          <p className="text-[11px] text-muted-foreground">{t('settings.extensionsPluginsDesc')}</p>
                          <p className="text-[11px] text-muted-foreground mt-1.5">{t('settings.pluginSlashConflictNote')}</p>
                        </div>
                      </div>
                      <Button variant="outline" size="sm" onClick={() => void loadExtensions()} disabled={pluginsLoading}>
                        <RefreshCw className={cn('h-4 w-4 mr-1', pluginsLoading && 'animate-spin')} />
                        {t('settings.refresh')}
                      </Button>
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {t('settings.pluginsTierInstalled', { tier: pluginsTier, count: pluginsInstalledCount })}
                      {pluginsMaxAllowed < 0 ? ` / ${t('settings.unlimited')}` : ` / ${pluginsMaxAllowed}`}
                    </div>
                    <p className="text-xs font-medium text-muted-foreground">{t('settings.extensionsQuotaTitle')}</p>
                    <div className="rounded border border-border/60 p-2 space-y-2">
                      <div className="space-y-1">
                        <div className="flex items-center justify-between text-[11px]">
                          <span className="text-muted-foreground">{t('settings.cloudQuotaDaily')}</span>
                          <span>{quotaText(cloudQuotaUsed, cloudQuotaLimit)}</span>
                        </div>
                        {cloudQuotaLimit < 0 ? (
                          <div className="text-[10px] text-muted-foreground">{t('settings.unlimited')}</div>
                        ) : (
                          <Progress value={quotaPercent(cloudQuotaUsed, cloudQuotaLimit)} className="h-1.5" />
                        )}
                      </div>
                      <div className="space-y-1">
                        <div className="flex items-center justify-between text-[11px]">
                          <span className="text-muted-foreground">{t('settings.autonomousQuotaDaily')}</span>
                          <span>{quotaText(autonomousQuotaUsed, autonomousQuotaLimit)}</span>
                        </div>
                        {autonomousQuotaLimit < 0 ? (
                          <div className="text-[10px] text-muted-foreground">{t('settings.unlimited')}</div>
                        ) : (
                          <Progress value={quotaPercent(autonomousQuotaUsed, autonomousQuotaLimit)} className="h-1.5" />
                        )}
                      </div>
                    </div>
                    <Input
                      className="h-8 text-xs"
                      placeholder={t('settings.searchPluginsPlaceholder')}
                      value={pluginSearch}
                      onChange={(e) => setPluginSearch(e.target.value)}
                    />
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant={pluginFilter === 'all' ? 'secondary' : 'outline'}
                        className="text-[11px] h-7"
                        onClick={() => setPluginFilter('all')}
                      >
                        {t('settings.filterAll')}
                      </Button>
                      <Button
                        size="sm"
                        variant={pluginFilter === 'installed' ? 'secondary' : 'outline'}
                        className="text-[11px] h-7"
                        onClick={() => setPluginFilter('installed')}
                      >
                        {t('settings.filterInstalled')}
                      </Button>
                      <Button
                        size="sm"
                        variant={pluginFilter === 'installable' ? 'secondary' : 'outline'}
                        className="text-[11px] h-7"
                        onClick={() => setPluginFilter('installable')}
                      >
                        {t('settings.filterInstallable')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-[11px] h-7 ml-auto"
                        onClick={() => {
                          setPluginFilter('all');
                          setPluginSearch('');
                        }}
                      >
                        {t('settings.clearFilter')}
                      </Button>
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {t('settings.filterResultCount', { filtered: filteredPlugins.length, total: sortedPlugins.length })}
                    </div>
                    <ScrollArea className="h-[220px] rounded border">
                      {filteredPlugins.length > 0 ? (
                        <div className="p-2 space-y-2">
                          {filteredPlugins.map((p) => (
                            <div
                              key={p.name}
                              className={cn(
                                "rounded border p-2 space-y-2 cursor-pointer",
                                selectedPlugin?.name === p.name && "border-primary/60 bg-primary/5"
                              )}
                              onClick={() => setPluginDetailName(p.name)}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <div className="min-w-0">
                                  <div className="text-xs font-medium truncate">{p.display_name || p.name}</div>
                                  <div className="text-[11px] text-muted-foreground truncate">{p.description || p.name}</div>
                                  <div className="text-[10px] text-muted-foreground mt-1">
                                    {pluginComponentsSummary(p.components)}
                                  </div>
                                </div>
                                <div className="flex items-center gap-2">
                                  {p.category ? <Badge variant="outline" className="text-[10px]">{p.category}</Badge> : null}
                                  {p.source_label ? <Badge variant="outline" className="text-[10px]">{p.source_label}</Badge> : null}
                                  <Badge variant="outline" className="text-[10px]">{p.requires_tier || 'free'}</Badge>
                                  {p.loaded ? (
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="text-[11px]"
                                      disabled={pluginActionName === p.name}
                                      onClick={() => handleUninstallPlugin(p.name)}
                                    >
                                      {t('settings.uninstall')}
                                    </Button>
                                  ) : (
                                    <Button
                                      size="sm"
                                      variant="secondary"
                                      className="text-[11px]"
                                      disabled={
                                        pluginActionName === p.name
                                        || (pluginsMaxAllowed >= 0 && pluginsInstalledCount >= pluginsMaxAllowed && pluginsMaxAllowed !== 0)
                                      }
                                      onClick={() => handleInstallPlugin(p.name)}
                                      title={
                                        (pluginsMaxAllowed >= 0 && pluginsInstalledCount >= pluginsMaxAllowed && pluginsMaxAllowed !== 0)
                                          ? `插件数量已达上限（${pluginsMaxAllowed}）`
                                          : undefined
                                      }
                                    >
                                      {t('settings.install')}
                                    </Button>
                                  )}
                                </div>
                              </div>
                              {p.update_available && (
                                <p className="text-[11px] text-blue-600 dark:text-blue-400">
                                  检测到新版本：{p.version} → {p.remote_version || "latest"}
                                </p>
                              )}
                              {!p.eligible && (
                                <p className="text-[11px] text-amber-600 dark:text-amber-400">
                                  {t('settings.upgradeToUnlockPlugin')}
                                </p>
                              )}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="flex items-center justify-center h-full text-[11px] text-muted-foreground">
                          {t("settings.noPluginsInFilter")}
                        </div>
                      )}
                    </ScrollArea>
                    {selectedPlugin && (
                      <div className="rounded border border-border/60 p-2 space-y-1.5">
                        <div className="text-xs font-medium">{t('settings.pluginDetailTitle')} · {selectedPlugin.display_name || selectedPlugin.name}</div>
                        <div className="text-[11px] text-muted-foreground">{t('settings.pluginVersion')} {selectedPlugin.version}{selectedPlugin.remote_version ? ` / ${t('settings.pluginRemoteVersion')} ${selectedPlugin.remote_version}` : ''}</div>
                        <div className="text-[11px] text-muted-foreground">{t('settings.pluginSource')} {selectedPlugin.source_label || 'local'} · {t('settings.pluginCategory')} {selectedPlugin.category || 'Uncategorized'}</div>
                        <div className="text-[11px] text-muted-foreground">{t('settings.pluginComponents')} {pluginComponentsSummary(selectedPlugin.components)}</div>
                        {selectedPlugin.compatibility?.min_version ? (
                          <div className="text-[11px] text-muted-foreground">{t('settings.pluginMinSystemVersion')} {selectedPlugin.compatibility.min_version}</div>
                        ) : null}
                        {selectedPlugin.changelog ? (
                          <div className="text-[11px] text-muted-foreground line-clamp-3">{t('settings.pluginChangelog')}：{selectedPlugin.changelog}</div>
                        ) : null}
                      </div>
                    )}
                  </div>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm">{t('settings.extensionsMCPTitle')}</CardTitle>
                      <CardDescription className="text-[11px]">Model Context Protocol 服务器管理</CardDescription>
                    </CardHeader>
                    <CardContent className="pt-0">
                      <MCPManager />
                    </CardContent>
                  </Card>
                </div>
              )}

              {section === 'shortcuts' && (
                <div className="space-y-6">
                  <SettingsSectionHeader title={t('settings.sectionTitle.shortcuts')} description={t('settings.sectionDesc.shortcuts')} />
                  <div className="space-y-6">
                    {SHORTCUT_GROUPS.map((g) => (
                      <div key={g.group}>
                        <div className="text-xs font-semibold text-muted-foreground mb-2">{t(g.group)}</div>
                        <div className="rounded-md border border-border/50 overflow-hidden">
                          <table className="w-full text-xs">
                            <tbody>
                              {g.items.map((row, i) => (
                                <tr key={i} className={cn(i > 0 && 'border-t border-border/20')}>
                                  <td className="py-2 px-3 text-foreground">{t(row.label)}</td>
                                  <td className="py-2 px-3 text-right font-mono text-muted-foreground">{row.keys}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {section === 'agent_profile' && (
                <div className="space-y-6">
                  <SettingsSectionHeader title={t('settings.sectionTitle.agentProfile')} description={t('settings.sectionDesc.agentProfile')} />
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">{t('settings.agentProfileCardTitle')}</CardTitle>
                    <CardDescription>{t('settings.agentProfileCardDesc')}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {loadErrorSection === 'agent_profile' ? (
                      <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 flex flex-col items-center gap-3 text-center">
                        <p className="text-sm text-muted-foreground">{t("settings.loadError")}</p>
                        <Button size="sm" variant="outline" onClick={() => void loadAgentProfile()}>
                          {t("settings.loadErrorRetry")}
                        </Button>
                      </div>
                    ) : loading ? (
                      <div className="space-y-3">
                        <div className="h-10 rounded-md bg-muted/60 animate-pulse" />
                        <div className="grid grid-cols-2 gap-2">
                          {[1, 2, 3, 4].map((i) => (
                            <div key={i} className="h-8 rounded bg-muted/50 animate-pulse" />
                          ))}
                        </div>
                        <div className="h-16 rounded-md bg-muted/40 animate-pulse" />
                      </div>
                    ) : (
                      <>
                        <div className="rounded-md border p-3 space-y-3">
                          <div className="flex items-center justify-between">
                            <div>
                              <Label className="text-xs font-medium">{t('settings.personaLabel')}</Label>
                              <p className="text-[11px] text-muted-foreground mt-0.5">{t('settings.personaHint')}</p>
                            </div>
                            <Button size="sm" variant="outline" onClick={handleSavePersona} disabled={personaSaving}>
                              {personaSaving ? t('settings.saving') : t('settings.savePersona')}
                            </Button>
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            <div className="space-y-1">
                              <Label className="text-xs">{t('settings.personaName')}</Label>
                              <Input
                                value={persona.name ?? ''}
                                onChange={(e) => setPersona((p) => ({ ...p, name: e.target.value }))}
                                placeholder="MAIBOT"
                                className="h-8 text-xs"
                              />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">{t('settings.personaRelationship')}</Label>
                              <Input
                                value={persona.relationship ?? ''}
                                onChange={(e) => setPersona((p) => ({ ...p, relationship: e.target.value }))}
                                placeholder="default"
                                className="h-8 text-xs"
                              />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">{t('settings.personaTone')}</Label>
                              <Input
                                value={persona.tone ?? ''}
                                onChange={(e) => setPersona((p) => ({ ...p, tone: e.target.value }))}
                                placeholder="professional"
                                className="h-8 text-xs"
                              />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">{t('settings.personaCommunicationStyle')}</Label>
                              <Input
                                value={persona.communication_style ?? ''}
                                onChange={(e) => setPersona((p) => ({ ...p, communication_style: e.target.value }))}
                                placeholder="concise"
                                className="h-8 text-xs"
                              />
                            </div>
                          </div>
                        </div>

                        <div className="rounded-md border p-3 space-y-3">
                          <div className="flex items-center justify-between">
                            <div>
                              <Label className="text-xs font-medium">{t('settings.userPreferencesLabel')}</Label>
                              <p className="text-[11px] text-muted-foreground mt-0.5">
                                {t('settings.userPreferencesHint')}
                              </p>
                            </div>
                            <Button size="sm" variant="outline" onClick={handleSaveUserProfile} disabled={userProfileSaving}>
                              {userProfileSaving ? t('settings.saving') : t('settings.savePreferences')}
                            </Button>
                          </div>
                          <div className="grid gap-2">
                            <Label className="text-xs">沟通风格</Label>
                            <Select
                              value={userProfile.communication_style || 'none'}
                              onValueChange={(v) => setUserProfile((p) => ({ ...p, communication_style: v === 'none' ? '' : v }))}
                            >
                              <SelectTrigger className="h-8 text-xs">
                                <SelectValue placeholder={t('settings.placeholder.selectStyleOptional')} />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="none">不指定</SelectItem>
                                <SelectItem value="casual">轻松</SelectItem>
                                <SelectItem value="professional">专业</SelectItem>
                                <SelectItem value="academic">学术</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="grid gap-2">
                            <Label className="text-xs">回复详细程度</Label>
                            <Select
                              value={userProfile.detail_level || 'none'}
                              onValueChange={(v) => setUserProfile((p) => ({ ...p, detail_level: v === 'none' ? '' : v }))}
                            >
                              <SelectTrigger className="h-8 text-xs">
                                <SelectValue placeholder={t('settings.placeholder.selectOptional')} />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="none">不指定</SelectItem>
                                <SelectItem value="brief">简洁</SelectItem>
                                <SelectItem value="normal">适中</SelectItem>
                                <SelectItem value="detailed">详细</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="grid gap-2">
                            <Label className="text-xs">用户专业度</Label>
                            <Select
                              value={userProfile.domain_expertise || 'none'}
                              onValueChange={(v) => setUserProfile((p) => ({ ...p, domain_expertise: v === 'none' ? '' : v }))}
                            >
                              <SelectTrigger className="h-8 text-xs">
                                <SelectValue placeholder={t('settings.placeholder.selectOptional')} />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="none">不指定</SelectItem>
                                <SelectItem value="beginner">初学者</SelectItem>
                                <SelectItem value="intermediate">中级</SelectItem>
                                <SelectItem value="expert">专家</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="grid gap-2">
                            <Label className="text-xs">专业领域（每行一条，格式：领域:级别）</Label>
                            <Textarea
                              className="min-h-[60px] text-xs font-mono"
                              placeholder={t('settings.placeholder.domainLevelExample')}
                              value={Object.entries(userProfile.expertise_areas || {})
                                .map(([k, v]) => `${k}:${v}`)
                                .join('\n')}
                              onChange={(e) => {
                                const lines = e.target.value.split('\n').filter((l) => l.trim());
                                const next: Record<string, string> = {};
                                for (const line of lines) {
                                  const idx = line.indexOf(':');
                                  if (idx > 0) {
                                    const key = line.slice(0, idx).trim();
                                    const val = line.slice(idx + 1).trim();
                                    if (key && val) next[key] = val;
                                  }
                                }
                                setUserProfile((p) => ({ ...p, expertise_areas: next }));
                              }}
                            />
                            <p className="text-[10px] text-muted-foreground">级别可选：beginner / intermediate / expert</p>
                          </div>
                          {(userProfile.learning_trajectory?.length ?? 0) > 0 && (
                            <div className="grid gap-2">
                              <Label className="text-xs">成长轨迹（由系统自动更新，只读）</Label>
                              <div className="rounded-md border bg-muted/30 px-2 py-1.5 text-xs text-muted-foreground max-h-24 overflow-y-auto">
                                {(userProfile.learning_trajectory ?? []).map((item, i) => (
                                  <div key={i}>{item}</div>
                                ))}
                              </div>
                            </div>
                          )}
                          <div className="grid gap-2">
                            <Label className="text-xs">自定义规则（每行一条，如 Cursor Rules）</Label>
                            <Textarea
                              className="min-h-[80px] text-xs"
                              placeholder={t('settings.placeholder.preferencesExample')}
                              value={(userProfile.custom_rules || []).join('\n')}
                              onChange={(e) =>
                                setUserProfile((p) => ({
                                  ...p,
                                  custom_rules: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean),
                                }))
                              }
                            />
                          </div>
                        </div>

                        {roles.length > 0 && (
                          <div className="grid gap-2">
                            <Label className="text-xs">当前角色</Label>
                            <Select
                              value={scopedActiveRoleId || "none"}
                              onValueChange={async (roleId) => {
                                if (!roleId || roleId === "none") return;
                                setRoleActivating(true);
                                try {
                                  const rawThreadId = getCurrentThreadIdFromStorage();
                                  const threadId = validServerThreadIdOrUndefined(rawThreadId);
                                  const r = await rolesApi.activateRole(roleId, { threadId });
                                  if (r.ok) {
                                    const res = await boardApi.getAgentProfile();
                                    if (res.ok && res.profile) setAgentProfile(res.profile);
                                    try {
                                      setScopedActiveRoleIdInStorage(roleId, threadId ?? undefined);
                                      setScopedActiveRoleId(roleId);
                                      const role = roles.find((it) => it.id === roleId);
                                      const profileFromRole = String(role?.skill_profile || "").trim().toLowerCase();
                                      if (profileFromRole) {
                                        setStorageItem("maibot_skill_profile", profileFromRole);
                                        window.dispatchEvent(new CustomEvent(EVENTS.SKILL_PROFILE_CHANGED, { detail: { profileId: profileFromRole } }));
                                      }
                                      window.dispatchEvent(new CustomEvent(EVENTS.COMPOSER_PREFS_CHANGED));
                                      window.dispatchEvent(new CustomEvent(EVENTS.ROLE_CHANGED, { detail: { roleId, threadId: threadId ?? undefined, source: "settings" } }));
                                    } catch (err) {
                                      if (typeof import.meta !== "undefined" && import.meta.env?.DEV) {
                                        console.warn("[SettingsView] 角色偏好写入失败", err);
                                      }
                                    }
                                    toast.success(t("settings.roleSwitched"));
                                  } else {
                                    toast.error(r.error ?? '切换角色失败');
                                  }
                                } finally {
                                  setRoleActivating(false);
                                }
                              }}
                              disabled={roleActivating}
                            >
                              <SelectTrigger className="h-8 text-xs">
                                <SelectValue placeholder={t('settings.placeholder.selectRole')} />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="none">未选择角色</SelectItem>
                                {roles.map((r) => (
                                  <SelectItem key={r.id} value={r.id}>
                                    {r.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <p className="text-[11px] text-muted-foreground">切换角色将更新名称、描述与技能配置</p>
                            <p className="text-[11px] text-muted-foreground/90">
                              角色决定助理是谁（语气、风格）；Skills 决定能做什么（流程、工具、领域知识）。
                            </p>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="mt-1"
                              onClick={async () => {
                                try {
                                  const r = await rolesApi.reloadRoles();
                                  if (r.error) {
                                    toast.error(r.error);
                                  } else {
                                    await loadAgentProfile();
                                    toast.success(t("settings.roleRediscovered"));
                                  }
                                } catch (e) {
                                  toast.error(e instanceof Error ? e.message : String(e));
                                }
                              }}
                            >
                              <RefreshCw className="h-3.5 w-3.5 mr-1" />
                              重新发现角色
                            </Button>
                          </div>
                        )}
                        <div className="grid gap-2">
                          <Label className="text-xs">许可证</Label>
                          {licenseStatus != null && (
                            <div className="flex items-center gap-2 text-[11px]">
                              <span className="text-muted-foreground">服务器状态：</span>
                              <Badge variant="outline">{licenseStatus.ok ? (licenseStatus.tier ?? '—') : (licenseStatus.error ?? '加载失败')}</Badge>
                              {licenseStatus.limits != null && (
                                <span className="text-muted-foreground">
                                  云模型 {licenseStatus.usage?.cloud_model_requests_today ?? 0}/{licenseStatus.limits?.cloud_model_requests_daily ?? 0}，
                                  自治 {licenseStatus.usage?.autonomous_tasks_today ?? 0}/{licenseStatus.limits?.max_daily_autonomous_tasks ?? 0}
                                </span>
                              )}
                            </div>
                          )}
                          <div className="flex items-center gap-2">
                            <Label className="text-xs shrink-0">层级（本机）</Label>
                            <Select
                              value={licenseTier}
                              onValueChange={(value) => {
                                const next = persistLicenseTier(value, 'settings');
                                setLicenseTier(next);
                                toast.success(`已切换许可证层级：${next}`);
                              }}
                            >
                              <SelectTrigger className="h-8 text-xs">
                                <SelectValue placeholder={t('settings.placeholder.selectLicenseTier')} />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="free">free（免费）</SelectItem>
                                <SelectItem value="pro">pro（专业）</SelectItem>
                                <SelectItem value="enterprise">enterprise（企业）</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="flex flex-wrap items-end gap-2">
                            <div className="flex-1 min-w-[160px]">
                              <Label className="text-[11px] text-muted-foreground">License Key（可选）</Label>
                              <Input
                                className="h-8 text-xs mt-0.5"
                                placeholder={t('settings.placeholder.activationCode')}
                                value={licenseKeyInput}
                                onChange={(e) => setLicenseKeyInput(e.target.value)}
                                type="password"
                                autoComplete="off"
                              />
                            </div>
                            <Button
                              size="sm"
                              variant="secondary"
                              className="h-8"
                              disabled={licenseActivating || !licenseKeyInput.trim()}
                              onClick={async () => {
                                setLicenseActivating(true);
                                try {
                                  const res = await activateLicense(licenseTier, licenseKeyInput.trim() || undefined);
                                  if (res.ok) {
                                    toast.success(`已激活：${res.tier ?? licenseTier}`);
                                    setLicenseKeyInput('');
                                    const next = await getLicenseStatus();
                                    setLicenseStatus(next);
                                  } else {
                                    toast.error(res.error || '激活失败');
                                  }
                                } catch (e) {
                                  toast.error(t("settings.activationFailed"), { description: e instanceof Error ? e.message : String(e) });
                                } finally {
                                  setLicenseActivating(false);
                                }
                              }}
                            >
                              {licenseActivating ? <RefreshCw className="h-3 animate-spin" /> : null}
                              <span className="ml-1">激活</span>
                            </Button>
                          </div>
                          <p className="text-[11px] text-muted-foreground">
                            当前能力：自治上限 {tierCapabilities.maxAutonomyLevel}，云模型{tierCapabilities.cloudModelEnabled ? '已启用' : '未启用'}，
                            进化{tierCapabilities.evolutionEnabled ? '已启用' : '未启用'}，插件上限 {tierCapabilities.maxPlugins < 0 ? '无限' : tierCapabilities.maxPlugins}。
                          </p>
                        </div>
                        <div className="rounded-md border p-3 space-y-3">
                          <div className="flex items-center justify-between">
                            <Label className="text-xs font-medium">自我进化流水线（实验）</Label>
                            <Badge variant="outline" className="text-[10px]">{evolutionEngineKind}</Badge>
                          </div>
                          <p className="text-[11px] text-muted-foreground">
                            gated 代码升级：{evolutionGatedAllowed ? '允许' : '不允许'} · idle loop：{evolutionIdleAllowed ? '允许' : '不允许'}
                          </p>
                          <div className="grid gap-2">
                            <Label className="text-xs">目标域</Label>
                            <Select value={evolutionTarget} onValueChange={setEvolutionTarget}>
                              <SelectTrigger className="h-8 text-xs">
                                <SelectValue placeholder={t('settings.placeholder.selectTargetDomain')} />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="core_engine">core_engine</SelectItem>
                                <SelectItem value="skills">skills</SelectItem>
                                <SelectItem value="knowledge">knowledge</SelectItem>
                                <SelectItem value="tools">tools</SelectItem>
                                <SelectItem value="ontology">ontology</SelectItem>
                              </SelectContent>
                            </Select>
                            <p className="text-[11px] text-muted-foreground">{evolutionTargetDescription}</p>
                          </div>
                          <div className="grid gap-2">
                            <Label className="text-xs">
                              进化标题
                              {!evolutionTitleValid ? <span className="ml-1 text-amber-600 dark:text-amber-400">*必填</span> : null}
                            </Label>
                            <Input
                              className={cn(
                                'h-8 text-xs',
                                !evolutionTitleValid && 'border-amber-500/60 focus-visible:ring-amber-500/50'
                              )}
                              value={evolutionTitle}
                              onChange={(e) => setEvolutionTitle(e.target.value)}
                              placeholder={t('settings.placeholder.evolutionGoalExample')}
                            />
                          </div>
                          <div className="grid gap-2">
                            <Label className="text-xs">
                              进化动机
                              {!evolutionMotivationValid ? <span className="ml-1 text-amber-600 dark:text-amber-400">*必填</span> : null}
                            </Label>
                            <Textarea
                              className={cn(
                                'min-h-[60px] text-xs',
                                !evolutionMotivationValid && 'border-amber-500/60 focus-visible:ring-amber-500/50'
                              )}
                              value={evolutionMotivation}
                              onChange={(e) => setEvolutionMotivation(e.target.value)}
                              placeholder={t('settings.placeholder.evolutionReason')}
                            />
                          </div>
                          <div className="grid gap-2">
                            <Label className="text-xs">
                              进化计划
                              {!evolutionPlanValid ? <span className="ml-1 text-amber-600 dark:text-amber-400">*必填</span> : null}
                            </Label>
                            <Textarea
                              className={cn(
                                'min-h-[90px] text-xs',
                                !evolutionPlanValid && 'border-amber-500/60 focus-visible:ring-amber-500/50'
                              )}
                              value={evolutionPlan}
                              onChange={(e) => setEvolutionPlan(e.target.value)}
                              placeholder={t('settings.placeholder.evolutionSteps')}
                            />
                          </div>
                          <div className="flex items-center gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={evolutionRunning || !evolutionDraftReady}
                              onClick={handleCreateEvolutionProposal}
                            >
                              创建提案
                            </Button>
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              disabled={evolutionRunning || !evolutionDraftReady}
                              onClick={handleRunEvolutionPipeline}
                            >
                              试运行流水线
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              disabled={evolutionRunning}
                              onClick={handleResetEvolutionDraft}
                            >
                              恢复默认模板
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              disabled={evolutionRunning}
                              onClick={handleClearEvolutionDraft}
                            >
                              清空草稿
                            </Button>
                          </div>
                          {!evolutionDraftReady ? (
                            <p className="text-[11px] text-muted-foreground">请先填写完整的标题、动机与计划，再执行提案/流水线。</p>
                          ) : null}
                          <div className="flex items-center justify-between rounded border border-border/60 p-2">
                            <div className="space-y-0.5">
                              <div className="text-[11px]">送审自动发送</div>
                              <div className="text-[10px] text-muted-foreground">开启后点击“一键送审”将直接发送到对话区</div>
                            </div>
                            <Switch checked={evolutionReviewAutoSend} onCheckedChange={setEvolutionReviewAutoSend} />
                          </div>
                          {evolutionLastResult && (
                            <div className="text-[11px] text-muted-foreground rounded border border-border/60 p-2 space-y-1">
                              <div>最近结果：{evolutionLastResult.ok ? '成功' : '失败'}</div>
                              {evolutionLastResult.proposal_path ? <div className="truncate">提案文件：{evolutionLastResult.proposal_path}</div> : null}
                              {(evolutionLastResult.proposal_path || evolutionLastResult.result?.proposal_path) ? (
                                <div className="flex items-center gap-2 pt-1">
                                  <Button type="button" variant="outline" size="sm" className="h-6 text-[11px]" onClick={handleOpenEvolutionProposal}>
                                    打开提案
                                  </Button>
                                  <Button type="button" variant="ghost" size="sm" className="h-6 text-[11px]" onClick={handleCopyEvolutionProposalPath}>
                                    复制路径
                                  </Button>
                                  <Button type="button" variant="secondary" size="sm" className="h-6 text-[11px]" onClick={handleSendEvolutionForReview}>
                                    一键送审
                                  </Button>
                                </div>
                              ) : null}
                              {(evolutionLastResult.result?.stages ?? []).length > 0 ? (
                                <div className="truncate">
                                  阶段：{(evolutionLastResult.result?.stages ?? []).map((s) => `${s.stage}:${s.ok ? 'ok' : 'fail'}`).join(' | ')}
                                </div>
                              ) : null}
                              {evolutionLastResult.error ? <div className="text-amber-600 dark:text-amber-400">{evolutionLastResult.error}</div> : null}
                            </div>
                          )}
                        </div>
                        <div className="grid gap-2">
                          <Label className="text-xs">助理名称</Label>
                          <Input
                            value={agentProfile?.name ?? ''}
                            onChange={(e) => setAgentProfile((p) => (p ? { ...p, name: e.target.value } : { name: e.target.value }))}
                            placeholder={t('settings.placeholder.aiAssistant')}
                          />
                        </div>
                        <div className="grid gap-2">
                          <Label className="text-xs">描述</Label>
                          <Input
                            value={agentProfile?.description ?? ''}
                            onChange={(e) =>
                              setAgentProfile((p) =>
                                p ? { ...p, description: e.target.value } : { name: '', description: e.target.value, capabilities: { skills: [] } }
                              )
                            }
                            placeholder={t('settings.placeholder.officeAndDomain')}
                          />
                        </div>
                        <div className="grid gap-2">
                          <Label className="text-xs">已装备 Skills（多选）</Label>
                          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                            <span>总计 {agentProfileSkills.length}</span>
                            <span>
                              远程 {agentProfileSkills.filter((s) => s.source_type === 'remote').length}
                            </span>
                            <span>
                              本地 {agentProfileSkills.filter((s) => s.source_type !== 'remote').length}
                            </span>
                          </div>
                          <select
                            multiple
                            className="flex min-h-[120px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
                            value={agentProfile?.capabilities?.skills ?? []}
                            onChange={(e) => {
                              const selected = Array.from(e.target.selectedOptions, (o: HTMLOptionElement) => o.value);
                              setAgentProfile((p) => ({
                                ...(p ?? {}),
                                capabilities: { ...(p?.capabilities ?? {}), skills: selected },
                              } as AgentProfile));
                            }}
                          >
                            {agentProfileSkills.map((s) => (
                              <option key={s.name} value={s.name}>
                                {(s.source_type === 'remote' ? '[远程] ' : '[本地] ') + (s.display_name ?? s.name)}
                              </option>
                            ))}
                          </select>
                          {agentProfileSkills.length === 0 && !loading && (
                            <p className="text-[11px] text-muted-foreground">{t("settings.noSkillList")}</p>
                          )}
                          <p className="text-[11px] text-muted-foreground">Ctrl/Cmd+点击多选</p>
                          <div className="flex gap-2 mt-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={async () => {
                                try {
                                  const res = await fetch(`${getApiBase()}/skills/reload`, { method: 'POST' });
                                  const payload = await res.json().catch((): Record<string, unknown> => ({}));
                                  if (res.ok && payload?.ok !== false) {
                                    await loadAgentProfile();
                                    toast.success(t("settings.skillReloaded"));
                                  } else {
                                    const msg = payload?.detail || payload?.error || `HTTP ${res.status}`;
                                    toast.error(typeof msg === 'string' ? msg : '重载失败');
                                  }
                                } catch (e) {
                                  toast.error(e instanceof Error ? e.message : String(e));
                                }
                              }}
                            >
                              <RefreshCw className="h-3.5 w-3.5 mr-1" />
                              重载技能
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => setShowCreateSkillModal(true)}
                            >
                              新建技能
                            </Button>
                          </div>
                          {/* 技能详情列表（编辑/删除） */}
                          {agentProfileSkills.length > 0 && (
                            <div className="space-y-1 mt-2">
                              <Label className="text-[11px] text-muted-foreground">技能管理</Label>
                              {agentProfileSkills.map(s => {
                                const skillKey = `${s.domain ?? 'general'}/${s.name}`;
                                const isDisabled = disabledSkillKeys.includes(skillKey);
                                return (
                                  <div key={skillKey} className="flex items-center justify-between text-xs p-1.5 rounded bg-muted/50">
                                    <span className="truncate">
                                      {s.display_name ?? s.name} <span className="text-muted-foreground">({s.domain ?? 'general'})</span>
                                      {isDisabled && (
                                        <span className="ml-1 text-[11px] px-1 py-0.5 rounded bg-amber-500/15 text-amber-700 dark:text-amber-400 border border-amber-500/25">已禁用</span>
                                      )}
                                      {s.source === 'anthropic' && (
                                        <span className="ml-1 text-[11px] px-1 py-0.5 rounded bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-500/25">官方</span>
                                      )}
                                      {s.source === 'learned' && (
                                        <span className="ml-1 text-[11px] px-1 py-0.5 rounded bg-blue-500/15 text-blue-700 dark:text-blue-400 border border-blue-500/25">学习</span>
                                      )}
                                      {(s.source === 'custom' || !s.source) && (
                                        <span className="ml-1 text-[11px] px-1 py-0.5 rounded border border-border/60">内置</span>
                                      )}
                                      <span className="ml-1 text-[11px] px-1 py-0.5 rounded border border-border/60">
                                        {s.source_type === 'remote' ? '远程市场' : '本地'}
                                      </span>
                                      {s.installed_version ? (
                                        <span className="ml-1 text-[11px] text-muted-foreground">v{s.installed_version}</span>
                                      ) : null}
                                    </span>
                                    <div className="flex gap-1 shrink-0">
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="sm"
                                        className="h-5 px-1.5 text-[11px]"
                                        onClick={async () => {
                                          const next = isDisabled ? disabledSkillKeys.filter((k) => k !== skillKey) : [...disabledSkillKeys, skillKey];
                                          const res = await skillsAPI.patchDisabledSkills(next);
                                          if (res.ok) {
                                            setDisabledSkillKeys(res.disabled ?? []);
                                            toast.success(isDisabled ? '已启用技能' : '已禁用技能');
                                          } else {
                                            toast.error(t("settings.operationFailed"));
                                          }
                                        }}
                                      >
                                        {isDisabled ? '启用' : '禁用'}
                                      </Button>
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="sm"
                                        className="h-5 px-1.5 text-[11px]"
                                        onClick={() => {
                                          const path = `knowledge_base/skills/${s.name}/SKILL.md`;
                                          fileEventBus.openFile(path);
                                          toast.success(`已打开 ${s.name}`);
                                        }}
                                      >
                                        编辑
                                      </Button>
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="sm"
                                        className="h-5 px-1.5 text-[10px] text-destructive hover:text-destructive"
                                        onClick={() => handleDeleteSkill(s)}
                                      >
{t('settings.delete')}
                                        </Button>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                        <div className="grid gap-2">
                          <Label className="text-xs">领域（domains）</Label>
                          <select
                            multiple
                            className="flex min-h-[72px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
                            value={agentProfile?.capabilities?.domains ?? []}
                            onChange={(e) => {
                              const selected = Array.from(e.target.selectedOptions, (o: HTMLOptionElement) => o.value);
                              setAgentProfile((p) => ({
                                ...(p ?? {}),
                                capabilities: { ...(p?.capabilities ?? {}), domains: selected },
                              } as AgentProfile));
                            }}
                          >
                            {['marketing', 'legal', 'office', 'reports', 'research', 'dev'].map((d) => (
                              <option key={d} value={d}>{d}</option>
                            ))}
                          </select>
                          <p className="text-[11px] text-muted-foreground">Ctrl/Cmd+点击多选</p>
                        </div>
                        <div className="grid gap-2">
                          <Label className="text-xs">模式（modes）</Label>
                          <select
                            multiple
                            className="flex min-h-[72px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
                            value={agentProfile?.capabilities?.modes ?? []}
                            onChange={(e) => {
                              const selected = Array.from(e.target.selectedOptions, (o: HTMLOptionElement) => o.value);
                              setAgentProfile((p) => ({
                                ...(p ?? {}),
                                capabilities: { ...(p?.capabilities ?? {}), modes: selected },
                              } as AgentProfile));
                            }}
                          >
                            {['agent', 'ask', 'plan', 'debug', 'review'].map((m) => (
                              <option key={m} value={m}>{m}</option>
                            ))}
                          </select>
                          <p className="text-[11px] text-muted-foreground">Ctrl/Cmd+点击多选</p>
                        </div>
                        <div className="grid gap-2">
                          <Label className="text-xs">最大并行任务数（max_parallel_tasks）</Label>
                          <Input
                            type="number"
                            min={1}
                            max={10}
                            value={agentProfile?.capabilities?.max_parallel_tasks ?? 2}
                            onChange={(e) => {
                              const v = e.target.value;
                              if (v === "") return;
                              const n = parseInt(v, 10);
                              if (Number.isNaN(n) || n < 1 || n > 10) return;
                              setAgentProfile((p) => ({
                                ...(p ?? {}),
                                capabilities: { ...(p?.capabilities ?? {}), max_parallel_tasks: n },
                              } as AgentProfile));
                            }}
                            onBlur={(e) => {
                              const n = parseInt(e.target.value, 10);
                              const clamped = Number.isNaN(n) ? 2 : Math.min(10, Math.max(1, n));
                              if (agentProfile?.capabilities?.max_parallel_tasks !== clamped) {
                                setAgentProfile((p) => ({
                                  ...(p ?? {}),
                                  capabilities: { ...(p?.capabilities ?? {}), max_parallel_tasks: clamped },
                                } as AgentProfile));
                              }
                            }}
                          />
                          <p className="text-[11px] text-muted-foreground">1–10，用于可拆分任务并发</p>
                        </div>
                        <div className="rounded border border-border/50 p-2 bg-muted/30">
                          <Label className="text-xs text-muted-foreground">资源配置（只读）</Label>
                          <p className="text-[11px] mt-1">
                            {String(agentProfile?.resources?.compute_tier ?? 'medium')} · 上下文
                            {agentProfile?.resources?.max_context_tokens != null
                              ? ` ${(Number(agentProfile.resources.max_context_tokens) / 1000).toFixed(0)}K`
                              : ''}
                          </p>
                        </div>
                        <div className="rounded border border-border/50 p-2 bg-muted/30">
                          <Label className="text-xs text-muted-foreground">联网（预留）</Label>
                          <div className="flex items-center gap-2 mt-1" title={t('settings.titlePhase2OpenClaw')}>
                            <Switch
                              checked={!!agentProfile?.network?.openclaw_enabled}
                              disabled
                              aria-label={t('settings.ariaOpenClawPhase2')}
                            />
                            <span className="text-[11px] text-muted-foreground">
                              {agentProfile?.network?.openclaw_enabled ? 'OpenClaw 已启用' : '当前仅本地'}
                            </span>
                          </div>
                          {(agentProfile?.network?.channels?.length ?? 0) > 0 && (
                            <p className="text-[11px] text-muted-foreground mt-1">
                              渠道：{agentProfile!.network!.channels!.join(', ')}
                            </p>
                          )}
                        </div>
                        <Button
                          size="sm"
                          disabled={agentProfileSaving}
                          onClick={() =>
                            handleSaveAgentProfile({
                              name: agentProfile?.name ?? 'AI 工作助手',
                              description: agentProfile?.description ?? '',
                              capabilities: {
                                ...(agentProfile?.capabilities ?? {}),
                                skills: agentProfile?.capabilities?.skills ?? [],
                                domains: agentProfile?.capabilities?.domains ?? [],
                                modes: agentProfile?.capabilities?.modes ?? [],
                                max_parallel_tasks: agentProfile?.capabilities?.max_parallel_tasks ?? 2,
                              },
                            })
                          }
                        >
                          {agentProfileSaving ? (
                            <RefreshCw className="h-3 w-3 mr-1 animate-spin" />
                          ) : (
                            <CheckCircle className="h-3 w-3 mr-1" />
                          )}
                          保存档案
                        </Button>
                      </>
                    )}
                  </CardContent>
                </Card>
                </div>
              )}

              {section === 'threads' && (
                <div className="space-y-6">
                  <SettingsSectionHeader title={t('settings.sectionTitle.threads')} description={t('settings.sectionDesc.threads')} />
                  {loadErrorSection === 'threads' && (
                    <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 flex flex-col items-center gap-3 text-center">
                      <p className="text-sm text-muted-foreground">{t("settings.loadError")}</p>
                      <Button size="sm" variant="outline" onClick={() => void loadThreads()}>{t("settings.loadErrorRetry")}</Button>
                    </div>
                  )}
                <Card>
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <CardTitle className="text-base">{t('settings.threadsCardTitle')}</CardTitle>
                        <CardDescription>{t('settings.threadCountDesc', { count: threadCount })}</CardDescription>
                      </div>
                      <div className="flex gap-2">
                        <Button variant="outline" size="sm" onClick={() => void loadThreads()} disabled={loading}>
                          <RefreshCw className={cn('h-4 w-4 mr-1', loading && 'animate-spin')} />
                          {t('settings.refresh')}
                        </Button>
                        <Button variant="destructive" size="sm" onClick={() => handleCleanupThreads(7)} disabled={loading}>
                          <Trash2 className="h-4 w-4 mr-1" />
                          {t('settings.cleanup7Days')}
                        </Button>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <ScrollArea className="h-[300px]">
                      {threads.length > 0 ? (
                        <div className="space-y-2">
                          {threads.map((thread: any) => (
                            <div
                              key={thread.thread_id}
                              className={cn(
                                'flex items-center justify-between p-2 rounded-lg border hover:bg-muted/50',
                                selectedThreadForHistory === thread.thread_id && 'bg-muted'
                              )}
                            >
                              <div className="flex-1 min-w-0 cursor-pointer" onClick={() => handleLoadRunHistory(thread.thread_id)}>
                                <div className="text-sm font-medium truncate">{thread.metadata?.title || `对话 ${thread.thread_id.slice(0, 8)}`}</div>
                                <div className="text-xs text-muted-foreground">
                                  {thread.metadata?.created_at || thread.created_at
                                    ? new Date(thread.metadata?.created_at || thread.created_at).toLocaleString()
                                    : '未知时间'}
                                </div>
                              </div>
                              <div className="flex gap-1">
                                <Button variant="ghost" size="sm" onClick={() => handleLoadRunHistory(thread.thread_id)} title={t('settings.titleViewRunHistory')}>
                                  <History className="h-4 w-4" />
                                </Button>
                                <Button variant="ghost" size="sm" onClick={() => handleDeleteThread(thread.thread_id)} title={t('settings.titleDeleteThread')}>
                                  <Trash2 className="h-4 w-4 text-destructive" />
                                </Button>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="flex flex-col items-center justify-center h-full text-muted-foreground py-8">
                          <MessageSquare className="h-12 w-12 mb-2 opacity-50" />
                          <p>{t("settings.noChatHistory")}</p>
                        </div>
                      )}
                    </ScrollArea>
                    {selectedThreadForHistory && (
                      <div className="mt-4 border-t pt-4">
                        <div className="flex items-center justify-between mb-2">
                          <h4 className="text-sm font-medium flex items-center gap-2">
                            <History className="h-4 w-4" />
                            {t('settings.runHistory')}
                          </h4>
                          <Button variant="ghost" size="sm" onClick={() => { setSelectedThreadForHistory(null); setRunHistory([]); }}>
                            <XCircle className="h-4 w-4" />
                          </Button>
                        </div>
                        <ScrollArea className="h-[150px]">
                          {runHistory.length > 0 ? (
                            <div className="space-y-2">
                              {runHistory.map((run: any, index: number) => (
                                <div key={run.run_id || index} className="p-2 rounded border text-xs">
                                  <div className="flex items-center justify-between">
                                    <Badge variant={run.status === 'success' ? 'default' : 'destructive'}>{run.status || 'unknown'}</Badge>
                                    <span className="text-muted-foreground">
                                      {run.created_at ? new Date(run.created_at).toLocaleString() : '未知时间'}
                                    </span>
                                  </div>
                                  {run.error && <div className="mt-1 text-destructive">错误: {run.error}</div>}
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="text-center text-muted-foreground py-4">{t("settings.noRunHistory")}</div>
                          )}
                        </ScrollArea>
                      </div>
                    )}
                  </CardContent>
                </Card>
                </div>
              )}

              {section === 'workspaces' && (
                <>
                <SettingsSectionHeader title={t('settings.sectionTitle.workspaces')} description={t('settings.sectionDesc.workspaces')} />
                {loadErrorSection === 'workspaces' && (
                  <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 flex flex-col items-center gap-3 text-center">
                    <p className="text-sm text-muted-foreground">{t("settings.loadError")}</p>
                    <Button size="sm" variant="outline" onClick={() => void loadWorkspaces()}>{t("settings.loadErrorRetry")}</Button>
                  </div>
                )}
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">{t('settings.workspacesCardTitle')}</CardTitle>
                    <CardDescription>{t('settings.workspacesCardDesc')}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex items-center gap-2 p-2 rounded-lg border bg-muted/30">
                      <span className="text-xs text-muted-foreground shrink-0">{t('settings.currentWorkspace')}</span>
                      <code className="flex-1 min-w-0 truncate text-xs font-mono" title={(() => { try { return getCurrentWorkspacePathFromStorage() || ''; } catch { return ''; } })()}>
                        {(() => { try { return getCurrentWorkspacePathFromStorage() || t('settings.notSelected'); } catch { return t('settings.notSelected'); } })()}
                      </code>
                      <Button variant="outline" size="sm" onClick={() => setPendingWorkspacePath('')} disabled={loading || !(function(){ try { return (getCurrentWorkspacePathFromStorage() || '').trim(); } catch { return ''; } })()}>
                        {t('settings.clearWorkspace')}
                      </Button>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted-foreground">{t('settings.recentWorkspacesClickToSwitch')}</span>
                      <div className="flex gap-2">
                        <Button variant="outline" size="sm" onClick={handleClearRecentWorkspaces} disabled={loading}>{t('settings.clearRecent')}</Button>
                        <Button variant="destructive" size="sm" onClick={handleCleanupWorkspaces} disabled={loading}>{t('settings.cleanupInvalid')}</Button>
                      </div>
                    </div>
                    <ScrollArea className="h-[220px]">
                      {recentWorkspaces.length > 0 ? (
                        <div className="space-y-1">
                          {recentWorkspaces.map((ws: any) => {
                            const currentPath = (() => { try { return getCurrentWorkspacePathFromStorage() || ''; } catch { return ''; } })();
                            const isCurrent = ws.path === currentPath;
                            return (
                              <div
                                key={ws.id}
                                role="button"
                                tabIndex={0}
                                className="group flex items-center justify-between p-2 rounded-md border hover:bg-muted/50 cursor-pointer transition-colors"
                                onClick={() => { setProjectFolder(ws.path); setPendingWorkspacePath(ws.path); }}
                                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setProjectFolder(ws.path); setPendingWorkspacePath(ws.path); } }}
                              >
                                <div className="flex items-center gap-2 flex-1 min-w-0">
                                  <FolderOpen className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                                  <div className="flex-1 min-w-0">
                                    <div className="text-sm font-medium truncate">{ws.name}</div>
                                    <div className="text-[11px] text-muted-foreground truncate">{ws.path}</div>
                                  </div>
                                </div>
                                {isCurrent ? <CheckCircle className="h-4 w-4 text-emerald-500 shrink-0" aria-label={t('settings.ariaCurrentWorkspace')} /> : <ArrowRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 shrink-0" aria-hidden />}
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="flex flex-col items-center justify-center text-muted-foreground py-6">
                          <FolderOpen className="h-10 w-10 mb-2 opacity-50" />
                          <p className="text-sm">{t("settings.noRecentWorkspaces")}</p>
                        </div>
                      )}
                    </ScrollArea>
                  </CardContent>
                </Card>
                <Card className="mt-4">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">工具与执行权限</CardTitle>
                    <CardDescription>执行策略与工作区写入说明</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-2 text-sm text-muted-foreground">
                    <p>执行策略（Python/Shell 超时与禁止命令）由当前工作区 <code className="rounded bg-muted px-1">.maibot/settings.json</code> 的 <code className="rounded bg-muted px-1">execution_policy</code> 配置。</p>
                    <p>文件写入与工具执行：需确认的操作会在聊天区以 diff/预览展示，并提供「接受」「拒绝」按钮；勾选上方「默认接受以下工具」后，对应工具将直接执行。配置见 <code className="rounded bg-muted px-1">.maibot/settings.json</code> 的 <code className="rounded bg-muted px-1">autonomous</code> 与 <code className="rounded bg-muted px-1">execution_policy</code>。</p>
                  </CardContent>
                </Card>
                </>
              )}

              {section === 'memories' && (
                <div className="space-y-6">
                  <SettingsSectionHeader title={t('settings.sectionTitle.memories')} description={t('settings.sectionDesc.memories')} />
                  {loadErrorSection === 'memories' && (
                    <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 flex flex-col items-center gap-3 text-center">
                      <p className="text-sm text-muted-foreground">{t("settings.loadError")}</p>
                      <Button size="sm" variant="outline" onClick={() => void loadMemories()}>{t("settings.loadErrorRetry")}</Button>
                    </div>
                  )}
                <Card>
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <CardTitle className="text-base">用户记忆</CardTitle>
                        <CardDescription>AI 学习到的偏好和模式</CardDescription>
                      </div>
                        <Button variant="outline" size="sm" onClick={() => void loadMemories()} disabled={loading}>
                          <RefreshCw className={cn('h-4 w-4 mr-1', loading && 'animate-spin')} />
                          {t('settings.refresh')}
                        </Button>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <ScrollArea className="h-[300px]">
                      {memories.length > 0 ? (
                        <div className="space-y-2">
                          {memories.map((memory: any, index: number) => (
                            <div
                              key={`${memory?.key || 'memory'}-${memory?.id || index}`}
                              className="flex items-center justify-between p-2 rounded-lg border hover:bg-muted/50"
                            >
                              <div className="flex-1 min-w-0">
                                <div className="text-sm font-medium">{memory.key}</div>
                                <div className="text-xs text-muted-foreground truncate">{JSON.stringify(memory.value).slice(0, 100)}</div>
                                <div className="text-[11px] text-muted-foreground mt-1">
                                  {[
                                    memory?.workspace_id ? `workspace=${memory.workspace_id}` : "",
                                    memory?.source_thread_id ? `source_thread=${memory.source_thread_id}` : "",
                                    memory?.write_reason ? `reason=${memory.write_reason}` : "",
                                    memory?.confidence != null ? `confidence=${memory.confidence}` : "",
                                    memory?.updated_at ? `updated=${memory.updated_at}` : (memory?.created_at ? `created=${memory.created_at}` : ""),
                                  ].filter(Boolean).join(" · ")}
                                </div>
                              </div>
                              <Button variant="ghost" size="sm" onClick={() => handleDeleteMemory(memory)}>
                                <Trash2 className="h-4 w-4 text-destructive" />
                              </Button>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="flex flex-col items-center justify-center h-full text-muted-foreground py-8">
                          <Brain className="h-12 w-12 mb-2 opacity-50" />
                          <p className="text-sm">{t("settings.noMemoryData")}</p>
                          <p className="text-[11px] mt-1">{t("settings.noMemoryDataHint")}</p>
                        </div>
                      )}
                    </ScrollArea>
                  </CardContent>
                </Card>
                </div>
              )}

              {section === 'connection' && (
                <div className="space-y-6">
                  <SettingsSectionHeader title={t('settings.sectionTitle.connection')} description={t('settings.sectionDesc.connection')} />
                  {loadErrorSection === 'connection' && (
                    <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 flex flex-col items-center gap-3 text-center">
                      <p className="text-sm text-muted-foreground">{t("settings.loadError")}</p>
                      <Button size="sm" variant="outline" onClick={() => void loadConnection()}>{t("settings.loadErrorRetry")}</Button>
                    </div>
                  )}
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">{t('settings.connectionCardTitle')}</CardTitle>
                    <CardDescription>{t('settings.connectionCardDesc')}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="flex items-center justify-between p-3 rounded-lg border">
                      <div className="flex items-center gap-2">
                        <Database className="h-4 w-4" />
                        <span className="text-sm">LangGraph Server</span>
                      </div>
                      <div className="flex items-center gap-2">
                        {healthStatus === 'checking' && <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />}
                        {healthStatus === 'healthy' && (
                          <>
                            <CheckCircle className="h-4 w-4 text-emerald-500" />
                            <Badge variant="outline" className="text-emerald-500 border-emerald-500">{t('settings.healthOnline')}</Badge>
                          </>
                        )}
                        {healthStatus === 'unhealthy' && (
                          <>
                            <XCircle className="h-4 w-4 text-destructive" />
                            <Badge variant="outline" className="text-destructive border-destructive">{t('settings.healthOffline')}</Badge>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label className="text-sm font-medium">项目文件夹（工作区根）</Label>
                      <p className="text-xs text-muted-foreground">Agent 文件操作根目录。在左侧栏「文件」顶部切换工作区；此处仅作展示。</p>
                      <div className="flex gap-2 items-center p-2 rounded-lg border bg-muted/30">
                        <code className="flex-1 min-w-0 truncate text-xs font-mono" title={(() => { try { return getCurrentWorkspacePathFromStorage() || ''; } catch { return ''; } })()}>
                          {(() => { try { return getCurrentWorkspacePathFromStorage() || t('settings.notSelected'); } catch { return t('settings.notSelected'); } })()}
                        </code>
                      </div>
                    </div>
                    <Button variant="outline" className="w-full" onClick={() => { setHealthStatus('checking'); void loadConnection(); }}>
                      <RefreshCw className="h-4 w-4 mr-2" />
                      {t('settings.refreshStatus')}
                    </Button>
                  </CardContent>
                </Card>
                </div>
              )}

              <AlertDialog open={pendingWorkspacePath !== null} onOpenChange={(open) => { if (!open) setPendingWorkspacePath(null); }}>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t('settings.confirmSwitchWorkspace')}</AlertDialogTitle>
                    <AlertDialogDescription>
                      {pendingWorkspacePath === ''
                        ? t('settings.confirmSwitchWorkspaceClearDesc')
                        : t('settings.confirmSwitchWorkspaceDesc', { path: pendingWorkspacePath ?? '' })}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                    <AlertDialogAction onClick={() => pendingWorkspacePath !== null && doSwitchWorkspace(pendingWorkspacePath)}>
                      {t('common.confirm')}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>

              <AlertDialog open={!!pendingDeleteModelId} onOpenChange={(o) => { if (!o) setPendingDeleteModelId(null); }}>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t('settings.confirmDeleteModel')}</AlertDialogTitle>
                    <AlertDialogDescription>{t('settings.confirmDeleteModelDesc')}</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                    <AlertDialogAction onClick={async () => {
                      if (!pendingDeleteModelId) return;
                      const toDelete = modelList.find((m) => m.id === pendingDeleteModelId);
                      if (isCloudDiscoveredModel(toDelete)) {
                        toast.error(t("settings.cloudModelCannotDelete"), { description: t("settings.cloudModelCannotDeleteDesc") });
                        setPendingDeleteModelId(null);
                        return;
                      }
                      try {
                        await modelsApi.remove(pendingDeleteModelId);
                        await loadModels();
                      } catch (e) {
                        toast.error(t("settings.modelDeleteFailed"), { description: e instanceof Error ? e.message : String(e) });
                      } finally {
                        setPendingDeleteModelId(null);
                      }
                    }}>
                      {t('settings.confirmDeleteAction')}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>

              <AlertDialog open={cleanThreadsConfirm !== null} onOpenChange={(o) => { if (!o) setCleanThreadsConfirm(null); }}>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t('settings.confirmCleanupThreads')}</AlertDialogTitle>
                    <AlertDialogDescription>
                      {cleanThreadsConfirm != null
                        ? t('settings.confirmCleanupThreadsDesc', { days: cleanThreadsConfirm.days })
                        : ""}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                    <AlertDialogAction onClick={performCleanupThreads}>{t('common.confirm')}</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>

              <AlertDialog open={confirmAction !== null} onOpenChange={(o) => { if (!o) setConfirmAction(null); }}>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {confirmAction?.type === "deleteThread" && t('settings.confirmDeleteThread')}
                      {confirmAction?.type === "cleanupWorkspaces" && t('settings.confirmCleanupWorkspaces')}
                      {confirmAction?.type === "clearRecent" && t('settings.confirmClearRecent')}
                      {confirmAction?.type === "deleteMemory" && t('settings.confirmDeleteMemory')}
                      {confirmAction?.type === "deleteSkill" && t('settings.confirmDeleteSkill')}
                      {confirmAction?.type === "resetToDefault" && t('settings.confirmResetToDefault')}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {confirmAction?.type === "deleteThread" && t('settings.confirmDeleteThreadDesc')}
                      {confirmAction?.type === "cleanupWorkspaces" && t('settings.confirmCleanupWorkspacesDesc')}
                      {confirmAction?.type === "clearRecent" && t('settings.confirmClearRecentDesc')}
                      {confirmAction?.type === "deleteMemory" && t('settings.confirmDeleteMemoryDesc')}
                      {confirmAction?.type === "deleteSkill" && confirmAction?.skill != null && t('settings.confirmDeleteSkillDesc', { name: confirmAction.skill.display_name ?? confirmAction.skill.name })}
                      {confirmAction?.type === "resetToDefault" && t('settings.resetToDefaultConfirm')}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() => {
                        if (confirmAction?.type === "deleteThread") void performDeleteThread();
                        else if (confirmAction?.type === "cleanupWorkspaces") void performCleanupWorkspaces();
                        else if (confirmAction?.type === "clearRecent") performClearRecentWorkspaces();
                        else if (confirmAction?.type === "deleteMemory") void performDeleteMemory();
                        else if (confirmAction?.type === "deleteSkill") void performDeleteSkill();
                        else if (confirmAction?.type === "resetToDefault") handleResetToDefault();
                      }}
                    >
                      {t('common.confirm')}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>

              <Dialog open={editingModel !== null} onOpenChange={(open) => { if (!open) setEditingModel(null); }}>
                <DialogContent className="sm:max-w-md">
                  <DialogHeader>
                    <DialogTitle>{editingModel?.field === 'name' ? t('settings.editModelNameTitle') : t('settings.editModelUrlTitle')}</DialogTitle>
                    <DialogDescription>
                      {editingModel?.field === 'name' ? t('settings.editModelNameDesc') : t('settings.editModelUrlDesc')}
                    </DialogDescription>
                  </DialogHeader>
                  <div className="py-2">
                    <Input
                      value={editingModel?.value ?? ''}
                      onChange={(e) => editingModel && setEditingModel({ ...editingModel, value: e.target.value })}
                      placeholder={editingModel?.field === 'name' ? '显示名称' : 'https://...'}
                      className="font-mono text-sm"
                    />
                  </div>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setEditingModel(null)}>{t('common.cancel')}</Button>
                    <Button
                      onClick={async () => {
                        if (!editingModel) return;
                        const model = modelList.find(m => m.id === editingModel.id);
                        if (isCloudDiscoveredModel(model)) {
                          toast.error(t("settings.cloudModelCannotEdit"), { description: t("settings.cloudModelCannotEditDesc") });
                          return;
                        }
                        const trimmed = editingModel.value.trim();
                        if (editingModel.field === 'name' && (!trimmed || trimmed === model?.name)) {
                          setEditingModel(null);
                          return;
                        }
                        try {
                          await modelsApi.update(editingModel.id, editingModel.field === 'name' ? { name: trimmed } : { url: trimmed || undefined });
                          await loadModels();
                          setEditingModel(null);
                        } catch (e) {
                          toast.error(editingModel.field === 'name' ? t('settings.modelUpdateFailed') : t('settings.modelUrlUpdateFailed'), { description: e instanceof Error ? e.message : String(e) });
                        }
                      }}
                    >
                      {t('common.confirm')}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>

              {section === 'network' && (
                <div className="space-y-6">
                  <SettingsSectionHeader title={t('settings.sectionTitle.network')} description={t('settings.sectionDesc.network')} />
                  {loadErrorSection === 'network' && (
                    <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 flex flex-col items-center gap-3 text-center">
                      <p className="text-sm text-muted-foreground">{t("settings.loadError")}</p>
                      <Button size="sm" variant="outline" onClick={() => void loadNetwork()}>{t("settings.loadErrorRetry")}</Button>
                    </div>
                  )}
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">数字员工网络（A2A）</CardTitle>
                    <CardDescription>已注册的 A2A 节点，用于跨平台任务与发现</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="flex gap-2">
                      <Input
                        id="net-node-id"
                        placeholder={t('settings.placeholder.nodeId')}
                        className="flex-1 text-xs font-mono"
                      />
                      <Input
                        id="net-base-url"
                        placeholder="Base URL (e.g. http://host:2024)"
                        className="flex-1 text-xs font-mono"
                      />
                      <Button
                        size="sm"
                        onClick={async () => {
                          const idEl = document.getElementById('net-node-id') as HTMLInputElement;
                          const urlEl = document.getElementById('net-base-url') as HTMLInputElement;
                          const nodeId = idEl?.value?.trim();
                          const baseUrl = urlEl?.value?.trim();
                          if (!nodeId || !baseUrl) {
                            toast.error(t("settings.fillNodeIdAndUrl"));
                            return;
                          }
                          try {
                            const res = await fetch(`${getApiBase()}/network/nodes`, {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ node_id: nodeId, base_url: baseUrl }),
                            });
                            const data = await res.json().catch(() => ({}));
                            if (!res.ok) {
                              toast.error((data as { detail?: string; error?: string })?.detail || (data as { detail?: string; error?: string })?.error || '注册失败');
                              return;
                            }
                            if (data?.ok) {
                              toast.success(t("settings.nodeRegistered"));
                              idEl.value = '';
                              urlEl.value = '';
                              loadNetwork();
                            } else toast.error((data as { detail?: string; error?: string })?.detail || (data as { detail?: string; error?: string })?.error || '注册失败');
                          } catch (e) {
                            toast.error(e instanceof Error ? e.message : String(e));
                          }
                        }}
                      >
                        注册
                      </Button>
                    </div>
                    <ScrollArea className="h-[200px] rounded border">
                      {networkNodes.length > 0 ? (
                        <div className="p-2 space-y-2">
                          {networkNodes.map((n) => (
                            <div key={n.node_id} className="flex items-center justify-between rounded border p-2 text-xs">
                              <div className="min-w-0">
                                <span className="font-medium">{n.name || n.node_id}</span>
                                <span className="text-muted-foreground ml-2 truncate block">{n.base_url}</span>
                              </div>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="shrink-0 text-destructive"
                                onClick={async () => {
                                  try {
                                    const res = await fetch(`${getApiBase()}/network/nodes/${encodeURIComponent(n.node_id)}`, { method: 'DELETE' });
                                    if (res.ok) {
                                      toast.success(t("settings.nodeRemoved"));
                                      loadNetwork();
                                    } else toast.error(t("settings.nodeRemoveFailed"));
                                  } catch (e) {
                                    toast.error(e instanceof Error ? e.message : String(e));
                                  }
                                }}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="flex flex-col items-center justify-center h-full text-muted-foreground py-6 text-sm">
                          <Server className="h-10 w-10 mb-2 opacity-50" />
                          <p>{t("settings.noRegisteredNodes")}</p>
                          <p className="text-[11px] mt-1">{t("settings.noRegisteredNodesHint")}</p>
                        </div>
                      )}
                    </ScrollArea>
                  </CardContent>
                </Card>
                </div>
              )}

              {section === 'advanced' && (
                <div className="space-y-6">
                  <SettingsSectionHeader title={t('settings.sectionTitle.advanced')} description={t('settings.sectionDesc.advanced')} />
                  {loadErrorSection === 'advanced' && (
                    <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 flex flex-col items-center gap-3 text-center">
                      <p className="text-sm text-muted-foreground">{t("settings.loadError")}</p>
                      <Button size="sm" variant="outline" onClick={() => void loadAdvanced()}>
                        {t("settings.loadErrorRetry")}
                      </Button>
                    </div>
                  )}
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm">{t('settings.advancedGroupConnection')}</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3 pt-0">
                      <div className="rounded-lg border border-border/50 bg-card/40 px-3 py-2 space-y-2">
                        <RoleContextBadgeGroup className="text-[11px]" showRoleCount showRolePool showHint />
                        <div className="text-[11px] text-muted-foreground">
                          当前用户：{userId || '匿名/本地用户'}
                        </div>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="baseurl" className="text-xs font-medium">API 基础 URL</Label>
                    <Input
                      id="baseurl"
                      value={baseURL}
                      onChange={(e) => setBaseURL(e.target.value)}
                      placeholder="http://127.0.0.1:8000"
                      className="h-8 text-xs"
                    />
                        <p className="text-[11px] text-muted-foreground">后端 API 服务地址</p>
                      </div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm">{t('settings.advancedGroupDebug')}</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3 pt-0">
                  <ExecutionLogsCard />
                  <LangSmithStatusCard />
                  <SensitiveFilesCard />
                  <VisionAnalyzeCard />
                  <LangSmithEvalsCard />
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm">{t('settings.advancedGroupPolicy')}</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3 pt-0">
                  <UpgradeControlCard />
                  <AutonomousWatcherCard />
                  <AutonomyLevelCard />
                  <OrganizationPolicyCard />
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm">{t('settings.advancedGroupLearning')}</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3 pt-0">
                  <SkillFeedbackStatsCard />
                  <DailyInsightsCard />
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm">{t('settings.advancedGroupProject')}</CardTitle>
                      <CardDescription className="text-[11px]">API Key、.maibot 配置文件</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3 pt-0">
                  <div className="space-y-2">
                    <Label className="text-xs font-medium">API Key（本地存储）</Label>
                    <p className="text-[11px] text-muted-foreground">用于直连 OpenAI 等；云端端点鉴权请在「常规 → 云端端点」填写环境变量名，并在后端 .env 中配置该变量。</p>
                    <Input
                      type="password"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder={t('settings.placeholder.apiKeyProvider')}
                      className="h-8 text-xs font-mono"
                      aria-label={t('settings.ariaApiKeyInput')}
                    />
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={apiKeySaving}
                        onClick={async () => {
                          setApiKeySaving(true);
                          try {
                            const next = apiKey.trim();
                            const electron = window.electron;
                            if (electron?.secureStoreSet) {
                              await electron.secureStoreSet({ key: 'maibot_api_key', value: next });
                            } else {
                              setStorageItem('maibot_api_key', next);
                            }
                            toast.success(t('settings.apiKeySaved'));
                          } finally {
                            setApiKeySaving(false);
                          }
                        }}
                      >
                        {apiKeySaving ? t('settings.savingKey') : t('settings.saveKey')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={async () => {
                          setApiKey('');
                          const electron = window.electron;
                          if (electron?.secureStoreDelete) {
                            await electron.secureStoreDelete({ key: 'maibot_api_key' });
                          } else {
                            removeStorageItem('maibot_api_key');
                          }
                          toast.success(t('settings.apiKeyCleared'));
                        }}
                      >
                        {t('settings.clearKey')}
                      </Button>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs font-medium">{t('settings.projectConfigLabel')}</Label>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={async () => {
                          try {
                            setConfigLoading(true);
                            const res = await configApi.list();
                            setConfigFiles(Array.isArray(res.files) ? res.files : []);
                          } catch (e) {
                            toast.error(t('settings.configListRefreshFailed'), { description: e instanceof Error ? e.message : String(e) });
                          } finally {
                            setConfigLoading(false);
                          }
                        }}
                        disabled={configLoading}
                      >
                        {configLoading ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : t('settings.refresh')}
                      </Button>
                    </div>
                    <div className="rounded border divide-y">
                      {configLoading ? (
                        <>
                          {[1, 2, 3].map((i) => (
                            <div key={i} className="p-2 flex items-center justify-between gap-2">
                              <div className="h-4 w-24 rounded bg-muted/60 animate-pulse" />
                              <div className="h-3 w-16 rounded bg-muted/40 animate-pulse" />
                            </div>
                          ))}
                        </>
                      ) : configFiles.length === 0 ? (
                        <div className="p-2 text-xs text-muted-foreground">{t("settings.noEditableConfig")}</div>
                      ) : (
                        configFiles.map((f) => (
                          <div key={f.key} className="p-2 flex items-center justify-between gap-2">
                            <div className="min-w-0">
                              <div className="text-xs font-mono truncate">{f.key}</div>
                              <div className="text-[11px] text-muted-foreground truncate">
                                {f.exists ? `size=${f.size ?? 0}` : '未创建'}{f.updated_at ? ` · ${new Date(f.updated_at).toLocaleString()}` : ''}
                              </div>
                            </div>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-xs"
                              onClick={() => openConfigEditor(f.key)}
                            >
                              编辑
                            </Button>
                          </div>
                        ))
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground">用于直接编辑 MAIBOT 记忆、Prompt 组装与 Persona 配置。</p>
                  </div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm">{t('settings.advancedGroupExperimental')}</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3 pt-0">
                  <div className="space-y-2">
                    <Label className="text-xs font-medium">工具启停（实验）</Label>
                    {['python_run', 'web_search', 'search_knowledge', 'ontology', 'ontology_import', 'knowledge_graph', 'critic_review'].map((name) => (
                      <div key={name} className="flex items-center justify-between rounded border p-2">
                        <span className="text-xs font-mono">{name}</span>
                        <Switch
                          checked={toolToggles[name] !== false}
                          onCheckedChange={(checked) => {
                            const next = { ...toolToggles, [name]: checked };
                            setToolToggles(next);
                            setStorageItem('maibot_tool_toggles', JSON.stringify(next));
                            if (
                              name === 'critic_review' &&
                              !checked &&
                              reviewPolicy !== 'notify'
                            ) {
                              setReviewPolicy('notify');
                              setStorageItem('maibot_review_policy', 'notify');
                            }
                            if (
                              name === 'critic_review' &&
                              !checked &&
                              reviewTemplate === 'strict'
                            ) {
                              setReviewTemplate('standard');
                              setStorageItem('maibot_review_template', 'standard');
                            }
                          }}
                        />
                      </div>
                    ))}
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs font-medium">{t('settings.reviewPolicyLabel')}</Label>
                    <Select
                      value={reviewPolicy}
                      onValueChange={(v: 'notify' | 'auto' | 'gate') => {
                        setReviewPolicy(v);
                        setStorageItem('maibot_review_policy', v);
                      }}
                    >
                      <SelectTrigger className="h-8 text-xs mt-1">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="notify">{t('settings.reviewNotify')}</SelectItem>
                        <SelectItem value="auto">{t('settings.reviewAuto')}</SelectItem>
                        <SelectItem value="gate">{t('settings.reviewGate')}</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-[11px] text-muted-foreground">
                      {t('settings.reviewPolicyHint')}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs font-medium">{t('settings.reviewTemplateLabel')}</Label>
                    <Select
                      value={reviewTemplate}
                      onValueChange={(v: 'short' | 'standard' | 'strict') => {
                        setReviewTemplate(v);
                        setStorageItem('maibot_review_template', v);
                      }}
                    >
                      <SelectTrigger className="h-8 text-xs mt-1">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="short">短版（快速迭代）</SelectItem>
                        <SelectItem value="standard">标准（默认）</SelectItem>
                        <SelectItem value="strict">严格（证据/计算优先）</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-[11px] text-muted-foreground">
                      控制“填入修订提示/直接发送修订任务”的提示词详细程度。
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs font-medium">计划确认后自动切回 Agent</Label>
                    <div className="flex items-center justify-between rounded border p-2">
                      <div className="space-y-0.5">
                        <p className="text-xs font-medium">启用后，确认执行计划时自动切换到 Agent</p>
                        <p className="text-[11px] text-muted-foreground">
                          关闭后保持当前模式（通常为 Plan），仅发送“确认执行上述计划”指令。
                        </p>
                      </div>
                      <Switch
                        checked={planConfirmSwitchToAgent}
                        onCheckedChange={(checked) => {
                          setPlanConfirmSwitchToAgent(checked);
                          setStorageItem('maibot_plan_confirm_switch_to_agent', checked ? 'true' : 'false');
                        }}
                      />
                    </div>
                    <div className="rounded border p-2 space-y-2">
                      <p className="text-[11px] font-medium text-muted-foreground">{t('settings.editBookmark')}</p>
                      <p className="text-[11px] text-muted-foreground">
                        当前共 {getPromptTemplates().length} 条快捷模板；恢复默认将还原为内置列表。可添加自定义书签或删除单条。
                      </p>
                      <div className="max-h-32 overflow-y-auto space-y-1 pr-1">
                        {getPromptTemplates().map((template) => (
                          <div key={template.id} className="flex items-center justify-between gap-2 py-1 px-2 rounded bg-muted/30 text-xs">
                            <span className="truncate flex-1 font-medium">{template.label}</span>
                            <span className="text-[10px] text-muted-foreground shrink-0">{template.modes?.length ? template.modes.join(',') : '全部'}</span>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-6 w-6 p-0 shrink-0 text-muted-foreground hover:text-destructive"
                              title={t('settings.titleDeleteBookmark')}
                              onClick={() => {
                                const next = getPromptTemplates().filter((x) => x.id !== template.id);
                                setPromptTemplates(next.length > 0 ? next : [...DEFAULT_PROMPT_TEMPLATES]);
                                window.dispatchEvent(new CustomEvent(EVENTS.COMPOSER_PREFS_CHANGED));
                                setBookmarkListVersion((v) => v + 1);
                                toast.success(`已删除「${template.label}」`);
                              }}
                            >
                              <Trash2 className="size-3" />
                            </Button>
                          </div>
                        ))}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setNewBookmarkLabel('');
                            setNewBookmarkText('');
                            setNewBookmarkModes(['agent']);
                            setBookmarkAddOpen(true);
                          }}
                        >
                          {t('settings.addBookmark')}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            resetPromptTemplatesToDefault();
                            window.dispatchEvent(new CustomEvent(EVENTS.COMPOSER_PREFS_CHANGED));
                            setBookmarkListVersion((v) => v + 1);
                            toast.success(t("settings.bookmarksRestored"));
                          }}
                        >
                          恢复默认书签
                        </Button>
                      </div>
                    </div>
                    <Dialog open={bookmarkAddOpen} onOpenChange={setBookmarkAddOpen}>
                      <DialogContent className="max-w-lg">
                        <DialogHeader>
                          <DialogTitle>{t('settings.addBookmark')}</DialogTitle>
                          <DialogDescription>新增一条 Composer 快捷提示词，可指定适用的对话模式。</DialogDescription>
                        </DialogHeader>
                        <div className="grid gap-3 py-2">
                          <div className="space-y-1">
                            <Label className="text-xs">标签名</Label>
                            <Input
                              value={newBookmarkLabel}
                              onChange={(e) => setNewBookmarkLabel(e.target.value)}
                              placeholder={t('settings.placeholder.exampleCodeReview')}
                              className="h-8 text-xs"
                            />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">模板内容（可用 &#123;&#123;code&#125;&#125;、&#123;&#123;content&#125;&#125;、&#123;&#123;goal&#125;&#125; 等占位符）</Label>
                            <Textarea
                              value={newBookmarkText}
                              onChange={(e) => setNewBookmarkText(e.target.value)}
                              placeholder={t('settings.placeholder.promptTemplate')}
                              rows={4}
                              className="text-xs resize-none"
                            />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">适用模式（不选则全部模式显示）</Label>
                            <div className="flex flex-wrap gap-2">
                              {BOOKMARK_MODES.map((m) => (
                                <label key={m} className="flex items-center gap-1.5 text-xs cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={newBookmarkModes.includes(m)}
                                    onChange={(e) => {
                                      if (e.target.checked) setNewBookmarkModes((prev) => [...prev, m]);
                                      else setNewBookmarkModes((prev) => prev.filter((x) => x !== m));
                                    }}
                                    className="rounded"
                                  />
                                  {m}
                                </label>
                              ))}
                            </div>
                          </div>
                        </div>
                        <DialogFooter>
                          <Button type="button" variant="outline" size="sm" onClick={() => setBookmarkAddOpen(false)}>
                            {t('settings.cancel')}
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            onClick={() => {
                              const label = newBookmarkLabel.trim();
                              const text = newBookmarkText.trim();
                              if (!label || !text) {
                                toast.error(t("settings.fillTagAndTemplate"));
                                return;
                              }
                              const id = `custom-${Date.now()}`;
                              const modes = newBookmarkModes.length > 0 ? [...newBookmarkModes] : undefined;
                              const list = getPromptTemplates();
                              setPromptTemplates([...list, { id, label, text, modes }]);
                              window.dispatchEvent(new CustomEvent(EVENTS.COMPOSER_PREFS_CHANGED));
                              setBookmarkListVersion((v) => v + 1);
                              setBookmarkAddOpen(false);
                              setNewBookmarkLabel('');
                              setNewBookmarkText('');
                              setNewBookmarkModes(['agent']);
                              toast.success(t("settings.bookmarkAdded"));
                            }}
                          >
                            保存
                          </Button>
                        </DialogFooter>
                      </DialogContent>
                    </Dialog>
                  </div>
                    </CardContent>
                  </Card>
                  <div className="flex items-start gap-2">
                    <Shield className="h-4 w-4 mt-1 text-amber-600 dark:text-amber-400" />
                    <div className="text-[11px] text-muted-foreground">
                      <p className="font-medium mb-1">隐私和安全</p>
                      <ul className="list-disc list-inside space-y-1">
                        <li>所有数据都在本地处理</li>
                        <li>通信已加密</li>
                        <li>不收集个人信息</li>
                      </ul>
                    </div>
                  </div>
                </div>
              )}

              {section === 'about' && (
                <div className="space-y-6">
                  <SettingsSectionHeader title={t('settings.sectionTitle.about')} description={t('settings.sectionDesc.about')} />
                  <div>
                    <h3 className="text-sm font-semibold text-foreground mb-1">应用名称</h3>
                    <p className="text-xs text-muted-foreground">AI 工作舞台（MAIBOT Desktop）</p>
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-foreground mb-1">版本</h3>
                    <p className="text-xs font-mono text-muted-foreground">
                      {import.meta.env?.VITE_APP_VERSION ?? '0.1.0'}
                    </p>
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-foreground mb-2">技术栈</h3>
                    <ul className="text-xs text-muted-foreground space-y-1">
                      <li>• 前端: React, Vite, TypeScript</li>
                      <li>• UI: Radix UI, Tailwind CSS, Motion</li>
                      <li>• 对话: @assistant-ui/react, LangGraph</li>
                      <li>• 编辑器: Monaco Editor</li>
                      <li>• 数据: localStorage, LangGraph Server</li>
                    </ul>
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    <p>工作区与展开状态等偏好保存在本地（localStorage）。</p>
                  </div>
                </div>
              )}
            </div>
          </ScrollArea>
        </main>
      </div>

      <Dialog open={configEditorOpen} onOpenChange={setConfigEditorOpen}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>编辑配置：{configSelectedKey || '-'}</DialogTitle>
            <DialogDescription>修改后将写入当前工作区 `.maibot` 目录。</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-1">
            <Textarea
              value={configContent}
              onChange={(e) => setConfigContent(e.target.value)}
              className="min-h-[420px] font-mono text-xs"
              placeholder={t('settings.placeholder.configContent')}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfigEditorOpen(false)}>
              取消
            </Button>
            <Button size="sm" onClick={handleSaveConfig} disabled={configSaving || !configSelectedKey}>
              {configSaving ? '保存中...' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 新建技能 Modal */}
      <Dialog open={showCreateSkillModal} onOpenChange={setShowCreateSkillModal}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>新建技能</DialogTitle>
            <DialogDescription>创建一个新的 Agent 技能，将在 knowledge_base/skills/ 下生成 SKILL.md</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <Label className="text-xs">技能名称（英文或拼音）</Label>
              <Input
                className="h-8 text-xs mt-1"
                placeholder={t('settings.placeholder.skillIdExample')}
                value={newSkillForm.name}
                onChange={e => setNewSkillForm(f => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div>
              <Label className="text-xs">所属领域</Label>
              <Input
                className="h-8 text-xs mt-1"
                placeholder={t('settings.placeholder.skillTagsExample')}
                value={newSkillForm.domain}
                onChange={e => setNewSkillForm(f => ({ ...f, domain: e.target.value }))}
              />
            </div>
            <div>
              <Label className="text-xs">描述（可选）</Label>
              <Input
                className="h-8 text-xs mt-1"
                placeholder={t('settings.placeholder.skillDescriptionHint')}
                value={newSkillForm.description}
                onChange={e => setNewSkillForm(f => ({ ...f, description: e.target.value }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setShowCreateSkillModal(false)}>
              取消
            </Button>
            <Button
              size="sm"
              disabled={!newSkillForm.name.trim()}
              onClick={async () => {
                try {
                  await skillsAPI.createSkill({
                    name: newSkillForm.name.trim(),
                    domain: newSkillForm.domain.trim() || 'general',
                    description: newSkillForm.description.trim(),
                  });
                  toast.success(t("settings.skillCreated"));
                  setShowCreateSkillModal(false);
                  setNewSkillForm({ name: '', domain: 'general', description: '' });
                  await loadAgentProfile();
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : String(e));
                }
              }}
            >
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
