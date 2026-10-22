import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "../lib/utils";
import {
  Dialog as DialogRoot,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

export function Dialog({
  title,
  closeLabel,
  onClose,
  children,
  panel = false,
  footer,
  className,
  bodyClassName,
  description,
  headerAdornment,
}: {
  title: string;
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
  panel?: boolean;
  footer?: ReactNode;
  className?: string;
  bodyClassName?: string;
  description?: string;
  headerAdornment?: ReactNode;
}) {
  const returnFocus = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  useEffect(() => {
    return () => {
      const target = returnFocus.current;
      queueMicrotask(() => {
        // A shortcut may replace this dialog with another. Do not steal its focus.
        if (document.querySelector('[role="dialog"]')) return;
        const fallback = document.querySelector<HTMLElement>('[data-dialog-return-focus="true"]');
        if (target?.isConnected) target.focus();
        else fallback?.focus();
      });
    };
  }, []);
  return (
    <DialogRoot open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        className={cn(
          !panel && "sm:max-w-xl",
          panel &&
            "top-0 left-0 flex h-dvh max-h-dvh w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none p-0 md:top-1/2 md:left-1/2 md:h-auto md:max-h-[85dvh] md:max-w-xl md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-2xl",
          className,
        )}
      >
        <DialogHeader
          className={cn(
            "flex-row items-center justify-between gap-3 pr-8",
            panel && "relative shrink-0 border-b p-4 pr-16",
          )}
        >
          <DialogTitle>{title}</DialogTitle>
          {headerAdornment && <div className="mr-10 shrink-0">{headerAdornment}</div>}
          <DialogClose
            className="absolute top-4 right-4 grid size-11 place-items-center rounded-md hover:bg-accent"
            aria-label={closeLabel}
          >
            <span aria-hidden="true">×</span>
          </DialogClose>
        </DialogHeader>
        {description && <p className="px-4 pt-1 text-xs text-muted-foreground">{description}</p>}
        <div
          className={cn(
            "dialog-body agentkib-conversation-dialog min-w-0 space-y-4",
            panel && "min-h-0 flex-1 overflow-y-auto overscroll-contain p-4",
            bodyClassName,
          )}
        >
          {children}
        </div>
        {footer && (
          <div className="shrink-0 border-t bg-background p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
            {footer}
          </div>
        )}
      </DialogContent>
    </DialogRoot>
  );
}
