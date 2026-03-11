"use client";

import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";

import { cn } from "./utils";

/** 供聊天区包裹后，其下所有 Tooltip 使用轻量 popover 样式 */
export const TooltipVariantContext = React.createContext<"default" | "popover">("default");

function TooltipProvider({
  delayDuration = 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  );
}

function Tooltip({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

const TooltipTrigger = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Trigger>
>(({ ...props }, ref) => (
  <TooltipPrimitive.Trigger ref={ref} data-slot="tooltip-trigger" {...props} />
));
TooltipTrigger.displayName = "TooltipTrigger";

const TOOLTIP_CONTENT_BASE =
  "animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 w-fit origin-(--radix-tooltip-content-transform-origin) rounded-md px-3 py-1.5 text-xs text-balance";
const TOOLTIP_Z = "z-[var(--z-tooltip)]";

function TooltipContent({
  className,
  sideOffset = 6,
  children,
  variant: variantProp,
  avoidCollisions = true,
  collisionPadding = 8,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content> & {
  variant?: "default" | "popover";
}) {
  const contextVariant = React.useContext(TooltipVariantContext);
  const variant = variantProp ?? contextVariant;
  const isPopover = variant === "popover";
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        data-tooltip-variant={variant}
        sideOffset={sideOffset}
        avoidCollisions={avoidCollisions}
        collisionPadding={collisionPadding}
        className={cn(
          TOOLTIP_CONTENT_BASE,
          TOOLTIP_Z,
          isPopover
            ? "bg-popover text-popover-foreground border border-border shadow-md"
            : "bg-primary text-primary-foreground",
          className,
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow
          className={cn(
            "z-50 size-2.5 translate-y-[calc(-50%-2px)] rotate-45 rounded-[2px]",
            isPopover ? "bg-popover fill-popover" : "bg-primary fill-primary"
          )}
        />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
