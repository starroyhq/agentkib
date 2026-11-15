import { XIcon } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
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
            panel && "shrink-0 px-5 pt-5",
          )}
        >
          <div className="min-w-0 space-y-1.5">
            <DialogTitle className="leading-6">{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </div>
          {headerAdornment && <div className="mr-10 shrink-0">{headerAdornment}</div>}
          {/* The same close button as the app's other dialogs. */}
          <DialogClose
            render={<Button variant="ghost" size="icon-sm" />}
            className={cn("absolute", panel ? "top-4 right-4" : "-top-2 -right-2")}
            aria-label={closeLabel}
          >
            <XIcon aria-hidden="true" />
          </DialogClose>
        </DialogHeader>
        <div
          className={cn(
            "dialog-body agentkib-conversation-dialog min-w-0 space-y-4",
            panel && "min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4",
            bodyClassName,
          )}
        >
          {children}
        </div>
        {footer && (
          <div className="shrink-0 border-t bg-muted/30 px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
            {footer}
          </div>
        )}
      </DialogContent>
    </DialogRoot>
  );
}
