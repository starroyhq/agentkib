import { useCallback, useRef, type ReactElement } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function SessionDirectoryHoverCard({
  children,
  title,
  details,
  disabled,
}: {
  children: ReactElement;
  title: string;
  details: string;
  disabled?: boolean;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  // Session buttons end before the status slot. Anchor to the whole row so
  // their cards share the same edge as project cards at every font size.
  const anchor = useCallback(
    () => trigger.current?.closest(".session-directory-row") ?? trigger.current,
    [],
  );
  return (
    <Tooltip disabled={disabled}>
      <TooltipTrigger ref={trigger} render={children} delay={500} />
      <TooltipContent
        role="tooltip"
        anchor={anchor}
        side="right"
        align="start"
        sideOffset={8}
        className="w-80 max-w-[calc(100vw-2rem)] select-text rounded-xl bg-popover p-3 text-sm font-normal text-popover-foreground shadow-lg"
      >
        <strong className="block break-words font-semibold">{title}</strong>
        {details && (
          <p className="mt-2 whitespace-pre-line break-words text-xs leading-5 text-muted-foreground">
            {details}
          </p>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
