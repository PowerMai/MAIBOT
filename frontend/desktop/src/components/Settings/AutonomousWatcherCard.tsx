/**
 * 自治巡检（Task Watcher）配置卡片
 */
import React, { useState, useEffect } from 'react';
import { Button } from '../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Label } from '../ui/label';
import { Input } from '../ui/input';
import { Switch } from '../ui/switch';
import { Separator } from '../ui/separator';
import { RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { boardApi } from '../../lib/api/boardApi';
import {
  getAutonomousWatcherConfig,
  resetAutonomousWatcherObservability,
  updateAutonomousWatcherConfig,
  type AutonomousWatcherRuntime,
} from '../../lib/api/systemApi';
import { EVENTS } from '../../lib/constants';
import { getScopedActiveRoleIdFromStorage } from '../../lib/roleIdentity';

export function AutonomousWatcherCard() {
  const readActiveRoleFromStorage = () => getScopedActiveRoleIdFromStorage();
  const [enabled, setEnabled] = useState(false);
  const [roleId, setRoleId] = useState<string>(() => readActiveRoleFromStorage());
  const [runtime, setRuntime] = useState<AutonomousWatcherRuntime | null>(null);
  const [availableRoles, setAvailableRoles] = useState<Array<{ id: string; label?: string; skill_profile?: string }>>([]);
  const [quotaCpuSlots, setQuotaCpuSlots] = useState<number>(1);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resettingObs, setResettingObs] = useState(false);

  const loadQuota = async (nextRoleId?: string) => {
    const rid = String(nextRoleId ?? roleId ?? '').trim();
    if (!rid) {
      setQuotaCpuSlots(1);
      return;
    }
    const qRes = await boardApi.getOrganizationResourceQuota(rid);
    if (qRes.ok && qRes.quota) {
      setQuotaCpuSlots(Math.max(1, Number(qRes.quota.cpu_slots ?? 1)));
    } else {
      setQuotaCpuSlots(1);
    }
  };

  const loadConfig = async () => {
    setLoading(true);
    try {
      const res = await getAutonomousWatcherConfig();
      if (!res.ok) {
        toast.error('读取自治巡检配置失败', { description: res.error || '未知错误' });
        return;
      }
      setEnabled(Boolean(res.config?.enabled));
      setRoleId(String(res.config?.role_id || ''));
      setRuntime(res.runtime || null);
      setAvailableRoles(Array.isArray(res.available_roles) ? res.available_roles : []);
      await loadQuota(String(res.config?.role_id || ''));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadConfig();
  }, []);

  const handleSave = async (nextEnabled: boolean, nextRoleId: string) => {
    setSaving(true);
    try {
      const res = await updateAutonomousWatcherConfig({
        enabled: nextEnabled,
        role_id: nextRoleId.trim(),
      });
      if (!res.ok) {
        const roles = Array.isArray(res.available_roles) ? res.available_roles : [];
        if (roles.length > 0) setAvailableRoles(roles);
        if (nextEnabled && !nextRoleId.trim() && roles.length > 0) {
          const suggested = String(roles[0].id || '').trim();
          if (suggested) {
            setRoleId(suggested);
            const retryRes = await updateAutonomousWatcherConfig({
              enabled: true,
              role_id: suggested,
            });
            if (retryRes.ok) {
              setEnabled(Boolean(retryRes.config?.enabled));
              setRoleId(String(retryRes.config?.role_id || suggested));
              setRuntime(retryRes.runtime || null);
              setAvailableRoles(Array.isArray(retryRes.available_roles) ? retryRes.available_roles : roles);
              toast.success('已使用推荐角色自动重试并启用自治巡检');
              window.dispatchEvent(
                new CustomEvent(EVENTS.AUTONOMOUS_WATCHER_CONFIG_CHANGED, {
                  detail: { source: 'settings' },
                }),
              );
              return;
            }
            toast.warning('启用失败：缺少角色 ID，已自动填充建议角色', {
              description: `建议角色：${roles[0].label || suggested}。请点击「保存」重试。`,
            });
            return;
          }
        }
        toast.error('更新自治巡检失败', { description: res.error || '未知错误' });
        return;
      }
      setEnabled(Boolean(res.config?.enabled));
      setRoleId(String(res.config?.role_id || nextRoleId));
      setRuntime(res.runtime || null);
      setAvailableRoles(Array.isArray(res.available_roles) ? res.available_roles : []);
      await loadQuota(String(res.config?.role_id || nextRoleId));
      toast.success(nextEnabled ? '自治巡检已启用' : '自治巡检已停用');
      window.dispatchEvent(
        new CustomEvent(EVENTS.AUTONOMOUS_WATCHER_CONFIG_CHANGED, {
          detail: { source: 'settings' },
        }),
      );
    } finally {
      setSaving(false);
    }
  };

  const handleResetObservability = async () => {
    setResettingObs(true);
    try {
      const res = await resetAutonomousWatcherObservability();
      if (!res.ok) {
        toast.error('重置观测计数失败', { description: res.error || '未知错误' });
        return;
      }
      if (res.runtime) {
        setRuntime(res.runtime);
      } else {
        setRuntime((prev) => (prev ? { ...prev, invites_observability: res.invites_observability } : prev));
      }
      toast.success('已重置 Invites 观测计数');
    } finally {
      setResettingObs(false);
    }
  };

  useEffect(() => {
    const onWatcherChanged = () => {
      void loadConfig();
    };
    window.addEventListener(EVENTS.AUTONOMOUS_WATCHER_CONFIG_CHANGED, onWatcherChanged);
    return () => window.removeEventListener(EVENTS.AUTONOMOUS_WATCHER_CONFIG_CHANGED, onWatcherChanged);
  }, []);

  useEffect(() => {
    void loadQuota(roleId);
  }, [roleId]);

  useEffect(() => {
    const syncRoleFromContext = () => {
      const activeRole = readActiveRoleFromStorage();
      if (activeRole && activeRole !== roleId) {
        setRoleId(activeRole);
      }
    };
    window.addEventListener(EVENTS.ROLE_CHANGED, syncRoleFromContext);
    window.addEventListener(EVENTS.COMPOSER_PREFS_CHANGED, syncRoleFromContext);
    window.addEventListener('storage', syncRoleFromContext);
    return () => {
      window.removeEventListener(EVENTS.ROLE_CHANGED, syncRoleFromContext);
      window.removeEventListener(EVENTS.COMPOSER_PREFS_CHANGED, syncRoleFromContext);
      window.removeEventListener('storage', syncRoleFromContext);
    };
  }, [roleId]);

  const executingTasks = Number(runtime?.executing_tasks || 0);
  const gateBlocked = executingTasks >= quotaCpuSlots;
  const inviteObs = runtime?.invites_observability;
  const inviteSearchCalls = Number(inviteObs?.scan_search_calls || 0);
  const inviteFallbackCalls = Number(inviteObs?.scan_fallback_calls || 0);
  const inviteScanCalls = inviteSearchCalls + inviteFallbackCalls;
  const fallbackRatio = inviteScanCalls > 0 ? Math.round((inviteFallbackCalls / inviteScanCalls) * 100) : 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">自治巡检（Task Watcher）</CardTitle>
        <CardDescription>设置页开关可即时控制任务巡检后台任务</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-center justify-between rounded border p-2">
          <div>
            <p className="text-xs font-medium">启用自治巡检</p>
            <p className="text-[11px] text-muted-foreground">开启后自动巡检可领取任务并触发调度执行</p>
          </div>
          <Switch
            checked={enabled}
            disabled={saving}
            onCheckedChange={(checked) => {
              setEnabled(checked);
              void handleSave(checked, roleId);
            }}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Watcher 角色 ID（可选）</Label>
          {availableRoles.length > 0 && (
            <div className="rounded border p-2 space-y-1">
              <p className="text-[11px] text-muted-foreground">可用角色（点击填充）</p>
              <div className="flex flex-wrap gap-1">
                {availableRoles.slice(0, 8).map((r) => (
                  <Button
                    key={r.id}
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-[10px]"
                    onClick={() => setRoleId(r.id)}
                  >
                    {r.label || r.id}
                  </Button>
                ))}
              </div>
            </div>
          )}
          <div className="flex gap-2">
            <Input
              value={roleId}
              onChange={(e) => setRoleId(e.target.value)}
              placeholder="如 assistant-general"
              className="h-8 text-xs font-mono"
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setRoleId(readActiveRoleFromStorage())}
              disabled={!readActiveRoleFromStorage()}
            >
              使用当前角色
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={saving}
              onClick={() => void handleSave(enabled, roleId)}
            >
              保存
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={loading || saving || resettingObs}
              onClick={() => void loadConfig()}
            >
              {loading ? <RefreshCw className="h-4 w-4 animate-spin" /> : '刷新'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={loading || saving || resettingObs}
              onClick={() => void handleResetObservability()}
            >
              {resettingObs ? <RefreshCw className="h-4 w-4 animate-spin" /> : '重置观测'}
            </Button>
          </div>
        </div>
        <div className="text-[11px] text-muted-foreground space-y-1">
          <p>运行状态：{runtime?.enabled ? 'running' : 'stopped'}</p>
          <p>调度器：{runtime?.scheduler_running ? 'running' : 'stopped'}</p>
          <p>执行中任务：{Number(runtime?.executing_tasks || 0)}</p>
          {!!runtime?.assistant_id && <p>当前角色：{runtime.assistant_id}</p>}
          <p>资源门控：CPU 槽位 {quotaCpuSlots} · 当前执行 {executingTasks} · {gateBlocked ? '已触发限流' : '可继续调度'}</p>
          <Separator className="my-1" />
          <p className="font-medium text-foreground">Invites 观测</p>
          <p>
            读路径命中：search {inviteSearchCalls} 次 / list+get {inviteFallbackCalls} 次
            {inviteScanCalls > 0 ? `（fallback ${fallbackRatio}%）` : ''}
          </p>
          <p>
            扫描行数：search {Number(inviteObs?.scan_search_rows || 0)} · fallback {Number(inviteObs?.scan_fallback_rows || 0)}
            {Number(inviteObs?.scan_search_errors || 0) > 0 ? ` · search_err ${Number(inviteObs?.scan_search_errors || 0)}` : ''}
          </p>
          <p>
            处理结果：seen {Number(inviteObs?.rows_seen || 0)} · processable {Number(inviteObs?.processable_rows || 0)} · submit {Number(inviteObs?.bid_submitted || 0)} · fail {Number(inviteObs?.bid_failed || 0)}
          </p>
          <p>
            过滤结果：ignored {Number(inviteObs?.ignored || 0)} · skipped {Number(inviteObs?.skipped || 0)} · invalid {Number(inviteObs?.invalid || 0)}
            {Number(inviteObs?.loop_errors || 0) > 0 ? ` · loop_err ${Number(inviteObs?.loop_errors || 0)}` : ''}
          </p>
          {!!inviteObs?.last_scan_path && <p>最近扫描：{String(inviteObs.last_scan_path)} @ {String(inviteObs.last_scan_at || '-')}</p>}
          {!!inviteObs?.last_error && <p>最近错误：{String(inviteObs.last_error)}</p>}
        </div>
      </CardContent>
    </Card>
  );
}
