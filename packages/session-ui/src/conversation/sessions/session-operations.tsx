import {
  useEffect,
  useState,
  type ComponentProps,
  type ComponentType,
  type ReactNode,
} from "react";
import {
  connectionManagementUnavailableReason,
  sessionConnectionPanels,
  type SessionTerminalPanelProps,
} from "../../agents/session-connection-panels";
import { requestReadStateRefresh } from "../../read-state";
import { SessionDetailOperations } from "../../session-detail-operations";
import { useSessionPlatform } from "../../session-platform";
import { resolveSessionProvider } from "../../session-provider";
import { ProjectAgentPanel, type ProjectAgentPanelClient } from "./project-agent-panel";
import {
  SessionReceiptRecovery,
  type SessionReceiptRecoveryProps,
} from "./session-receipt-recovery";
import { useSessionPanels } from "./session-panels";
import { webLayoutCopy } from "./web-layout-copy";

export function SessionOperations({
  open,
  onOpenChange,
  session,
  projectAgentClient,
  ExecutionControls,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  session: SessionReceiptRecoveryProps["session"] &
    SessionTerminalPanelProps["session"] &
    Pick<ComponentProps<typeof ProjectAgentPanel>, "choose" | "formatCatalogTime"> & {
      t: ComponentProps<typeof SessionDetailOperations>["labels"];
      embedded?: boolean;
      setModal: ComponentProps<typeof SessionDetailOperations>["onShowModal"];
    };
  projectAgentClient: ProjectAgentPanelClient;
  ExecutionControls: ComponentType<{
    open: boolean;
    onOpenChange: (open: boolean) => void;
    showTrigger: boolean;
    shortcuts: ReactNode;
    ownership: ReactNode;
  }>;
}) {
  const platform = useSessionPlatform();
  const { kind, components, readScope } = platform;
  const {
    t,
    locale,
    current,
    selected,
    client,
    access,
    capabilities,
    setModal,
    refresh,
    busy,
    embedded,
  } = session;
  const provider = resolveSessionProvider(
    current?.id === selected ? current : undefined,
    capabilities,
  );
  const hasExecutionControls = provider?.operations.execution === true;
  const hasProjectAgentControl = provider?.operations.projectAgent === true;
  const connection = sessionConnectionPanels(provider?.connection?.kind, platform);
  const Settings = connection?.Settings;
  const Terminal = connection?.terminal?.Panel;
  const managementUnavailable = connectionManagementUnavailableReason(access, locale);
  const panels = useSessionPanels();
  const [localTerminalOpen, setLocalTerminalOpen] = useState(false);
  const terminalOpen = panels?.terminalOpen ?? localTerminalOpen;
  const setTerminalOpen = panels?.setTerminalOpen ?? setLocalTerminalOpen;
  const canOpenTerminal = !!Terminal && !managementUnavailable;
  useEffect(() => {
    setTerminalOpen(false);
  }, [selected, canOpenTerminal, setTerminalOpen]);

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
          requestReadStateRefresh(readScope.refreshContext(client), selected);
          void refresh(true);
        }}
        extra={
          <>
            {Settings && (
              <Settings
                key={managementUnavailable ? "read-only" : "owner"}
                locale={locale}
                unavailableReason={managementUnavailable}
              />
            )}
            {(hasExecutionControls || hasProjectAgentControl) &&
              (kind === "web" || access?.device?.manage) && (
                <ProjectAgentPanel
                  key={selected}
                  locale={locale}
                  selected={selected}
                  choose={session.choose}
                  formatCatalogTime={session.formatCatalogTime}
                  client={projectAgentClient}
                  device={access?.device}
                  showDesignation={hasProjectAgentControl}
                />
              )}
          </>
        }
        controls={
          hasExecutionControls
            ? (shortcuts) => (
                <SessionReceiptRecovery
                  session={session}
                  renderContent={(ownership) => (
                    <ExecutionControls
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
        buttonClassName={components.touchTargetClassName}
        Button={components.Button}
        Dialog={components.SessionDialog}
      />
      {Terminal && canOpenTerminal && terminalOpen && (
        <Terminal session={session} active onClose={() => setTerminalOpen(false)} />
      )}
    </>
  );
}
