/**
 * 文件查看器组件导出
 */

export { 
  UniversalFileViewer, 
  detectFileType,
} from './UniversalFileViewer';

export { WebViewer } from './WebViewer';
export type { WebViewerProps } from './WebViewer';
export { DiagramViewer } from './DiagramViewer';
export type { DiagramViewerProps } from './DiagramViewer';
export { MindmapViewer } from './MindmapViewer';
export type { MindmapViewerProps } from './MindmapViewer';
export { GraphViewer } from './GraphViewer';
export type { GraphViewerProps } from './GraphViewer';

export type { 
  FileViewerProps,
  FileTypeInfo, 
  FileFormat 
} from './UniversalFileViewer';

export { UniversalFileViewer as default } from './UniversalFileViewer';
