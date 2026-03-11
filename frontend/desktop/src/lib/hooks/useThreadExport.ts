import { useEffect } from "react";
import { toast } from "sonner";
import { getThreadState, validServerThreadIdOrUndefined } from "../api/langserveChat";
import { getCurrentThreadIdFromStorage } from "../sessionState";

export function useThreadExport() {
  useEffect(() => {
    const exportThread = (format: "md" | "json") => {
      const raw = typeof localStorage !== "undefined" ? getCurrentThreadIdFromStorage() : "";
      const threadId = validServerThreadIdOrUndefined(raw);
      if (!threadId) {
        toast.error("导出失败", { description: "当前没有可导出的对话或会话 ID 无效" });
        return;
      }
      getThreadState(threadId)
        .then((state) => {
          const values = state.values as { messages?: Array<{ type?: string; content?: string | Array<{ type?: string; text?: string }> }> };
          const messages = values?.messages ?? [];
          if (format === "json") {
            const payload = { thread_id: threadId, exported_at: new Date().toISOString(), message_count: messages.length, messages };
            const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `对话导出-${threadId.slice(0, 8)}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            toast.success("对话已导出为 JSON");
            return;
          }
          const lines: string[] = ["# 对话导出\n\n"];
          for (const msg of messages) {
            const role = msg.type === "human" ? "User" : "Assistant";
            const text = typeof msg.content === "string"
              ? msg.content
              : Array.isArray(msg.content)
                ? msg.content.map((p) => (p && typeof p === "object" && "text" in p ? (p as { text?: string }).text : "")).filter(Boolean).join("\n")
                : "";
            lines.push(`## ${role}\n\n`, text.trim(), "\n\n");
          }
          const blob = new Blob([lines.join("")], { type: "text/markdown;charset=utf-8" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `对话导出-${threadId.slice(0, 8)}.md`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
          toast.success("对话已导出");
        })
        .catch((err) => {
          toast.error("导出失败", { description: err instanceof Error ? err.message : String(err) });
        });
    };

    const onExportMarkdown = () => exportThread("md");
    const onExportJson = () => exportThread("json");
    window.addEventListener("export_chat", onExportMarkdown);
    window.addEventListener("export_chat_json", onExportJson);
    return () => {
      window.removeEventListener("export_chat", onExportMarkdown);
      window.removeEventListener("export_chat_json", onExportJson);
    };
  }, []);
}
