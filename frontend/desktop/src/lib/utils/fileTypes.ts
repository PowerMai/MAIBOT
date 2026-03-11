/**
 * 共享文件类型检测 - 统一 FullEditorV2Enhanced 和 UniversalFileViewer 的文件类型判断
 *
 * 返回统一的 FileTypeInfo，包含：
 * - format: 文件格式分类
 * - language: 编辑器语言标识
 * - renderAs: 渲染器类别（monaco / richtext / viewer）
 * - viewerHint: 给 UniversalFileViewer 的内部路由提示
 * - icon/color/label: UI 展示信息
 * - isEditable/isBinary/mimeType: 元数据
 */

/** 文件格式分类 */
export type FileFormat =
  | 'markdown' | 'code' | 'text' | 'json'
  | 'pdf' | 'docx' | 'excel' | 'ppt'
  | 'image' | 'video' | 'audio'
  | 'html' | 'diagram' | 'mindmap' | 'graph'
  | 'notebook'
  | 'binary' | 'archive' | 'unknown';

/** 渲染器类别 */
export type RenderAs = 'monaco' | 'richtext' | 'viewer';

/** 统一的文件类型信息 */
export interface FileTypeInfo {
  /** 文件格式分类 */
  format: FileFormat;
  /** 编辑器语言标识 (Monaco language id) */
  language: string;
  /** 渲染器类别 */
  renderAs: RenderAs;
  /** 给 UniversalFileViewer 的内部路由提示 */
  viewerHint?: string;
  /** 图标颜色 CSS 类名 */
  iconColor: string;
  /** 显示标签 */
  label: string;
  /** 是否可编辑 */
  isEditable: boolean;
  /** 是否二进制文件 */
  isBinary: boolean;
  /** MIME 类型 */
  mimeType?: string;
}

// ============================================================================
// 扩展名映射表
// ============================================================================

const CODE_EXTENSIONS: Record<string, string> = {
  // JavaScript/TypeScript
  'js': 'javascript', 'jsx': 'javascript', 'mjs': 'javascript', 'cjs': 'javascript',
  'ts': 'typescript', 'tsx': 'typescript', 'mts': 'typescript', 'cts': 'typescript',
  // Python
  'py': 'python', 'pyw': 'python', 'pyi': 'python', 'ipynb': 'python',
  // Web
  'css': 'css', 'scss': 'scss', 'sass': 'sass', 'less': 'less',
  'vue': 'vue', 'svelte': 'svelte',
  // C/C++
  'c': 'c', 'h': 'c',
  'cpp': 'cpp', 'cc': 'cpp', 'cxx': 'cpp', 'hpp': 'cpp', 'hxx': 'cpp',
  // Java/Kotlin
  'java': 'java', 'kt': 'kotlin', 'kts': 'kotlin',
  // Go/Rust
  'go': 'go', 'rs': 'rust',
  // Shell
  'sh': 'shell', 'bash': 'shell', 'zsh': 'shell', 'fish': 'shell',
  'ps1': 'powershell', 'psm1': 'powershell',
  // Config
  'yaml': 'yaml', 'yml': 'yaml',
  'toml': 'toml',
  'ini': 'ini', 'cfg': 'ini', 'conf': 'ini',
  'env': 'dotenv',
  // Database
  'sql': 'sql', 'mysql': 'sql', 'pgsql': 'sql',
  // Markup
  'xml': 'xml', 'xsl': 'xml', 'xslt': 'xml',
  // Other
  'php': 'php', 'rb': 'ruby', 'swift': 'swift', 'scala': 'scala',
  'r': 'r', 'R': 'r',
  'lua': 'lua', 'perl': 'perl', 'pl': 'perl',
  'graphql': 'graphql', 'gql': 'graphql',
  'proto': 'protobuf',
  // Rich text
  'rtf': 'rtf', 'tex': 'latex', 'latex': 'latex',
};

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'tiff']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'avi', 'mkv', 'flv', 'wmv', 'm4v']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'wma', 'opus']);
const ARCHIVE_EXTENSIONS = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz']);
const BINARY_EXTENSIONS = new Set(['exe', 'dll', 'so', 'dylib', 'bin', 'dat', 'db', 'sqlite']);
const TEXT_EXTENSIONS = new Set(['txt', 'log', 'readme', 'license', 'changelog', 'authors', 'contributing', 'tsv']);

const IMAGE_MIME: Record<string, string> = {
  'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg',
  'gif': 'image/gif', 'webp': 'image/webp', 'svg': 'image/svg+xml',
  'ico': 'image/x-icon', 'bmp': 'image/bmp', 'tiff': 'image/tiff',
};

const VIDEO_MIME: Record<string, string> = {
  'mp4': 'video/mp4', 'webm': 'video/webm', 'mov': 'video/quicktime',
  'avi': 'video/x-msvideo', 'mkv': 'video/x-matroska', 'flv': 'video/x-flv',
  'wmv': 'video/x-ms-wmv', 'm4v': 'video/x-m4v',
};

