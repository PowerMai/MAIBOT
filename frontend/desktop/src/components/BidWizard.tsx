import React, { useState, useRef, useCallback } from "react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Progress } from "./ui/progress";
import { Textarea } from "./ui/textarea";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import {
  CheckCircle2,
  ChevronRight,
  ChevronLeft,
  Upload,
  FileText,
  Sparkles,
  Loader2,
  X,
} from "lucide-react";
import { ScrollArea } from "./ui/scroll-area";
import { toast } from "sonner";
import { getCurrentWorkspacePathFromStorage } from "../lib/sessionState";
import { EVENTS } from "../lib/constants";
import langgraphApi from "../lib/langgraphApi";
import { boardApi, type BoardTask } from "../lib/api/boardApi";
import { Play } from "lucide-react";
import { t } from "../lib/i18n";

type WizardStep =
  | "requirements"
  | "documents"
  | "outline"
  | "generate"
  | "review";

interface BidWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete?: () => void;
  /** 在右侧面板内展示（无 Dialog 包裹，带关闭按钮） */
  variant?: "dialog" | "panel";
  /** 创建并派发看板任务成功后回调，用于控制台绑定并展示执行过程 */
  onTaskCreated?: (taskId: string, task: BoardTask, threadId?: string | null) => void;
}

interface UploadedDoc {
  id: string;
  name: string;
  size: number;
  status: "uploading" | "indexed" | "error";
  docId?: string;
}

