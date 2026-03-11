import React from "react";
import { ChevronDownIcon } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { cn } from "../ui/utils";

export interface PluginSelectorItem {
  id: string;
  label: string;
  description?: string;
  tier?: string;
}

type PluginSelectorProps = {
  items: PluginSelectorItem[];
  activeId: string;
  onChange: (id: string) => void;
  title?: string;
};

function getRoleTheme(roleId: string) {
  const palette = [
    "text-indigo-600 dark:text-indigo-400",
    "text-teal-600 dark:text-teal-400",
    "text-rose-600 dark:text-rose-400",
    "text-cyan-600 dark:text-cyan-400",
    "text-slate-600 dark:text-slate-400",
  ];
  if (!roleId) return "text-muted-foreground";
  let hash = 0;
  for (let i = 0; i < roleId.length; i++) hash = (hash * 31 + roleId.charCodeAt(i)) >>> 0;
  return palette[hash % palette.length] ?? "text-muted-foreground";
}

export const PluginSelector: React.FC<PluginSelectorProps> = ({
  items,
  activeId,
  onChange,
  title,
}) => {
  const active = items.find((r) => r.id === activeId);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="h-7 min-h-7 px-2 text-[12px] rounded-md hover:bg-muted/80 flex items-center gap-1.5 text-muted-foreground/80 min-w-0 max-w-28 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
          title={title || active?.description || "选择插件"}
          aria-label={`插件：${active?.label ?? "未启用"}`}
        >
          <span className={cn("size-1.5 rounded-full shrink-0", getRoleTheme(activeId).replace("text-", "bg-").replace(" dark:", ""))} aria-hidden />
          <span className={cn("font-medium truncate", getRoleTheme(activeId))}>{active?.label ?? "未启用插件"}</span>
          <ChevronDownIcon className="size-3 text-muted-foreground/60 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        {items.map((r) => (
          <DropdownMenuItem
            key={r.id}
            onClick={() => onChange(r.id)}
            className="text-[12px] py-1.5 gap-2 flex flex-col items-stretch"
            title={r.description ? `${r.label} - ${r.description}` : r.label}
          >
            <div className="flex items-center gap-2 min-w-0">
              <span className={cn("size-1.5 rounded-full shrink-0", getRoleTheme(r.id).replace("text-", "bg-").replace(" dark:", ""))} aria-hidden />
              <span className="flex-1 min-w-0 font-medium truncate">{r.label}</span>
              {activeId === r.id && <span className={cn("shrink-0", getRoleTheme(r.id))}>✓</span>}
            </div>
            {r.description ? <div className="text-[10px] text-muted-foreground pl-3.5 line-clamp-2">{r.description}</div> : null}
            {r.tier ? <div className="pl-3.5 text-[10px] text-muted-foreground">需要版本：{r.tier}</div> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

// 向后兼容旧命名，避免存量引用报错。
export const RoleSelector = PluginSelector;
