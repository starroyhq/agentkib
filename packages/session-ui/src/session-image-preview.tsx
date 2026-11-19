import { useEffect, useRef } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";

export function SessionImagePreview({
  src,
  name,
  closeLabel,
  onClose,
}: {
  src: string;
  name: string;
  closeLabel: string;
  onClose: () => void;
}) {
  const close = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  useEffect(() => {
    const target = returnFocus.current;
    return () => {
      queueMicrotask(() => {
        if (document.querySelector('[data-slot="dialog-content"][data-open]')) return;
        if (target?.isConnected) target.focus();
      });
    };
  }, []);
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[100] bg-black/85" />
        <Dialog.Popup
          data-slot="dialog-content"
          aria-modal="true"
          initialFocus={close}
          finalFocus={returnFocus}
          className="fixed inset-0 z-[101] flex h-dvh w-screen items-center justify-center bg-transparent outline-none [-webkit-app-region:no-drag]"
          onClick={(event) => {
            if (event.target === event.currentTarget) onClose();
          }}
        >
          <Dialog.Title className="sr-only">{name}</Dialog.Title>
          <img
            src={src}
            alt={name}
            draggable={false}
            className="block max-h-dvh max-w-full object-contain"
          />
          <Dialog.Close
            ref={close}
            aria-label={closeLabel}
            className="fixed top-[max(1rem,env(safe-area-inset-top))] right-[max(1rem,env(safe-area-inset-right))] grid size-11 place-items-center rounded-full bg-black/50 text-white transition-colors hover:bg-black/75 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          >
            <X aria-hidden="true" className="size-6" />
          </Dialog.Close>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
