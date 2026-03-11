/**
 * 组织策略（资源/学习）配置卡片
 */
import React, { useState, useEffect, useMemo } from 'react';
import { Button } from '../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Label } from '../ui/label';
import { Input } from '../ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { ScrollArea } from '../ui/scroll-area';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../ui/dialog';
import { RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { boardApi } from '../../lib/api/boardApi';
import { EVENTS } from '../../lib/constants';
import { getScopedActiveRoleIdFromStorage } from '../../lib/roleIdentity';

export function OrganizationPolicyCard() {
  const readActiveRoleFromStorage = () => getScopedActiveRoleIdFromStorage();
  const [agentId, setAgentId] = useState<string>(() =>
    readActiveRoleFromStorage()
  );
  const [cpuSlots, setCpuSlots] = useState<number>(1);
  const [modelCallsPerHour, setModelCallsPerHour] = useState<number>(100);
  const [usdBudgetDaily, setUsdBudgetDaily] = useState<number>(0);
  const [learningScore, setLearningScore] = useState<number | null>(null);
  const [learningSucc, setLearningSucc] = useState<number>(0);
  const [learningFail, setLearningFail] = useState<number>(0);
  const [learningRows, setLearningRows] = useState<{ success_patterns: Array<Record<string, unknown>>; failure_lessons: Array<Record<string, unknown>> }>({
    success_patterns: [],
    failure_lessons: [],
  });
  const [learningTaskTypeFilter, setLearningTaskTypeFilter] = useState<string>('all');
  const [learningFailureReasonFilter, setLearningFailureReasonFilter] = useState<string>('all');
  const [showLearningDialog, setShowLearningDialog] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const readRowField = (row: Record<string, unknown>, keys: string[]): string => {
    for (const key of keys) {
      const value = row[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      if (value && typeof value === 'object') {
        const nested = value as Record<string, unknown>;
        const nestedMessage = nested.message;
        if (typeof nestedMessage === 'string' && nestedMessage.trim()) return nestedMessage.trim();
      }
    }
    return '';
  };

  const taskTypeOptions = React.useMemo(() => {
    const bucket = new Set<string>();
    const rows = [...learningRows.success_patterns, ...learningRows.failure_lessons];
    for (const row of rows) {
      const v = readRowField(row, ['task_type', 'taskType', 'category', 'type']);
      if (v) bucket.add(v);
    }
    return Array.from(bucket).slice(0, 30);
  }, [learningRows]);

  const failureReasonOptions = React.useMemo(() => {
    const bucket = new Set<string>();
    for (const row of learningRows.failure_lessons) {
      const v = readRowField(row, ['failure_reason', 'reason', 'error', 'cause', 'lesson', 'message']);
      if (v) bucket.add(v);
    }
    return Array.from(bucket).slice(0, 30);
  }, [learningRows]);

  const filteredSuccessPatterns = React.useMemo(() => {
    if (learningTaskTypeFilter === 'all') return learningRows.success_patterns;
    return learningRows.success_patterns.filter((row) => {
      const type = readRowField(row, ['task_type', 'taskType', 'category', 'type']);
      return type === learningTaskTypeFilter;
    });
  }, [learningRows.success_patterns, learningTaskTypeFilter]);

  const filteredFailureLessons = React.useMemo(() => {
    return learningRows.failure_lessons.filter((row) => {
      if (learningTaskTypeFilter !== 'all') {
        const type = readRowField(row, ['task_type', 'taskType', 'category', 'type']);
        if (type !== learningTaskTypeFilter) return false;
      }
      if (learningFailureReasonFilter !== 'all') {
        const reason = readRowField(row, ['failure_reason', 'reason', 'error', 'cause', 'lesson', 'message']);
        if (reason !== learningFailureReasonFilter) return false;
      }
      return true;
    });
  }, [learningRows.failure_lessons, learningTaskTypeFilter, learningFailureReasonFilter]);

  const load = async (nextAgentId?: string) => {
    const aid = String(nextAgentId ?? agentId).trim();
    if (!aid) return;
    setLoading(true);
    try {
      const [qRes, lRes] = await Promise.all([
        boardApi.getOrganizationResourceQuota(aid),
        boardApi.getOrganizationLearningRecent({ agent_id: aid, limit: 40 }),
      ]);
      if (qRes.ok && qRes.quota) {
        setCpuSlots(Number(qRes.quota.cpu_slots ?? 1));
        setModelCallsPerHour(Number(qRes.quota.model_calls_per_hour ?? 100));
        setUsdBudgetDaily(Number(qRes.quota.usd_budget_daily ?? 0));
      }
      if (lRes.ok && lRes.agent_score) {
        setLearningScore(Number(lRes.agent_score.score ?? 0));
        setLearningSucc(Number(lRes.agent_score.success_count ?? 0));
        setLearningFail(Number(lRes.agent_score.failure_count ?? 0));
        setLearningRows({
          success_patterns: Array.isArray(lRes.rows?.success_patterns) ? lRes.rows.success_patterns : [],
          failure_lessons: Array.isArray(lRes.rows?.failure_lessons) ? lRes.rows.failure_lessons : [],
        });
      } else {
        setLearningScore(null);
        setLearningSucc(0);
        setLearningFail(0);
        setLearningRows({ success_patterns: [], failure_lessons: [] });
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (agentId) void load(agentId);
  }, [agentId]);

  useEffect(() => {
    const syncRoleFromContext = () => {
      const activeRole = readActiveRoleFromStorage();
      if (activeRole && activeRole !== agentId) {
        setAgentId(activeRole);
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
  }, [agentId]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">组织策略（资源/学习）</CardTitle>
        <CardDescription>按角色配置资源配额，并查看集体学习评分</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1">
          <Label className="text-xs">角色 ID（agent_id）</Label>
          <div className="flex gap-2">
            <Input
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              placeholder="例如 assistant"
              className="h-8 text-xs font-mono"
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setAgentId(readActiveRoleFromStorage())}
              disabled={!readActiveRoleFromStorage()}
            >
              使用当前角色
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <div className="space-y-1">
            <Label className="text-xs">CPU 槽位</Label>
            <Input
              type="number"
              min={1}
              value={cpuSlots}
              onChange={(e) => setCpuSlots(Math.max(1, Number(e.target.value || 1)))}
              className="h-8 text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">模型调用/小时</Label>
            <Input
              type="number"
              min={1}
              value={modelCallsPerHour}
              onChange={(e) => setModelCallsPerHour(Math.max(1, Number(e.target.value || 100)))}
              className="h-8 text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">日预算（USD）</Label>
            <Input
              type="number"
              min={0}
              step={0.1}
              value={usdBudgetDaily}
              onChange={(e) => setUsdBudgetDaily(Math.max(0, Number(e.target.value || 0)))}
              className="h-8 text-xs"
            />
          </div>
        </div>

        <div className="rounded border border-border/50 bg-muted/20 px-2 py-1 text-[11px] text-muted-foreground">
          学习评分：{learningScore == null ? '暂无样本' : learningScore.toFixed(2)}
          {learningScore != null ? `（成功 ${learningSucc} / 失败 ${learningFail}）` : ''}
        </div>

        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={loading || !agentId.trim()}
            onClick={() => void load(agentId)}
          >
            {loading ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : '刷新'}
          </Button>
          <Button
            size="sm"
            disabled={saving || !agentId.trim()}
            onClick={async () => {
              const aid = String(agentId || '').trim();
              if (!aid) {
                toast.error('请先填写角色 ID');
                return;
              }
              setSaving(true);
              try {
                const res = await boardApi.setOrganizationResourceQuota({
                  agent_id: aid,
                  cpu_slots: cpuSlots,
                  model_calls_per_hour: modelCallsPerHour,
                  usd_budget_daily: usdBudgetDaily,
                });
                if (!res.ok) {
                  toast.error('保存配额失败', { description: res.error || '未知错误' });
                  return;
                }
                toast.success('组织资源配额已保存');
                await load(aid);
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : '保存配额'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={learningRows.success_patterns.length + learningRows.failure_lessons.length === 0}
            onClick={() => setShowLearningDialog(true)}
          >
            查看学习样本
          </Button>
        </div>
      </CardContent>
      <Dialog open={showLearningDialog} onOpenChange={setShowLearningDialog}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>组织学习样本</DialogTitle>
            <DialogDescription>
              角色 {agentId || '-'} 的近期成功/失败样本，可用于调参和复盘。
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs">任务类型</Label>
              <Select value={learningTaskTypeFilter} onValueChange={setLearningTaskTypeFilter}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="全部任务类型" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部任务类型</SelectItem>
                  {taskTypeOptions.map((item) => (
                    <SelectItem key={item} value={item}>
                      {item}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">失败原因</Label>
              <Select value={learningFailureReasonFilter} onValueChange={setLearningFailureReasonFilter}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="全部失败原因" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部失败原因</SelectItem>
                  {failureReasonOptions.map((item) => (
                    <SelectItem key={item} value={item}>
                      {item.length > 48 ? `${item.slice(0, 48)}...` : item}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">成功样本 ({filteredSuccessPatterns.length})</Label>
              <ScrollArea className="h-[220px] rounded border p-2 text-[11px] font-mono">
                <pre className="whitespace-pre-wrap break-all">
                  {JSON.stringify(filteredSuccessPatterns, null, 2)}
                </pre>
              </ScrollArea>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">失败样本 ({filteredFailureLessons.length})</Label>
              <ScrollArea className="h-[220px] rounded border p-2 text-[11px] font-mono">
                <pre className="whitespace-pre-wrap break-all">
                  {JSON.stringify(filteredFailureLessons, null, 2)}
                </pre>
              </ScrollArea>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
