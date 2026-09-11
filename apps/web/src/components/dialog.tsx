import type { ReactNode } from "react";
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
}: {
  title: string;
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <DialogRoot open onOpenChange={(open) => !open && onClose()}>
      <DialogContent showCloseButton={false} className="sm:max-w-xl">
        <DialogHeader className="flex-row items-center justify-between gap-3 pr-8">
          <DialogTitle>{title}</DialogTitle>
          <DialogClose
            className="absolute top-4 right-4 grid size-9 place-items-center rounded-md hover:bg-accent"
            aria-label={closeLabel}
          >
            <span aria-hidden="true">×</span>
          </DialogClose>
        </DialogHeader>
        <div className="dialog-body min-w-0 space-y-4">{children}</div>
      </DialogContent>
    </DialogRoot>
  );
}