const AUDIO_MIME: Record<string, string> = {
  'mp3': 'audio/mpeg', 'wav': 'audio/wav', 'ogg': 'audio/ogg',
  'm4a': 'audio/mp4', 'flac': 'audio/flac', 'aac': 'audio/aac',
  'wma': 'audio/x-ms-wma', 'opus': 'audio/opus',
};

// ============================================================================
// 主函数
// ============================================================================

/**
 * 统一的文件类型检测函数
 * 
 * @param fileName 文件名（含扩展名）
 * @param mimeType 可选的 MIME 类型（用于 MIME 优先检测）
 * @returns FileTypeInfo
 */
export function getFileTypeInfo(fileName: string, mimeType?: string): FileTypeInfo {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  const lowerName = fileName.toLowerCase();

  // --- MIME 优先检测 ---
  if (mimeType) {
    if (mimeType === 'application/pdf') return pdfInfo();
    if (mimeType.includes('wordprocessing')) return docxInfo();
    if (mimeType.includes('spreadsheet')) return excelInfo(ext);
    if (mimeType.includes('presentation')) return pptInfo();
    if (mimeType.startsWith('image/')) return imageInfo(ext);
    if (mimeType.startsWith('video/')) return videoInfo(ext);
    if (mimeType.startsWith('audio/')) return audioInfo(ext);
    if (mimeType === 'application/json') return jsonInfo();
    if (mimeType === 'text/html') return htmlInfo();
  }

  // --- PDF ---
  if (ext === 'pdf') return pdfInfo();

  // --- Office ---
  if (ext === 'docx' || ext === 'doc') return docxInfo();
  if (ext === 'xlsx' || ext === 'xls') return excelInfo(ext);
  if (ext === 'csv') return csvInfo();
  if (ext === 'pptx' || ext === 'ppt') return pptInfo();

  // --- 图片 ---
  if (IMAGE_EXTENSIONS.has(ext)) return imageInfo(ext);

  // --- 视频 ---
  if (VIDEO_EXTENSIONS.has(ext)) return videoInfo(ext);

  // --- 音频 ---
  if (AUDIO_EXTENSIONS.has(ext)) return audioInfo(ext);

  // --- Jupyter Notebook ---
  if (ext === 'ipynb') {
    return { format: 'notebook', language: 'json', renderAs: 'viewer', viewerHint: 'notebook', iconColor: 'text-orange-500', label: 'Jupyter Notebook', isEditable: true, isBinary: false };
  }

  // --- Markdown ---
  if (ext === 'md' || ext === 'markdown' || ext === 'mdx') {
    return { format: 'markdown', language: 'markdown', renderAs: 'richtext', iconColor: 'text-blue-400', label: 'Markdown', isEditable: true, isBinary: false };
  }

  // --- 知识图谱 JSON ---
  if (lowerName.endsWith('.graph.json') || lowerName.endsWith('.kg.json')) {
    return { format: 'graph', language: 'json', renderAs: 'viewer', viewerHint: 'graph', iconColor: 'text-violet-500', label: '知识图谱', isEditable: true, isBinary: false };
  }

  // --- JSON ---
  if (ext === 'json' || ext === 'jsonc' || ext === 'json5') return jsonInfo();

  // --- HTML ---
  if (ext === 'html' || ext === 'htm' || ext === 'xhtml') return htmlInfo();

  // --- Mermaid 图表 ---
  if (ext === 'mmd' || ext === 'mermaid') {
    return { format: 'diagram', language: 'mermaid', renderAs: 'viewer', viewerHint: 'diagram', iconColor: 'text-cyan-500', label: 'Mermaid 图表', isEditable: true, isBinary: false };
  }

  // --- 思维导图 ---
  if (ext === 'mm') {
    return { format: 'mindmap', language: 'markdown', renderAs: 'viewer', viewerHint: 'mindmap', iconColor: 'text-emerald-500', label: '思维导图', isEditable: true, isBinary: false };
  }

  // --- 代码文件 ---
  if (CODE_EXTENSIONS[ext]) {
    return { format: 'code', language: CODE_EXTENSIONS[ext], renderAs: 'monaco', iconColor: 'text-cyan-500', label: CODE_EXTENSIONS[ext].toUpperCase(), isEditable: true, isBinary: false };
  }

  // --- 特殊文件名 ---
  if (lowerName === 'dockerfile' || lowerName.startsWith('dockerfile.')) {
    return { format: 'code', language: 'dockerfile', renderAs: 'monaco', iconColor: 'text-blue-500', label: 'Dockerfile', isEditable: true, isBinary: false };
  }
  if (lowerName === 'makefile' || lowerName.startsWith('makefile.')) {
    return { format: 'code', language: 'makefile', renderAs: 'monaco', iconColor: 'text-gray-500', label: 'Makefile', isEditable: true, isBinary: false };
  }
  if (lowerName === '.gitignore' || lowerName === '.dockerignore') {
    return { format: 'text', language: 'ignore', renderAs: 'monaco', iconColor: 'text-gray-500', label: '忽略文件', isEditable: true, isBinary: false };
  }
  if (lowerName === '.env' || lowerName.startsWith('.env.')) {
    return { format: 'text', language: 'dotenv', renderAs: 'monaco', iconColor: 'text-yellow-500', label: '环境变量', isEditable: true, isBinary: false };
  }

  // --- 文本文件 ---
  if (TEXT_EXTENSIONS.has(ext)) {
    return { format: 'text', language: 'plaintext', renderAs: 'monaco', iconColor: 'text-gray-500', label: '文本文件', isEditable: true, isBinary: false };
  }

  // --- 压缩文件 ---
  if (ARCHIVE_EXTENSIONS.has(ext)) {
    return { format: 'archive', language: ext, renderAs: 'viewer', viewerHint: 'archive', iconColor: 'text-amber-600', label: '压缩文件', isEditable: false, isBinary: true };
  }

  // --- 二进制文件 ---
  if (BINARY_EXTENSIONS.has(ext)) {
    return { format: 'binary', language: ext, renderAs: 'viewer', viewerHint: 'binary', iconColor: 'text-gray-400', label: '二进制文件', isEditable: false, isBinary: true };
  }

  // --- 默认：文本 ---
  return { format: 'text', language: ext || 'plaintext', renderAs: 'monaco', iconColor: 'text-gray-400', label: ext ? ext.toUpperCase() : '文本文件', isEditable: true, isBinary: false };
}

