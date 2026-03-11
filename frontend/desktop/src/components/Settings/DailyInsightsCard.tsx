/**
 * 每日洞察卡片（自我生长日志）
 */
import React, { useState, useEffect, useMemo } from 'react';
import { Button } from '../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Badge } from '../ui/badge';
import { Label } from '../ui/label';
import { Input } from '../ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { ScrollArea } from '../ui/scroll-area';
import { RefreshCw, Copy, Download, Search } from 'lucide-react';
import { toast } from 'sonner';
import {
  getDailyInsights,
  getInsightContentByFilename,
  getInsightsSummary,
  type DailyInsightFile,
  type InsightsSummary,
} from '../../lib/api/systemApi';
import { EVENTS } from '../../lib/constants';
import { getCurrentThreadIdFromStorage } from '../../lib/sessionState';
import { getItem as getStorageItem, setItem as setStorageItem } from '../../lib/safeStorage';

export function DailyInsightsCard() {
  const [files, setFiles] = useState<DailyInsightFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string>('');
  const [content, setContent] = useState<string>('');
  const [keyword, setKeyword] = useState('');
  const [summary, setSummary] = useState<InsightsSummary | null>(null);
  const [summaryWindow, setSummaryWindow] = useState<'7' | '14' | '30'>('7');
  const [retroTemplate, setRetroTemplate] = useState<'fast' | 'standard' | 'strict'>(() => {
    try {
      const v = getStorageItem('maibot_retro_template');
      return v === 'fast' || v === 'strict' ? v : 'standard';
    } catch {
      return 'standard';
    }
  });
  const [contentLoading, setContentLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadFiles = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getDailyInsights(30);
      if (res.success) {
        setFiles(res.files);
        if (!selectedFile && res.files.length > 0) {
          setSelectedFile(res.files[0].filename);
        }
        const summaryRes = await getInsightsSummary(parseInt(summaryWindow, 10));
        if (summaryRes.success && summaryRes.summary) {
          setSummary(summaryRes.summary);
        } else {
          setSummary(null);
        }
      } else {
        setError(res.error || '加载洞察列表失败');
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const loadContent = async (filename: string) => {
    if (!filename) return;
    setContentLoading(true);
    setError(null);
    try {
      const res = await getInsightContentByFilename(filename);
      if (res.success) {
        setContent(res.content || '');
      } else {
        setContent('');
        setError(res.error || '加载洞察内容失败');
      }
    } catch (e) {
      setError(String(e));
      setContent('');
    } finally {
      setContentLoading(false);
    }
  };

  useEffect(() => {
    loadFiles();
  }, []);

  useEffect(() => {
    getInsightsSummary(parseInt(summaryWindow, 10)).then((res) => {
      if (res.success && res.summary) {
        setSummary(res.summary);
      } else {
        setSummary(null);
      }
    }).catch(() => setSummary(null));
  }, [summaryWindow]);

  useEffect(() => {
    if (selectedFile) loadContent(selectedFile);
  }, [selectedFile]);

  const filteredContent = React.useMemo(() => {
    const text = content || '';
    const kw = keyword.trim();
    if (!kw) return text;
    const lines = text.split('\n');
    return lines.filter((line) => line.toLowerCase().includes(kw.toLowerCase())).join('\n');
  }, [content, keyword]);

  const handleCopy = async () => {
    const text = filteredContent || content || '';
    if (!text) {
      toast.error('没有可复制的内容');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast.success('已复制洞察内容');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const handleExport = () => {
    const text = filteredContent || content || '';
    if (!text) {
      toast.error('没有可导出的内容');
      return;
    }
    const name = selectedFile ? `insights-${selectedFile}` : `insights-${Date.now()}.md`;
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('已导出洞察 Markdown');
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="text-sm">每日洞察（自我生长）</CardTitle>
            <CardDescription>Roses / Buds / Thorns 日志</CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={loadFiles} disabled={loading}>
            {loading ? <RefreshCw className="h-4 w-4 animate-spin" /> : '刷新'}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <Label className="text-xs shrink-0">趋势窗口</Label>
          <Select value={summaryWindow} onValueChange={(v: '7' | '14' | '30') => setSummaryWindow(v)}>
            <SelectTrigger className="h-8 w-[120px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="7">近 7 天</SelectItem>
              <SelectItem value="14">近 14 天</SelectItem>
              <SelectItem value="30">近 30 天</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center justify-between gap-2">
          <Label className="text-xs shrink-0">复盘模板</Label>
          <Select
            value={retroTemplate}
            onValueChange={(v: 'fast' | 'standard' | 'strict') => {
              setRetroTemplate(v);
              try { setStorageItem('maibot_retro_template', v); } catch { /* ignore */ }
            }}
          >
            <SelectTrigger className="h-8 w-[120px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="fast">快速</SelectItem>
              <SelectItem value="standard">标准</SelectItem>
              <SelectItem value="strict">严格</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {summary && (
          <div className="grid grid-cols-5 gap-1">
            <Badge variant="outline" className="justify-center text-[10px]">runs {summary.runs}</Badge>
            <Badge variant="outline" className="justify-center text-[10px]">signals {summary.signals}</Badge>
            <Badge variant="outline" className="justify-center text-[10px]">roses {summary.roses}</Badge>
            <Badge variant="outline" className="justify-center text-[10px]">buds {summary.buds}</Badge>
            <Badge variant="outline" className="justify-center text-[10px]">thorns {summary.thorns}</Badge>
          </div>
        )}
        {summary && summary.thorns >= 5 && (
          <div className="flex items-center justify-between gap-2 rounded border border-amber-500/30 bg-amber-500/5 px-2 py-1.5">
            <p className="text-[11px] text-amber-600 dark:text-amber-400">
              预警：近 {summaryWindow} 天 Thorns 偏高（{summary.thorns}），建议优先复盘失败模式并优化 Skill。
            </p>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-[11px] shrink-0"
              onClick={() => {
                const prompt = (() => {
                  const base = `请复盘最近 ${summaryWindow} 天的失败模式（thorns=${summary.thorns}）。`;
                  if (retroTemplate === 'fast') {
                    return (
                      `${base}\n要求：` +
                      `\n1) 列出 Top3 问题；` +
                      `\n2) 每个问题给出 1 条立刻可执行修复动作。`
                    );
                  }
                  if (retroTemplate === 'strict') {
                    return (
                      `${base}\n要求：` +
                      `\n1) 归纳 Top5 失败类型并给占比；` +
                      `\n2) 每类给出根因、证据、修复动作、验收标准；` +
                      `\n3) 形成 7 天改进计划与优先级；` +
                      `\n4) 产出可落地 Skill 优化建议（含风险与回滚方案）。`
                    );
                  }
                  return (
                    `${base}\n要求：` +
                    `\n1) 归纳 Top3 失败类型；` +
                    `\n2) 给出根因与可验证改进动作；` +
                    `\n3) 产出 Skill 优化建议（含优先级）。`
                  );
                })();
                window.dispatchEvent(new CustomEvent(EVENTS.OPEN_CHAT_PANEL));
                const threadId = getCurrentThreadIdFromStorage();
                window.dispatchEvent(new CustomEvent(EVENTS.FILL_PROMPT, { detail: { prompt, autoSend: false, threadId: threadId || undefined } }));
                toast.success('已填入复盘任务到聊天区');
              }}
            >
              一键复盘
            </Button>
          </div>
        )}
        <div className="flex items-center gap-2">
          <Label className="text-xs shrink-0">洞察文件</Label>
          <Select value={selectedFile} onValueChange={setSelectedFile}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder={files.length ? '选择洞察文件' : '暂无洞察文件'} />
            </SelectTrigger>
            <SelectContent>
              {files.map((f) => (
                <SelectItem key={f.filename} value={f.filename}>
                  {f.filename}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {!loading && files.length === 0 && !error && (
          <div className="rounded-md border border-dashed border-border/60 bg-muted/30 px-3 py-2">
            <p className="text-xs text-muted-foreground">还没有生成洞察文件。建议先执行一次“每日复盘/成长日志”任务。</p>
            <Button
              size="sm"
              variant="outline"
              className="mt-2 h-7 text-[11px]"
              onClick={() => {
                const prompt = "请基于今天的任务执行情况生成一份每日洞察（Roses / Buds / Thorns），并给出 3 条可执行的明日优化动作。";
                window.dispatchEvent(new CustomEvent(EVENTS.OPEN_CHAT_PANEL));
                const threadId = getCurrentThreadIdFromStorage();
                window.dispatchEvent(new CustomEvent(EVENTS.FILL_PROMPT, { detail: { prompt, autoSend: false, threadId: threadId || undefined } }));
                toast.success('已填入每日洞察任务到聊天区');
              }}
            >
              一键生成今日洞察
            </Button>
          </div>
        )}
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="h-3.5 w-3.5 text-muted-foreground absolute left-2 top-1/2 -translate-y-1/2" />
            <Input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="按关键词过滤（如 roses / failures / 具体 skill）"
              className="h-8 text-xs pl-7"
            />
          </div>
          <Button size="sm" variant="outline" onClick={handleCopy} className="gap-1" disabled={!content && !filteredContent}>
            <Copy className="h-3.5 w-3.5" />
            复制
          </Button>
          <Button size="sm" variant="outline" onClick={handleExport} className="gap-1" disabled={!content && !filteredContent}>
            <Download className="h-3.5 w-3.5" />
            导出
          </Button>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <ScrollArea className="h-[220px] rounded border p-2 text-[11px] font-mono">
          {contentLoading ? (
            <div className="text-xs text-muted-foreground">加载中…</div>
          ) : (filteredContent || content) ? (
            <pre className="whitespace-pre-wrap break-all">{filteredContent || content}</pre>
          ) : (
            <div className="text-xs text-muted-foreground">暂无内容</div>
          )}
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
