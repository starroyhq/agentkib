import { requestReadStateRefresh, SessionDetailOperations } from "@agentkib/session-ui";
import { sessionDetailCapabilities } from "@agentkib/web-client";
import { useEffect, useState } from "react";
import { useSessionPanels } from "./session-panels";
import { Button } from "@/components/ui/button";
import { Dialog } from "../../components/dialog";
import { CodexTools } from "./codex-tools";
import { SessionReceiptRecovery } from "./session-receipt-recovery";
import { useSession } from "./session-context";
import { webLayoutCopy } from "./web-layout-copy";
import { ClaudeBackgroundSetting } from "./claude-background-setting";
import { ProjectAgentPanel } from "./project-agent-panel";
import { ClaudeBridgePanel } from "./claude-bridge-panel";
import { DshBridgePanel } from "./dsh-bridge-panel";
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
          requestReadStateRefresh("desktop-local", selected);
          void refresh(true);
        }}
        extra={
          access?.device?.manage &&
          hasExecutionControls && (
            <>
              {current?.agent === "deepseek-harness" && <DshBridgePanel />}
              {current?.agent === "claude-code" && <ClaudeBackgroundSetting />}
              <ProjectAgentPanel />
            </>
          )
        }
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
        Button={Button}
        Dialog={Dialog}
      />
      {canConnectTerminal && terminalOpen && (
        <ClaudeBridgePanel active onClose={() => setTerminalOpen(false)} />
      )}
    </>
  );
}
