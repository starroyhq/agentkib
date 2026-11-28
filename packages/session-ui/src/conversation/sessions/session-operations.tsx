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
import { SessionDetailOperations } from "../../session-detail-operations";
import { useSessionPlatform } from "../../session-platform";
import { resolveSessionProvider, sessionProviderControlsDisabled } from "../../session-provider";
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
  onOpenIntegrations,
  onOpenWorkspaces,
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
  onOpenIntegrations?: () => void;
  onOpenWorkspaces?: () => void;
}) {
  const platform = useSessionPlatform();
  const { kind, components } = platform;
  const { t, locale, current, selected, access, capabilities, setModal, embedded } = session;
  const provider = resolveSessionProvider(
    current?.id === selected ? current : undefined,
    capabilities,
  );
  const hasExecutionControls = provider?.operations.execution === true;
  const providerDisabled = sessionProviderControlsDisabled(
    access,
    current?.id === selected ? current.agent : undefined,
    capabilities?.sessionId === selected ? capabilities.reason : undefined,
  );
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
        embedded={embedded}
        onOpenChange={onOpenChange}
        onShowModal={setModal}
        extra={
          <>
            {Settings && (
              <Settings
                key={managementUnavailable ? "read-only" : "owner"}
                locale={locale}
                unavailableReason={managementUnavailable}
              />
            )}
            {provider?.projectAgent?.lead && (kind === "web" || access?.device?.manage) && (
              <ProjectAgentPanel
                key={selected}
                locale={locale}
                selected={selected}
                choose={session.choose}
                formatCatalogTime={session.formatCatalogTime}
                client={projectAgentClient}
                device={access?.device}
                providerDisabled={providerDisabled}
                onConnectTerminal={canOpenTerminal ? () => setTerminalOpen(true) : undefined}
                onOpenIntegrations={onOpenIntegrations}
                onOpenWorkspaces={onOpenWorkspaces}
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
