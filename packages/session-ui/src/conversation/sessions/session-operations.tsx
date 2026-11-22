import {
  sessionDetailCapabilities,
  type Access,
  type ConversationSessionSummary,
  type WebClient,
} from "@agentkib/web-client";
import type { ComponentProps, ComponentType, ReactNode } from "react";
import type { InteractionLocale } from "../../interaction-model";
import { requestReadStateRefresh } from "../../read-state";
import { SessionDetailOperations } from "../../session-detail-operations";
import { useSessionPlatform } from "../../session-platform";
import { ProjectAgentPanel, type ProjectAgentPanelClient } from "./project-agent-panel";
import { webLayoutCopy } from "./web-layout-copy";

export function SessionOperations({
  open,
  onOpenChange,
  session,
  projectAgentClient,
  hostPanels,
  ExecutionControls,
  ReceiptRecovery,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  session: Pick<
    ComponentProps<typeof ProjectAgentPanel>,
    "selected" | "choose" | "formatCatalogTime"
  > & {
    locale: InteractionLocale;
    t: ComponentProps<typeof SessionDetailOperations>["labels"];
    current?: Pick<ConversationSessionSummary, "agent">;
    access?: Access;
    client: WebClient;
    busy: boolean;
    embedded?: boolean;
    setModal: ComponentProps<typeof SessionDetailOperations>["onShowModal"];
    refresh(manual: boolean): Promise<void>;
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
  ReceiptRecovery: ComponentType<{ renderContent: (content: ReactNode) => ReactNode }>;
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
              <ReceiptRecovery
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
