import { sessionDetailCapabilities } from "@agentkib/web-client";
import type { ComponentProps, ComponentType, ReactNode } from "react";
import { requestReadStateRefresh } from "../../read-state";
import { SessionDetailOperations } from "../../session-detail-operations";
import { useSessionPlatform } from "../../session-platform";
import { ProjectAgentPanel, type ProjectAgentPanelClient } from "./project-agent-panel";
import {
  SessionReceiptRecovery,
  type SessionReceiptRecoveryProps,
} from "./session-receipt-recovery";
import { webLayoutCopy } from "./web-layout-copy";

export function SessionOperations({
  open,
  onOpenChange,
  session,
  projectAgentClient,
  hostPanels,
  ExecutionControls,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  session: SessionReceiptRecoveryProps["session"] &
    Pick<ComponentProps<typeof ProjectAgentPanel>, "choose" | "formatCatalogTime"> & {
      t: ComponentProps<typeof SessionDetailOperations>["labels"];
      embedded?: boolean;
      setModal: ComponentProps<typeof SessionDetailOperations>["onShowModal"];
    };
  projectAgentClient: ProjectAgentPanelClient;
  hostPanels?: ReactNode;
  ExecutionControls: ComponentType<{
    open: boolean;
    onOpenChange: (open: boolean) => void;
    showTrigger: boolean;
    shortcuts: ReactNode;
    ownership: ReactNode;
  }>;
}) {
  const { kind, components, readScope } = useSessionPlatform();
  const { t, locale, current, selected, client, access, setModal, refresh, busy, embedded } =
    session;
  const hasExecutionControls = sessionDetailCapabilities(current?.agent).operations.execution;
  return (
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
        hasExecutionControls &&
        (kind === "web" || access?.device?.manage) && (
          <>
            {hostPanels}
            <ProjectAgentPanel
              locale={locale}
              selected={selected}
              choose={session.choose}
              formatCatalogTime={session.formatCatalogTime}
              client={projectAgentClient}
              device={access?.device}
            />
          </>
        )
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
  );
}
