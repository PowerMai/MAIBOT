import React, { useState } from 'react';
import { Button } from '../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Input } from '../ui/input';
import { ScrollArea } from '../ui/scroll-area';
import { RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { t } from '../../lib/i18n';
import { analyzeVisionImage, type VisionAnalyzeResult } from '../../lib/api/systemApi';

export function VisionAnalyzeCard() {
  const [pathInput, setPathInput] = useState('');
  const [urlInput, setUrlInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<VisionAnalyzeResult | null>(null);

  const handleAnalyze = async () => {
    if (!pathInput.trim() && !urlInput.trim()) {
      toast.error(t('settings.imageAnalysis.fillPathOrUrl'));
      return;
    }
    setLoading(true);
    try {
      const res = await analyzeVisionImage({
        path: pathInput.trim() || undefined,
        url: urlInput.trim() || undefined,
      });
      setResult(res);
      if (res.ok) {
        toast.success(t('settings.imageAnalysis.done'));
      } else {
        toast.error(t('settings.imageAnalysis.failed'), { description: res.error || t('settings.imageAnalysis.unknownError') });
      }
    } catch (err) {
      toast.error(t('settings.imageAnalysis.failed'), {
        description: err instanceof Error ? err.message : t('settings.imageAnalysis.unknownError'),
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{t('settings.imageAnalysis.title')}</CardTitle>
        <CardDescription>{t('settings.imageAnalysis.desc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <Input
          value={pathInput}
          onChange={(e) => setPathInput(e.target.value)}
          placeholder={t('settings.imageAnalysis.pathPlaceholder')}
          className="h-8 text-xs font-mono"
        />
        <Input
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          placeholder={t('settings.imageAnalysis.urlPlaceholder')}
          className="h-8 text-xs font-mono"
        />
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={handleAnalyze} disabled={loading}>
            {loading ? <RefreshCw className="h-4 w-4 animate-spin" /> : t('settings.imageAnalysis.analyzeBtn')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setPathInput('');
              setUrlInput('');
              setResult(null);
            }}
          >
            {t('settings.imageAnalysis.clear')}
          </Button>
        </div>
        {result?.summary && <p className="text-xs text-muted-foreground">{result.summary}</p>}
        {result && (
          <ScrollArea className="h-[160px] rounded border p-2 text-[11px] font-mono">
            <pre className="whitespace-pre-wrap break-all">{JSON.stringify(result, null, 2)}</pre>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}
