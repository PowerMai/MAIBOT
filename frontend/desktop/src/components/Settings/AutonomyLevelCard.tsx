import React, { useState, useEffect } from 'react';
import { Button } from '../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Label } from '../ui/label';
import { Switch } from '../ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { t } from '../../lib/i18n';
import {
  getAutonomyLevelConfig,
  updateAutonomyLevelConfig,
  AUTO_ACCEPT_TOOL_OPTIONS,
  type AutonomyLevelConfig,
} from '../../lib/api/systemApi';

export function AutonomyLevelCard() {
  const [config, setConfig] = useState<AutonomyLevelConfig>({
    level: 'L1',
    require_tool_approval: true,
    allow_idle_loop: false,
    allow_gated_code_changes: false,
    auto_accept_tools: [],
  });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await getAutonomyLevelConfig();
      if (!res.ok) {
        toast.error(t('settings.autonomyLevel.loadFailed'), { description: res.error || t('settings.imageAnalysis.unknownError') });
        return;
      }
      if (res.config) setConfig(res.config);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const save = async (next: AutonomyLevelConfig) => {
    setSaving(true);
    try {
      const res = await updateAutonomyLevelConfig({
        level: next.level,
        require_tool_approval: next.require_tool_approval,
        allow_idle_loop: next.allow_idle_loop,
        allow_gated_code_changes: next.allow_gated_code_changes,
        auto_accept_tools: next.auto_accept_tools,
      });
      if (!res.ok) {
        toast.error(t('settings.autonomyLevel.saveFailed'), { description: res.error || t('settings.imageAnalysis.unknownError') });
        return;
      }
      if (res.config) setConfig(res.config);
      toast.success(t('settings.autonomyLevel.saved'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{t('settings.autonomyLevel.title')}</CardTitle>
        <CardDescription>{t('settings.autonomyLevel.desc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1">
          <Label className="text-xs">{t('settings.autonomyLevel.label')}</Label>
          <Select
            value={config.level}
            onValueChange={(value: 'L0' | 'L1' | 'L2' | 'L3') => {
              const next: AutonomyLevelConfig = {
                ...config,
                level: value,
                require_tool_approval: value === 'L0' || value === 'L1',
                allow_idle_loop: value === 'L2' || value === 'L3',
                allow_gated_code_changes: value === 'L3',
              };
              setConfig(next);
              void save(next);
            }}
          >
            <SelectTrigger className="h-8 text-xs" disabled={saving}>
              <SelectValue placeholder={t('settings.autonomyLevel.placeholder')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="L0">{t('settings.autonomyLevel.l0')}</SelectItem>
              <SelectItem value="L1">{t('settings.autonomyLevel.l1')}</SelectItem>
              <SelectItem value="L2">{t('settings.autonomyLevel.l2')}</SelectItem>
              <SelectItem value="L3">{t('settings.autonomyLevel.l3')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-2">
          <div className="flex items-center justify-between rounded border p-2">
            <div>
              <p className="text-xs font-medium">{t('settings.autonomyLevel.toolApproval')}</p>
              <p className="text-[11px] text-muted-foreground">{t('settings.autonomyLevel.toolApprovalDesc')}</p>
            </div>
            <Switch
              checked={Boolean(config.require_tool_approval)}
              disabled={saving}
              onCheckedChange={(checked) => {
                const next = { ...config, require_tool_approval: checked };
                setConfig(next);
                void save(next);
              }}
            />
          </div>
          <div className="flex items-center justify-between rounded border p-2">
            <div>
              <p className="text-xs font-medium">{t('settings.autonomyLevel.idleLoop')}</p>
              <p className="text-[11px] text-muted-foreground">{t('settings.autonomyLevel.idleLoopDesc')}</p>
            </div>
            <Switch
              checked={Boolean(config.allow_idle_loop)}
              disabled={saving}
              onCheckedChange={(checked) => {
                const next = { ...config, allow_idle_loop: checked };
                setConfig(next);
                void save(next);
              }}
            />
          </div>
          <div className="flex items-center justify-between rounded border p-2">
            <div>
              <p className="text-xs font-medium">{t('settings.autonomyLevel.gatedCode')}</p>
              <p className="text-[11px] text-muted-foreground">{t('settings.autonomyLevel.gatedCodeDesc')}</p>
            </div>
            <Switch
              checked={Boolean(config.allow_gated_code_changes)}
              disabled={saving}
              onCheckedChange={(checked) => {
                const next = { ...config, allow_gated_code_changes: checked };
                setConfig(next);
                void save(next);
              }}
            />
          </div>
        </div>
        <div className="space-y-2">
          <p className="text-xs font-medium">{t('settings.autonomyLevel.defaultAccept')}</p>
          <p className="text-[11px] text-muted-foreground">{t('settings.autonomyLevel.defaultAcceptDesc')}</p>
          <div className="flex flex-wrap gap-3 pt-1">
            {AUTO_ACCEPT_TOOL_OPTIONS.map((opt) => {
              const checked = Array.isArray(config.auto_accept_tools) && config.auto_accept_tools.includes(opt.id);
              return (
                <label key={opt.id} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={saving}
                    onChange={() => {
                      const prev = config.auto_accept_tools ?? [];
                      const next = checked ? prev.filter((x) => x !== opt.id) : [...prev, opt.id];
                      const nextConfig = { ...config, auto_accept_tools: next };
                      setConfig(nextConfig);
                      void save(nextConfig);
                    }}
                    className="rounded border-border"
                  />
                  <span className="text-xs">{opt.label}</span>
                </label>
              );
            })}
          </div>
        </div>
        <div className="flex justify-end">
          <Button size="sm" variant="ghost" disabled={loading || saving} onClick={() => void load()}>
            {loading ? <RefreshCw className="h-4 w-4 animate-spin" /> : t('settings.sensitiveScan.refresh')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
