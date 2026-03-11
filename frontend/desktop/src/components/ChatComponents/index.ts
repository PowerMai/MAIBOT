/**
 * ChatComponents - LangChain官方生成式UI组件包
 * 
 * 统一导出所有assistant-ui标准组件，严格遵循LangChain规范
 * 完全使用官方库实现，零自定义重复代码
 */

// Runtime提供者 - 整个聊天系统的核心
export { MyRuntimeProvider } from "./MyRuntimeProvider";

// 主聊天线程组件 - 消息显示和输入
export { Thread } from "./thread";

// 线程列表 - 历史对话管理
export { ThreadList } from "./thread-list";

// 文本渲染 - Markdown和代码支持
export { MarkdownText } from "./markdown-text";

// 附件处理 - 图片和文件支持
export { 
  ComposerAddAttachment, 
  ComposerAttachments, 
  UserMessageAttachments 
} from "./attachment";

// 工具调用显示 - 工具执行结果渲染
export { ToolFallback } from "./tool-fallback";

// UI工具 - 图标按钮和提示
export { TooltipIconButton } from "./tooltip-icon-button";

// 生成式UI - 仅一套实现、多场景复用：消息 Part 用 GenerativeUIMessagePart，工具结果/任务详情/视觉分析等直接使用 GenerativeUI
export {
  GenerativeUI,
  GenerativeUIMessagePart,
  TableUI,
  CodeUI,
  MarkdownUI,
  StepsUI,
  EvidenceUI,
  DocumentUI,
  ImageUI,
  ChartUI,
  MetricsUI,
} from "./generative-ui";

/**
 * 使用示例：
 * 
 * import { MyRuntimeProvider, Thread } from "./ChatComponents";
 * 
 * <MyRuntimeProvider>
 *   <div className="flex h-full flex-col">
 *     <Thread />
 *   </div>
 * </MyRuntimeProvider>
 * 
 * 注意：
 * - MyRuntimeProvider必须是最外层
 * - Thread处理所有消息显示和输入
 * - 所有生成式UI由assistant-ui自动处理
 * - 不需要自己处理消息流或UI渲染
 */

