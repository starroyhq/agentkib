import type { RefObject } from "react";
import { Dialog as SheetPrimitive } from "@base-ui/react/dialog";
import { cn } from "cn";

const Sheet = SheetPrimitive.Root;
const SheetClose = SheetPrimitive.Close;
const SheetTitle = SheetPrimitive.Title;

function SheetContent({
  className,
  children,
  container,
  docked = false,
  ...props
}: SheetPrimitive.Popup.Props & {
  container?: HTMLElement | RefObject<HTMLElement | null> | null;
  docked?: boolean;
}) {
  return (
    <SheetPrimitive.Portal container={container} className="contents">
      {!docked && (
        <SheetPrimitive.Backdrop
          data-slot="sheet-overlay"
          className="fixed inset-0 z-50 bg-black/20 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none"
        />
      )}
      <SheetPrimitive.Popup
        data-slot="sheet-content"
        data-side="right"
        className={cn(
          "flex min-h-0 min-w-0 flex-col bg-background text-foreground outline-none",
          docked
            ? "relative h-full w-full"
            : "fixed inset-y-0 right-0 z-50 h-dvh w-[min(100%,420px)] border-l shadow-xl transition-transform duration-200 data-ending-style:translate-x-full data-starting-style:translate-x-full motion-reduce:transition-none",
          className,
        )}
        {...props}
      >
        {children}
      </SheetPrimitive.Popup>
    </SheetPrimitive.Portal>
  );
}

export { Sheet, SheetClose, SheetContent, SheetTitle };
