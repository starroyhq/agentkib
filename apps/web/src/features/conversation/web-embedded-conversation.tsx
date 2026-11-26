import {
  EmbeddedSessionLoading,
  EmbeddedSessionShell,
  SessionHeaderStatus,
  useEmbeddedEmptySelection,
  useEmbeddedSessionSelection,
  useEmbeddedSessionShell,
  useExternalSessionNavigation,
} from "@agentkib/session-ui";
import { WebHistorySearchTrigger } from "./features/history/web-history-search";
import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useImperativeHandle,
  useState,
  type Ref,
} from "react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useParams,
} from "@tanstack/react-router";
import { PendingCenter, SessionPlatformProvider } from "@agentkib/session-ui";
import type { WebClient } from "@agentkib/web-client";
import type { Locale } from "./i18n";
import { SessionProvider, useSession } from "./web-session-context";
import { SessionReader } from "./features/sessions/web-session-reader";
import { SessionDialogs } from "./web-session-dialogs";
import { sessionCopyForSurface } from "./session-copy";
import { Button } from "./components/ui/button";
import { webLayoutCopy } from "@agentkib/session-ui";
import { useSessionNavigate } from "./web-session-navigation";
import { webSessionPlatform } from "./session-platform";
import { sessionDisplayState } from "./web-session-display";

export type { ConversationClientBridge, WebClient } from "@agentkib/web-client";
export type ConversationPanel = "files" | "actions" | "search";
export interface EmbeddedConversationHandle {
  openPanel: (panel: ConversationPanel) => void;
}
export interface EmbeddedConversationProps {
  controlsRef?: Ref<EmbeddedConversationHandle>;
  client: WebClient;
  sessionId?: string;
  /** Changes only when the host explicitly requests a conversation refresh. */
  refreshRevision?: number;
  locale: Locale;
  onSessionChange: (sessionId?: string) => void;
  onCatalogChange?: () => void;
}
const EmbeddedContext = createContext<
  | (EmbeddedConversationProps & {
      externalNavigation: { current: boolean };
    })
  | null
>(null);
function useEmbedded() {
  const value = useContext(EmbeddedContext);
  if (!value) throw new Error("EmbeddedConversation is missing");
  return value;
}
function EmbeddedRoot() {
  const { client, locale } = useEmbedded();
  return (
    <SessionPlatformProvider platform={webSessionPlatform}>
      <SessionProvider client={client} embedded initialLocale={locale}>
        <EmbeddedShell />
      </SessionProvider>
    </SessionPlatformProvider>
  );
}
function EmbeddedShell() {
  const props = useEmbedded();
  const session = useSession();
  const { refresh: refreshSession, setHistorySearchOpen } = session;
  const navigate = useSessionNavigate();
  const refresh = useCallback(() => {
    void refreshSession(true);
  }, [refreshSession]);
  const panels = useEmbeddedSessionShell({
    sessionId: props.sessionId,
    refreshRevision: props.refreshRevision,
    locale: props.locale,
    onCatalogChange: props.onCatalogChange,
    selected: session.selected,
    sessions: session.sessions,
    setLocale: session.setLocale,
    refresh,
    modal: session.modal,
  });
  const { filesOpen, setFilesOpen, setActionsOpen } = panels;
  useImperativeHandle(
    props.controlsRef,
    () => ({
      openPanel(panel) {
        if (panel === "search") {
          setHistorySearchOpen(true);
          return;
        }
        if (!session.selected) return;
        if (panel === "files" && session.access?.device?.files) setFilesOpen(true);
        if (panel === "actions") setActionsOpen(true);
      },
    }),
    [
      session.selected,
      session.access?.device?.files,
      setActionsOpen,
      setFilesOpen,
      setHistorySearchOpen,
    ],
  );
  const copy = webLayoutCopy[session.locale];
  const status = sessionDisplayState(session, "web");
  return (
    <EmbeddedSessionShell
      panels={{
        ...panels,
        statusOutsideComposer: session.streamReconnecting || (session.error && !session.online),
      }}
    >
      <div
        data-conversation-toolbar
        className="flex shrink-0 items-center justify-end gap-2 border-b px-4 py-2"
      >
        <WebHistorySearchTrigger />
        <PendingCenter
          compact
          session={session}
          copy={sessionCopyForSurface(session.locale, "web")}
          onNavigate={(sessionId) => {
            void navigate({ to: "/sessions/$sessionId", params: { sessionId } });
          }}
        />
        {session.selected && (
          <>
            {!(session.error && status.offline) && (
              <SessionHeaderStatus
                locale={session.locale}
                status={status}
                reconnecting={session.streamReconnecting && !session.error}
              />
            )}
            {session.access?.device?.files && (
              <Button variant="ghost" onClick={() => setFilesOpen(!filesOpen)}>
                {copy.files}
              </Button>
            )}
            <Button variant="ghost" onClick={() => setActionsOpen(true)}>
              {copy.actions}
            </Button>
          </>
        )}
      </div>
      {session.error && (
        <p role="alert" className="px-4 py-2 text-sm text-destructive-text">
          {session.incompatible ? session.t.lanIncompatible : session.t.error}{" "}
          <Button variant="outline" onClick={() => void session.refresh(true)}>
            {session.t.retry}
          </Button>
        </p>
      )}
      {session.catalogNotice && (
        <p role="status" className="px-4 py-2 text-sm text-muted-foreground">
          {session.c.excludedSession}
        </p>
      )}
      <Outlet />
      <SessionDialogs />
    </EmbeddedSessionShell>
  );
}
function EmbeddedReader() {
  const props = useEmbedded();
  const params = useParams({ strict: false }) as { sessionId?: string };
  const session = useSession();
  const { selected, t } = session;
  const navigate = useSessionNavigate();
  const id = params.sessionId;
  const { excluded, readable } = useEmbeddedSessionSelection(props, id, session, navigate);
  if (excluded) return null;

  return id && readable && selected === id ? (
    <SessionReader />
  ) : (
    <EmbeddedSessionLoading label={t.loading} />
  );
}

function EmbeddedEmpty() {
  const props = useEmbedded();
  const { leaveSession, t } = useSession();
  useEmbeddedEmptySelection(props, leaveSession);
  return <p className="p-6 text-sm text-muted-foreground">{t.sessions}</p>;
}
const root = createRootRoute({ component: EmbeddedRoot });
const reader = createRoute({
  getParentRoute: () => root,
  path: "/sessions/$sessionId",
  component: EmbeddedReader,
});
const empty = createRoute({
  getParentRoute: () => root,
  path: "/sessions",
  component: EmbeddedEmpty,
});
const routeTree = root.addChildren([reader, empty]);

/** Full conversation controls, without Web pairing, appearance or catalog chrome. */
export function EmbeddedConversation(props: EmbeddedConversationProps) {
  const externalNavigation = useExternalSessionNavigation(props.sessionId);
  const [router] = useState(() =>
    createRouter({
      routeTree,
      history: createMemoryHistory({
        initialEntries: [
          props.sessionId ? `/sessions/${encodeURIComponent(props.sessionId)}` : "/sessions",
        ],
      }),
    }),
  );
  useEffect(() => {
    const path = props.sessionId ? `/sessions/${encodeURIComponent(props.sessionId)}` : "/sessions";
    if (router.state.location.pathname !== path)
      void router.navigate({ to: path, replace: true } as never);
  }, [props.sessionId, router]);
  return (
    <EmbeddedContext value={{ ...props, externalNavigation }}>
      <RouterProvider router={router} />
    </EmbeddedContext>
  );
}
