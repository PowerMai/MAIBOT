/**
 * 文件处理工具 - 支持多种文件格式的读取和转换
 * 包括：docx（含图片）、PDF、图片预览
 */

// 二进制文件扩展名列表
const BINARY_EXTENSIONS = new Set([
  // 文档
  'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'pdf',
  // 图片
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'svg',
  // 音视频
  'mp3', 'mp4', 'wav', 'avi', 'mov', 'mkv', 'flac',
  // 压缩包
  'zip', 'rar', '7z', 'tar', 'gz',
  // 其他二进制
  'exe', 'dll', 'so', 'dylib', 'bin', 'dat',
]);

// 可以转换为 Markdown 的文件类型
const CONVERTIBLE_TO_MARKDOWN = new Set(['docx', 'doc']);

// 图片扩展名
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'svg']);

// PDF 文件
const PDF_EXTENSIONS = new Set(['pdf']);

export interface FileInfo {
  path: string;
  name: string;
  extension: string;
  isBinary: boolean;
  isImage: boolean;
  isPdf: boolean;
  isConvertibleToMarkdown: boolean;
  isText: boolean;
}

/**
 * 获取文件扩展名
 */
export function getFileExtension(filePath: string): string {
  const parts = filePath.split('.');
  if (parts.length < 2) return '';
  return parts[parts.length - 1].toLowerCase();
}

/**
 * 分析文件信息
 */
export function analyzeFile(filePath: string): FileInfo {
  const name = filePath.split('/').pop() || filePath.split('\\').pop() || filePath;
  const extension = getFileExtension(filePath);
  const isBinary = BINARY_EXTENSIONS.has(extension);
  const isImage = IMAGE_EXTENSIONS.has(extension);
  const isPdf = PDF_EXTENSIONS.has(extension);
  const isConvertibleToMarkdown = CONVERTIBLE_TO_MARKDOWN.has(extension);
  const isText = !isBinary;

  return {
    path: filePath,
    name,
    extension,
    isBinary,
    isImage,
    isPdf,
    isConvertibleToMarkdown,
    isText,
  };
}

/**
 * 将图片 buffer 转换为 base64 data URL
 */
function bufferToDataUrl(buffer: ArrayBuffer, contentType: string): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return `data:${contentType};base64,${btoa(binary)}`;
}

/**
 * 将 docx ArrayBuffer 转换为 Markdown（包含内嵌图片）
 */
export async function convertDocxToMarkdown(arrayBuffer: ArrayBuffer): Promise<string> {
  // docx 本质为 ZIP，EOCD 至少 22 字节，过小则必为无效/损坏
  if (!arrayBuffer || arrayBuffer.byteLength < 22) {
    throw new Error('文档数据过小或为空，无法解析为 Word 文档');
  }
  try {
    // 动态导入 mammoth
    const mammoth = await import('mammoth');
    
    // 配置图片转换：将图片转换为内嵌的 base64
    const options = {
      arrayBuffer,
      convertImage: mammoth.images.imgElement(async (image: any) => {
        try {
          const imageBuffer = await image.read('base64');
          const contentType = image.contentType || 'image/png';
          return {
            src: `data:${contentType};base64,${imageBuffer}`
          };
        } catch (e) {
          console.warn('图片转换失败:', e);
          return { src: '' };
        }
      })
    };
    
    // 转换为 HTML（保留图片）
    const htmlResult = await mammoth.convertToHtml(options);
    
    // 统计警告数量（不显示具体内容，太杂乱）
    const warningCount = htmlResult.messages.filter((m: any) => m.type === 'warning').length;
    
    // 将 HTML 转换为 Markdown 格式
    let markdown = htmlToMarkdown(htmlResult.value);
    
    // 简洁的提示信息
    if (warningCount > 0) {
      markdown = `> 📄 已从 Word 转换为 Markdown（${warningCount} 个格式提示已忽略）\n\n---\n\n` + markdown;
    } else {
      markdown = `> 📄 已从 Word 转换为 Markdown，可直接编辑\n\n---\n\n` + markdown;
    }
    
    return markdown;
  } catch (error) {
    console.error('docx 转换失败:', error);
    throw new Error(`Word 文档转换失败: ${error}`);
  }
}

/**
 * 简单的 HTML 转 Markdown
 */
