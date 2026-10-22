import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "cn";
import {
  Dialog as DialogRoot,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function Dialog({
  title,
  description,
  closeLabel,
  onClose,
  children,
  panel = false,
  footer,
  className,
  bodyClassName,
  headerAdornment,
}: {
  title: string;
  description?: ReactNode;
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
  panel?: boolean;
  footer?: ReactNode;
  className?: string;
  bodyClassName?: string;
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
        if (document.querySelector('[data-slot="dialog-content"]')) return;
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
            "flex max-h-[min(85dvh,760px)] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden rounded-xl p-0 sm:max-w-xl",
          className,
        )}
      >
        <DialogHeader
          className={cn(
            "relative flex-row items-start justify-between gap-3 pr-10",
            panel && "shrink-0 px-6 pt-6",
          )}
        >
          <div className="min-w-0 space-y-1">
            <DialogTitle className="text-lg font-semibold tracking-tight">{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </div>
          {headerAdornment && <div className="mr-10 shrink-0">{headerAdornment}</div>}
          <DialogClose
            className="absolute top-4 right-4 grid size-8 place-items-center rounded-md text-muted-foreground opacity-70 hover:bg-accent hover:text-foreground hover:opacity-100"
            aria-label={closeLabel}
          >
            <span aria-hidden="true" className="text-xl leading-none">
              ×
            </span>
          </DialogClose>
        </DialogHeader>
        <div
          className={cn(
            "dialog-body agentkib-conversation-dialog min-w-0 space-y-4",
            panel && "min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-5",
            bodyClassName,
          )}
        >
          {children}
        </div>
        {footer && (
          <div className="shrink-0 border-t bg-muted/30 px-6 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
            {footer}
          </div>
        )}
      </DialogContent>
    </DialogRoot>
  );
}
