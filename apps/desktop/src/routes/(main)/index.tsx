import { useI18n } from "@/core/useI18n";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { GlobalHome, type ContinuationHomeState } from "@/features/home/GlobalHome";
import { HomeSkeleton } from "@/features/home/HomeSkeleton";
import { api } from "@/core/api";
import { groupCatalogAssets, workspaceAssetCounts } from "@/features/catalog/catalog";
import { useAppStore } from "@/stores/app-store";
import { useAppNavigationContext } from "@/features/app/AppNavigationContext";
import { desktopApi } from "@/core/desktop";
import { homeBenchmarkOutcome } from "@/features/home/home-benchmark";
import {
  refreshConversationCatalog,
  useConversationCatalog,
} from "@/features/sessions/conversation-catalog";
import { workspaceSessionEntries } from "@/features/sessions/session-catalog";
import { prepareSessionNavigation } from "@/features/sessions/session-view-store";
import {
  continuationIndexingEnabled,
  continuationRefreshFailed,
  metadataOnlyContinuationWorkspace,
  recentContinuationWorkspaces,
  selectRecentContinuations,
} from "@/features/home/home-continuations";
import type { ConversationSessionSummary, WorkspaceSummary } from "@/core/types";
import {
  homeKeys,
  useHomeCatalog,
  useHomeDiscovery,
  useHomeDoctorSummaries,
  useHomeInsightsSummary,
  useHomeInstallations,
  useHomeMemories,
  useHomeWorkspaces,
} from "@/features/home/home-query";