// ============================================================================
// 工厂函数（避免重复对象字面量）
// ============================================================================

function pdfInfo(): FileTypeInfo {
  return { format: 'pdf', language: 'pdf', renderAs: 'viewer', viewerHint: 'pdf', iconColor: 'text-red-500', label: 'PDF 文档', isEditable: false, isBinary: true, mimeType: 'application/pdf' };
}

function docxInfo(): FileTypeInfo {
  return { format: 'docx', language: 'docx', renderAs: 'viewer', viewerHint: 'word', iconColor: 'text-blue-500', label: 'Word 文档', isEditable: false, isBinary: true, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
}

function excelInfo(ext: string): FileTypeInfo {
  return { format: 'excel', language: 'xlsx', renderAs: 'viewer', viewerHint: 'excel', iconColor: 'text-green-600', label: ext === 'csv' ? 'CSV 文件' : 'Excel 表格', isEditable: ext === 'csv', isBinary: ext !== 'csv', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
}

function csvInfo(): FileTypeInfo {
  return { format: 'excel', language: 'csv', renderAs: 'viewer', viewerHint: 'excel', iconColor: 'text-green-600', label: 'CSV 文件', isEditable: true, isBinary: false, mimeType: 'text/csv' };
}

function pptInfo(): FileTypeInfo {
  return { format: 'ppt', language: 'pptx', renderAs: 'viewer', viewerHint: 'ppt', iconColor: 'text-orange-500', label: 'PPT 演示文稿', isEditable: false, isBinary: true, mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
}

function imageInfo(ext: string): FileTypeInfo {
  return { format: 'image', language: ext, renderAs: 'viewer', viewerHint: 'image', iconColor: 'text-purple-500', label: '图片', isEditable: false, isBinary: ext !== 'svg', mimeType: IMAGE_MIME[ext] };
}

function videoInfo(ext: string): FileTypeInfo {
  return { format: 'video', language: ext, renderAs: 'viewer', viewerHint: 'video', iconColor: 'text-pink-500', label: '视频', isEditable: false, isBinary: true, mimeType: VIDEO_MIME[ext] };
}

function audioInfo(ext: string): FileTypeInfo {
  return { format: 'audio', language: ext, renderAs: 'viewer', viewerHint: 'audio', iconColor: 'text-indigo-500', label: '音频', isEditable: false, isBinary: true, mimeType: AUDIO_MIME[ext] };
}

function jsonInfo(): FileTypeInfo {
  return { format: 'json', language: 'json', renderAs: 'monaco', iconColor: 'text-yellow-500', label: 'JSON', isEditable: true, isBinary: false, mimeType: 'application/json' };
}

function htmlInfo(): FileTypeInfo {
  return { format: 'html', language: 'html', renderAs: 'viewer', viewerHint: 'html', iconColor: 'text-orange-500', label: 'HTML 网页', isEditable: true, isBinary: false, mimeType: 'text/html' };
}

/**
 * 判断文件格式是否支持 diff 模式
 */
export function supportsDiffFormat(format: FileFormat): boolean {
  return format === 'code' || format === 'text' || format === 'markdown' || format === 'json';
}
