import { useEffect, useState } from "react";
import { useSessionPanels } from "./session-panels";
import { Button } from "@/components/ui/button";
import { Dialog } from "../../components/dialog";
import { CodexTools } from "./codex-tools";
import { ManagedTasks } from "./managed-tasks";
import { useSession } from "./session-context";
import { webLayoutCopy } from "./web-layout-copy";
import { ClaudeBridgePanel } from "./claude-bridge-panel";
export function SessionOperations({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
}) {
  const { t, locale, current, selected, access, setModal, refresh, busy, embedded } = useSession();
  const panels = useSessionPanels();
  const [localTerminalOpen, setLocalTerminalOpen] = useState(false);
  const terminalOpen = panels?.terminalOpen ?? localTerminalOpen;
  const setTerminalOpen = panels?.setTerminalOpen ?? setLocalTerminalOpen;
  const canConnectTerminal =
    current?.agent === "claude-code" &&
    document.documentElement.dataset.platform === "macos" &&
    !!access?.device?.manage;
  useEffect(() => {
    setTerminalOpen(false);
  }, [selected, canConnectTerminal, setTerminalOpen]);
  const shortcuts = (
    <div className="flex flex-wrap gap-2 border-b pb-4">
      <Button
        variant="outline"
        className="min-h-11"
        onClick={() => {
          onOpenChange(false);
          setModal("metadata");
        }}
      >
        {t.details}
      </Button>
      <Button
        variant="outline"
        className="min-h-11"
        disabled={busy}
        onClick={() => void refresh(true)}
      >
        {t.refresh}
      </Button>
      {!embedded && (
        <Button
          variant="outline"
          className="min-h-11"
          onClick={() => {
            onOpenChange(false);
            setModal("preferences");
          }}
        >
          {t.preferences}
        </Button>
      )}
    </div>
  );
  if (current?.agent !== "codex" && current?.agent !== "claude-code")
    return open ? (
      <Dialog
        panel
        title={webLayoutCopy[locale].actions}
        closeLabel={t.close}
        onClose={() => onOpenChange(false)}
      >
        {shortcuts}
      </Dialog>
    ) : null;
  // Old request identities still need settlement after the execution controls disappear.
  return (
    <>
      <ManagedTasks
        active={open}
        onClose={() => onOpenChange(false)}
        renderContent={(pendingOutcome) => (
          <CodexTools
            open={open}
            onOpenChange={onOpenChange}
            showTrigger={false}
            shortcuts={shortcuts}
            ownership={pendingOutcome}
          />
        )}
      />
      {canConnectTerminal && terminalOpen && (
        <ClaudeBridgePanel active onClose={() => setTerminalOpen(false)} />
      )}
    </>
  );
}
