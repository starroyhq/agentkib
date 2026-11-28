import * as React from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { cn } from "cn";
import { XIcon } from "lucide-react";
import { Button } from "./button";
import { useUiCloseLabel, useUiSurface, type UiSurface } from "./config";

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
  className,
  surface,
  ...props
}: DialogPrimitive.Backdrop.Props & { surface?: UiSurface }) {
  const resolvedSurface = useUiSurface(surface);
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn(
        resolvedSurface === "web"
          ? "fixed inset-0 z-50 bg-black/50"
          : "fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className,
      )}
      {...props}
    />
  );
}

function DialogContent({
  className,
  overlayClassName,
  children,
  showCloseButton = true,
  closeLabel,
  surface,
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean;
  overlayClassName?: string;
  closeLabel?: string;
  surface?: UiSurface;
}) {
  const resolvedSurface = useUiSurface(surface);
  const resolvedCloseLabel = useUiCloseLabel(closeLabel);
  return (
    <DialogPortal>
      <DialogOverlay className={overlayClassName} surface={resolvedSurface} />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          resolvedSurface === "web"
            ? "fixed top-1/2 left-1/2 z-50 grid max-h-[85dvh] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 grid-cols-1 gap-4 overflow-y-auto rounded-2xl border bg-background p-6 text-foreground shadow-xl outline-none"
            : "fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 grid-cols-1 gap-4 rounded-xl bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none sm:max-w-sm data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton &&
          (resolvedSurface === "web" ? (
            <DialogPrimitive.Close
              data-slot="dialog-close"
              className="absolute top-4 right-4 grid size-9 place-items-center rounded-md hover:bg-accent"
              aria-label={resolvedCloseLabel}
            >
              <XIcon className="size-4" />
            </DialogPrimitive.Close>
          ) : (
            <DialogPrimitive.Close
              data-slot="dialog-close"
              render={
                <Button
                  surface="desktop"
                  variant="ghost"
                  className="absolute top-2 right-2"
                  size="icon-sm"
                />
              }
            >
              <XIcon />
              <span className="sr-only">{resolvedCloseLabel}</span>
            </DialogPrimitive.Close>
          ))}
      </DialogPrimitive.Popup>
    </DialogPortal>
  );
}

function DialogHeader({
  className,
  surface,
  ...props
}: React.ComponentProps<"div"> & { surface?: UiSurface }) {
  const resolvedSurface = useUiSurface(surface);
  return (
    <div
      data-slot="dialog-header"
      className={cn(
        "flex min-w-0 flex-col gap-2",
        resolvedSurface === "web" && "text-left",
        className,
      )}
      {...props}
    />
  );
}

function DialogFooter({
  className,
  showCloseButton = false,
  closeLabel,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean;
  closeLabel?: string;
}) {
  const resolvedCloseLabel = useUiCloseLabel(closeLabel);
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "-mx-4 -mb-4 flex flex-col-reverse gap-2 rounded-b-xl border-t bg-muted/50 p-4 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close render={<Button variant="outline" />}>
          {resolvedCloseLabel}
        </DialogPrimitive.Close>
      )}
    </div>
  );
}

function DialogTitle({
  className,
  surface,
  ...props
}: DialogPrimitive.Title.Props & { surface?: UiSurface }) {
  const resolvedSurface = useUiSurface(surface);
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        resolvedSurface === "web"
          ? "min-w-0 text-lg font-semibold wrap-anywhere"
          : "min-w-0 font-heading text-base leading-snug font-medium wrap-anywhere",
        className,
      )}
      {...props}
    />
  );
}

function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "min-w-0 text-sm wrap-anywhere text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
