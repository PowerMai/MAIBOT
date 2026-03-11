"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import { Brain, Plus, Search, Trash2, Loader2, Trash, Pencil, ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { ScrollArea } from "./ui/scroll-area";
import { getApiBase } from "../lib/api/langserveChat";
import { getItem as getStorageItem } from "../lib/safeStorage";
import { userModelApi, type UserProfileDto } from "../lib/api/userModelApi";
import { toast } from "sonner";
import { cn } from "./ui/utils";
import { t } from "../lib/i18n";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";

type MemoryEntry = {
  id: string;
  content: string;
  created_at: string;
  namespace?: string[];
};

export const MemoryPanel: React.FC<{ workspacePath?: string | null }> = ({ workspacePath }) => {
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [addText, setAddText] = useState("");
  const [adding, setAdding] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [cleanupLoading, setCleanupLoading] = useState(false);
  const [showCleanupConfirm, setShowCleanupConfirm] = useState(false);
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const editSaveGuardRef = useRef(false);
  const editingClearedBySaveRef = useRef(false);
  const [profile, setProfile] = useState<UserProfileDto | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileLoading, setProfileLoading] = useState(false);
  const mountedRef = useRef(true);

  const userId = getStorageItem("maibot_user_id") || undefined;
  const wsId = workspacePath || "default";

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const fetchEntries = useCallback(async () => {
    if (mountedRef.current) setLoading(true);
    try {
      const base = getApiBase();
      const params = new URLSearchParams({ limit: "100" });
      if (workspacePath) params.set("workspace_path", workspacePath);
      if (userId) params.set("user_id", userId);
      const res = await fetch(`${base}/memory/entries?${params}`);
      if (!res.ok) {
        if (mountedRef.current) { setEntries([]); toast.error("记忆加载失败"); }
        return;
      }
      const data = await res.json().catch(() => ({ __parseError: true } as const));
      if (!mountedRef.current) return;
      if ((data as { __parseError?: boolean })?.__parseError) {
        setEntries([]);
        toast.error(t('composer.responseParseFailed'));
        return;
      }
      if (data.ok && Array.isArray(data.entries)) {
        setEntries(data.entries);
      } else {
        setEntries([]);
      }
    } catch (e) {
      if (mountedRef.current) {
        setEntries([]);
        toast.error("记忆加载失败");
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [workspacePath, userId]);

  useEffect(() => {
    fetchEntries();
  }, [fetchEntries]);

  useEffect(() => {
    if (mountedRef.current) setProfileLoading(true);
    userModelApi.get(wsId).then((res) => {
      if (!mountedRef.current) return;
      if (res.ok && res.profile) setProfile(res.profile);
      else setProfile(null);
    }).catch(() => {
      if (mountedRef.current) {
        setProfile(null);
        toast.error(t("execution.loadFailed"));
      }
    }).finally(() => {
      if (mountedRef.current) setProfileLoading(false);
    });
  }, [wsId]);

  const filtered = React.useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) => String(e.content || "").toLowerCase().includes(q));
  }, [entries, searchQuery]);

  const handleDelete = async (id: string) => {
    if (mountedRef.current) setDeletingId(id);
    try {
      const base = getApiBase();
      const q = new URLSearchParams();
      if (workspacePath) q.set("workspace_path", workspacePath);
      if (userId) q.set("user_id", userId);
      const params = q.toString() ? `?${q.toString()}` : "";
      const res = await fetch(`${base}/memory/entries/${encodeURIComponent(id)}${params}`, { method: "DELETE" });
      if (!res.ok) {
        if (mountedRef.current) toast.error("删除失败");
        return;
      }
      const data = await res.json().catch(() => ({ __parseError: true } as const));
      if (!mountedRef.current) return;
      if ((data as { __parseError?: boolean })?.__parseError) {
        toast.error(t('composer.responseParseFailed'));
        return;
      }
      if (data.ok) {
        setEntries((prev) => prev.filter((e) => e.id !== id));
        toast.success("已删除");
      } else {
        toast.error(data.error || "删除失败");
      }
    } catch (e) {
      if (mountedRef.current) toast.error("删除失败");
    } finally {
      if (mountedRef.current) setDeletingId(null);
    }
  };

  const handleAdd = async () => {
    const text = addText.trim();
    if (!text || adding) return;
    if (mountedRef.current) setAdding(true);
    try {
      const base = getApiBase();
      const q = new URLSearchParams();
      if (workspacePath) q.set("workspace_path", workspacePath);
      if (userId) q.set("user_id", userId);
      const params = q.toString() ? `?${q.toString()}` : "";
      const res = await fetch(`${base}/memory/entries${params}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text }),
      });
      if (!res.ok) {
        if (mountedRef.current) toast.error("添加失败");
        return;
      }
      const data = await res.json().catch(() => ({ __parseError: true } as const));
      if (!mountedRef.current) return;
      if ((data as { __parseError?: boolean })?.__parseError) {
        toast.error(t('composer.responseParseFailed'));
        return;
      }
      if (data.ok) {
        setEntries((prev) => [{ id: data.id, content: data.content || text, created_at: new Date().toISOString() }, ...prev]);
        setAddText("");
        toast.success("已添加");
      } else {
        toast.error(data.detail || data.error || "添加失败");
      }
    } catch (e) {
      if (mountedRef.current) toast.error("添加失败");
    } finally {
      if (mountedRef.current) setAdding(false);
    }
  };

  const handleUpdateEntry = async (id: string, newContent: string) => {
    if (editSaveGuardRef.current) return;
    editSaveGuardRef.current = true;
    try {
      const base = getApiBase();
      const q = new URLSearchParams();
      if (workspacePath) q.set("workspace_path", workspacePath);
      if (userId) q.set("user_id", userId);
      const params = q.toString() ? `?${q.toString()}` : "";
      const res = await fetch(`${base}/memory/entries/${encodeURIComponent(id)}${params}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: newContent }),
      });
      if (!res.ok) {
        if (mountedRef.current) toast.error("更新失败");
        return;
      }
      const data = await res.json().catch(() => ({ __parseError: true } as const));
      if (!mountedRef.current) return;
      if ((data as { __parseError?: boolean })?.__parseError) {
        toast.error(t('composer.responseParseFailed'));
        return;
      }
      if (data.ok) {
        editingClearedBySaveRef.current = true;
        setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, content: newContent } : e)));
        setEditingEntryId(null);
        setEditDraft("");
        toast.success("已更新");
      } else {
        toast.error(data.error || data.detail || "更新失败");
      }
    } catch (e) {
      if (mountedRef.current) toast.error("更新失败");
    } finally {
      editSaveGuardRef.current = false;
    }
  };

  const handleCleanup = async () => {
    if (cleanupLoading) return;
    if (mountedRef.current) setCleanupLoading(true);
    try {
      const base = getApiBase();
      const q = new URLSearchParams();
      if (workspacePath) q.set("workspace_path", workspacePath);
      if (userId) q.set("user_id", userId);
      const params = q.toString() ? `?${q.toString()}` : "";
      const res = await fetch(`${base}/memory/cleanup${params}`, { method: "POST" });
      if (!res.ok) {
        if (mountedRef.current) toast.error("清理失败");
        return;
      }
      const data = await res.json().catch(() => ({ __parseError: true } as const));
      if (!mountedRef.current) return;
      if ((data as { __parseError?: boolean })?.__parseError) {
        toast.error(t('composer.responseParseFailed'));
        return;
      }
      if (data.success === true) {
        toast.success("清理完成");
        await fetchEntries();
      } else {
        toast.error(data.error || data.detail || "清理失败");
      }
    } catch (e) {
      if (mountedRef.current) toast.error("清理失败");
    } finally {
      if (mountedRef.current) setCleanupLoading(false);
    }
  };

  const hasProfileData = profile && (
    (profile.learning_trajectory?.length ?? 0) > 0 ||
    !!profile.domain_expertise?.trim() ||
    (profile.unsolved_intents?.length ?? 0) > 0
  );

  return (
    <div className="h-full flex flex-col min-h-0">
      {hasProfileData && (
        <div className="shrink-0 border-b border-border/20">
          <button
            type="button"
            onClick={() => setProfileOpen((o) => !o)}
            className="w-full flex items-center gap-1.5 px-2 py-1.5 text-left text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/30"
          >
            {profileOpen ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
            <span className="font-medium">用户画像</span>
            {profileLoading && <Loader2 className="size-3 animate-spin shrink-0" />}
          </button>
          {profileOpen && !profile && profileLoading && (
            <div className="px-2 pb-2 pt-0 text-[11px] text-muted-foreground">{t("common.loading")}</div>
          )}
          {profileOpen && profile && (
            <div className="px-2 pb-2 pt-0 space-y-1.5 text-[11px] text-muted-foreground">
              {profile.domain_expertise?.trim() && (
                <div><span className="text-foreground/80">专业度：</span>{profile.domain_expertise}</div>
              )}
              {(profile.learning_trajectory?.length ?? 0) > 0 && (
                <div>
                  <span className="text-foreground/80">成长轨迹（最近 3 条）：</span>
                  <ul className="mt-0.5 list-none pl-0 space-y-0.5">
                    {(profile.learning_trajectory ?? []).slice(-3).reverse().map((item, i) => (
                      <li key={i}>{item}</li>
                    ))}
                  </ul>
                </div>
              )}
              {(profile.unsolved_intents?.length ?? 0) > 0 && (
                <div><span className="text-foreground/80">未完成意图：</span>{profile.unsolved_intents?.length ?? 0} 条</div>
              )}
            </div>
          )}
        </div>
      )}
      <div className="shrink-0 p-2 border-b border-border/20 space-y-1.5">
        <p className="text-[10px] text-muted-foreground px-0.5" title={t("memory.usageHint")}>
          {t("memory.usageHint")}
        </p>
        <div className="flex items-center gap-2">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            <Input
              placeholder="搜索记忆…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-7 h-7 text-[11px]"
            />
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 shrink-0 text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => setShowCleanupConfirm(true)}
            disabled={cleanupLoading}
            title="清理过期记忆"
          >
            {cleanupLoading ? <Loader2 className="size-3 animate-spin" /> : <Trash className="size-3" />}
            <span className="ml-1">清理过期</span>
          </Button>
        </div>
      </div>
      <AlertDialog open={showCleanupConfirm} onOpenChange={setShowCleanupConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>清理过期记忆</AlertDialogTitle>
            <AlertDialogDescription>确定清理当前工作区下的过期记忆？此操作不可恢复。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setShowCleanupConfirm(false);
                void handleCleanup();
              }}
            >
              确认清理
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <ScrollArea className="flex-1 min-h-0">
        <div className="p-2 space-y-1">
          {loading ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-10 px-4 text-center" role="status" aria-live="polite" aria-label={entries.length === 0 ? t("memory.noMemory") : t("memory.noMatchResult")}>
              <div className="w-14 h-14 rounded-2xl bg-muted/50 flex items-center justify-center mx-auto mb-4">
                <Brain className="size-7 text-muted-foreground" />
              </div>
              {entries.length === 0 ? (
                <>
                  <p className="text-sm font-medium text-foreground mb-1">{t("memory.noMemory")}</p>
                  <p className="text-xs text-muted-foreground">{t("memory.noMemoryHint")}</p>
                </>
              ) : (
                <>
                  <p className="text-sm font-medium text-foreground mb-1">{t("memory.noMatchResult")}</p>
                  <p className="text-xs text-muted-foreground">{t("memory.noMatchHint", { query: searchQuery })}</p>
                </>
              )}
            </div>
          ) : (
            filtered.map((e) => (
              <div
                key={e.id}
                className={cn(
                  "group rounded-md border border-border/40 bg-muted/20 p-2 text-[11px]",
                  "flex items-start gap-2"
                )}
              >
                {editingEntryId === e.id ? (
                  <Textarea
                    value={editDraft}
                    onChange={(ev) => setEditDraft(ev.target.value)}
                    onKeyDown={(ev) => {
                      if (ev.key === "Escape") {
                        setEditingEntryId(null);
                        setEditDraft("");
                      }
                      if (ev.key === "Enter" && !ev.shiftKey) {
                        ev.preventDefault();
                        const trimmed = editDraft.trim();
                        if (trimmed && trimmed !== e.content) handleUpdateEntry(e.id, trimmed);
                        else {
                          setEditingEntryId(null);
                          setEditDraft("");
                        }
                      }
                    }}
                    onBlur={() => {
                      if (editingClearedBySaveRef.current) {
                        editingClearedBySaveRef.current = false;
                        return;
                      }
                      const trimmed = editDraft.trim();
                      if (trimmed && trimmed !== e.content) {
                        handleUpdateEntry(e.id, trimmed);
                      } else {
                        setEditingEntryId(null);
                        setEditDraft("");
                      }
                    }}
                    className="flex-1 min-w-0 text-[11px] min-h-[60px] resize-y"
                    autoFocus
                  />
                ) : (
                  <>
                    <p className="flex-1 min-w-0 text-foreground/90 wrap-break-word">{e.content || "(空)"}</p>
                    <div className="shrink-0 flex items-center gap-1">
                      {e.created_at && (
                        <span className="text-[10px] text-muted-foreground/60">
                          {new Date(e.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                        </span>
                      )}
                      <button
                        type="button"
                        className="opacity-0 group-hover:opacity-100 h-6 w-6 rounded flex items-center justify-center text-muted-foreground hover:text-foreground transition-all"
                        onClick={() => {
                          setEditingEntryId(e.id);
                          setEditDraft(e.content || "");
                        }}
                        title="编辑"
                      >
                        <Pencil className="size-3" />
                      </button>
                      <button
                        type="button"
                        className="opacity-0 group-hover:opacity-100 h-6 w-6 rounded flex items-center justify-center text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-all"
                        onClick={() => handleDelete(e.id)}
                        disabled={deletingId === e.id}
                        title="删除"
                      >
                        {deletingId === e.id ? <Loader2 className="size-3 animate-spin" /> : <Trash2 className="size-3" />}
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))
          )}
        </div>
      </ScrollArea>
      <div className="shrink-0 p-2 border-t border-border/20 flex gap-2">
        <Input
          placeholder="手动添加记忆…"
          value={addText}
          onChange={(e) => setAddText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
          className="h-7 text-[11px] flex-1 min-w-0"
        />
        <Button size="sm" variant="secondary" className="h-7 px-2 shrink-0" onClick={handleAdd} disabled={!addText.trim() || adding}>
          {adding ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />}
        </Button>
      </div>
    </div>
  );
};

export default MemoryPanel;
