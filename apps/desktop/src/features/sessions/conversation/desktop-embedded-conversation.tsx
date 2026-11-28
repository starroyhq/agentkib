import {
  EmbeddedSessionLoading,
  EmbeddedSessionShell,
  useEmbeddedEmptySelection,
  useEmbeddedSessionSelection,
  useEmbeddedSessionShell,
  useExternalSessionNavigation,
} from "@agentkib/session-ui";
import { MAX_MESSAGE_LENGTH } from "@agentkib/conversation-state";
import {
  ComposerPrimaryAction,
  PendingCenter,
  requestReadStateRefresh,
  sessionContinuationCopy,
  sessionContinuationRegistration,
  SessionComposerInput,
  SessionComposerToolbar,
  SessionDetail,
  SessionPlatformProvider,
} from "@agentkib/session-ui";
import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
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
import type { ConversationCatalog, WebClient } from "@agentkib/web-client";
import type { SupportedLocale as Locale } from "@/core/types";
import { SessionProvider, useSession } from "./desktop-session-context";
import { SessionReader } from "./features/sessions/desktop-session-reader";
import { SessionDialogs } from "./desktop-session-dialogs";
import { Button } from "@agentkib/ui/button";
import { useSessionNavigate } from "./desktop-session-navigation";
import { ConversationWindowTools } from "../conversation-window-tools";
import {
  useConversationDisplayLive,
  useConversationDraft,
  useDesktopConversationWindow,
} from "../DesktopConversationWindow";
import { desktopReadScope } from "../read-state-scope";
import {
  connectionManagementUnavailableReason,
  resolveSessionProvider,
  sessionConnectionPanels,
  useSessionPlatform,
  webLayoutCopy,
} from "@agentkib/session-ui";
import { sessionCopy } from "./session-copy";
import { useDesktopSessionPlatform } from "./session-platform";