function htmlToMarkdown(html: string): string {
  let md = html;
  
  // 处理标题
  md = md.replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n\n');
  md = md.replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n\n');
  md = md.replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n\n');
  md = md.replace(/<h4[^>]*>(.*?)<\/h4>/gi, '#### $1\n\n');
  md = md.replace(/<h5[^>]*>(.*?)<\/h5>/gi, '##### $1\n\n');
  md = md.replace(/<h6[^>]*>(.*?)<\/h6>/gi, '###### $1\n\n');
  
  // 处理段落
  md = md.replace(/<p[^>]*>(.*?)<\/p>/gi, '$1\n\n');
  
  // 处理粗体和斜体
  md = md.replace(/<strong[^>]*>(.*?)<\/strong>/gi, '**$1**');
  md = md.replace(/<b[^>]*>(.*?)<\/b>/gi, '**$1**');
  md = md.replace(/<em[^>]*>(.*?)<\/em>/gi, '*$1*');
  md = md.replace(/<i[^>]*>(.*?)<\/i>/gi, '*$1*');
  
  // 处理下划线和删除线
  md = md.replace(/<u[^>]*>(.*?)<\/u>/gi, '<u>$1</u>');
  md = md.replace(/<s[^>]*>(.*?)<\/s>/gi, '~~$1~~');
  md = md.replace(/<del[^>]*>(.*?)<\/del>/gi, '~~$1~~');
  
  // 处理链接
  md = md.replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)');
  
  // 处理图片（保留 base64 内嵌图片）
  md = md.replace(/<img[^>]*src="([^"]*)"[^>]*alt="([^"]*)"[^>]*\/?>/gi, '![$2]($1)');
  md = md.replace(/<img[^>]*src="([^"]*)"[^>]*\/?>/gi, '![图片]($1)');
  
  // 处理列表
  md = md.replace(/<ul[^>]*>/gi, '\n');
  md = md.replace(/<\/ul>/gi, '\n');
  md = md.replace(/<ol[^>]*>/gi, '\n');
  md = md.replace(/<\/ol>/gi, '\n');
  md = md.replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n');
  
  // 处理代码
  md = md.replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`');
  md = md.replace(/<pre[^>]*>(.*?)<\/pre>/gis, '```\n$1\n```\n\n');
  
  // 处理引用块
  md = md.replace(/<blockquote[^>]*>(.*?)<\/blockquote>/gis, (_, content) => {
    return content.split('\n').map((line: string) => `> ${line}`).join('\n') + '\n\n';
  });
  
  // 处理换行
  md = md.replace(/<br\s*\/?>/gi, '\n');
  
  // 处理表格
  md = md.replace(/<table[^>]*>(.*?)<\/table>/gis, (_, tableContent) => {
    let result = '\n';
    const rows = tableContent.match(/<tr[^>]*>.*?<\/tr>/gis) || [];
    
    rows.forEach((row: string, idx: number) => {
      const cells = row.match(/<t[hd][^>]*>(.*?)<\/t[hd]>/gis) || [];
      const cellContents = cells.map((cell: string) => {
        return cell.replace(/<t[hd][^>]*>(.*?)<\/t[hd]>/is, '$1').trim();
      });
      
      result += '| ' + cellContents.join(' | ') + ' |\n';
      
      // 第一行后添加分隔行
      if (idx === 0) {
        result += '| ' + cellContents.map(() => '---').join(' | ') + ' |\n';
      }
    });
    
    return result + '\n';
  });
  
  // 清理剩余的 HTML 标签
  md = md.replace(/<[^>]+>/g, '');
  
  // 清理多余的空行
  md = md.replace(/\n{3,}/g, '\n\n');
  
  // 解码 HTML 实体
  md = md.replace(/&nbsp;/g, ' ');
  md = md.replace(/&amp;/g, '&');
  md = md.replace(/&lt;/g, '<');
  md = md.replace(/&gt;/g, '>');
  md = md.replace(/&quot;/g, '"');
  md = md.replace(/&#39;/g, "'");
  
  return md.trim();
}

/**
 * 将 docx ArrayBuffer 转换为 HTML（保留更多格式和图片）
 */
export async function convertDocxToHtml(arrayBuffer: ArrayBuffer): Promise<string> {
  try {
    const mammoth = await import('mammoth');
    
    const options = {
      arrayBuffer,
      convertImage: mammoth.images.imgElement(async (image: any) => {
        try {
          const imageBuffer = await image.read('base64');
          const contentType = image.contentType || 'image/png';
          return {
            src: `data:${contentType};base64,${imageBuffer}`
          };
        } catch (e) {
          return { src: '' };
        }
      })
    };
    
    const result = await mammoth.convertToHtml(options);
    return result.value;
  } catch (error) {
    console.error('docx 转 HTML 失败:', error);
    throw new Error(`Word 文档转换失败: ${error}`);
  }
}

/**
 * 生成图片预览的 Markdown/HTML
 */
export function generateImagePreview(base64: string, fileName: string, extension: string): string {
  const mimeType = {
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'bmp': 'image/bmp',
    'webp': 'image/webp',
    'svg': 'image/svg+xml',
    'ico': 'image/x-icon',
  }[extension] || 'image/png';
  
  const dataUrl = `data:${mimeType};base64,${base64}`;
  
  return `# 📷 ${fileName}

