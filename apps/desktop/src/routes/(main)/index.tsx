import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useI18n } from "@/core/useI18n";
import { GlobalHome } from "@/features/home/GlobalHome";
import { HomeSkeleton } from "@/features/home/HomeSkeleton";
import type { HomeSessionsState } from "@/features/home/HomeSessions";
import { api } from "@/core/api";
import { useAppStore } from "@/stores/app-store";
import { useAppNavigationContext } from "@/features/app/AppNavigationContext";
import { desktopApi } from "@/core/desktop";
import { homeBenchmarkOutcome } from "@/features/home/home-benchmark";
import {
  refreshConversationCatalog,
  useConversationCatalog,
} from "@/features/sessions/conversation-catalog";
import { prepareSessionNavigation } from "@/features/sessions/session-view-store";
import { hasDesktopConversation } from "@/core/conversation-bridge";
import { useHomeReplies } from "@/features/home/home-replies";
import { NewSessionComposer } from "@/features/sessions/new-session/NewSessionComposer";
import { useAddWorkspace } from "@/features/sessions/new-session/use-add-workspace";
import { useOpenWhenListed } from "@/features/sessions/new-session/use-open-when-listed";
import {
  continuationIndexingEnabled,
  recentContinuationWorkspaces,
} from "@/features/home/home-continuations";
import type { AgentKind, AgentToolSnapshot, WorkspaceSummary } from "@/core/types";
import {
  homeKeys,
  useHomeDoctorSummaries,
  useHomeInstallations,
  useHomeMemories,
  useHomeRelayUsage,
  useHomeRemoteStatus,
  useHomeWorkspaces,
} from "@/features/home/home-query";
import { homeMaintenance, homeQuotaRows, homeRemote } from "@/features/home/home-side";
import {
  DEFAULT_QUOTA_PREFERENCES,
  useQuotaPreferences,
  useQuotaSnapshot,
} from "@/features/quota/quota-query";
import { agentToolsKey } from "@/features/settings/agent-tools-query";

const settle = () =>
  refreshConversationCatalog().then(
    () => undefined,
    () => undefined,
  );

