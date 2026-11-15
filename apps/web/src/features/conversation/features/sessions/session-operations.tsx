import { requestReadStateRefresh } from "@agentkib/session-ui";
import { Info, RefreshCw, SlidersHorizontal } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/dialog";
import { CodexTools } from "./codex-tools";
import { ManagedTasks } from "./managed-tasks";
import { TOUCH_TARGET } from "./operation-layout";
import { ProjectAgentPanel } from "./project-agent-panel";
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
    <div className="flex flex-wrap gap-2">
      <Button
        variant="outline"
        className={TOUCH_TARGET}
        onClick={() => {
          onOpenChange(false);
          setModal("metadata");
        }}
      >
        <Info aria-hidden="true" />
        {t.details}
      </Button>
      <Button
        variant="outline"
        className={TOUCH_TARGET}
        disabled={busy}
        onClick={() => {
          requestReadStateRefresh(client, selected);
          void refresh(true);
        }}
      >
        <RefreshCw aria-hidden="true" />
        {t.refresh}
      </Button>
      {!embedded && (
        <Button
          variant="outline"
          className={TOUCH_TARGET}
          onClick={() => {
            onOpenChange(false);
            setModal("preferences");
          }}
        >
          <SlidersHorizontal aria-hidden="true" />
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
        bodyClassName="space-y-5 leading-5"
      >
        {shortcuts}
      </Dialog>
    ) : null;
  // A Claude Code, Codex or DeepSeek Harness session AgentKib runs or reaches may direct
  // workers as a Project Agent.
  const header =
    current?.agent === "claude-code" ||
    current?.agent === "codex" ||
    current?.agent === "deepseek-harness" ? (
      <>
        {shortcuts}
        <ProjectAgentPanel />
      </>
    ) : (
      shortcuts
    );
  // Keep the receipt reconciler mounted even after the operations panel closes.
  return (
    <ManagedTasks
      renderContent={(ownership) => (
        <CodexTools
          open={open}
          onOpenChange={onOpenChange}
          showTrigger={false}
          shortcuts={header}
          ownership={ownership}
        />
      )}
    />
  );
}