export type { ConversationClientBridge, WebClient } from "@agentkib/web-client";
export type ConversationPanel = "files" | "actions" | "search" | "terminal";
export interface EmbeddedConversationHandle {
  openPanel: (panel: ConversationPanel) => void;
}
export interface EmbeddedConversationProps {
  controlsRef?: Ref<EmbeddedConversationHandle>;
  initialPanel?: ConversationPanel;
  onInitialPanelConsumed?: () => void;
  client: WebClient;
  sessionId?: string;
  readInitialCatalog?: (sessionId: string) => ConversationCatalog | undefined;
  observeCatalog?: (receive: (catalog: ConversationCatalog) => void) => () => void;
  /** Changes only when the host explicitly requests a conversation refresh. */
  refreshRevision?: number;
  locale: Locale;
  /** Also open program-started sessions, as the directory option allows. */
  showExecution?: boolean;
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
  const { client, locale, sessionId, showExecution, readInitialCatalog, observeCatalog } =
    useEmbedded();
  const platform = useDesktopSessionPlatform(client);
  return (
    <SessionPlatformProvider platform={platform}>
      <SessionProvider
        client={client}
        embedded
        initialLocale={locale}
        initialSessionId={sessionId}
        readInitialCatalog={readInitialCatalog}
        observeCatalog={observeCatalog}
        showExecution={showExecution}
      >
        <EmbeddedShell />
      </SessionProvider>
    </SessionPlatformProvider>
  );
}
function EmbeddedShell() {
  const props = useEmbedded();
  const session = useSession();
  const { refresh: refreshSession, setHistorySearchOpen } = session;
  const platform = useSessionPlatform();
  const provider = resolveSessionProvider(
    session.current?.id === session.selected ? session.current : undefined,
    session.capabilities,
  );
  const terminal = sessionConnectionPanels(provider?.connection?.kind, platform)?.terminal;
  const terminalUnavailable = connectionManagementUnavailableReason(session.access, session.locale);
  const { sessionId } = props;
  const navigate = useSessionNavigate();
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [statusInToolbar, setStatusInToolbar] = useState(false);
  const refresh = useCallback(() => {
    requestReadStateRefresh("desktop-local", sessionId);
    void refreshSession(true, true);
  }, [sessionId, refreshSession]);
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
    setTerminalOpen,
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
        if (panel === "terminal" && terminal && !terminalUnavailable) setTerminalOpen(true);
      },
    }),
    [
      session.selected,
      terminal,
      terminalUnavailable,
      session.access?.device?.files,
      setActionsOpen,
      setFilesOpen,
      setHistorySearchOpen,
    ],
  );
  const panelRequest = useMemo(
    () => ({ panel: props.initialPanel, sessionId: props.sessionId }),
    [props.initialPanel, props.sessionId],
  );
  const consumedPanel = useRef<typeof panelRequest | undefined>(undefined);
  useEffect(() => {
    if (
      !panelRequest.panel ||
      !panelRequest.sessionId ||
      consumedPanel.current === panelRequest ||
      session.selected !== panelRequest.sessionId ||
      session.current?.id !== panelRequest.sessionId ||
      session.access?.status !== "approved"
    )
      return;
    if (panelRequest.panel === "terminal") {
      if (!terminal) {
        consumedPanel.current = panelRequest;
        props.onInitialPanelConsumed?.();
        return;
      }
      if (
        !session.online ||
        !session.controlReady ||
        session.live?.sessionId !== panelRequest.sessionId ||
        session.busy ||
        !!session.modal ||
        session.notice === "uncertain" ||
        session.live.status === "outcome-unknown" ||
        session.live.reason === "control-outcome-unconfirmed" ||
        session.access.protocolVersion !== 2 ||
        !session.access.experimentalEnabled ||
        !session.access.device?.manage
      )
        return;
      setTerminalOpen(true);
    } else if (panelRequest.panel === "actions") setActionsOpen(true);
    else if (panelRequest.panel === "files" && session.access.device?.files) setFilesOpen(true);
    else if (panelRequest.panel === "search") session.setHistorySearchOpen(true);
    consumedPanel.current = panelRequest;
    props.onInitialPanelConsumed?.();
  }, [
    panelRequest,
    props.onInitialPanelConsumed,
    session.selected,
    session.current?.id,
    terminal,
    session.access?.status,
    session.access?.protocolVersion,
    session.access?.experimentalEnabled,
    session.access?.device?.files,
    session.access?.device?.manage,
    session.online,
    session.controlReady,
    session.live?.sessionId,
    session.live?.status,
    session.live?.reason,
    session.busy,
    session.modal,
    session.notice,
    setActionsOpen,
    setFilesOpen,
    session.setHistorySearchOpen,
  ]);
  return (
    <EmbeddedSessionShell
      panels={{ ...panels, terminalOpen, setTerminalOpen, statusOutsideComposer: statusInToolbar }}
    >
      <ConversationWindowTools
        filesOpen={filesOpen}
        onFilesOpenChange={setFilesOpen}
        onStatusInToolbarChange={setStatusInToolbar}
      />
      <PendingCenter
        compact
        session={session}
        copy={sessionCopy[session.locale]}
        onNavigate={(sessionId) => {
          void navigate({ to: "/sessions/$sessionId", params: { sessionId } });
        }}
      />
      <div className="relative flex min-h-0 flex-1 flex-col">
        {session.error && (!statusInToolbar || session.online || session.incompatible) && (
          <div className="pointer-events-none absolute inset-x-0 top-3 z-30 flex justify-center px-4">
            <p
              role="alert"
              data-floating-session-error="true"
              className="pointer-events-auto flex max-w-3xl flex-wrap items-center gap-3 rounded-xl border border-destructive/30 bg-popover/95 px-4 py-2 text-sm text-destructive-text shadow-md backdrop-blur-sm"
            >
              <span>{session.incompatible ? session.t.lanIncompatible : session.t.error}</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  requestReadStateRefresh("desktop-local", session.selected);
                  void session.refresh(true);
                }}
              >
                {session.t.retry}
              </Button>
            </p>
          </div>
        )}
        {session.catalogNotice && (
          <div className="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center px-4">
            <p
              role="status"
              className="pointer-events-auto rounded-xl border border-border/80 bg-popover/95 px-4 py-2 text-sm text-muted-foreground shadow-sm backdrop-blur-sm"
            >
              {session.c.excludedSession}
            </p>
          </div>
        )}
        <Outlet />
      </div>
      <SessionDialogs />
    </EmbeddedSessionShell>
  );
}
const noParkedSubscription = () => () => {};