function HomeRoute() {
  const { localizeMessage, tr } = useI18n();
  const { app } = useAppNavigationContext();
  const navigate = useNavigate();
  const runtime = useAppStore((state) => state.runtime);
  const setRuntime = useAppStore((state) => state.setRuntime);
  const queryClient = useQueryClient();
  const workspacesQuery = useHomeWorkspaces();
  const workspaces = useMemo(() => workspacesQuery.data ?? [], [workspacesQuery.data]);
  const indexEnabled = continuationIndexingEnabled(runtime);
  // The home lists sessions from the catalog and follows its subscription.
  const catalog = useConversationCatalog(indexEnabled);
  // Approvals and questions are answered in their home rows, as in the session view.
  const replies = useHomeReplies(catalog.sessions);
  // Nothing watches session sources, so a session started outside AgentKib (a terminal, the Codex
  // app) reaches the index only when it is read. As before, entering the home reads the most
  // recently active workspaces once, in the background, without forcing a full rescan.
  const recentWorkspaceIds = recentContinuationWorkspaces(workspaces)
    .map(({ id }) => id)
    .join(":");
  const readRecentWorkspaces = useRef("");
  useEffect(() => {
    if (!indexEnabled || !recentWorkspaceIds) return;
    if (readRecentWorkspaces.current === recentWorkspaceIds) return;
    readRecentWorkspaces.current = recentWorkspaceIds;
    void Promise.allSettled(
      recentWorkspaceIds.split(":").map((id) => api.refreshWorkspaceSessions(id, false)),
    ).then(settle);
  }, [indexEnabled, recentWorkspaceIds]);
  const doctorSummariesQuery = useHomeDoctorSummaries(workspaces.map((workspace) => workspace.id));
  const installationsQuery = useHomeInstallations();
  const memoriesQuery = useHomeMemories();
  const benchmarkReported = useRef(false);
  useEffect(() => {
    if (benchmarkReported.current) return;
    const queries = [workspacesQuery, doctorSummariesQuery, installationsQuery, memoriesQuery];
    if (!runtime) return;
    const outcome = homeBenchmarkOutcome(queries);
    if (outcome === "pending") return;
    benchmarkReported.current = true;
    void desktopApi()
      .benchmark.mark(outcome === "ready" ? "home-data-ready" : "home-data-failed")
      .catch(() => undefined);
  }, [doctorSummariesQuery, installationsQuery, memoriesQuery, runtime, workspacesQuery]);
  // The side column reads saved results only: no quota collection, CLI probe or doctor run here.
  const quotaSnapshot = useQuotaSnapshot();
  const quotaPreferences = useQuotaPreferences();
  const remoteStatus = useHomeRemoteStatus();
  const relay = remoteStatus.data?.relay;
  const relayUsage = useHomeRelayUsage(
    Boolean(remoteStatus.data?.running && relay && relay.phase !== "disabled"),
  );
  // Checking CLI versions runs every CLI and reaches the network, so only reuse a check another
  // page already made.
  const agentTools = useQuery({
    queryKey: agentToolsKey,
    queryFn: (): Promise<AgentToolSnapshot> => api.agentTools(false),
    enabled: false,
  });
  const installations = installationsQuery.data ?? [];
  const installed = new Set(
    installations.filter((item) => item.installed).map((item) => item.agent),
  );
  const notInstalled = new Set(
    installations.filter((item) => !item.installed).map((item) => item.agent),
  );
  const addWorkspace = useAddWorkspace();
  const openWhenListed = useOpenWhenListed(catalog.sessions, (session) => {
    prepareSessionNavigation(session);
    void navigate({ to: "/sessions", search: { sessionId: session.id } });
  });
  // Agents that are not installed have nothing to read; only an installed one is worth a note.
  const unavailableAgents = [
    ...new Set((catalog.incompleteSources ?? []).map((source) => source.agent)),
  ].filter((agent): agent is AgentKind => installed.has(agent as AgentKind));
  const sessionsState: HomeSessionsState = !runtime
    ? "loading"
    : !indexEnabled
      ? "disabled"
      : catalog.usable
        ? "ready"
        : catalog.error !== undefined && !catalog.refreshing
          ? "error"
          : "loading";
  const openWorkspace = async (workspace: WorkspaceSummary, page = "overview") => {
    const path =
      page === "overview" ? "/workspace/$workspaceId" : "/workspace/$workspaceId/" + page;
    await navigate({ to: path as never, params: { workspaceId: workspace.id } as never });
  };
  const addScanRoot = async () => {
    const selected = await api.pickDirectory(tr("dialog.addScanRoot"));
    if (typeof selected === "string") {
      await api.addScanRoot(selected, 5);
      await queryClient.invalidateQueries({ queryKey: homeKeys.scanRoots() });
      await api.requestRefresh("discovery", true);
    }
  };
  if (workspacesQuery.isPending) return <HomeSkeleton />;
  return (
    <GlobalHome
      workspaces={workspaces}
      doctorSummaries={doctorSummariesQuery.isError ? {} : (doctorSummariesQuery.data ?? {})}
      installations={installations}
      memories={memoriesQuery.data ?? []}
      installationsPending={installationsQuery.isPending}
      sessions={{
        state: sessionsState,
        sessions: catalog.sessions,
        error: catalog.error === undefined ? undefined : localizeMessage(catalog.error),
        unavailableAgents,
        replies: hasDesktopConversation() ? replies : undefined,
        onOpen: (session) => {
          prepareSessionNavigation(session);
          void navigate({ to: "/sessions", search: { sessionId: session.id } });
        },
        onShowAll: () => void navigate({ to: "/sessions" }),
        onEnableIndex: async () => {
          // A newly enabled index is empty; read each workspace's sessions once, as the sessions
          // page does when it opens, so the home has something to show. That covers the recent
          // workspaces the entry read would take again.
          readRecentWorkspaces.current = recentWorkspaceIds;
          setRuntime(await api.setSessionIndexEnabled(true));
          await Promise.allSettled(
            workspaces.map((workspace) => api.refreshWorkspaceSessions(workspace.id, false)),
          );
          await settle();
        },
        onRetry: settle,
        onRetrySources: async () => {
          const ids = new Set(
            (catalog.incompleteSources ?? []).map((source) => source.workspaceId),
          );
          await Promise.allSettled([...ids].map((id) => api.refreshWorkspaceSessions(id, true)));
          await settle();
        },
      }}
      newSession={
        // A session opens on the sessions page, which needs the session index.
        indexEnabled && hasDesktopConversation() ? (
          <NewSessionComposer
            placement="home"
            workspaces={workspaces}
            notInstalled={notInstalled}
            onCreated={openWhenListed}
            onAddWorkspace={addWorkspace}
            onOpenSettings={() =>
              void navigate({ to: "/settings", search: { settingsSection: "tools" } })
            }
          />
        ) : undefined
      }
      side={{
        quota: homeQuotaRows(
          quotaSnapshot.data,
          quotaPreferences.data ?? DEFAULT_QUOTA_PREFERENCES,
        ),
        remote: homeRemote(remoteStatus.data, relayUsage.data ?? undefined),
        maintenance: homeMaintenance({
          workspaces,
          doctorSummaries: doctorSummariesQuery.isSuccess ? doctorSummariesQuery.data : undefined,
          memories: memoriesQuery.isSuccess ? memoriesQuery.data : undefined,
          tools: agentTools.data,
        }),
        onOpenQuota: () => void navigate({ to: "/quota" }),
        onOpenRemote: () =>
          void navigate({ to: "/settings", search: { settingsSection: "remote" } }),
        onOpenMaintenance: (kind) =>
          void (kind === "config"
            ? navigate({ to: "/workspaces", search: { workspaceStatus: "attention" } })
            : kind === "memories"
              ? navigate({ to: "/catalog", search: { assetSection: "memory" } })
              : navigate({ to: "/settings", search: { settingsSection: "tools" } })),
      }}
      onOpenDoctor={(workspace) => openWorkspace(workspace, "doctor")}
      onAddWorkspace={app.addWorkspace}
      onAddRoot={addScanRoot}
      runtime={runtime}
      onRuntimeChanged={setRuntime}
    />
  );
}

export const Route = createFileRoute("/(main)/")({
  staticData: { appRoute: { kind: "global", page: "home" } },
  component: HomeRoute,
});
