import {
  createContext,
  useContext,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
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
import { LoaderCircle } from "lucide-react";
import type { WebClient } from "@agentkib/web-client";
import type { SupportedLocale as Locale } from "@/core/types";
import { SessionProvider, useSession } from "./features/sessions/session-context";
import { SessionReader } from "./features/sessions/session-reader";
import { SessionDialogs } from "./features/sessions/session-dialogs";
import { SessionPanelsContext } from "./features/sessions/session-panels";
import { ManagedTasks } from "./features/sessions/managed-tasks";
import { PendingCenter } from "./features/sessions/pending-center";
import { Button } from "@/components/ui/button";
import { useSessionNavigate } from "./features/sessions/session-navigation";
import { ConversationWindowTools } from "../conversation-window-tools";

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
  /** Changes only when the host explicitly requests a conversation refresh. */
  refreshRevision?: number;
  locale: Locale;
  create?: boolean;
  /** Also open program-started sessions, as the directory option allows. */
  showExecution?: boolean;
  onSessionChange: (sessionId?: string) => void;
  onCatalogChange?: () => void;
  onCreateClosed?: () => void;
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
  const { client, locale, showExecution } = useEmbedded();
  return (
    <SessionProvider client={client} embedded initialLocale={locale} showExecution={showExecution}>
      <EmbeddedShell />
    </SessionProvider>
  );
}
function EmbeddedShell() {
  const props = useEmbedded();
  const session = useSession();
  const [filesOpen, setFilesOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  useImperativeHandle(
    props.controlsRef,
    () => ({
      openPanel(panel) {
        if (panel === "search") {
          session.setHistorySearchOpen(true);
          return;
        }
        if (!session.selected) return;
        if (panel === "files" && session.access?.device?.files) setFilesOpen(true);
        if (panel === "actions") setActionsOpen(true);
        if (
          panel === "terminal" &&
          session.current?.agent === "claude-code" &&
          document.documentElement.dataset.platform === "macos"
        )
          setTerminalOpen(true);
      },
    }),
    [session.selected, session.current?.agent, session.access?.device?.files],
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
      if (
        session.current.agent !== "claude-code" ||
        document.documentElement.dataset.platform !== "macos"
      ) {
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
    session.current?.agent,
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
    session.setHistorySearchOpen,
  ]);
  const previousCatalog = useRef(session.sessions);
  const hostRefresh = useRef<{
    revision?: number;
    pending?: { sessionId?: string };
  }>({ revision: props.refreshRevision });
  useEffect(() => {
    const request = hostRefresh.current;
    if (request.revision !== props.refreshRevision) {
      request.revision = props.refreshRevision;
      request.pending = { sessionId: props.sessionId };
    }
    // A selection can change before the embedded router finishes navigation.
    // Never refresh the old record for a newly selected host record.
    if (request.pending?.sessionId !== props.sessionId) request.pending = undefined;
    if (!request.pending || (session.selected || undefined) !== props.sessionId) return;
    request.pending = undefined;
    void session.refresh(true);
  }, [props.refreshRevision, props.sessionId, session.selected, session.refresh]);
  useEffect(() => {
    session.setLocale(props.locale);
  }, [props.locale, session.setLocale]);
  useEffect(() => {
    if (previousCatalog.current === session.sessions) return;
    previousCatalog.current = session.sessions;
    props.onCatalogChange?.();
  }, [session.sessions, props.onCatalogChange]);
  useLayoutEffect(() => {
    setFilesOpen(false);
    setActionsOpen(false);
    setTerminalOpen(false);
  }, [session.selected]);
  useEffect(() => {
    if (session.modal) {
      setFilesOpen(false);
      setActionsOpen(false);
      setTerminalOpen(false);
    }
  }, [session.modal]);
  return (
    <SessionPanelsContext
      value={{
        filesOpen,
        setFilesOpen,
        actionsOpen,
        setActionsOpen,
        terminalOpen,
        setTerminalOpen,
      }}
    >
      <div className="agentkib-conversation flex min-h-0 flex-1 flex-col bg-background text-foreground">
        <ConversationWindowTools filesOpen={filesOpen} onFilesOpenChange={setFilesOpen} />
        <ManagedTasks
          key={String(props.create)}
          create
          showTrigger={false}
          initialOpen={props.create}
          onDismiss={props.onCreateClosed}
        />
        <PendingCenter compact />
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
      </div>
    </SessionPanelsContext>
  );
}
function EmbeddedReader() {
  const props = useEmbedded();
  const params = useParams({ strict: false }) as { sessionId?: string };
  const { choose, selected, sessions, t, excludedSessionIds } = useSession();
  const navigate = useSessionNavigate();
  const id = params.sessionId;
  const excluded = !!id && excludedSessionIds.has(id);
  const readable = sessions.some(
    (session) => session.id === id && session.availability === "readable",
  );
  useEffect(() => {
    // A parent selection changes before the memory router finishes navigation.
    // Do not report the previously rendered route back as a new user selection.
    if (props.externalNavigation.current) {
      if (props.sessionId !== id) return;
      props.externalNavigation.current = false;
    }
    if (id && excluded) {
      void choose(id);
      props.onSessionChange(undefined);
      void navigate({ to: "/sessions", replace: true });
      return;
    }
    if (!id || !readable) return;
    void choose(id);
    if (props.sessionId !== id) props.onSessionChange(id);
  }, [
    id,
    readable,
    choose,
    excluded,
    navigate,
    props.sessionId,
    props.onSessionChange,
    props.externalNavigation,
  ]);
  if (excluded) return null;
  return id && readable && selected === id ? (
    <SessionReader />
  ) : (
    <div
      role="status"
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
    >
      <LoaderCircle
        aria-hidden="true"
        className="size-6 animate-spin text-muted-foreground motion-reduce:animate-none"
      />
      <p className="text-sm text-muted-foreground">{t.loading}</p>
    </div>
  );
}
function EmbeddedEmpty() {
  const props = useEmbedded();
  const { leaveSession, t } = useSession();
  useEffect(() => {
    if (props.externalNavigation.current) {
      if (props.sessionId !== undefined) return;
      props.externalNavigation.current = false;
    }
    leaveSession();
    if (props.sessionId !== undefined) props.onSessionChange(undefined);
  }, [leaveSession, props.sessionId, props.onSessionChange, props.externalNavigation]);
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
  const lastExternalSession = useRef(props.sessionId);
  const externalNavigation = useRef(false);
  if (lastExternalSession.current !== props.sessionId) {
    lastExternalSession.current = props.sessionId;
    externalNavigation.current = true;
  }
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
