/**
 * UniversalFileViewer - 通用文件查看器
 * 
 * 支持格式：
 * - 文档：PDF, Word (docx), Excel (xlsx), PPT (pptx)
 * - 图片：PNG, JPG, GIF, WebP, SVG, BMP
 * - 视频：MP4, WebM, MOV, AVI
 * - 音频：MP3, WAV, OGG, M4A
 * - 代码：所有主流编程语言
 * - 文本：Markdown, JSON, XML, TXT
 * - 压缩：ZIP, RAR, 7Z, TAR.GZ
 * 
 * 特性：
 * - Cursor/VSCode 风格的 UI 设计
 * - 流畅的滚动和缩放
 * - 全屏预览支持
 * - 下载和外部打开功能
 */

import React, { useState, useCallback, useRef, useEffect, Suspense, lazy, memo } from 'react';
import { motion } from 'motion/react';
import { Button } from '../ui/button';
import { Slider } from '../ui/slider';
import {
  FileText,
  Image as ImageIcon,
  Video,
  Music,
  FileSpreadsheet,
  FileArchive,
  File,
  Download,
  ExternalLink,
  Play,
  Pause,
  Volume2,
  VolumeX,
  RotateCw,
  SkipBack,
  SkipForward,
  Presentation,
  Code,
  FileWarning,
  RefreshCw,
  Subtitles,
  X,
} from 'lucide-react';
import { useVirtualList } from '../../lib/utils/virtualList';
import { getFileTypeInfo as sharedGetFileTypeInfo } from '../../lib/utils/fileTypes';
import { t } from '../../lib/i18n';
import { Skeleton } from '../ui/skeleton';
import ReactMarkdown from 'react-markdown';
import { remarkPluginsWithMath, rehypePluginsMath, PROSE_CLASSES_MARKDOWN } from '../../lib/markdownRender';

// Worker 超时常量：Word/PPT 解码 30s，Excel 解析 60s（大表可更长）
const BINARY_WORKER_TIMEOUT_MS = 30000;
const EXCEL_WORKER_TIMEOUT_MS = 60000;

/** DOCX 转换结果模块级缓存：同一 convertKey 只转换一次，组件多次挂载（Strict Mode/父重挂载）时直接复用，避免重复转换与刷屏 */
const wordViewerResultCache = new Map<string, { html: string; hasHints: boolean }>();
let wordViewerLastFileName = "";

// 重量级查看器懒加载，减少首包解析与内存
const LazyPdfPreview = lazy(() => import('../PdfPreview').then((m) => ({ default: m.default })));
const LazyWebViewer = lazy(() => import('./WebViewer').then((m) => ({ default: m.WebViewer })));
const LazyDiagramViewer = lazy(() => import('./DiagramViewer').then((m) => ({ default: m.DiagramViewer })));
const LazyMindmapViewer = lazy(() => import('./MindmapViewer').then((m) => ({ default: m.MindmapViewer })));
const LazyGraphViewer = lazy(() => import('./GraphViewer').then((m) => ({ default: m.GraphViewer })));
const LazyExcelViewer = lazy(() => import('./ExcelViewer').then((m) => ({ default: m.ExcelViewer })));
const LazyNotebookViewer = lazy(() => import('./NotebookViewer').then((m) => ({ default: m.NotebookViewer })));

function ViewerLoadingFallback() {
  return (
    <div className="h-full flex flex-col p-6 bg-muted/20" role="status" aria-label={t('viewer.loadingPreview')}>
      <Skeleton className="h-5 w-48 mb-4" />
      <Skeleton className="h-4 w-full max-w-2xl mb-2" />
      <Skeleton className="h-4 w-full max-w-2xl mb-2" />
      <Skeleton className="h-32 w-full max-w-2xl rounded-lg" />
    </div>
  );
}

// ============================================================================
// 类型定义
// ============================================================================

export interface FileViewerProps {
  /** 文件名 */
  fileName: string;
  /** 文件路径 */
  filePath?: string;
  /** 文件内容 (文本文件) */
  content?: string;
  /** Base64 数据 (二进制文件) */
  base64Data?: string;
  /** MIME 类型 */
  mimeType?: string;
  /** 文件大小 (bytes) */
  fileSize?: number;
  /** 是否只读 */
  readOnly?: boolean;
  /** 内容变更回调 */
  onChange?: (content: string) => void;
  /** 高度 */
  height?: string;
  /** 下载回调 */
  onDownload?: () => void;
  /** 外部打开回调 */
  onOpenExternal?: () => void;
  /** 保存二进制内容到工作区（如 Excel 编辑后写回 xlsx） */
  onSaveBinary?: (base64: string) => Promise<void>;
  /** 嵌入编辑区时：不显示文件名栏与下载/打开（Tab 已显示名称，资源管理器可下载） */
  embeddedInEditor?: boolean;
}

type FileFormat = 
  | 'pdf' | 'word' | 'excel' | 'ppt'
  | 'image' | 'video' | 'audio'
  | 'code' | 'markdown' | 'json' | 'text'
  | 'html' | 'web' | 'diagram' | 'mindmap' | 'graph'
  | 'notebook'
  | 'archive' | 'binary' | 'unknown';

interface FileTypeInfo {
  format: FileFormat;
  language?: string;
  icon: React.ReactNode;
  color: string;
  label: string;
  isEditable: boolean;
  isBinary: boolean;
}

// ============================================================================
// 文件类型检测
// ============================================================================

/** 图标映射：根据 format 返回对应的 lucide-react 图标 */
const FORMAT_ICON_MAP: Record<string, React.ReactNode> = {
  pdf: <FileText className="h-4 w-4" />,
  docx: <FileText className="h-4 w-4" />,
  excel: <FileSpreadsheet className="h-4 w-4" />,
  ppt: <Presentation className="h-4 w-4" />,
  image: <ImageIcon className="h-4 w-4" />,
  video: <Video className="h-4 w-4" />,
  audio: <Music className="h-4 w-4" />,
  markdown: <FileText className="h-4 w-4" />,
  json: <Code className="h-4 w-4" />,
  code: <Code className="h-4 w-4" />,
  html: <Code className="h-4 w-4" />,
  diagram: <Code className="h-4 w-4" />,
  mindmap: <FileText className="h-4 w-4" />,
  graph: <Code className="h-4 w-4" />,
  notebook: <Code className="h-4 w-4" />,
  text: <FileText className="h-4 w-4" />,
  archive: <FileArchive className="h-4 w-4" />,
  binary: <File className="h-4 w-4" />,
  unknown: <File className="h-4 w-4" />,
};