function HomeRoute() {
  const { localizeMessage, tr } = useI18n();
  const { app } = useAppNavigationContext();
  const navigate = useNavigate();
  const runtime = useAppStore((state) => state.runtime);
  const setRuntime = useAppStore((state) => state.setRuntime);
  const queryClient = useQueryClient();
  const workspacesQuery = useHomeWorkspaces();
  const workspaces = useMemo(() => workspacesQuery.data ?? [], [workspacesQuery.data]);
  const continuationWorkspaces = useMemo(
    () => recentContinuationWorkspaces(workspaces),
    [workspaces],
  );
  const continuationRuntimeReady = runtime !== undefined;
  const continuationEnabled = continuationIndexingEnabled(runtime);
  const managedCatalog = useConversationCatalog(continuationEnabled);
  const continuationQueries = useQueries({
    queries: continuationWorkspaces.map((workspace) => ({
      queryKey: homeKeys.continuations(workspace.id),
      queryFn: () => api.workspaceSessions(workspace.id),
      staleTime: 60_000,
      enabled: continuationEnabled,
    })),
  });
  const continuationKey = continuationWorkspaces.map(({ id }) => id).join(":");
  const continuationCacheReady = continuationQueries.every((query) => !query.isPending);
  const continuationRefreshKey = useRef("");
  const continuationRefreshGeneration = useRef(0);
  const [continuationsRefreshing, setContinuationsRefreshing] = useState(false);
  const [continuationsSlow, setContinuationsSlow] = useState(false);
  const [continuationsError, setContinuationsError] = useState("");
  const refreshContinuations = useCallback(async () => {
    if (!continuationEnabled || !continuationWorkspaces.length) return;
    const generation = ++continuationRefreshGeneration.current;
    setContinuationsRefreshing(true);
    setContinuationsSlow(false);
    setContinuationsError("");
    const results = await Promise.allSettled(
      continuationWorkspaces.map(async (workspace) => {
        const sessions = await api.refreshWorkspaceSessions(workspace.id, false);
        return { workspaceId: workspace.id, sessions };
      }),
    );
    if (generation !== continuationRefreshGeneration.current) return;
    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      queryClient.setQueryData<ConversationSessionSummary[]>(
        homeKeys.continuations(result.value.workspaceId),
        result.value.sessions,
      );
    }
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (continuationRefreshFailed(results) && failures[0]) {
      setContinuationsError(localizeMessage(failures[0].reason));
    }
    setContinuationsRefreshing(false);
  }, [continuationEnabled, continuationWorkspaces, localizeMessage, queryClient]);
  useEffect(() => {
    if (!continuationEnabled) {
      continuationRefreshGeneration.current += 1;
      continuationRefreshKey.current = "";
      return;
    }
    if (!continuationKey || !continuationCacheReady) return;
    if (continuationRefreshKey.current === continuationKey) return;
    continuationRefreshKey.current = continuationKey;
    void refreshContinuations();
  }, [continuationCacheReady, continuationEnabled, continuationKey, refreshContinuations]);
  useEffect(() => {
    if (!continuationsRefreshing) return;
    const timer = window.setTimeout(() => setContinuationsSlow(true), 3000);
    return () => window.clearTimeout(timer);
  }, [continuationsRefreshing]);
  useEffect(
    () => () => {
      continuationRefreshGeneration.current += 1;
    },
    [],
  );
  const projectedContinuationSessions = continuationEnabled
    ? continuationQueries.map((query, index) =>
        workspaceSessionEntries(
          continuationWorkspaces[index].id,
          query.data ?? [],
          managedCatalog.sessions,
        ),
      )
    : [];
  const recentContinuations = continuationEnabled
    ? selectRecentContinuations(continuationWorkspaces, projectedContinuationSessions, 3)
    : [];
  const metadataOnlyWorkspace = continuationEnabled
    ? metadataOnlyContinuationWorkspace(continuationWorkspaces, projectedContinuationSessions)
    : undefined;
  const continuationError =
    continuationsError || (managedCatalog.error ? localizeMessage(managedCatalog.error) : "");
  const continuationState: ContinuationHomeState = !continuationRuntimeReady
    ? "loading"
    : !continuationEnabled
      ? "disabled"
      : recentContinuations.length
        ? "ready"
        : continuationQueries.some((query) => query.isPending) ||
            continuationsRefreshing ||
            !managedCatalog.ready
          ? "loading"
          : continuationError
            ? "error"
            : metadataOnlyWorkspace
              ? "metadata-only"
              : "empty";
  const doctorSummariesQuery = useHomeDoctorSummaries(workspaces.map((workspace) => workspace.id));
  const installationsQuery = useHomeInstallations();
  const memoriesQuery = useHomeMemories();
  const discoveryQuery = useHomeDiscovery();
  const insightsQuery = useHomeInsightsSummary();
  const catalogQuery = useHomeCatalog();
  const benchmarkReported = useRef(false);
  useEffect(() => {
    if (benchmarkReported.current) return;
    const queries = [
      workspacesQuery,
      doctorSummariesQuery,
      installationsQuery,
      memoriesQuery,
      discoveryQuery,
      insightsQuery,
      catalogQuery,
    ];
    if (!runtime) return;
    const outcome = homeBenchmarkOutcome(queries);
    if (outcome === "pending") return;
    benchmarkReported.current = true;
    void desktopApi()
      .benchmark.mark(outcome === "ready" ? "home-data-ready" : "home-data-failed")
      .catch(() => undefined);
  }, [
    catalogQuery,
    discoveryQuery,
    doctorSummariesQuery,
    insightsQuery,
    installationsQuery,
    memoriesQuery,
    runtime,
    workspacesQuery,
  ]);
  const doctorSummaries = doctorSummariesQuery.isError ? {} : (doctorSummariesQuery.data ?? {});
  const installations = installationsQuery.data ?? [];
  const globalMemories = memoriesQuery.data ?? [];
  const discovery = discoveryQuery.data;
  const insightsSummary = insightsQuery.data;
  const catalog = catalogQuery.data ?? [];
  const groupedCatalog = groupCatalogAssets(catalog);
  const assetCounts = workspaceAssetCounts(groupedCatalog);
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
  const issuesPending = doctorSummariesQuery.isPending || memoriesQuery.isPending;
  if (workspacesQuery.isPending) return <HomeSkeleton />;
  return (
    <GlobalHome
      workspaces={workspaces}
      doctorSummaries={doctorSummaries}
      installations={installations}
      memories={globalMemories}
      issuesPending={issuesPending}
      discovery={discovery}
      installationsPending={installationsQuery.isPending}
      catalogPending={catalogQuery.isPending}
      insights={insightsSummary}
      uniqueAssetCount={groupedCatalog.filter((asset) => asset.scope === "workspace").length}
      assetCounts={assetCounts}
      onShowWorkspaces={() => void navigate({ to: "/workspaces" })}
      onShowAgents={() => void navigate({ to: "/agents" })}
      recentContinuations={recentContinuations}
      continuationState={continuationState}
      continuationSlow={continuationsSlow}
      continuationError={continuationError}
      onContinue={async ({ session }) => {
        prepareSessionNavigation(session);
        await navigate({
          to: "/sessions",
          search: { sessionId: session.id },
        });
      }}
      onEnableContinuations={async () => {
        setRuntime(await api.setSessionIndexEnabled(true));
      }}
      onRetryContinuations={async () => {
        await Promise.allSettled([refreshContinuations(), refreshConversationCatalog()]);
      }}
      onOpenContinuationWorkspace={async () => {
        const workspace = metadataOnlyWorkspace ?? continuationWorkspaces[0];
        if (workspace) await openWorkspace(workspace, "sessions");
      }}
      onOpen={openWorkspace}
      onOpenDoctor={(workspace) => openWorkspace(workspace, "doctor")}
      onOpenAssets={(section) =>
        void navigate({ to: "/catalog", search: { assetSection: section } as never })
      }
      onAddWorkspace={app.addWorkspace}
      onAddRoot={addScanRoot}
      onRefresh={() => {
        void Promise.all([
          api.requestRefresh("discovery", true),
          api.requestRefresh("insights", true),
        ]);
      }}
      runtime={runtime}
      onRuntimeChanged={setRuntime}
    />
  );
}

export const Route = createFileRoute("/(main)/")({
  staticData: { appRoute: { kind: "global", page: "home" } },
  component: HomeRoute,
});
