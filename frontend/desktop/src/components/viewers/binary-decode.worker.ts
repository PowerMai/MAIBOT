/**
 * Web Worker：在后台线程解码 base64 并解析 Word/PPT，避免主线程卡顿
 */

export interface WordWorkerInput {
  type: 'word';
  base64Data: string;
}

export interface WordWorkerSuccess {
  ok: true;
  html: string;
  messages: Array<{ message: string }>;
}

export interface PPTWorkerInput {
  type: 'ppt';
  base64Data: string;
}

function extractTextFromSlideXml(xml: string): string {
  const texts: string[] = [];
  const regex = /<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(xml)) !== null) {
    if (m[1]) texts.push(m[1]);
  }
  if (texts.length > 0) return texts.join(' ').replace(/\s+/g, ' ').trim();
  const fallback = xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return fallback.slice(0, 1000);
}

export interface PPTWorkerSuccess {
  ok: true;
  slides: Array<{ title?: string; content?: string }>;
}

export type WorkerError = { ok: false; error: string };

self.onmessage = async (e: MessageEvent<WordWorkerInput | PPTWorkerInput>) => {
  const payload = e.data;
  try {
    if (payload.type === 'word') {
      const mammoth = await import('mammoth');
      const bin = atob(payload.base64Data.replace(/\s/g, ''));
      const arrayBuffer = Uint8Array.from(bin, (c) => c.charCodeAt(0)).buffer;
      const result = await mammoth.convertToHtml(
        { arrayBuffer },
        { convertImage: mammoth.images.dataUri }
      );
      let html = (result.value || '').trim();
      if (html.length < 50) {
        const raw = await mammoth.extractRawText({ arrayBuffer });
        const text = (raw.value || '').trim();
        const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        html = text
          ? `<pre class="word-doc-content-plain" style="white-space: pre-wrap; font-family: inherit; margin: 0;">${escape(text)}</pre>`
          : '<p class="text-muted-foreground">未能提取文档文本，建议使用 Word 打开查看。</p>';
      }
      const out: WordWorkerSuccess = { ok: true, html, messages: result.messages };
      self.postMessage(out);
      return;
    }
    if (payload.type === 'ppt') {
      const JSZip = (await import('jszip')).default;
      const binary = Uint8Array.from(atob(payload.base64Data.replace(/\s/g, '')), (c) => c.charCodeAt(0));
      const zip = await JSZip.loadAsync(binary);
      const slideNames: string[] = [];
      zip.forEach((path) => {
        const m = path.match(/^ppt\/slides\/slide(\d+)\.xml$/);
        if (m) slideNames.push(path);
      });
      slideNames.sort((a, b) => {
        const n1 = parseInt(a.replace(/\D/g, ''), 10);
        const n2 = parseInt(b.replace(/\D/g, ''), 10);
        return n1 - n2;
      });
      const parsed: Array<{ title?: string; content?: string }> = [];
      for (const path of slideNames) {
        const xml = await zip.file(path)?.async('string');
        if (!xml) continue;
        const text = extractTextFromSlideXml(xml);
        const firstLine = text.split(/\r?\n/).filter(Boolean)[0] || '';
        parsed.push({
          title: firstLine.slice(0, 80) || `幻灯片 ${parsed.length + 1}`,
          content: text.slice(0, 500) || '(无文本)',
        });
      }
      if (parsed.length === 0) {
        parsed.push({ title: '幻灯片 1', content: '未能解析到幻灯片内容，建议使用系统应用打开。' });
      }
      const out: PPTWorkerSuccess = { ok: true, slides: parsed };
      self.postMessage(out);
      return;
    }
    self.postMessage({ ok: false, error: '未知类型' });
  } catch (err) {
    self.postMessage({
      ok: false,
      error: err instanceof Error ? err.message : '解析失败',
    });
  }
};
