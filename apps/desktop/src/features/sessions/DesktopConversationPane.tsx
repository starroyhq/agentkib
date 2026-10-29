import { isBusyRead } from "./conversation/features/sessions/session-read-retry";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { EmbeddedConversationHandle } from "./conversation/conversation";
import { RefreshCw } from "lucide-react";
import { createDesktopConversationClient } from "@/core/conversation-bridge";
import type { ConversationSessionSummary } from "@/core/types";
import { useI18n } from "@/core/useI18n";
import { useSessionHub } from "./SessionHubContext";
import { refreshConversationCatalog } from "./conversation-catalog";
import { useSessionViewStore } from "./session-view-store";
import { cn } from "cn";
import { subscribeConversationPanel } from "./conversation-panel-commands";

const EmbeddedConversation = lazy(() =>
  import("./conversation/conversation").then((module) => ({
    default: module.EmbeddedConversation,
  })),
);

export function DesktopConversationPane({
  sessionId,
  create = false,
}: {
  sessionId?: string;
  create?: boolean;
}) {
  const { locale, tr, localizeMessage } = useI18n();
  const { select, selected, sessions, selectionVersion, conversationRefreshRevision } =
    useSessionHub();
  const [client] = useState(createDesktopConversationClient);
  const [catalogError, setCatalogError] = useState("");
  const navigation = useRef(0);
  const pendingNavigation = useRef<{ id: string; request: number; intent: number } | undefined>(
    undefined,
  );
  const controlsRef = useRef<EmbeddedConversationHandle>(null);
  const requestedPanel = useSessionViewStore((state) => state.requestedPanel);
  const showExecution = useSessionViewStore((state) => state.execution);
  const initialPanel =
    requestedPanel &&
    (requestedPanel.sessionId === sessionId ||
      (selected?.id === sessionId &&
        selected?.indexedSessionIds?.includes(requestedPanel.sessionId)))
      ? requestedPanel
      : undefined;
  const onInitialPanelConsumed = useCallback(() => {
    if (initialPanel) useSessionViewStore.getState().consumePanel(initialPanel);
  }, [initialPanel]);
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => subscribeConversationPanel((panel) => controlsRef.current?.openPanel(panel)), []);
  useEffect(
    () => () => {
      navigation.current += 1;
      pendingNavigation.current = undefined;
    },
    [sessionId],
  );
  const onCreateClosed = useCallback(() => {
    navigation.current += 1;
    pendingNavigation.current = undefined;
    useSessionViewStore.getState().setCreatingConversation(false);
  }, []);
  const completeNavigation = useCallback(
    (catalog: ConversationSessionSummary[]) => {
      const pending = pendingNavigation.current;
      if (!pending) return;
      if (pending.request !== navigation.current || pending.intent !== selectionVersion()) {
        pendingNavigation.current = undefined;
        return;
      }
      const session = catalog.find((item) => item.id === pending.id);
      if (!session) return;
      pendingNavigation.current = undefined;
      useSessionViewStore.getState().revealSession(session);
      select(pending.id);
      setCatalogError("");
    },
    [select, selectionVersion],
  );
  // A busy one-off read can settle through the shared catalog observation later.
  // Keep its navigation intent until that verified catalog contains the child.
  useEffect(() => completeNavigation(sessions), [sessions, completeNavigation]);
  const onCatalogChange = useCallback(() => {
    const request = navigation.current;
    const intent = selectionVersion();
    void refreshConversationCatalog().then(
      (catalog) => {
        if (request !== navigation.current || intent !== selectionVersion()) return;
        completeNavigation(catalog);
        setCatalogError("");
      },
      (error: unknown) => {
        if (request === navigation.current && intent === selectionVersion() && !isBusyRead(error))
          setCatalogError(localizeMessage(error));
      },
    );
  }, [completeNavigation, selectionVersion, localizeMessage]);
  const onSessionChange = useCallback(
    async (id?: string) => {
      const request = ++navigation.current;
      const intent = selectionVersion();
      pendingNavigation.current = id ? { id, request, intent } : undefined;
      if (!id) {
        useSessionViewStore.getState().setCreatingConversation(false);
        select();
        setCatalogError("");
        return;
      }
      try {
        const sessions = await refreshConversationCatalog();
        if (request !== navigation.current || intent !== selectionVersion()) return;
        completeNavigation(sessions);
        setCatalogError("");
      } catch (error) {
        // Creation/fork has already succeeded. Keep its conversation mounted and
        // report catalog refresh separately instead of offering to repeat creation.
        if (request === navigation.current && intent === selectionVersion() && !isBusyRead(error))
          setCatalogError(localizeMessage(error));
      }
    },
    [select, completeNavigation, selectionVersion, localizeMessage],
  );
  return (
    <div
      ref={containerRef}
      className={cn(
        "desktop-conversation flex min-h-0 flex-1 flex-col",
        "[&_.agentkib-conversation_.reader-scroll]:px-4",
        '[&_.agentkib-conversation_[data-message-role="user"]]:px-1',
        '[&_.agentkib-conversation_[data-message-role="assistant"]]:px-1',
      )}
    >
      {catalogError && (
        <p role="status" className="px-4 py-2 text-sm text-muted-foreground">
          {tr("sessions.conversationCatalogError")} {catalogError}
        </p>
      )}
      <Suspense
        fallback={
          <div
            className="session-state flex min-w-0 flex-1 flex-col items-center justify-center gap-4 p-8 text-center"
            role="status"
          >
            <RefreshCw className="animate-spin" size={24} />
            <p className="max-w-[520px] leading-[1.7] text-muted-foreground">
              {tr("sessions.loading")}
            </p>
          </div>
        }
      >
        <EmbeddedConversation
          controlsRef={controlsRef}
          initialPanel={initialPanel?.panel}
          onInitialPanelConsumed={onInitialPanelConsumed}
          client={client}
          sessionId={sessionId}
          create={create}
          refreshRevision={conversationRefreshRevision}
          locale={locale}
          showExecution={showExecution}
          onSessionChange={onSessionChange}
          onCatalogChange={onCatalogChange}
          onCreateClosed={onCreateClosed}
        />
      </Suspense>
    </div>
  );
}
