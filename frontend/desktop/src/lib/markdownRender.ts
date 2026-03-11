/**
 * 聊天区与编辑区共用的 Markdown 渲染配置
 * 统一 GFM、换行、数学公式及 prose 基线，保证表格/图片/公式等在各处一致展示
 */
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";

export const remarkPluginsBase = [remarkGfm, remarkBreaks] as const;
export const remarkPluginsWithMath = [remarkGfm, remarkBreaks, remarkMath] as const;
export const rehypePluginsMath = [rehypeKatex] as const;

/** 生成式内容 prose 基线（与 Cursor 风格对齐），供工具结果、任务、Artifact、简报、Notebook、编辑预览等复用 */
export const PROSE_CLASSES_MARKDOWN =
  "prose prose-sm dark:prose-invert max-w-none prose-p:leading-[1.65] prose-p:my-0.5 prose-headings:font-semibold prose-headings:tracking-tight prose-blockquote:border-l-primary prose-blockquote:bg-muted/30 prose-blockquote:py-1 prose-code:rounded prose-code:bg-muted/60 prose-code:px-1.5 prose-code:py-0.5 prose-li:my-0.5";

/** 编辑区 Markdown 预览用 prose（标题层级、表格、图片、链接等与 Monaco 预览一致） */
export const PROSE_CLASSES_EDITOR_PREVIEW =
  "prose prose-slate dark:prose-invert max-w-none prose-headings:font-semibold prose-headings:tracking-tight prose-h1:text-2xl prose-h1:border-b prose-h1:pb-2 prose-h1:mb-4 prose-h2:text-xl prose-h2:mt-8 prose-h2:mb-3 prose-h3:text-lg prose-h3:mt-6 prose-h3:mb-2 prose-p:text-[15px] prose-p:leading-[1.65] prose-p:text-foreground/90 prose-li:text-[15px] prose-li:leading-[1.65] prose-code:text-sm prose-code:bg-muted prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-pre:bg-muted prose-pre:border prose-pre:border-border/50 prose-blockquote:border-l-primary prose-blockquote:bg-muted/30 prose-blockquote:py-1 prose-table:text-sm prose-th:bg-muted/50 prose-th:px-4 prose-th:py-2 prose-td:px-4 prose-td:py-2 prose-td:border-b prose-td:border-border/30 prose-img:rounded-lg prose-img:shadow-md prose-a:text-primary prose-a:no-underline hover:prose-a:underline";
