import { useI18n } from "@/core/useI18n";
import { SESSION_COLLECTIONS } from "@agentkib/runtime-protocol";
import type { WorkspaceSummary } from "@/core/types";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useHomeWorkspaces } from "@/features/home/home-query";
import { useAppStore } from "@/stores/app-store";
import { useSessionCatalog } from "./useSessionCatalog";
import { filterSessions } from "./session-catalog";
import { useSessionViewStore } from "./session-view-store";
import { SESSION_REFRESH_EVENT } from "./session-refresh";
import {
  useRemoteCatalogEntries,
  refreshRemoteCatalog,
} from "@/features/remote/remote-catalog-store";
import "./sessions.css";

function useHub(active: boolean) {
  const { localizeMessage, tr } = useI18n();
  const workspaceQuery = useHomeWorkspaces();
  const runtime = useAppStore((state) => state.runtime);
  const localEnabled = runtime?.session_index_enabled === true;
  const localWorkspaces = useMemo(
    (): WorkspaceSummary[] => [
      ...(workspaceQuery.data ?? []),
      ...(active && localEnabled
        ? Object.entries(SESSION_COLLECTIONS).map(([kind, id]) => ({
            id,
            name: tr(kind === "projectless" ? "sessions.projectless" : "sessions.unclassified"),
            path: "",
            status: "healthy" as const,
            asset_count: 0,
            warning_count: 0,
            sources: [],
          }))
        : []),
    ],
    [workspaceQuery.data, active, localEnabled, tr],
  );
  const remote = useRemoteCatalogEntries();
  const enabled = active && (localEnabled || remote.hosts.length > 0);
  const catalog = useSessionCatalog(localWorkspaces, active && localEnabled);
  const workspaces = useMemo(
    () => [...localWorkspaces, ...remote.workspaces],
    [localWorkspaces, remote.workspaces],
  );
  const sessions = useMemo(
    () => [...catalog.sessions, ...remote.sessions],
    [catalog.sessions, remote.sessions],
  );
  const refreshCatalog = catalog.refresh;
  const [historyRevision, setHistoryRevision] = useState(0);
  const refresh = useCallback(async () => {
    await Promise.all([
      localEnabled ? refreshCatalog() : Promise.resolve(),
      ...remote.hosts.map((host) => refreshRemoteCatalog(host.id, true)),
    ]);
    setHistoryRevision((revision) => revision + 1);
  }, [localEnabled, refreshCatalog, remote.hosts]);
  const wasRefreshing = useRef(false);
  useEffect(() => {
    if (wasRefreshing.current && !catalog.refreshing && catalog.ready && enabled) {
      setHistoryRevision((revision) => revision + 1);
    }
    wasRefreshing.current = catalog.refreshing;
  }, [catalog.refreshing, catalog.ready, enabled]);
  useEffect(() => {
    if (!active) return;
    const handleRefresh = () => void refresh();
    window.addEventListener(SESSION_REFRESH_EVENT, handleRefresh);
    return () => window.removeEventListener(SESSION_REFRESH_EVENT, handleRefresh);
  }, [active, refresh]);
  const agent = useSessionViewStore((state) => state.agent);
  const filter = useSessionViewStore((state) => state.filter);
  const host = useSessionViewStore((state) => state.host);
  const showAuxiliary = useSessionViewStore((state) => state.showAuxiliary);
  const revealSession = useSessionViewStore((state) => state.revealSession);
  const filtered = useMemo(
    () =>
      filterSessions(sessions, workspaces, { query: "", agent, filter, showAuxiliary }).filter(
        (session) => host === "all" || host === (session.remote?.host_id ?? "local"),
      ),
    [sessions, workspaces, agent, filter, host, showAuxiliary],
  );
  const navigate = useNavigate();
  const { sessionId } = useSearch({ strict: false }) as { sessionId?: string };
  const selected = enabled ? filtered.find((session) => session.id === sessionId) : undefined;
  const selectedWorkspace = selected
    ? workspaces.find((workspace) => workspace.id === selected.workspace_id)
    : undefined;
  const select = (id?: string, replace = false) =>
    void navigate({
      to: "/sessions",
      replace,
      search: (current) => ({ ...current, sessionId: id }),
    });
  const routeReveal = useRef<{ sessionId?: string; revealed: boolean; skipClear: boolean }>({
    revealed: false,
    skipClear: false,
  });
  useEffect(() => {
    if (routeReveal.current.sessionId !== sessionId) {
      routeReveal.current = { sessionId, revealed: false, skipClear: false };
    }
    if (!sessionId || routeReveal.current.revealed) return;
    const target = sessions.find((session) => session.id === sessionId);
    if (!target || target.origin !== "auxiliary") return;
    routeReveal.current.revealed = true;
    routeReveal.current.skipClear = true;
    // Route targets are explicit intent. Reveal once, including auxiliary
    // records, without re-revealing after the user changes view filters.
    revealSession(target);
  }, [sessionId, sessions, revealSession]);
  useEffect(() => {
    if (routeReveal.current.skipClear && routeReveal.current.sessionId === sessionId) {
      routeReveal.current.skipClear = false;
      return;
    }
    // Wait until every workspace cache has been read before validating a deep link.
    if (
      sessionId &&
      (!sessionId.startsWith("remote:") || sessions.some((session) => session.id === sessionId)) &&
      catalog.ready &&
      enabled &&
      !workspaceQuery.isPending &&
      !workspaceQuery.error &&
      !selected &&
      (sessions.some((session) => session.id === sessionId) ||
        (!catalog.refreshing && Object.keys(catalog.errors).length === 0))
    ) {
      void navigate({
        to: "/sessions",
        replace: true,
        search: (current) => ({ ...current, sessionId: undefined }),
      });
    }
  }, [
    sessionId,
    catalog.ready,
    catalog.refreshing,
    catalog.sessions,
    sessions,
    catalog.errors,
    enabled,
    selected,
    workspaceQuery.isPending,
    workspaceQuery.error,
    navigate,
  ]);
  return {
    ...catalog,
    sessions,
    remoteHosts: remote.hosts,
    remoteErrors: remote.errors,
    localEnabled,
    historyRevision,
    refresh,
    workspaces,
    filtered,
    selected,
    selectedWorkspace,
    select,
    enabled,
    runtimeReady: runtime !== undefined,
    workspacesLoading: workspaceQuery.isPending && remote.sessions.length === 0,
    workspacesError: workspaceQuery.error ? localizeMessage(workspaceQuery.error) : "",
    retryWorkspaces: () => void workspaceQuery.refetch(),
  };
}

const SessionHubContext = createContext<ReturnType<typeof useHub> | null>(null);

export function SessionHubProvider({
  children,
  active = true,
}: {
  children: ReactNode;
  active?: boolean;
}) {
  return <SessionHubContext.Provider value={useHub(active)}>{children}</SessionHubContext.Provider>;
}

export function useSessionHub() {
  const context = useContext(SessionHubContext);
  if (!context) throw new Error("SessionHubProvider is required");
  return context;
}
