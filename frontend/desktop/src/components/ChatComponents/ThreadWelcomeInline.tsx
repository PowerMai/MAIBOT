import React, { FC, memo, useMemo, useState, useEffect } from "react";
import {
  CodeIcon,
  WrenchIcon,
  FileTextIcon,
  Bug,
  Search,
  Eye,
  BarChart,
  BookOpen,
} from "lucide-react";
import { cn } from "../ui/utils";
import { MODE_BADGE_STYLES } from "../../lib/chatModeState";
import { EVENTS } from "../../lib/constants";
import { t } from "../../lib/i18n";
import { useSessionContext } from "../../lib/contexts/SessionContext";
import { useShallow } from "zustand/react/shallow";
import { useTaskStore } from "../../store/taskStore";
import { rolesApi } from "../../lib/api/rolesApi";
import { boardApi } from "../../lib/api/boardApi";
import { personaApi } from "../../lib/api/personaApi";
import type { BoardTask } from "../../lib/api/boardApi";
import type { ChatMode } from "./cursor-style-composer";
import { toast } from "sonner";

export type WelcomeCard = { icon: React.ReactNode; title: string; sub: string; text: string };
type WelcomeCardSpec = { icon: React.ReactNode; titleKey: string; subKey: string; textKey: string };

export const WELCOME_CARD_SPEC: Record<ChatMode, WelcomeCardSpec[]> = {
  agent: [
    { icon: <CodeIcon className="size-4" />, titleKey: "welcomeCard.explainCode.title", subKey: "welcomeCard.explainCode.sub", textKey: "welcomeCard.explainCode.text" },
    { icon: <WrenchIcon className="size-4" />, titleKey: "welcomeCard.planTask.title", subKey: "welcomeCard.planTask.sub", textKey: "welcomeCard.planTask.text" },
    { icon: <FileTextIcon className="size-4" />, titleKey: "welcomeCard.analyzeDoc.title", subKey: "welcomeCard.analyzeDoc.sub", textKey: "welcomeCard.analyzeDoc.text" },
  ],
  plan: [
    { icon: <CodeIcon className="size-4" />, titleKey: "welcomeCard.explainCode.title", subKey: "welcomeCard.explainCode.sub", textKey: "welcomeCard.explainCode.text" },
    { icon: <WrenchIcon className="size-4" />, titleKey: "welcomeCard.planTask.title", subKey: "welcomeCard.planTask.sub", textKey: "welcomeCard.planTask.text" },
    { icon: <FileTextIcon className="size-4" />, titleKey: "welcomeCard.analyzeDoc.title", subKey: "welcomeCard.analyzeDoc.sub", textKey: "welcomeCard.analyzeDoc.text" },
  ],
  debug: [
    { icon: <Bug className="size-4" />, titleKey: "welcomeCard.analyzeError.title", subKey: "welcomeCard.analyzeError.sub", textKey: "welcomeCard.analyzeError.text" },
    { icon: <Search className="size-4" />, titleKey: "welcomeCard.findRootCause.title", subKey: "welcomeCard.findRootCause.sub", textKey: "welcomeCard.findRootCause.text" },
    { icon: <WrenchIcon className="size-4" />, titleKey: "welcomeCard.fixSuggestions.title", subKey: "welcomeCard.fixSuggestions.sub", textKey: "welcomeCard.fixSuggestions.text" },
  ],
  review: [
    { icon: <Eye className="size-4" />, titleKey: "welcomeCard.codeReview.title", subKey: "welcomeCard.codeReview.sub", textKey: "welcomeCard.codeReview.text" },
    { icon: <BarChart className="size-4" />, titleKey: "welcomeCard.perfEval.title", subKey: "welcomeCard.perfEval.sub", textKey: "welcomeCard.perfEval.text" },
    { icon: <FileTextIcon className="size-4" />, titleKey: "welcomeCard.specCheck.title", subKey: "welcomeCard.specCheck.sub", textKey: "welcomeCard.specCheck.text" },
  ],
  ask: [
    { icon: <BookOpen className="size-4" />, titleKey: "welcomeCard.explainConcept.title", subKey: "welcomeCard.explainConcept.sub", textKey: "welcomeCard.explainConcept.text" },
    { icon: <Search className="size-4" />, titleKey: "welcomeCard.searchCode.title", subKey: "welcomeCard.searchCode.sub", textKey: "welcomeCard.searchCode.text" },
    { icon: <CodeIcon className="size-4" />, titleKey: "welcomeCard.quickQa.title", subKey: "welcomeCard.quickQa.sub", textKey: "welcomeCard.quickQa.text" },
  ],
};

export function getWelcomeCards(mode: ChatMode, tr: (key: string) => string): WelcomeCard[] {
  const spec = WELCOME_CARD_SPEC[mode] ?? WELCOME_CARD_SPEC.agent;
  return spec.map((s) => ({ icon: s.icon, title: tr(s.titleKey), sub: tr(s.subKey), text: tr(s.textKey) }));
}

