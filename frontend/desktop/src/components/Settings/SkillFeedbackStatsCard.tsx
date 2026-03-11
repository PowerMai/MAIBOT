import React, { useState, useEffect } from 'react';
import { Button } from '../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { ScrollArea } from '../ui/scroll-area';
import { RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { t } from '../../lib/i18n';
import { getSkillFeedbackStats, type SkillFeedbackItem } from '../../lib/api/systemApi';

export function SkillFeedbackStatsCard() {
  const [items, setItems] = useState<SkillFeedbackItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadStats = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getSkillFeedbackStats(10);
      if (res.ok) {
        setItems(res.items || []);
      } else {
        setError(res.error || t('settings.getFailed'));
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      toast.error(t('settings.getFailed'), { description: msg });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadStats();
  }, []);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{t('settings.skillFeedback.title')}</CardTitle>
        <CardDescription>{t('settings.skillFeedback.desc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-center justify-end">
          <Button size="sm" variant="outline" onClick={loadStats} disabled={loading}>
            {loading ? <RefreshCw className="h-4 w-4 animate-spin" /> : t('settings.skillFeedback.refresh')}
          </Button>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        {items.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('settings.noFeedbackData')}</p>
        ) : (
          <ScrollArea className="h-[160px] rounded border p-2">
            <div className="space-y-2">
              {items.map((it) => (
                <div key={it.skill_name} className="rounded border p-2 text-[11px]">
                  <p className="font-medium">{it.skill_name}</p>
                  <p className="text-muted-foreground">
                    {t('settings.skillFeedback.positiveNegative', {
                      positive: it.positive,
                      negative: it.negative,
                      rate: ((it.positive_rate ?? 0) * 100).toFixed(1),
                    })}
                  </p>
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}
