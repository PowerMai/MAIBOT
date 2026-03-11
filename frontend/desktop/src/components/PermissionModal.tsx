import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { RadioGroup, RadioGroupItem } from "./ui/radio-group";
import { Label } from "./ui/label";
import { AlertTriangle, Shield } from "lucide-react";
import { useState } from "react";

interface Permission {
  scope: string;
  purpose: string;
  risk: "low" | "medium" | "high";
}

interface PermissionModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  permissions: Permission[];
  onAllow: (duration: string) => void;
  onDeny: () => void;
}

export function PermissionModal({
  open,
  onOpenChange,
  permissions,
  onAllow,
  onDeny,
}: PermissionModalProps) {
  const [duration, setDuration] = useState("once");

  const getRiskColor = (risk: string) => {
    switch (risk) {
      case "low":
        return "text-green-500";
      case "medium":
        return "text-yellow-500";
      case "high":
        return "text-red-500";
      default:
        return "";
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            权限请求
          </DialogTitle>
          <DialogDescription>
            应用需要以下权限才能继续操作。请仔细阅读用途披露。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {permissions.map((perm, idx) => (
            <div key={idx} className="border rounded-lg p-3">
              <div className="flex items-center justify-between mb-2">
                <code className="bg-muted px-2 py-1 rounded">{perm.scope}</code>
                <Badge
                  variant="outline"
                  className={getRiskColor(perm.risk)}
                >
                  {perm.risk}
                </Badge>
              </div>
              <p className="opacity-70">{perm.purpose}</p>
            </div>
          ))}
        </div>

        <div className="bg-yellow-50 dark:bg-yellow-950/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-3">
          <div className="flex gap-2">
            <AlertTriangle className="h-5 w-5 text-yellow-600 shrink-0" />
            <div>
              <p className="opacity-80">
                Figma Make 不用于收集个人敏感信息或处理机密数据。
              </p>
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <Label>授权时长</Label>
          <RadioGroup value={duration} onValueChange={setDuration}>
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="once" id="once" />
              <Label htmlFor="once">仅此次</Label>
            </div>
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="session" id="session" />
              <Label htmlFor="session">当前会话</Label>
            </div>
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="always" id="always" />
              <Label htmlFor="always">始终允许</Label>
            </div>
          </RadioGroup>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onDeny}>
            拒绝
          </Button>
          <Button onClick={() => onAllow(duration)}>允许</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
