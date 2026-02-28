"use client"

import * as React from "react"
import * as ResizablePrimitive from "react-resizable-panels"

import { cn } from "@/lib/utils"

function ResizablePanelGroup({
  className,
  ...props
}) {
  return (
    <ResizablePrimitive.PanelGroup
      data-slot="resizable-panel-group"
      className={cn(
        "flex h-full w-full data-[panel-group-direction=vertical]:flex-col",
        className
      )}
      {...props} />
  );
}

const ResizablePanel = React.forwardRef(function ResizablePanel(props, ref) {
  return <ResizablePrimitive.Panel ref={ref} data-slot="resizable-panel" {...props} />;
});

// Simplified splitter - no pill handle, just 1px line with cursor affordance
function ResizableHandle({
  withHandle,
  className,
  ...props
}) {
  return (
    <ResizablePrimitive.PanelResizeHandle
      data-slot="resizable-handle"
      className={cn(
        "relative flex items-center justify-center bg-[#27272a] transition-colors hover:bg-[#3b82f6] focus-visible:ring-1 focus-visible:ring-[#3b82f6] focus-visible:outline-hidden",
        "w-px data-[panel-group-direction=vertical]:h-px data-[panel-group-direction=vertical]:w-full",
        "after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2",
        "data-[panel-group-direction=vertical]:after:left-0 data-[panel-group-direction=vertical]:after:h-1 data-[panel-group-direction=vertical]:after:w-full data-[panel-group-direction=vertical]:after:translate-x-0 data-[panel-group-direction=vertical]:after:-translate-y-1/2",
        className
      )}
      {...props}
    />
  );
}

export { ResizablePanelGroup, ResizablePanel, ResizableHandle }
