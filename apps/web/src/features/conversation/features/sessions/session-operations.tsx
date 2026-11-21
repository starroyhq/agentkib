import { requestReadStateRefresh, SessionDetailOperations } from "@agentkib/session-ui";
import { sessionDetailCapabilities } from "@agentkib/web-client";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/dialog";
import { CodexTools } from "./codex-tools";
import { SessionReceiptRecovery } from "./session-receipt-recovery";
import { TOUCH_TARGET } from "./operation-layout";
import { ProjectAgentPanel } from "./project-agent-panel";
import { useSession } from "./session-context";
import { webLayoutCopy } from "@agentkib/session-ui";
export function SessionOperations({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
}) {
  const { t, locale, current, selected, client, setModal, refresh, busy, embedded } = useSession();
  const hasExecutionControls = sessionDetailCapabilities(current?.agent).operations.execution;
  return (
    <>
      <SessionDetailOperations
        open={open}
        title={webLayoutCopy[locale].actions}
        labels={t}
        busy={busy}
        embedded={embedded}
        onOpenChange={onOpenChange}
        onShowModal={setModal}
        onRefresh={() => {
          requestReadStateRefresh(client, selected);
          void refresh(true);
        }}
        extra={hasExecutionControls && <ProjectAgentPanel />}
        controls={
          hasExecutionControls
            ? (shortcuts) => (
                <SessionReceiptRecovery
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
              )
            : undefined
        }
        buttonClassName={TOUCH_TARGET}
        Button={Button}
        Dialog={Dialog}
      />
    </>
  );
}