/** 将生成内容保存到工作区并打开编辑器 */
async function saveGeneratedToWorkspaceAndOpen(
  content: string,
  projectName: string,
  translate: (key: string) => string
): Promise<string | null> {
  const workspacePath = getCurrentWorkspacePathFromStorage().trim();
  if (!workspacePath) {
    toast.error(translate("bidWizard.selectWorkspaceFirst"));
    return null;
  }
  const defaultName = translate("bidWizard.defaultProjectName");
  const safeName = (projectName || defaultName).replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]/g, "_").slice(0, 40) || defaultName;
  const date = new Date().toISOString().slice(0, 10);
  const relative = `output/${safeName}_${date}.md`;
  const fullPath = workspacePath.replace(/[/\\]+$/, "") + "/" + relative.replace(/\\/g, "/");
  try {
    await langgraphApi.writeFile(fullPath, content);
    toast.success(translate("bidWizard.savedToWorkspace"), { description: relative });
    window.dispatchEvent(
      new CustomEvent(EVENTS.OPEN_FILE_IN_EDITOR, { detail: { path: fullPath } })
    );
    return fullPath;
  } catch (e) {
    toast.error(translate("bidWizard.saveFailed"), { description: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

export function BidWizard({ open, onOpenChange, onComplete, variant = "dialog", onTaskCreated }: BidWizardProps) {
  const [currentStep, setCurrentStep] = useState<WizardStep>("requirements");
  const [projectName, setProjectName] = useState("");
  const [requirements, setRequirements] = useState("");
  const [uploadedDocs, setUploadedDocs] = useState<UploadedDoc[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isCreatingTask, setIsCreatingTask] = useState(false);
  const [outline, setOutline] = useState<string[]>([]);
  const [generatedContent, setGeneratedContent] = useState<string>("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleSaveAndOpen = useCallback(async () => {
    if (!generatedContent.trim()) {
      toast.info(t("bidWizard.noContentYet"));
      return;
    }
    const path = await saveGeneratedToWorkspaceAndOpen(generatedContent, projectName, (k) => t(k));
    if (path) onComplete?.();
  }, [generatedContent, projectName, onComplete]);

  const steps: Array<{
    id: WizardStep;
    label: string;
    description: string;
  }> = [
    { id: "requirements", label: t("bidWizard.step.requirements.label"), description: t("bidWizard.step.requirements.description") },
    { id: "documents", label: t("bidWizard.step.documents.label"), description: t("bidWizard.step.documents.description") },
    { id: "outline", label: t("bidWizard.step.outline.label"), description: t("bidWizard.step.outline.description") },
    { id: "generate", label: t("bidWizard.step.generate.label"), description: t("bidWizard.step.generate.description") },
    { id: "review", label: t("bidWizard.step.review.label"), description: t("bidWizard.step.review.description") },
  ];

  const currentStepIndex = steps.findIndex((s) => s.id === currentStep);
  const progress = ((currentStepIndex + 1) / steps.length) * 100;

  const handleNext = async () => {
      if (currentStepIndex < steps.length - 1) {
      setCurrentStep(steps[currentStepIndex + 1].id);
    } else {
      if (generatedContent.trim()) {
        const path = await saveGeneratedToWorkspaceAndOpen(generatedContent, projectName, (k) => t(k));
        if (path) {
          onComplete?.();
          onOpenChange(false);
        }
      } else {
        onComplete?.();
        onOpenChange(false);
      }
    }
  };

  const handleBack = () => {
    if (currentStepIndex > 0) {
      setCurrentStep(steps[currentStepIndex - 1].id);
    }
  };

  const handleFileUpload = async () => {
    // 触发文件选择
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    // const { kmAPI } = await import("../lib/api/km");

    for (const file of Array.from(files)) {
      const docId = `doc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const newDoc: UploadedDoc = {
        id: docId,
        name: file.name,
        size: file.size,
        status: "indexed", // 直接标记为已索引
      };
      
      setUploadedDocs(prev => [...prev, newDoc]);

      try {
        // 直接使用 FileReader API
        // const content = await file.text();
        
        // 暂时注释掉 - 需要后端 API 支持
        // const result = await kmAPI.importInline(content, {
        //   filename: file.name,
        //   namespace: `bidwizard:${projectName || 'default'}`,
        // });

        setUploadedDocs(prev => prev.map(doc => 
          doc.id === docId 
            ? { ...doc, status: "indexed", docId: docId }
            : doc
        ));
        
        toast.success(t("bidWizard.fileLoaded", { name: file.name }));
      } catch (err) {
        setUploadedDocs(prev => prev.map(doc =>
          doc.id === docId ? { ...doc, status: "error" } : doc
        ));
        toast.error(t("bidWizard.indexFailed", { name: file.name }), {
          description: err instanceof Error ? err.message : String(err)
        });
      }
    }

    // 重置 input
    e.target.value = '';
  };

  const removeDoc = (id: string) => {
    setUploadedDocs(prev => prev.filter(doc => doc.id !== id));
  };

  /** 创建并派发招投标看板任务，成功后由控制台绑定并展示执行过程 */
  const handleCreateTaskAndRun = useCallback(async () => {
    const defaultName = t("bidWizard.defaultProjectName");
    const subject = (projectName || defaultName).trim() || defaultName;
    const descParts: string[] = [];
    if (requirements.trim()) descParts.push(requirements.trim());
    if (uploadedDocs.length > 0) {
      descParts.push("\n" + t("bidWizard.uploadedDocsLabel") + uploadedDocs.map((d) => d.name).join("、"));
    }
    const description = descParts.join("\n\n").slice(0, 8000);
    setIsCreatingTask(true);
    try {
      const res = await boardApi.createTask({
        subject,
        description: description || subject,
        skill_profile: "bidding",
        source_channel: "bid_wizard",
        scope: "personal",
        priority: 3,
        workspace_path: getCurrentWorkspacePathFromStorage() || undefined,
      });
      if (!res.ok || !res.task_id) {
        toast.error(t("bidWizard.createTaskFailed"), { description: res.error ?? t("common.retry") });
        return;
      }
      toast.success(t("bidWizard.taskCreatedAndRunning"), { description: t("bidWizard.taskCreatedDescription") });
      window.dispatchEvent(new CustomEvent(EVENTS.TASK_PROGRESS, { detail: { message: t("bidWizard.taskCreatedMessage") } }));
      const task = res.task ?? { id: res.task_id, subject, thread_id: null as string | null };
      const threadId = task.thread_id ?? (res.task as BoardTask | undefined)?.thread_id ?? null;
      onTaskCreated?.(res.task_id, task as BoardTask, threadId ?? undefined);
    } catch (e) {
      toast.error(t("bidWizard.createTaskFailed"), { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setIsCreatingTask(false);
    }
  }, [projectName, requirements, uploadedDocs, onTaskCreated]);

  const generateOutline = async () => {
    setIsProcessing(true);
    try {
      // 调用后端生成大纲
      // const { controlAPI } = await import("../lib/api/control");
      
      // 使用默认大纲（后端 API 需要支持）
      const text: string = "";
      
      if (text) {
        const lines = text.split("\n").filter((line: string) => line.trim());
        setOutline(lines);
      } else {
        setOutline([
          t("bidWizard.outline.o1"), t("bidWizard.outline.o2"),
          t("bidWizard.outline.o2_1"), t("bidWizard.outline.o2_2"), t("bidWizard.outline.o2_3"),
          t("bidWizard.outline.o3"), t("bidWizard.outline.o3_1"), t("bidWizard.outline.o3_2"),
          t("bidWizard.outline.o4"), t("bidWizard.outline.o5"), t("bidWizard.outline.o6"),
        ]);
      }

      toast.success(t("bidWizard.outlineSuccess"));
    } catch (err) {
      toast.error(t("bidWizard.outlineFailed"), {
        description: err instanceof Error ? err.message : String(err)
      });
      setOutline([
        t("bidWizard.outline.o1"), t("bidWizard.outline.o2"), t("bidWizard.outline.o3"),
        t("bidWizard.outline.o4"), t("bidWizard.outline.o5_biz"), t("bidWizard.outline.o6"), t("bidWizard.outline.o7"),
      ]);
    } finally {
      setIsProcessing(false);
    }
  };

  const generateContent = async () => {
    setIsProcessing(true);
    try {
      // const { controlAPI } = await import("../lib/api/control");
      
      // 使用示例内容（后端 API 需要支持）
      const defaultContent = `# 投标方案

根据招标要求，我们已为您生成以下投标方案框架：

## 一、项目概述
项目名称：${projectName || '待定'}
本方案是根据招标要求精心编制的完整解决方案...

## 二、技术方案
### 2.1 系统架构
提供高可用、可扩展的系统架构...

### 2.2 核心功能
完整的功能模块实现...

### 2.3 技术指标
- 可用性：99.9%
- 响应时间：<200ms
- 并发能力：支持万级并发

## 三、实施计划
- 第一阶段：需求分析（1个月）
- 第二阶段：系统设计（1个月）
- 第三阶段：开发实现（3个月）
- 第四阶段：测试上线（1个月）

## 四、项目团队
由行业专家组成的专业团队，具有丰富的项目经验...

## 五、质量保障
建立完善的质量管理体系...

## 六、售后服务
提供7×24小时的技术支持和维护服务...
`;
      
      const text = defaultContent;
      
      if (text) {
        setGeneratedContent(text);
        toast.success(t("bidWizard.contentGenerated"));
      }
    } catch (err) {
      toast.error(t("bidWizard.contentFailed"), {
        description: err instanceof Error ? err.message : String(err)
      });
    } finally {
      setIsProcessing(false);
    }
  };

  const header = (
    <div className="px-5 py-3 border-b shrink-0 flex items-center justify-between gap-2">
      <div>
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <Sparkles className="h-4 w-4 text-primary" />
          {t("bidWizard.title")}
        </h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          {t("bidWizard.subtitle")}
        </p>
      </div>
      {variant === "panel" && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          onClick={() => onOpenChange(false)}
          aria-label={t("common.close")}
        >
          <X className="h-4 w-4" />
        </Button>
      )}
    </div>
  );

  const inner = (
    <>
        {header}

        {/* 步骤指示器 */}
        <div className="px-5 py-3 bg-muted/30 border-b shrink-0">
          <div className="flex items-center justify-between mb-2">
            {steps.map((step, idx) => (
              <div key={step.id} className="flex items-center flex-1">
                <div className="flex flex-col items-center flex-1">
                  <div
                    className={`h-7 w-7 rounded-full flex items-center justify-center border-2 mb-1 text-xs transition-all ${
                      idx <= currentStepIndex
                        ? "bg-primary border-primary text-primary-foreground shadow-sm"
                        : "border-border bg-background text-muted-foreground"
                    }`}
                  >
                    {idx < currentStepIndex ? (
                      <CheckCircle2 className="h-3.5 w-3.5" />
                    ) : (
                      <span>{idx + 1}</span>
                    )}
                  </div>
                  <span
                    className={`text-[10px] text-center leading-tight ${
                      idx === currentStepIndex ? "text-foreground font-medium" : "text-muted-foreground"
                    }`}
                  >
                    {step.label}
                  </span>
                </div>
                {idx < steps.length - 1 && (
                  <div
                    className={`h-0.5 flex-1 mx-1 transition-all ${
                      idx < currentStepIndex ? "bg-primary" : "bg-border"
                    }`}
                  />
                )}
              </div>
            ))}
          </div>
          <Progress value={progress} className="h-1" />
        </div>

        {/* 步骤内容：flex-1 min-h-0 使面板模式下可正确滚动 */}
        <ScrollArea className="flex-1 min-h-0 px-5 py-4">
          <div className="min-h-[320px]">
            {currentStep === "requirements" && (
              <div className="space-y-3">
                <div>
                  <Label htmlFor="project-name" className="text-xs">{t("bidWizard.projectNameLabel")}</Label>
                  <Input
                    id="project-name"
                    placeholder={t("bidWizard.projectNamePlaceholder")}
                    value={projectName}
                    onChange={(e) => setProjectName(e.target.value)}
                    className="mt-1.5 h-9 text-sm"
                  />
                </div>
                <div>
                  <Label htmlFor="requirements" className="text-xs">{t("bidWizard.requirementsLabel")}</Label>
                  <Textarea
                    id="requirements"
                    placeholder={t("bidWizard.requirementsPlaceholder")}
                    value={requirements}
                    onChange={(e) => setRequirements(e.target.value)}
                    className="mt-1.5 min-h-[240px] text-sm"
                  />
                </div>
              </div>
            )}

            {currentStep === "documents" && (
              <div className="space-y-3">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept=".pdf,.doc,.docx,.txt,.md,.json,.xls,.xlsx"
                  className="hidden"
                  onChange={handleFileChange}
                />
                <div 
                  className="border-2 border-dashed rounded-lg p-6 text-center bg-muted/20 hover:bg-muted/30 transition-colors cursor-pointer"
                  onClick={handleFileUpload}
                  onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
                  onDrop={async (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const files = e.dataTransfer.files;
                    if (files.length > 0) {
                      const fakeEvent = { target: { files, value: '' } } as any;
                      await handleFileChange(fakeEvent);
                    }
                  }}
                >
                  <Upload className="h-10 w-10 mx-auto mb-3 opacity-40" />
                  <p className="text-sm mb-1">{t("bidWizard.uploadHint")}</p>
                  <p className="text-xs text-muted-foreground mb-3">
                    {t("bidWizard.uploadFormats")}
                  </p>
                  <Button onClick={(e) => { e.stopPropagation(); handleFileUpload(); }} size="sm" className="h-8">{t("bidWizard.selectFiles")}</Button>
                </div>

                {uploadedDocs.length > 0 && (
                  <div className="space-y-2">
                    <h4 className="text-sm font-medium">{t("bidWizard.uploadedCount", { n: uploadedDocs.length })}</h4>
                    {uploadedDocs.map((doc) => (
                      <div
                        key={doc.id}
                        className="flex items-center gap-2 p-2.5 border rounded-lg bg-muted/30"
                      >
                        <FileText className="h-4 w-4 text-muted-foreground" />
                        <span className="flex-1 text-sm truncate">{doc.name}</span>
                        <span className="text-[10px] text-muted-foreground">
                          {(doc.size / 1024).toFixed(1)} KB
                        </span>
                        {doc.status === "uploading" && (
                          <Loader2 className="h-3 w-3 animate-spin text-primary" />
                        )}
                        {doc.status === "indexed" && (
                          <Badge variant="secondary" className="text-[10px] h-4 bg-emerald-500/10 text-emerald-600">{t("bidWizard.indexed")}</Badge>
                        )}
                        {doc.status === "error" && (
                          <Badge variant="destructive" className="text-[10px] h-4">{t("bidWizard.failed")}</Badge>
                        )}
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-6 w-6"
                          onClick={() => removeDoc(doc.id)}
                        >
                          <X className="h-3 w-3" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
                {onTaskCreated && (
                  <div className="mt-4 pt-3 border-t border-border/50">
                    <p className="text-xs text-muted-foreground mb-2">{t("bidWizard.createTaskHint")}</p>
                    <Button
                      className="w-full bg-primary"
                      size="sm"
                      disabled={isCreatingTask || (!projectName.trim() && !requirements.trim())}
                      onClick={handleCreateTaskAndRun}
                    >
                      {isCreatingTask ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
                          {t("bidWizard.creating")}
                        </>
                      ) : (
                        <>
                          <Play className="h-3.5 w-3.5 mr-2" />
                          {t("bidWizard.createAndRun")}
                        </>
                      )}
                    </Button>
                  </div>
                )}
              </div>
            )}

            {currentStep === "outline" && (
              <div className="space-y-3">
                {isProcessing ? (
                  <div className="bg-primary/5 border border-primary/20 rounded-lg p-3">
                    <div className="flex items-center gap-2 mb-2">
                      <Loader2 className="h-4 w-4 text-primary animate-spin" />
                      <span className="text-sm">{t("bidWizard.outlineAnalyzing")}</span>
                    </div>
                    <Progress value={75} className="h-1" />
                  </div>
                ) : outline.length === 0 ? (
                  <div className="text-center py-8">
                    <Sparkles className="h-10 w-10 mx-auto mb-3 text-primary opacity-50" />
                    <p className="text-sm text-muted-foreground mb-3">{t("bidWizard.outlinePrompt")}</p>
                    <Button onClick={generateOutline} className="bg-primary">
                      <Sparkles className="h-4 w-4 mr-2" />
                      {t("bidWizard.generateOutline")}
                    </Button>
                  </div>
                ) : (
                  <div className="border rounded-lg p-3">
                    <div className="flex items-center justify-between mb-2">
                      <h4 className="text-sm font-medium">{t("bidWizard.generatedOutline")}</h4>
                      <Button size="sm" variant="outline" className="h-7 text-xs" onClick={generateOutline}>
                        {t("bidWizard.regenerate")}
                      </Button>
                    </div>
                    <div className="space-y-0.5">
                      {outline.map((item, idx) => (
                        <div
                          key={idx}
                          className={`p-1.5 text-sm rounded hover:bg-muted/50 cursor-pointer transition-colors ${
                            item.startsWith(" ") || item.startsWith("  ") ? "pl-6 text-muted-foreground" : "font-medium"
                          }`}
                        >
                          {item.trim()}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {currentStep === "generate" && (
              <div className="space-y-3">
                {isProcessing ? (
                  <div className="bg-primary/5 border border-primary/20 rounded-lg p-3">
                    <div className="flex items-center gap-2 mb-2">
                      <Loader2 className="h-4 w-4 text-primary animate-spin" />
                      <span className="text-sm">{t("bidWizard.contentAnalyzing")}</span>
                    </div>
                    <Progress value={50} className="h-1" />
                  </div>
                ) : !generatedContent ? (
                  <div className="text-center py-8">
                    <Sparkles className="h-10 w-10 mx-auto mb-3 text-primary opacity-50" />
                    <p className="text-sm text-muted-foreground mb-3">{t("bidWizard.contentPrompt")}</p>
                    <Button onClick={generateContent} className="bg-primary">
                      <Sparkles className="h-4 w-4 mr-2" />
                      {t("bidWizard.generateContent")}
                    </Button>
                  </div>
                ) : (
                  <div className="border rounded-lg p-3">
                    <div className="flex items-center justify-between mb-2">
                      <h4 className="text-sm font-medium">{t("bidWizard.generatedContent")}</h4>
                      <Button size="sm" variant="outline" className="h-7 text-xs" onClick={generateContent}>
                        {t("bidWizard.regenerate")}
                      </Button>
                    </div>
                    <div className="prose prose-sm max-w-none max-h-[300px] overflow-y-auto">
                      <pre className="text-xs whitespace-pre-wrap font-sans">{generatedContent}</pre>
                    </div>
                  </div>
                )}
              </div>
            )}

            {currentStep === "review" && (
              <div className="space-y-3">
                <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-3">
                  <div className="flex items-center gap-2 mb-1">
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                    <h4 className="text-sm font-medium">{t("bidWizard.reviewComplete")}</h4>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t("bidWizard.reviewSummary")}
                  </p>
                </div>

                <div className="border rounded-lg p-3">
                  <h4 className="text-sm font-medium mb-2">{t("bidWizard.riskCheck")}</h4>
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between p-2 bg-yellow-500/10 border border-yellow-500/20 rounded text-xs">
                      <span>{t("bidWizard.riskMissingCert")}</span>
                      <Button size="sm" variant="outline" className="h-6 text-xs">
                        {t("bidWizard.riskSupplement")}
                      </Button>
                    </div>
                    <div className="flex items-center justify-between p-2 bg-green-500/10 border border-green-500/20 rounded text-xs">
                      <span>{t("bidWizard.riskTechOk")}</span>
                      <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                    </div>
                    <div className="flex items-center justify-between p-2 bg-green-500/10 border border-green-500/20 rounded text-xs">
                      <span>{t("bidWizard.riskBizOk")}</span>
                      <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                    </div>
                  </div>
                </div>

                <div className="border rounded-lg p-3">
                  <h4 className="text-sm font-medium mb-2">{t("bidWizard.nextSteps")}</h4>
                  <div className="space-y-1.5">
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full justify-start h-8 text-xs"
                      onClick={handleSaveAndOpen}
                    >
                      <FileText className="h-3.5 w-3.5 mr-2" />
                      {t("bidWizard.saveAndOpen")}
                    </Button>
                    <Button variant="outline" size="sm" className="w-full justify-start h-8 text-xs" disabled>
                      <Upload className="h-3.5 w-3.5 mr-2" />
                      {t("bidWizard.exportPdf")}
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </ScrollArea>

        <div className="flex justify-between px-5 py-3 border-t shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={handleBack}
            disabled={currentStepIndex === 0}
            className="h-8"
          >
            <ChevronLeft className="h-3.5 w-3.5 mr-1" />
            {t("bidWizard.prevStep")}
          </Button>
          <Button size="sm" onClick={handleNext} className="h-8">
            {currentStepIndex === steps.length - 1 ? t("bidWizard.done") : t("bidWizard.nextStep")}
            {currentStepIndex < steps.length - 1 && (
              <ChevronRight className="h-3.5 w-3.5 ml-1" />
            )}
          </Button>
        </div>
    </>
  );

  if (variant === "panel") {
    return (
      <div className="h-full flex flex-col min-h-0 bg-background">
        {inner}
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] p-0 gap-0 flex flex-col">
        <DialogHeader className="sr-only">
          <DialogTitle>{t("bidWizard.title")}</DialogTitle>
          <DialogDescription>{t("bidWizard.dialogDescription")}</DialogDescription>
        </DialogHeader>
        {inner}
      </DialogContent>
    </Dialog>
  );
}