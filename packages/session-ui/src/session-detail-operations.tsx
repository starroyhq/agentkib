import { Info, RefreshCw, SlidersHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import type { SessionPlatform } from "./session-platform";

export function SessionDetailOperations({
  open,
  title,
  labels,
  onOpenChange,
  onShowModal,
  onRefresh,
  busy,
  embedded,
  controls,
  extra,
  buttonClassName,
  Button,
  Dialog,
}: {
  open: boolean;
  title: string;
  labels: { details: string; refresh: string; preferences: string; close: string };
  onOpenChange: (open: boolean) => void;
  onShowModal: (modal: "metadata" | "preferences") => void;
  onRefresh: () => void;
  busy: boolean;
  embedded?: boolean;
  controls?: (shortcuts: ReactNode) => ReactNode;
  extra?: ReactNode;
  buttonClassName?: string;
  Button: SessionPlatform["components"]["Button"];
  Dialog: SessionPlatform["components"]["SessionDialog"];
}) {
  const openModal = (modal: "metadata" | "preferences") => {
    onOpenChange(false);
    onShowModal(modal);
  };
  const shortcuts = (
    <>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" className={buttonClassName} onClick={() => openModal("metadata")}>
          <Info aria-hidden="true" />
          {labels.details}
        </Button>
        <Button variant="outline" className={buttonClassName} disabled={busy} onClick={onRefresh}>
          <RefreshCw aria-hidden="true" />
          {labels.refresh}
        </Button>
        {!embedded && (
          <Button
            variant="outline"
            className={buttonClassName}
            onClick={() => openModal("preferences")}
          >
            <SlidersHorizontal aria-hidden="true" />
            {labels.preferences}
          </Button>
        )}
      </div>
      {extra}
    </>
  );
  // Keep the execution controls' receipt reconciliation mounted when the panel closes.
  if (controls) return controls(shortcuts);
  if (!open) return null;
  return (
    <Dialog
      panel
      title={title}
      closeLabel={labels.close}
      onClose={() => onOpenChange(false)}
      bodyClassName="space-y-5 leading-5"
    >
      {shortcuts}
    </Dialog>
  );
}
