import React, { useState, useEffect } from 'react';
import { Button } from '../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { ScrollArea } from '../ui/scroll-area';
import { Badge } from '../ui/badge';
import { RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { t } from '../../lib/i18n';
import { getSensitiveFiles, type SensitiveFileCandidate } from '../../lib/api/systemApi';

export function SensitiveFilesCard() {
  const [items, setItems] = useState<SensitiveFileCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);

  const loadItems = async (abortSignal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const res = await getSensitiveFiles(200, abortSignal);
      if (abortSignal?.aborted) return;
      if (!res.ok) {
        setItems([]);
        setTruncated(false);
        setError(res.error || t('settings.sensitiveScan.loadFailed'));
        return;
      }
      setItems(res.items || []);
      setTruncated(Boolean(res.truncated));
    } catch (e) {
      if (abortSignal?.aborted) return;
      setItems([]);
      setTruncated(false);
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      toast.error(t('settings.sensitiveScan.loadFailed'), { description: msg });
    } finally {
      if (!abortSignal?.aborted) setLoading(false);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    void loadItems(controller.signal);
    return () => controller.abort();
  }, []);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{t('settings.sensitiveScan.title')}</CardTitle>
        <CardDescription>{t('settings.sensitiveScan.desc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">{t('settings.sensitiveScan.resultCount', { count: items.length })}</p>
          <Button size="sm" variant="outline" onClick={() => void loadItems()} disabled={loading}>
            {loading ? <RefreshCw className="h-4 w-4 animate-spin" /> : t('settings.sensitiveScan.refresh')}
          </Button>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        {items.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('settings.sensitiveScan.noHits')}</p>
        ) : (
          <ScrollArea className="h-[180px] rounded border p-2">
            <div className="space-y-2">
              {items.map((it, idx) => (
                <div key={`sensitive-${idx}`} className="rounded border p-2 text-[11px] space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono truncate">{it.path}</span>
                    <Badge variant={it.risk_level === 'high' ? 'destructive' : 'outline'}>
                      {it.risk_level || 'medium'}
                    </Badge>
                  </div>
                  <p className="text-muted-foreground">{(it.reasons || []).join(' · ') || 'pattern'}</p>
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
        {truncated ? (
          <p className="text-[10px] text-muted-foreground">{t('settings.sensitiveScan.truncated')}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
