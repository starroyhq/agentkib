import { requestReadStateRefresh } from "@agentkib/session-ui";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/dialog";
import { CodexTools } from "./codex-tools";
import { ManagedTasks } from "./managed-tasks";
import { useSession } from "./session-context";
import { webLayoutCopy } from "./web-layout-copy";
export function SessionOperations({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
}) {
  const { t, locale, current, selected, client, setModal, refresh, busy, embedded } = useSession();
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
        onClick={() => {
          requestReadStateRefresh(client, selected);
          void refresh(true);
        }}
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
  if (
    current?.agent !== "codex" &&
    current?.agent !== "claude-code" &&
    current?.agent !== "deepseek-harness"
  )
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
  // Keep the receipt reconciler mounted even after the operations panel closes.
  return (
    <ManagedTasks
      renderContent={(ownership) => (
        <CodexTools
          open={open}
          onOpenChange={onOpenChange}
          showTrigger={false}
          shortcuts={shortcuts}
          ownership={ownership}
        />
      )}
    />
  );
}