export const ThreadWelcomeInline: FC = memo(function ThreadWelcomeInline() {
  const { chatMode, roleId } = useSessionContext();
  const [activeRoleLabel, setActiveRoleLabel] = useState<string | null>(null);
  const [assistantDisplayName, setAssistantDisplayName] = useState<string | null>(null);
  useEffect(() => {
    if (!roleId) {
      setActiveRoleLabel(null);
      return;
    }
    let cancelled = false;
    rolesApi.listRoles().then((res) => {
      if (cancelled || !res.ok || !res.roles) return;
      const role = res.roles.find((r) => r.id === roleId);
      setActiveRoleLabel(role?.label ?? roleId);
    }).catch(() => {
      if (cancelled) return;
      setActiveRoleLabel(roleId);
    });
    return () => { cancelled = true; };
  }, [roleId]);
  useEffect(() => {
    let cancelled = false;
    Promise.all([boardApi.getAgentProfile(), personaApi.get().catch(() => ({ ok: false, persona: {} }))])
      .then(([profileRes, personaRes]) => {
        if (cancelled) return;
        const name = (profileRes.ok && profileRes.profile?.name)
          ? String(profileRes.profile.name).trim()
          : ((personaRes as { ok?: boolean; persona?: { name?: string } }).ok && (personaRes as { persona?: { name?: string } }).persona?.name)
            ? String((personaRes as { persona: { name?: string } }).persona.name).trim()
            : null;
        if (name) setAssistantDisplayName(name);
      })
      .catch(() => {
        if (!cancelled) toast.error(t("dashboard.agentProfileLoadError"));
      });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    const onPersonaChanged = (e: Event) => {
      const p = (e as CustomEvent<{ persona?: { name?: string } }>).detail?.persona;
      if (p?.name != null) setAssistantDisplayName(String(p.name).trim() || null);
    };
    const onAgentProfileChanged = (e: Event) => {
      const profile = (e as CustomEvent<{ profile?: { name?: string } }>).detail?.profile;
      if (profile?.name != null) setAssistantDisplayName(String(profile.name).trim() || null);
    };
    window.addEventListener(EVENTS.PERSONA_CHANGED, onPersonaChanged);
    window.addEventListener(EVENTS.AGENT_PROFILE_CHANGED as string, onAgentProfileChanged);
    return () => {
      window.removeEventListener(EVENTS.PERSONA_CHANGED, onPersonaChanged);
      window.removeEventListener(EVENTS.AGENT_PROFILE_CHANGED as string, onAgentProfileChanged);
    };
  }, []);
  const personalTasks = useTaskStore(
    useShallow((s) =>
      (Object.values(s.tasksById) as BoardTask[]).filter((t) => (t.scope || "personal") === "personal")
    )
  );
  const taskSummary = useMemo(() => {
    const pending = personalTasks.filter((t) =>
      ["pending", "available", "awaiting_plan_confirm", "paused"].includes(String(t.status || "").toLowerCase())
    ).length;
    const running = personalTasks.filter((t) =>
      ["running", "in_progress"].includes(String(t.status || "").toLowerCase())
    ).length;
    return { pending, running };
  }, [personalTasks]);
  const shortcuts = useMemo(() => getWelcomeCards(chatMode, t), [chatMode]);
  return (
    <div className="flex flex-col items-center justify-center min-h-[50%] gap-4 px-4 text-center">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{assistantDisplayName || activeRoleLabel || "AI 助理"}</h2>
        <span className={cn("mt-1 inline-block text-[11px] px-1.5 py-0.5 rounded-md font-medium", MODE_BADGE_STYLES[chatMode])}>
          {t("modes." + chatMode)}
        </span>
        <p className="text-[11px] text-muted-foreground mt-1">围绕你的目标与工作区，随时提问或下达任务</p>
      </div>
      {taskSummary.pending > 0 || taskSummary.running > 0 ? (
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent(EVENTS.COLLAB_CENTER_OPEN, { detail: { source: "welcome_task_summary" } }))}
          className="rounded-lg border border-border/50 bg-muted/20 px-2.5 py-1.5 text-[11px] text-muted-foreground hover:bg-muted/40 hover:text-foreground transition-colors"
        >
          {taskSummary.pending > 0 && t("thread.tasks.pending", { n: taskSummary.pending })}
          {taskSummary.pending > 0 && taskSummary.running > 0 && "，"}
          {taskSummary.running > 0 && t("thread.tasks.running", { n: taskSummary.running })}
          {" · 点击查看工作区"}
        </button>
      ) : null}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 max-w-lg">
        {shortcuts.map((card) => (
          <button
            key={card.title}
            type="button"
            onMouseDown={(e) => {
              e.preventDefault();
              window.dispatchEvent(new CustomEvent(EVENTS.FILL_PROMPT, { detail: { prompt: card.text } }));
            }}
            className="rounded-lg border border-border/50 bg-muted/20 p-2.5 cursor-pointer hover:bg-muted/40 active:scale-[0.97] transition-all duration-100 text-left flex flex-col items-center gap-1"
          >
            {card.icon}
            <span className="text-sm font-medium">{card.title}</span>
            <span className="text-[11px] text-muted-foreground">{card.sub}</span>
          </button>
        ))}
      </div>
    </div>
  );
});