<div style="text-align: center; padding: 20px; background: #f5f5f5; border-radius: 8px;">
  <img src="${dataUrl}" alt="${fileName}" style="max-width: 100%; max-height: 600px; border-radius: 4px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);" />
</div>

---

**文件信息**
- 格式：${extension.toUpperCase()}
- 文件名：\`${fileName}\`

> 💡 提示：这是图片预览模式，图片内容不可编辑。
`;
}

/**
 * 生成 PDF 预览占位符（实际渲染在组件中完成）
 */
export function generatePdfPlaceholder(fileName: string, filePath: string): string {
  return `__PDF_PREVIEW__
{
  "fileName": "${fileName}",
  "filePath": "${filePath}"
}
__PDF_PREVIEW_END__`;
}

/**
 * 检测内容是否为 PDF 预览占位符
 */
export function isPdfPreviewContent(content: string): boolean {
  return content.startsWith('__PDF_PREVIEW__');
}

/**
 * 解析 PDF 预览信息
 */
export function parsePdfPreviewInfo(content: string): { fileName: string; filePath: string } | null {
  if (!isPdfPreviewContent(content)) return null;
  
  try {
    const jsonMatch = content.match(/__PDF_PREVIEW__\s*(\{[\s\S]*?\})\s*__PDF_PREVIEW_END__/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[1]);
    }
  } catch (e) {
    console.error('解析 PDF 信息失败:', e);
  }
  return null;
}

/**
 * 检查文件内容是否为二进制（通过检查是否包含 NULL 字符）
 */
export function isBinaryContent(content: string): boolean {
  const sample = content.slice(0, 8000);
  // eslint-disable-next-line no-control-regex
  return /[\x00-\x08\x0E-\x1F]/.test(sample);
}

/**
 * 获取文件类型的友好名称
 */
export function getFileTypeName(extension: string): string {
  const typeNames: Record<string, string> = {
    docx: 'Word 文档',
    doc: 'Word 文档 (旧版)',
    xlsx: 'Excel 表格',
    xls: 'Excel 表格 (旧版)',
    pptx: 'PowerPoint 演示文稿',
    ppt: 'PowerPoint (旧版)',
    pdf: 'PDF 文档',
    md: 'Markdown',
    markdown: 'Markdown',
    js: 'JavaScript',
    ts: 'TypeScript',
    jsx: 'React JSX',
    tsx: 'React TSX',
    py: 'Python',
    java: 'Java',
    go: 'Go',
    rs: 'Rust',
    cpp: 'C++',
    c: 'C',
    h: 'C Header',
    json: 'JSON',
    yaml: 'YAML',
    yml: 'YAML',
    toml: 'TOML',
    xml: 'XML',
    txt: '纯文本',
    log: '日志文件',
    csv: 'CSV 数据',
    png: 'PNG 图片',
    jpg: 'JPEG 图片',
    jpeg: 'JPEG 图片',
    gif: 'GIF 图片',
    svg: 'SVG 矢量图',
    webp: 'WebP 图片',
  };
  
  return typeNames[extension] || extension.toUpperCase();
}

/**
 * 获取文件的语言模式（用于代码高亮）
 */
export function getLanguageMode(extension: string): string {
  const languageModes: Record<string, string> = {
    js: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    py: 'python',
    java: 'java',
    go: 'go',
    rs: 'rust',
    cpp: 'cpp',
    c: 'c',
    h: 'c',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    xml: 'xml',
    html: 'html',
    css: 'css',
    scss: 'scss',
    less: 'less',
    md: 'markdown',
    markdown: 'markdown',
    sql: 'sql',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    ps1: 'powershell',
    dockerfile: 'dockerfile',
  };
  
  return languageModes[extension] || 'plaintext';
}
