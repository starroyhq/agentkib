import { Tooltip } from "@base-ui/react/tooltip";
import type { ReactElement, ReactNode } from "react";

/** Give an icon action a name and a hint while preserving its trigger semantics and sizing. */
export function IconAction({
  label,
  render,
  children,
}: {
  label: string;
  render: ReactElement;
  children: ReactNode;
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger render={render} aria-label={label}>
        {children}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Positioner side="top" sideOffset={4} className="isolate z-[100]">
          <Tooltip.Popup
            role="tooltip"
            className="w-fit max-w-xs rounded-md border border-border bg-foreground px-2.5 py-1.5 text-xs font-medium text-background shadow-lg"
          >
            {label}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