function ReturningConversationComposer({
  id,
  agent,
  showStop,
}: {
  id: string;
  agent?: string;
  showStop: boolean;
}) {
  const { locale, t } = useSession();
  const windowConversation = useDesktopConversationWindow();
  const draft = useConversationDraft(id);
  return (
    <div className="w-full max-w-3xl shrink-0 self-center">
      <SessionComposerInput
        editorContextKey={id}
        editor={{
          id: "message",
          "aria-label": t.message,
          value: draft,
          maxLength: MAX_MESSAGE_LENGTH,
          onChange: (event) => {
            if (windowConversation?.warmStreams.hasParked(id))
              windowConversation.setDraft(id, event.currentTarget.value);
          },
          placeholder: sessionContinuationRegistration(agent)
            ? sessionContinuationCopy(locale).placeholder
            : t.message,
        }}
        toolbar={
          <SessionComposerToolbar
            locale={locale}
            add={{ label: sessionCopy[locale].addContext, disabled: true }}
            action={
              <ComposerPrimaryAction
                kind={showStop ? "stop" : "send"}
                label={showStop ? t.stop : t.send}
                disabled
              />
            }
          />
        }
      />
    </div>
  );
}

function EmbeddedReader() {
  const props = useEmbedded();
  const params = useParams({ strict: false }) as { sessionId?: string };
  const session = useSession();
  const { selected, t } = session;
  const windowConversation = useDesktopConversationWindow();
  const navigate = useSessionNavigate();
  const id = params.sessionId;
  const displayLive = useConversationDisplayLive(id === props.sessionId ? id : undefined);
  const { excluded, readable } = useEmbeddedSessionSelection(props, id, session, navigate);
  // The parked subscription and the window's verified catalog only authorize
  // display of the retained history. The active reader still checks fresh access.
  const preview = useSyncExternalStore(
    windowConversation?.warmStreams.subscribeParked ?? noParkedSubscription,
    () => {
      if (
        !id ||
        id !== props.sessionId ||
        selected === id ||
        excluded ||
        session.error ||
        (session.access && session.access.status !== "approved") ||
        windowConversation?.client !== session.client ||
        !desktopReadScope().ready ||
        !windowConversation.warmStreams.hasParked(id) ||
        !props.readInitialCatalog?.(id)
      )
        return undefined;
      return windowConversation.pageCache.peek(id);
    },
  );
  if (excluded) return null;
  if (id && readable && selected === id) return <SessionReader />;
  if (id && preview) {
    const summary = props.readInitialCatalog?.(id)?.sessions.find((record) => record.id === id);
    return (
      <SessionDetail
        layout="desktop"
        sessionId={id}
        locale={session.locale}
        labels={t}
        jumpLabel={webLayoutCopy[session.locale].jumpToLatest}
        viewportRef={session.scroll}
        history={{ page: preview, live: displayLive, externalTurn: summary?.externalTurn }}
        composer={
          <ReturningConversationComposer
            id={id}
            agent={summary?.agent}
            showStop={!!(displayLive?.stopEnabled && displayLive.turnId)}
          />
        }
      />
    );
  }
  return <EmbeddedSessionLoading label={t.loading} />;
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