/**
 * detectFileType - 基于共享 getFileTypeInfo 的包装器
 * 补充 icon 等 UI 字段供 UniversalFileViewer 内部使用
 */
function detectFileType(fileName: string, mimeType?: string): FileTypeInfo {
  const shared = sharedGetFileTypeInfo(fileName, mimeType);
  // 映射 format：共享版的 'docx' 在 UniversalFileViewer 中对应 'word'
  let format: FileFormat = shared.format as FileFormat;
  if (shared.format === 'docx') format = 'word';
  return {
    format,
    language: shared.language,
    icon: FORMAT_ICON_MAP[shared.format] || <File className="h-4 w-4" />,
    color: shared.iconColor,
    label: shared.label,
    isEditable: shared.isEditable,
    isBinary: shared.isBinary,
  };
}

// ============================================================================
// 图片查看器组件
// ============================================================================

interface ImageViewerProps {
  src: string;
  fileName: string;
  onDownload?: () => void;
  onOpenExternal?: () => void;
  /** 嵌入编辑区时不显示文件名与下载/打开栏 */
  embeddedInEditor?: boolean;
}

function ImageViewer({ src, fileName, onDownload, onOpenExternal, embeddedInEditor }: ImageViewerProps) {
  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [loadError, setLoadError] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLoadError(false);
    setLoaded(false);
  }, [src]);

  const handleRotate = () => setRotation(r => (r + 90) % 360);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      setScale(s => Math.min(Math.max(s + delta, 0.25), 5));
    }
  }, []);

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [contextMenu]);

  return (
    <div ref={containerRef} className="h-full flex flex-col bg-muted/20">
      {/* 无工具栏：Ctrl+滚轮缩放，右键菜单旋转/下载/打开 */}
      {/* 图片区域 */}
      <div 
        className="flex-1 overflow-auto flex items-center justify-center p-8 bg-muted/10 relative"
        onWheel={handleWheel}
        onContextMenu={handleContextMenu}
      >
        {loadError ? (
          <div className="text-center max-w-sm">
            <ImageIcon className="h-14 w-14 mx-auto mb-3 text-muted-foreground" />
            <p className="text-sm text-foreground mb-2">{t('viewer.imageLoadFailed')}</p>
            <p className="text-xs text-muted-foreground mb-4 truncate" title={fileName}>{fileName}</p>
            <div className="flex items-center justify-center gap-2">
              {onDownload && (
                <Button variant="outline" size="sm" className="gap-2" onClick={onDownload}>
                  <Download className="h-4 w-4" /> {t('viewer.download')}
                </Button>
              )}
              {onOpenExternal && (
                <Button variant="outline" size="sm" className="gap-2" onClick={onOpenExternal}>
                  <ExternalLink className="h-4 w-4" /> {t('viewer.openExternal')}
                </Button>
              )}
            </div>
          </div>
        ) : (
          <>
            {!loaded && (
              <div className="w-64 h-48 rounded-lg bg-muted/50 animate-pulse shrink-0" aria-hidden />
            )}
            <motion.img
              src={src}
              alt={fileName}
              className="max-w-none shadow-2xl rounded-lg"
              style={{
                transform: `scale(${scale}) rotate(${rotation}deg)`,
                transition: 'transform 0.2s ease-out',
                ...(loaded ? {} : { position: 'absolute', opacity: 0 }),
              }}
              initial={loaded ? { opacity: 0, scale: 0.9 } : false}
              animate={loaded ? { opacity: 1, scale: 1 } : false}
              draggable={false}
              onLoad={() => setLoaded(true)}
              onError={() => setLoadError(true)}
            />
          </>
        )}
      </div>
      {contextMenu && (
        <div
          className="fixed z-[var(--z-dropdown)] min-w-[140px] py-1 rounded-md border bg-popover text-popover-foreground shadow-md"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          role="menu"
          aria-label={t('viewer.imageActions')}
        >
          <button
            type="button"
            className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted flex items-center gap-2"
            onClick={() => { handleRotate(); setContextMenu(null); }}
            aria-label={t('viewer.rotate90')}
          >
            <RotateCw className="h-4 w-4" /> {t('viewer.rotate90')}
          </button>
          {!embeddedInEditor && onDownload && (
            <button type="button" className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted flex items-center gap-2" onClick={() => { onDownload(); setContextMenu(null); }} aria-label={t('viewer.download')}>
              <Download className="h-4 w-4" /> {t('viewer.download')}
            </button>
          )}
          {!embeddedInEditor && onOpenExternal && (
            <button type="button" className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted flex items-center gap-2" onClick={() => { onOpenExternal(); setContextMenu(null); }} aria-label={t('viewer.openExternal')}>
              <ExternalLink className="h-4 w-4" /> {t('viewer.openExternal')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// 视频播放器组件
// ============================================================================

interface VideoPlayerProps {
  src: string;
  fileName: string;
  mimeType?: string;
  onDownload?: () => void;
  onOpenExternal?: () => void;
}

const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

/** 将 SRT 内容转为 WebVTT（浏览器 <track> 需要 VTT，时间戳逗号改点） */
function srtToVtt(srt: string): string {
  const normalized = srt.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const vtt = normalized.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return vtt.startsWith('WEBVTT') ? vtt : 'WEBVTT\n\n' + vtt;
}

function VideoPlayer({ src, fileName, mimeType, onDownload, onOpenExternal }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const subtitleInputRef = useRef<HTMLInputElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [subtitleUrl, setSubtitleUrl] = useState<string | null>(null);
  const subtitleUrlRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (subtitleUrlRef.current) URL.revokeObjectURL(subtitleUrlRef.current);
    };
  }, []);

  useEffect(() => {
    if (subtitleUrlRef.current) {
      URL.revokeObjectURL(subtitleUrlRef.current);
      subtitleUrlRef.current = null;
    }
    setSubtitleUrl(null);
  }, [src]);

  const handleSubtitleFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const isSrt = file.name.toLowerCase().endsWith('.srt');
    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result as string;
      const vtt = isSrt ? srtToVtt(text) : text;
      const blob = new Blob([vtt], { type: 'text/vtt' });
      const url = URL.createObjectURL(blob);
      if (subtitleUrlRef.current) URL.revokeObjectURL(subtitleUrlRef.current);
      subtitleUrlRef.current = url;
      setSubtitleUrl(url);
    };
    reader.readAsText(file, 'utf-8');
  }, []);

  const clearSubtitle = useCallback(() => {
    if (subtitleUrlRef.current) {
      URL.revokeObjectURL(subtitleUrlRef.current);
      subtitleUrlRef.current = null;
    }
    setSubtitleUrl(null);
  }, []);

  const togglePlay = () => {
    if (videoRef.current) {
      if (isPlaying) {
        videoRef.current.pause();
      } else {
        videoRef.current.play();
      }
      setIsPlaying(!isPlaying);
    }
  };

  const toggleMute = () => {
    if (videoRef.current) {
      videoRef.current.muted = !isMuted;
      setIsMuted(!isMuted);
    }
  };

  const handleSeek = (value: number[]) => {
    const v = value?.[0];
    if (videoRef.current && v !== undefined) {
      videoRef.current.currentTime = v;
      setCurrentTime(v);
    }
  };

  const handleVolumeChange = (value: number[]) => {
    const v = value?.[0];
    if (videoRef.current && v !== undefined) {
      videoRef.current.volume = v;
      setVolume(v);
    }
  };

  const skip = (seconds: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = Math.max(0, Math.min(duration, currentTime + seconds));
    }
  };

  const setSpeed = (rate: number) => {
    setPlaybackRate(rate);
    if (videoRef.current) videoRef.current.playbackRate = rate;
  };

  const formatTime = (time: number) => {
    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time % 60);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  return (
    <div className="h-full flex flex-col min-h-0 bg-black">
      {/* 视频区域 */}
      <div className="flex-1 min-h-0 flex items-center justify-center relative">
        <video
          ref={videoRef}
          className="max-w-full max-h-full"
          onTimeUpdate={() => setCurrentTime(videoRef.current?.currentTime || 0)}
          onLoadedMetadata={() => setDuration(videoRef.current?.duration || 0)}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onClick={togglePlay}
        >
          <source src={src} type={mimeType || 'video/mp4'} />
          {subtitleUrl && (
            <track src={subtitleUrl} kind="subtitles" srcLang="zh" label="字幕" default />
          )}
        </video>
        
        {/* 播放按钮覆盖 */}
        {!isPlaying && (
          <motion.button
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            className="absolute inset-0 flex items-center justify-center"
            onClick={togglePlay}
          >
            <div className="w-20 h-20 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center hover:bg-white/30 transition-colors">
              <Play className="h-10 w-10 text-white ml-1" />
            </div>
          </motion.button>
        )}
      </div>
      
      {/* 控制栏 */}
      <div className="shrink-0 bg-linear-to-t from-black/90 to-black/50 px-4 py-3">
        {/* 进度条 */}
        <div className="mb-3">
          <Slider
            value={[currentTime]}
            max={duration || 100}
            step={0.1}
            onValueChange={handleSeek}
            className="cursor-pointer"
          />
        </div>
        
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" className="h-9 w-9 text-white hover:bg-white/20" onClick={() => skip(-10)} aria-label={t('viewer.skipBack')}>
              <SkipBack className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" className="h-10 w-10 text-white hover:bg-white/20" onClick={togglePlay} aria-label={isPlaying ? t('viewer.pause') : t('viewer.play')}>
              {isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5 ml-0.5" />}
            </Button>
            <Button variant="ghost" size="icon" className="h-9 w-9 text-white hover:bg-white/20" onClick={() => skip(10)} aria-label={t('viewer.skipForward')}>
              <SkipForward className="h-4 w-4" />
            </Button>
            
            <span className="text-sm text-white/80 ml-2">
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>
            <div className="flex items-center gap-0.5 ml-2">
              {PLAYBACK_RATES.map((rate) => (
                <button
                  key={rate}
                  type="button"
                  onClick={() => setSpeed(rate)}
                  className={`px-1.5 py-0.5 text-xs rounded ${playbackRate === rate ? 'bg-white/30 text-white' : 'text-white/70 hover:bg-white/10'}`}
                >
                  {rate === 1 ? '1x' : `${rate}x`}
                </button>
              ))}
            </div>
          </div>
          
          <div className="flex items-center gap-2">
            <input
              ref={subtitleInputRef}
              type="file"
              accept=".vtt,.srt"
              className="hidden"
              onChange={handleSubtitleFile}
              aria-label={t('viewer.subtitles')}
            />
            {subtitleUrl ? (
              <Button variant="ghost" size="sm" className="h-8 text-white/70 hover:text-white hover:bg-white/20 gap-1" onClick={clearSubtitle} title={t('viewer.subtitles')} aria-label={t('viewer.subtitles')}>
                <Subtitles className="h-4 w-4" />
                <span className="text-xs">{t('viewer.subtitles')}</span>
                <X className="h-3 w-3" />
              </Button>
            ) : (
              <Button variant="ghost" size="sm" className="h-8 text-white/70 hover:text-white hover:bg-white/20 gap-1" onClick={() => subtitleInputRef.current?.click()} title={t('viewer.subtitles')} aria-label={t('viewer.subtitles')}>
                <Subtitles className="h-4 w-4" />
                <span className="text-xs">{t('viewer.subtitles')}</span>
              </Button>
            )}
            <div className="flex items-center gap-2 w-32">
              <Button variant="ghost" size="icon" className="h-8 w-8 text-white hover:bg-white/20" onClick={toggleMute} aria-label={isMuted ? t('viewer.unmute') : t('viewer.mute')}>
                {isMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
              </Button>
              <Slider
                value={[isMuted ? 0 : volume]}
                max={1}
                step={0.01}
                onValueChange={handleVolumeChange}
                className="w-20"
              />
            </div>
            
            {onDownload && (
              <Button variant="ghost" size="sm" className="h-8 text-white/70 hover:text-white hover:bg-white/20" onClick={onDownload} aria-label={t('viewer.download')}>
                <Download className="h-4 w-4" />
              </Button>
            )}
            {onOpenExternal && (
              <Button variant="ghost" size="sm" className="h-8 text-white/70 hover:text-white hover:bg-white/20" onClick={onOpenExternal} aria-label={t('viewer.openExternal')}>
                <ExternalLink className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// 音频播放器组件
// ============================================================================

interface AudioPlayerProps {
  src: string;
  fileName: string;
  mimeType?: string;
  onDownload?: () => void;
  onOpenExternal?: () => void;
  embeddedInEditor?: boolean;
}

function AudioPlayer({ src, fileName, mimeType, onDownload, onOpenExternal, embeddedInEditor }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);

  const togglePlay = () => {
    if (audioRef.current) {
      if (isPlaying) {
        audioRef.current.pause();
      } else {
        audioRef.current.play();
      }
      setIsPlaying(!isPlaying);
    }
  };

  const handleSeek = (value: number[]) => {
    const v = value?.[0];
    if (audioRef.current && v !== undefined) {
      audioRef.current.currentTime = v;
      setCurrentTime(v);
    }
  };

  const formatTime = (time: number) => {
    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time % 60);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  return (
    <div className={`h-full min-h-0 flex items-center justify-center bg-linear-to-br from-indigo-500/10 via-purple-500/10 to-pink-500/10 ${embeddedInEditor ? 'p-4' : 'p-8'}`}>
      <audio
        ref={audioRef}
        src={src}
        onTimeUpdate={() => setCurrentTime(audioRef.current?.currentTime || 0)}
        onLoadedMetadata={() => setDuration(audioRef.current?.duration || 0)}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
      />
      
      <div className="w-full max-w-md text-center space-y-8">
        {/* 封面/动画 */}
        <motion.div
          animate={{ scale: isPlaying ? [1, 1.05, 1] : 1 }}
          transition={{ duration: 2, repeat: Infinity }}
          className="w-40 h-40 mx-auto rounded-full bg-linear-to-br from-indigo-500 to-pink-500 flex items-center justify-center shadow-2xl shadow-purple-500/30"
        >
          <Music className="h-20 w-20 text-white" />
        </motion.div>
        
        {/* 文件名（嵌入编辑区时不显示，避免与 Tab 重复） */}
        <div>
          {!embeddedInEditor && <h3 className="text-xl font-semibold text-foreground">{fileName}</h3>}
          <p className="text-sm text-muted-foreground mt-1">{formatTime(duration)}</p>
        </div>
        
        {/* 进度条 */}
        <div className="space-y-2">
          <Slider
            value={[currentTime]}
            max={duration || 100}
            step={0.1}
            onValueChange={handleSeek}
            className="cursor-pointer"
          />
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{formatTime(currentTime)}</span>
            <span>{formatTime(duration)}</span>
          </div>
        </div>
        
        {/* 控制按钮 */}
        <div className="flex items-center justify-center gap-4">
          <Button variant="ghost" size="icon" className="h-12 w-12" onClick={() => { if (audioRef.current) audioRef.current.currentTime -= 10; }} aria-label={t('viewer.skipBack')}>
            <SkipBack className="h-5 w-5" />
          </Button>
          <Button size="icon" className="h-14 w-14 rounded-full bg-linear-to-r from-indigo-500 to-pink-500 hover:from-indigo-600 hover:to-pink-600" onClick={togglePlay} aria-label={isPlaying ? t('viewer.pause') : t('viewer.play')}>
            {isPlaying ? <Pause className="h-6 w-6" /> : <Play className="h-6 w-6 ml-1" />}
          </Button>
          <Button variant="ghost" size="icon" className="h-12 w-12" onClick={() => { if (audioRef.current) audioRef.current.currentTime += 10; }} aria-label={t('viewer.skipForward')}>
            <SkipForward className="h-5 w-5" />
          </Button>
        </div>
        
        {/* 下载 / 外部打开（嵌入编辑区时通常不显示，避免空占位） */}
        {(onDownload || onOpenExternal) && (
          <div className="flex items-center justify-center gap-2">
            {onDownload && (
              <Button variant="outline" className="gap-2" onClick={onDownload} aria-label={t('viewer.downloadAudio')}>
                <Download className="h-4 w-4" /> {t('viewer.downloadAudio')}
              </Button>
            )}
            {onOpenExternal && (
              <Button variant="outline" className="gap-2" onClick={onOpenExternal} aria-label={t('viewer.openExternal')}>
                <ExternalLink className="h-4 w-4" /> {t('viewer.openExternal')}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Word 预览组件
// ============================================================================

interface WordViewerProps {
  content: string;
  fileName: string;
  /** 文件完整路径，用于缓存 key 区分同名不同路径文件 */
  filePath?: string;
  base64Data?: string;
  onDownload?: () => void;
  onOpenExternal?: () => void;
  /** 嵌入编辑区时 Tab 已有文件名，不重复显示顶栏 */
  embeddedInEditor?: boolean;
}

const WordViewerInner = function WordViewerInner({ content, fileName, filePath, base64Data, onDownload, onOpenExternal, embeddedInEditor = false }: WordViewerProps) {
  const [htmlContent, setHtmlContent] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasConversionHints, setHasConversionHints] = useState(false);
  const [retryKey, setRetryKey] = useState(0);

  const handleRetry = useCallback(() => {
    setError(null);
    setLoading(true);
    setRetryKey((k) => k + 1);
  }, []);

  // 纯文本分支：仅 content/base64Data 变化时更新，避免父组件重渲染导致闪烁
  useEffect(() => {
    if (content && !base64Data) {
      setHtmlContent(`<pre style="white-space: pre-wrap; font-family: inherit;">${content}</pre>`);
      setLoading(false);
      setError(null);
    } else if (!base64Data) {
      setError('没有可用的文件数据');
      setLoading(false);
    }
  }, [content, base64Data]);

  // DOCX 转换：模块级缓存同一 convertKey 的转换结果；key 含 filePath 时区分同名不同路径文件，避免误复用
  const convertKey = filePath ? `${filePath}:${retryKey}` : `${fileName}:${retryKey}`;
  const fileKey = filePath ?? fileName;
  useEffect(() => {
    if (!base64Data) return;
    if (fileKey !== wordViewerLastFileName) {
      wordViewerResultCache.clear();
      wordViewerLastFileName = fileKey;
    }
    const cached = wordViewerResultCache.get(convertKey);
    if (cached) {
      setHtmlContent(cached.html);
      setHasConversionHints(cached.hasHints);
      setLoading(false);
      return;
    }
    const data = base64Data;
    let cancelled = false;
    const runMainThread = async () => {
      const mammoth = await import('mammoth');
      const arrayBuffer = Uint8Array.from(atob(data), (c) => c.charCodeAt(0)).buffer;
      const result = await mammoth.convertToHtml(
        { arrayBuffer },
        { convertImage: mammoth.images.dataUri }
      );
      if (!cancelled) {
        wordViewerResultCache.set(convertKey, { html: result.value, hasHints: result.messages.length > 0 });
        setHtmlContent(result.value);
        setHasConversionHints(result.messages.length > 0);
      }
    };

    try {
      setLoading(true);
      setError(null);
      setHasConversionHints(false);
      const workerUrl = new URL('./binary-decode.worker.ts', import.meta.url);
      const worker = new Worker(workerUrl, { type: 'module' });
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const cleanup = () => {
        if (timeoutId != null) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        worker.terminate();
      };
      const onMessage = (ev: MessageEvent<{ ok: true; html: string; messages: Array<{ message: string }> } | { ok: false; error: string }>) => {
        cleanup();
        if (cancelled) return;
        const msg = ev.data;
        if (msg.ok) {
          wordViewerResultCache.set(convertKey, { html: msg.html, hasHints: Array.isArray(msg.messages) && msg.messages.length > 0 });
          setHtmlContent(msg.html);
          const messages = Array.isArray(msg.messages) ? msg.messages : [];
          setHasConversionHints(messages.length > 0);
          if (messages.length > 0 && import.meta.env?.DEV) {
            console.debug('[WordViewer] 转换提示:', messages);
          }
        } else {
          setError(msg.error);
        }
        setLoading(false);
      };
      const onErr = () => {
        cleanup();
        if (!cancelled) runMainThread().catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : '解析失败'); }).finally(() => { if (!cancelled) setLoading(false); });
      };
      const onTimeout = () => {
        if (cancelled) return;
        cleanup();
        if (import.meta.env?.DEV) console.warn('[WordViewer] Worker 超时，回退主线程');
        runMainThread().catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : '解析超时'); }).finally(() => { if (!cancelled) setLoading(false); });
      };
      timeoutId = setTimeout(onTimeout, BINARY_WORKER_TIMEOUT_MS);
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onErr);
      worker.postMessage({ type: 'word', base64Data: data });
      return () => {
        cancelled = true;
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onErr);
        cleanup();
      };
    } catch {
      runMainThread().catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '解析失败');
      }).finally(() => { if (!cancelled) setLoading(false); });
      return () => { cancelled = true; };
    }
  }, [base64Data, convertKey, fileKey]);

  if (loading) {
    return (
      <div className="h-full min-h-0 flex flex-col items-center justify-center p-6" role="status" aria-label={t('viewer.wordLoading')}>
        <Skeleton className="h-6 w-56 mb-4" />
        <Skeleton className="h-4 w-full max-w-xl mb-2" />
        <Skeleton className="h-4 w-full max-w-xl mb-2" />
        <Skeleton className="h-48 w-full max-w-xl rounded-lg" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full min-h-0 flex items-center justify-center" role="alert">
        <div className="text-center max-w-md">
          <FileText className="h-16 w-16 mx-auto mb-4 text-blue-500/50" aria-hidden />
          <h3 className="text-lg font-medium mb-2">{t('viewer.wordDoc')}</h3>
          <p className="text-sm text-muted-foreground mb-4">{error}</p>
          <div className="flex items-center justify-center gap-3 flex-wrap">
            <Button variant="outline" className="gap-2" onClick={handleRetry} aria-label={t('viewer.retry')}>
              <RefreshCw className="h-4 w-4" /> {t('viewer.retry')}
            </Button>
            {onDownload && (
              <Button variant="outline" className="gap-2" onClick={onDownload} aria-label={t('viewer.downloadFile')}>
                <Download className="h-4 w-4" /> {t('viewer.downloadFile')}
              </Button>
            )}
            {onOpenExternal && (
              <Button variant="outline" className="gap-2" onClick={onOpenExternal} aria-label={t('viewer.openExternal')}>
                <ExternalLink className="h-4 w-4" /> {t('viewer.openExternal')}
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-4">
            {t('viewer.wordInstallHint')}
          </p>
        </div>
      </div>
    );
  }

  if (!htmlContent.trim()) {
    return (
      <div className="h-full min-h-0 flex flex-col bg-background">
        <div className="flex-1 min-h-0 flex items-center justify-center p-6">
          <div className="text-center max-w-md">
            <FileText className="h-16 w-16 mx-auto mb-4 text-blue-500/50" aria-hidden />
            <h3 className="text-lg font-medium mb-2">{t('viewer.wordDoc')}</h3>
            <p className="text-sm text-muted-foreground mb-4">{t('viewer.parseNoContent')}</p>
            <div className="flex items-center justify-center gap-3">
              {onDownload && (
                <Button variant="outline" className="gap-2" onClick={onDownload}>
                  <Download className="h-4 w-4" /> {t('viewer.downloadFile')}
                </Button>
              )}
              {onOpenExternal && (
                <Button variant="outline" className="gap-2" onClick={onOpenExternal}>
                  <ExternalLink className="h-4 w-4" /> {t('viewer.openExternal')}
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 flex flex-col bg-background">
      <style>{`
        .word-viewer-paper {
          background: var(--doc-paper-bg);
          color: var(--doc-paper-fg);
        }
        .word-doc-content {
          min-height: 2em;
          color: inherit;
        }
        .word-doc-content p, .word-doc-content li, .word-doc-content td, .word-doc-content th,
        .word-doc-content span, .word-doc-content div, .word-doc-content h1, .word-doc-content h2,
        .word-doc-content h3, .word-doc-content h4, .word-doc-content pre {
          color: inherit !important;
        }
        .word-doc-content h1 { font-size: 1.5rem; font-weight: 600; margin-top: 0; margin-bottom: 0.75rem; line-height: 1.3; border-bottom: 1px solid hsl(var(--border)); padding-bottom: 0.5rem; }
        .word-doc-content h2 { font-size: 1.25rem; font-weight: 600; margin-top: 1.5rem; margin-bottom: 0.5rem; line-height: 1.35; }
        .word-doc-content h3 { font-size: 1.125rem; font-weight: 600; margin-top: 1.25rem; margin-bottom: 0.375rem; line-height: 1.4; }
        .word-doc-content h4 { font-size: 1rem; font-weight: 600; margin-top: 1rem; margin-bottom: 0.25rem; line-height: 1.45; }
        .word-doc-content p { margin-top: 0.5rem; margin-bottom: 0.5rem; }
        .word-doc-content ul, .word-doc-content ol { margin-top: 0.5rem; margin-bottom: 0.75rem; padding-left: 1.5rem; }
        .word-doc-content li { margin-top: 0.25rem; margin-bottom: 0.25rem; }
        .word-doc-content blockquote {
          border-left: 4px solid hsl(var(--primary));
          background: hsl(var(--muted) / 0.3);
          margin: 0.75rem 0;
          padding: 0.5rem 0 0.5rem 1rem;
          color: inherit;
        }
        .dark .word-doc-content blockquote { background: hsl(var(--muted) / 0.4); }
        .word-doc-content a {
          color: hsl(var(--primary));
        }
        .dark .word-doc-content a {
          color: hsl(var(--primary));
        }
        .word-doc-content table {
          border-collapse: collapse;
          width: 100%;
          border: 1px solid hsl(var(--border));
          border-radius: 8px;
          overflow: hidden;
          margin: 1rem 0;
        }
        .word-doc-content table th,
        .word-doc-content table td {
          border: 1px solid hsl(var(--border));
          padding: 0.5rem 0.75rem;
          text-align: left;
          color: inherit;
        }
        .word-doc-content table th {
          background: hsl(var(--muted));
          font-weight: 600;
        }
        .dark .word-doc-content table th { background: hsl(var(--muted) / 0.8); }
        .word-doc-content table tbody tr:nth-child(even) {
          background: hsl(var(--muted) / 0.4);
        }
        .dark .word-doc-content table tbody tr:nth-child(even) { background: hsl(var(--muted) / 0.5); }
        .word-doc-content table tbody tr:hover {
          background: hsl(var(--muted) / 0.6);
        }
        .dark .word-doc-content table tbody tr:hover { background: hsl(var(--muted) / 0.7); }
      `}</style>
      {/* 无工具栏：纯文档内容滚动；纸张色使用全局 --doc-paper-*，与 PDF/PPT 一致 */}
      <div className="word-viewer-paper doc-viewer-paper flex-1 min-h-0 overflow-auto p-6">
        <div 
          className="word-doc-content max-w-4xl mx-auto prose prose-sm prose-headings:font-semibold prose-table:my-4"
          dangerouslySetInnerHTML={{ __html: htmlContent }}
          style={{ lineHeight: 1.8 }}
        />
      </div>
    </div>
  );
};
const WordViewer = memo(WordViewerInner, (prev, next) =>
  prev.base64Data === next.base64Data && prev.fileName === next.fileName && prev.filePath === next.filePath && prev.content === next.content && prev.embeddedInEditor === next.embeddedInEditor);

// ============================================================================
// PPT 预览组件（基于 .pptx ZIP + 幻灯片 XML 文本提取）
// ============================================================================

/** 从幻灯片 XML 中提取文本（OOXML 中文本多在 a:t 等标签内） */
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

interface PPTViewerProps {
  content: string;
  fileName: string;
  base64Data?: string;
  onDownload?: () => void;
  onOpenExternal?: () => void;
  /** 嵌入编辑区时 Tab 已有文件名，顶栏不重复显示文件名 */
  embeddedInEditor?: boolean;
}

function PPTViewer({ content, fileName, base64Data, onDownload, onOpenExternal, embeddedInEditor = false }: PPTViewerProps) {
  const [slides, setSlides] = useState<Array<{ title?: string; content?: string }>>([]);
  const [currentSlide, setCurrentSlide] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  const handleRetry = useCallback(() => {
    setError(null);
    setLoading(true);
    setRetryKey((k) => k + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!base64Data) {
      setSlides([{ title: '幻灯片 1', content: '请提供 PPT 文件（Base64）以预览。' }]);
      setLoading(false);
      return;
    }

    const runMainThread = async () => {
      const JSZip = (await import('jszip')).default;
      const binary = Uint8Array.from(atob(base64Data.replace(/\s/g, '')), (c) => c.charCodeAt(0));
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
      if (!cancelled) setSlides(parsed);
    };

    try {
      setLoading(true);
      setError(null);
      const workerUrl = new URL('./binary-decode.worker.ts', import.meta.url);
      const worker = new Worker(workerUrl, { type: 'module' });
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const cleanup = () => {
        if (timeoutId != null) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        worker.terminate();
      };
      const onMessage = (ev: MessageEvent<{ ok: true; slides: Array<{ title?: string; content?: string }> } | { ok: false; error: string }>) => {
        cleanup();
        if (cancelled) return;
        const data = ev.data;
        if (data.ok) setSlides(data.slides);
        else {
          setError(data.error);
          setSlides([{ title: '幻灯片 1', content: '解析失败，建议使用系统应用打开。' }]);
        }
        setLoading(false);
      };
      const onErr = () => {
        cleanup();
        if (!cancelled) runMainThread().catch((err) => { if (!cancelled) { setError(err instanceof Error ? err.message : '解析失败'); setSlides([{ title: '幻灯片 1', content: '解析失败。' }]); } }).finally(() => { if (!cancelled) setLoading(false); });
      };
      const onTimeout = () => {
        if (cancelled) return;
        cleanup();
        if (import.meta.env?.DEV) console.warn('[PPTViewer] Worker 超时，回退主线程');
        runMainThread().catch((err) => { if (!cancelled) { setError(err instanceof Error ? err.message : '解析超时'); setSlides([{ title: '幻灯片 1', content: '解析超时。' }]); } }).finally(() => { if (!cancelled) setLoading(false); });
      };
      timeoutId = setTimeout(onTimeout, BINARY_WORKER_TIMEOUT_MS);
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onErr);
      worker.postMessage({ type: 'ppt', base64Data });
      return () => {
        cancelled = true;
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onErr);
        cleanup();
      };
    } catch {
      runMainThread().catch((err) => {
        if (!cancelled) { setError(err instanceof Error ? err.message : '解析失败'); setSlides([{ title: '幻灯片 1', content: '解析失败。' }]); }
      }).finally(() => { if (!cancelled) setLoading(false); });
      return () => { cancelled = true; };
    }
  }, [content, base64Data, retryKey]);

  if (loading) {
    return (
      <div className="h-full min-h-0 flex flex-col items-center justify-center p-8" role="status" aria-label={t('viewer.pptLoading')}>
        <Skeleton className="h-8 w-64 mb-6 rounded" />
        <Skeleton className="h-48 w-full max-w-2xl rounded-lg aspect-video" />
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 flex flex-col bg-background">
      {/* 无工具栏：滚动/键盘翻页，页码见底部状态栏 */}
      {/* 幻灯片内容 */}
      <div className="flex-1 min-h-0 flex items-center justify-center p-8 overflow-auto">
        <div className="doc-viewer-paper w-full max-w-4xl aspect-video rounded-lg shadow-lg border border-border p-8 flex flex-col items-center justify-center">
          {error ? (
            <div className="text-center" role="alert">
              <FileWarning className="h-16 w-16 mx-auto mb-4 text-orange-500/50" />
              <p className="text-lg font-medium mb-2">{t('viewer.pptPreview')}</p>
              <p className="text-sm text-muted-foreground mb-4">{error}</p>
              <div className="flex items-center justify-center gap-2 flex-wrap">
                <Button variant="outline" size="sm" className="gap-2" onClick={handleRetry} aria-label={t('viewer.retry')}>
                  <RefreshCw className="h-4 w-4" /> {t('viewer.retry')}
                </Button>
                {onDownload && (
                  <Button variant="outline" size="sm" className="gap-2" onClick={onDownload} aria-label={t('viewer.download')}>
                    <Download className="h-4 w-4" /> {t('viewer.download')}
                  </Button>
                )}
                {onOpenExternal && (
                  <Button variant="outline" size="sm" className="gap-2" onClick={onOpenExternal} aria-label={t('viewer.openExternal')}>
                    <ExternalLink className="h-4 w-4" /> {t('viewer.openExternal')}
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <>
              <Presentation className="h-16 w-16 text-orange-500/30 mb-4" />
              <h2 className="text-xl font-semibold mb-3 text-center px-4">
                {slides[currentSlide]?.title || `幻灯片 ${currentSlide + 1}`}
              </h2>
              <div className="text-sm text-muted-foreground text-center max-h-48 overflow-auto px-6 whitespace-pre-wrap">
                {slides[currentSlide]?.content || '(无文本)'}
              </div>
              <p className="text-xs text-muted-foreground mt-6">
                {t('viewer.pptTextOnly')}
              </p>
            </>
          )}
        </div>
      </div>
      
      {/* 缩略图栏 */}
      {slides.length > 1 && (
        <div className="shrink-0 border-t bg-card px-4 py-2 overflow-x-auto">
          <div className="flex items-center gap-2">
            {slides.map((slide, index) => (
              <button
                key={index}
                onClick={() => setCurrentSlide(index)}
                className={`shrink-0 w-28 rounded border-2 transition-all overflow-hidden ${
                  currentSlide === index
                    ? 'border-orange-500 shadow-md'
                    : 'border-border hover:border-orange-500/50'
                }`}
              >
                <div className="h-10 bg-white dark:bg-neutral-800 flex items-center justify-center text-xs font-medium text-muted-foreground">
                  {index + 1}
                </div>
                <div className="h-6 px-1.5 bg-muted/30 flex items-center justify-center text-[10px] text-muted-foreground truncate">
                  {(slide.title || '').slice(0, 12)}
                  {(slide.title || '').length > 12 ? '…' : ''}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// 二进制/不支持文件占位组件
// ============================================================================

interface UnsupportedViewerProps {
  fileType: FileTypeInfo;
  fileName: string;
  fileSize?: number;
  onDownload?: () => void;
  onOpenExternal?: () => void;
}

function UnsupportedViewer({ fileType, fileName, fileSize, onDownload, onOpenExternal }: UnsupportedViewerProps) {
  return (
    <div className="h-full flex items-center justify-center bg-muted/20 p-8">
      <div className="text-center max-w-md">
        <div className={`inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-muted/50 mb-6 ${fileType.color}`}>
          {React.cloneElement(fileType.icon as React.ReactElement, { className: 'h-10 w-10' })}
        </div>

        <h3 className="text-lg font-semibold mb-2">{fileType.label}</h3>
        <p className="text-sm text-muted-foreground mb-1">{fileName}</p>

        {fileSize && (
          <p className="text-xs text-muted-foreground mb-4">
            {fileSize < 1024 * 1024
              ? `${(fileSize / 1024).toFixed(1)} KB`
              : `${(fileSize / 1024 / 1024).toFixed(2)} MB`}
          </p>
        )}

        <p className="text-sm text-muted-foreground mb-6">
          {t('viewer.unsupportedHint')}
        </p>

        <div className="flex items-center justify-center gap-3">
          {onDownload && (
            <Button variant="outline" className="gap-2" onClick={onDownload} aria-label={t('viewer.downloadFile')}>
              <Download className="h-4 w-4" /> {t('viewer.downloadFile')}
            </Button>
          )}
          {onOpenExternal && (
            <Button variant="outline" className="gap-2" onClick={onOpenExternal} aria-label={t('viewer.openExternal')}>
              <ExternalLink className="h-4 w-4" /> {t('viewer.openExternal')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// 主组件
// ============================================================================

function UniversalFileViewerInner({
  fileName,
  filePath,
  content = '',
  base64Data,
  mimeType,
  fileSize,
  readOnly = true,
  onChange,
  height = '100%',
  onDownload,
  onOpenExternal,
  onSaveBinary,
  embeddedInEditor = false,
}: FileViewerProps) {
  const fileType = React.useMemo(() => detectFileType(fileName, mimeType), [fileName, mimeType]);
  const passDownload = embeddedInEditor ? undefined : onDownload;
  const passOpenExternal = embeddedInEditor ? undefined : onOpenExternal;

  // Blob URL（避免大文件 data: URL 拼接卡顿与内存占用）；仅在实际内容变化时更新，避免父组件重渲染导致同一 base64 重复创建 blob 引发闪烁
  const blobUrlRef = useRef<string | null>(null);
  const lastBase64Ref = useRef<string | undefined>(undefined);
  const lastMimeRef = useRef<string | undefined>(undefined);
  const [blobUrl, setBlobUrl] = useState('');
  useEffect(() => {
    if (base64Data === lastBase64Ref.current && mimeType === lastMimeRef.current) return;
    lastBase64Ref.current = base64Data;
    lastMimeRef.current = mimeType;
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
    if (base64Data) {
      try {
        const binary = Uint8Array.from(atob(base64Data), (c) => c.charCodeAt(0));
        const blob = new Blob([binary], { type: mimeType || 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        blobUrlRef.current = url;
        setBlobUrl(url);
      } catch {
        setBlobUrl('');
      }
    } else {
      setBlobUrl('');
    }
    return () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, [base64Data, mimeType]);
  const getFileUrl = useCallback(() => blobUrl, [blobUrl]);

  // 嵌入编辑区时用统一根容器保证高度与滚动，各类资源一致显示
  const Wrap = embeddedInEditor
    ? ({ children }: { children: React.ReactNode }) => (
        <div
          className="h-full min-h-0 overflow-hidden flex flex-col"
          data-editor-viewer-root
          role="region"
          aria-label={`${fileType.label}预览`}
        >
          {children}
        </div>
      )
    : ({ children }: { children: React.ReactNode }) => <>{children}</>;

  switch (fileType.format) {
    case 'image':
      return (
        <Wrap>
          <ImageViewer
            src={getFileUrl() || content}
            fileName={fileName}
            onDownload={passDownload}
            onOpenExternal={passOpenExternal}
            embeddedInEditor={embeddedInEditor}
          />
        </Wrap>
      );

    case 'video':
      return (
        <Wrap>
          <VideoPlayer
            src={getFileUrl()}
            fileName={fileName}
            mimeType={mimeType}
            onDownload={passDownload}
            onOpenExternal={passOpenExternal}
          />
        </Wrap>
      );

    case 'audio':
      return (
        <Wrap>
          <AudioPlayer
            src={getFileUrl()}
            fileName={fileName}
            mimeType={mimeType}
            onDownload={passDownload}
            onOpenExternal={passOpenExternal}
            embeddedInEditor={embeddedInEditor}
          />
        </Wrap>
      );

    case 'excel':
      return (
        <Wrap>
          <Suspense fallback={<ViewerLoadingFallback />}>
            <LazyExcelViewer
              content={content}
              fileName={fileName}
              base64Data={base64Data}
              onDownload={passDownload}
              onOpenExternal={passOpenExternal}
              onSaveEdits={onSaveBinary}
              embeddedInEditor={embeddedInEditor}
            />
          </Suspense>
        </Wrap>
      );

    case 'ppt':
      return (
        <Wrap>
          <PPTViewer
            content={content}
            fileName={fileName}
            base64Data={base64Data}
            onDownload={passDownload}
            onOpenExternal={passOpenExternal}
            embeddedInEditor={embeddedInEditor}
          />
        </Wrap>
      );

    case 'word':
      return (
        <Wrap>
          <WordViewer
            content={content}
            fileName={fileName}
            filePath={filePath}
            base64Data={base64Data}
            onDownload={passDownload}
            onOpenExternal={passOpenExternal}
            embeddedInEditor={embeddedInEditor}
          />
        </Wrap>
      );

    case 'html':
      return (
        <Wrap>
          <Suspense fallback={<ViewerLoadingFallback />}>
            <LazyWebViewer
              content={content}
              fileName={fileName}
              height={height}
              embeddedInEditor={embeddedInEditor}
            />
          </Suspense>
        </Wrap>
      );

    case 'diagram':
      return (
        <Wrap>
          <Suspense fallback={<ViewerLoadingFallback />}>
            <LazyDiagramViewer
              content={content}
              fileName={fileName}
              readOnly={readOnly}
              onChange={onChange}
              height={height}
              embeddedInEditor={embeddedInEditor}
            />
          </Suspense>
        </Wrap>
      );

    case 'mindmap':
      return (
        <Wrap>
          <Suspense fallback={<ViewerLoadingFallback />}>
            <LazyMindmapViewer
              content={content}
              fileName={fileName}
              height={height}
              embeddedInEditor={embeddedInEditor}
            />
          </Suspense>
        </Wrap>
      );

    case 'graph':
      return (
        <Wrap>
          <Suspense fallback={<ViewerLoadingFallback />}>
            <LazyGraphViewer
              content={content}
              fileName={fileName}
              height={height}
              embeddedInEditor={embeddedInEditor}
            />
          </Suspense>
        </Wrap>
      );

    case 'notebook':
      return (
        <Wrap>
          <Suspense fallback={<ViewerLoadingFallback />}>
            <LazyNotebookViewer
              content={content ?? ''}
              fileName={fileName}
              height={height}
              embeddedInEditor={embeddedInEditor}
            />
          </Suspense>
        </Wrap>
      );

    case 'pdf':
      if (base64Data) {
        return (
          <Wrap>
            <Suspense fallback={<ViewerLoadingFallback />}>
              <LazyPdfPreview
                base64={base64Data}
                fileName={fileName}
                filePath={filePath}
                embeddedInEditor={embeddedInEditor}
              />
            </Suspense>
          </Wrap>
        );
      }
      return (
        <Wrap>
          <UnsupportedViewer
            fileType={fileType}
            fileName={fileName}
            fileSize={fileSize}
            onDownload={passDownload}
            onOpenExternal={passOpenExternal}
          />
        </Wrap>
      );

    case 'markdown':
      return (
        <Wrap>
          <div className="h-full overflow-auto p-6 bg-background">
            <div className="p-8 max-w-4xl mx-auto">
              <article className={PROSE_CLASSES_MARKDOWN}>
                <ReactMarkdown
                  remarkPlugins={[...remarkPluginsWithMath]}
                  rehypePlugins={[...rehypePluginsMath]}
                >
                  {content ?? ''}
                </ReactMarkdown>
              </article>
            </div>
          </div>
        </Wrap>
      );

    case 'code':
    case 'text':
    case 'json':
      return (
        <Wrap>
          <div className="h-full overflow-auto bg-background p-4">
            <pre
              className="text-sm font-mono text-foreground whitespace-pre-wrap wrap-break-word min-h-0 rounded border border-border/50 bg-muted/20 p-4"
              style={{ fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, monospace' }}
            >
              {content ?? ''}
            </pre>
          </div>
        </Wrap>
      );

    case 'archive':
    case 'binary':
    case 'unknown':
      return (
        <Wrap>
          <UnsupportedViewer
            fileType={fileType}
            fileName={fileName}
            fileSize={fileSize}
            onDownload={passDownload}
            onOpenExternal={passOpenExternal}
          />
        </Wrap>
      );

    default:
      return null;
  }
}

export const UniversalFileViewer = React.memo(UniversalFileViewerInner);
export default UniversalFileViewer;
export { detectFileType };
export type { FileTypeInfo, FileFormat };
