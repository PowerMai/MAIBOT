/**
 * NotebookViewer - Jupyter .ipynb 单元格列表查看
 * - code cell: 只读代码块 + output 折叠区
 * - markdown cell: react-markdown 渲染
 */

import React, { useState, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import { remarkPluginsWithMath, rehypePluginsMath } from '../../lib/markdownRender';
import { Editor } from '@monaco-editor/react';
import { ChevronDown, ChevronRight, Code, FileText } from 'lucide-react';
import { t } from '../../lib/i18n';

export interface NotebookViewerProps {
  content: string;
  fileName?: string;
  height?: string;
  embeddedInEditor?: boolean;
}

interface NbCell {
  cell_type: 'code' | 'markdown' | 'raw';
  source: string[] | string;
  outputs?: unknown[];
}

interface NbNotebook {
  cells?: NbCell[];
  nbformat?: number;
}

function getSource(cell: NbCell): string {
  const s = cell.source;
  if (Array.isArray(s)) return s.join('');
  return typeof s === 'string' ? s : '';
}

function CodeCell({ source, outputs }: { source: string; outputs?: unknown[] }) {
  const [outputOpen, setOutputOpen] = useState(false);
  const hasOutput = Array.isArray(outputs) && outputs.length > 0;
  return (
    <div className="notebook-cell code-cell border border-border/60 rounded-md overflow-hidden bg-muted/20">
      <div className="flex items-center gap-1 px-2 py-1 border-b border-border/40 bg-muted/40 text-xs text-muted-foreground">
        <Code className="h-3 w-3" />
        <span>代码</span>
      </div>
      <div className="min-h-[60px]" data-monaco-readonly>
        <Editor
          height="120px"
          language="python"
          value={source}
          options={{
            readOnly: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            lineNumbers: 'on',
            folding: true,
            wordWrap: 'on',
          }}
        />
      </div>
      {hasOutput && (
        <>
          <button
            type="button"
            className="w-full flex items-center gap-1 px-2 py-1 border-t border-border/40 bg-muted/30 text-xs text-muted-foreground hover:bg-muted/50"
            onClick={() => setOutputOpen((o) => !o)}
          >
            {outputOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            输出
          </button>
          {outputOpen && (
            <div className="px-2 py-2 border-t border-border/40 bg-background/80 text-xs font-mono whitespace-pre-wrap wrap-break-word max-h-48 overflow-auto">
              {outputs!.map((out: unknown, i: number) => {
                const o = out as { output_type?: string; text?: string[]; data?: Record<string, unknown> };
                if (o.output_type === 'stream' && Array.isArray(o.text)) {
                  return <div key={i}>{o.text.join('')}</div>;
                }
                if (o.output_type === 'execute_result' && o.data && typeof (o.data as { 'text/plain'?: string[] })['text/plain'] !== 'undefined') {
                  const t = (o.data as { 'text/plain': string[] })['text/plain'];
                  return <div key={i}>{Array.isArray(t) ? t.join('') : String(t)}</div>;
                }
                return <div key={i} className="text-muted-foreground">[输出]</div>;
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function MarkdownCell({ source }: { source: string }) {
  return (
    <div className="notebook-cell markdown-cell rounded-md overflow-hidden border border-border/40 bg-background">
      <div className="flex items-center gap-1 px-2 py-1 border-b border-border/40 bg-muted/30 text-xs text-muted-foreground">
        <FileText className="h-3 w-3" />
        <span>Markdown</span>
      </div>
      <div className="px-3 py-2 text-sm prose prose-sm dark:prose-invert max-w-none prose-p:leading-[1.65] prose-p:my-0.5 prose-headings:font-semibold prose-headings:tracking-tight prose-blockquote:border-l-primary prose-blockquote:bg-muted/30 prose-blockquote:py-0.5 prose-code:rounded prose-code:bg-muted/60 prose-code:px-1 prose-code:py-0.5 prose-li:my-0.5">
        <ReactMarkdown remarkPlugins={[...remarkPluginsWithMath]} rehypePlugins={[...rehypePluginsMath]}>{source}</ReactMarkdown>
      </div>
    </div>
  );
}

export function NotebookViewer({ content, fileName, height = '100%', embeddedInEditor }: NotebookViewerProps) {
  const { cells, error } = useMemo(() => {
    try {
      const raw = JSON.parse(content || '{}') as NbNotebook;
      const cells = Array.isArray(raw.cells) ? raw.cells : [];
      return { cells, error: null };
    } catch (e) {
      return { cells: [], error: e instanceof Error ? e.message : String(e) };
    }
  }, [content]);

  if (error) {
    return (
      <div className="h-full min-h-0 flex items-center justify-center p-4 text-muted-foreground text-sm">
        {t('viewer.notebookParseError')}：{error}
      </div>
    );
  }

  if (cells.length === 0) {
    return (
      <div className="h-full min-h-0 flex items-center justify-center p-4 text-muted-foreground text-sm">
        {t('viewer.noCells')}
      </div>
    );
  }

  return (
    <div
      className="h-full min-h-0 flex flex-col overflow-hidden"
      style={{ height }}
      data-notebook-viewer
    >
      <div className="flex-1 min-h-0 overflow-auto p-3 space-y-3">
      {cells.map((cell, i) => {
        const source = getSource(cell);
        if (cell.cell_type === 'code') {
          return <CodeCell key={i} source={source} outputs={cell.outputs} />;
        }
        if (cell.cell_type === 'markdown') {
          return <MarkdownCell key={i} source={source} />;
        }
        return (
          <div key={i} className="rounded border border-border/40 px-3 py-2 text-sm text-muted-foreground">
            {source || t('viewer.emptyContent')}
          </div>
        );
      })}
      </div>
    </div>
  );
}

export default NotebookViewer;
