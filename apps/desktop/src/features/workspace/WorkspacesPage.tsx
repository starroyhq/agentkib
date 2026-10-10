import { useI18n } from "@/core/useI18n";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { WorkspaceStoragePage } from "@/features/workspace/WorkspaceStoragePage";
import { cn } from "cn";
import { FolderGit2 } from "lucide-react";
import type { AgentKind, DiscoveryReport, RefreshJobStatus, WorkspaceSummary } from "@/core/types";
import { formatRelativeTime, tr as i18nTr } from "@/core/i18n";
import { WorkspaceDetailsPanel } from "./WorkspaceDetailsPanel";
import { WorkspaceFilters, WorkspacePageHeader } from "./WorkspaceFilters";
import { WorkspaceListPanel } from "./WorkspaceListPanel";
import type { WorkspaceView } from "./workspace-page-types";

const WORKSPACES_PER_PAGE = 8;

export function WorkspacesPage({
  view,
  storageJob,
  workspaces,
  favoriteWorkspaceIds,
  onToggleFavorite,
  discovery,
  assetCounts,
  catalogPending = false,
  catalogError = false,
  discoveryRefreshing,
  refreshingWorkspaceIds,
  onAddWorkspace,
  onViewChange,
  onOpen,
  onRefreshDiscovery,
  onOpenDiscoveryDetails,
  onRefreshWorkspace,
  onExclude,
}: {
  view: WorkspaceView;
  storageJob?: RefreshJobStatus;
  workspaces: WorkspaceSummary[];
  favoriteWorkspaceIds: string[];
  onToggleFavorite: (workspaceId: string) => void;
  discovery?: DiscoveryReport;
  assetCounts: Map<string, number>;
  catalogPending?: boolean;
  catalogError?: boolean;
  discoveryRefreshing: boolean;
  refreshingWorkspaceIds?: string[];
  onAddWorkspace: () => void;
  onViewChange: (view: WorkspaceView) => void;
  onOpen: (workspace: WorkspaceSummary) => Promise<void>;
  onRefreshDiscovery: () => void;
  onOpenDiscoveryDetails: () => void;
  onRefreshWorkspace: (id: string) => Promise<void>;
  onExclude: (id: string) => Promise<void>;
}) {
  const { tr, formatRelativeTime: relativeTime } = useI18n();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | WorkspaceSummary["status"]>("all");
  const [agent, setAgent] = useState<"all" | AgentKind>("all");
  const [selectedId, setSelectedId] = useState(workspaces[0]?.id ?? "");
  const [page, setPage] = useState(1);
  const filtered = useMemo(
    () =>
      workspaces.filter(
        (item) =>
          `${item.name} ${item.path}`.toLowerCase().includes(query.toLowerCase()) &&
          (status === "all" || item.status === status) &&
          (agent === "all" || item.sources.some((source) => source.agent === agent)),
      ),
    [agent, query, status, workspaces],
  );
  useEffect(() => setPage(1), [agent, query, status]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / WORKSPACES_PER_PAGE));
  const activePage = Math.min(page, totalPages);
  const pageStart = filtered.length ? (activePage - 1) * WORKSPACES_PER_PAGE + 1 : 0;
  const pageEnd = Math.min(activePage * WORKSPACES_PER_PAGE, filtered.length);
  const paginatedWorkspaces = useMemo(
    () => filtered.slice((activePage - 1) * WORKSPACES_PER_PAGE, activePage * WORKSPACES_PER_PAGE),
    [activePage, filtered],
  );
  useEffect(() => {
    if (!paginatedWorkspaces.some((workspace) => workspace.id === selectedId)) {
      setSelectedId(paginatedWorkspaces[0]?.id ?? "");
    }
  }, [paginatedWorkspaces, selectedId]);
  const selectedWorkspace =
    paginatedWorkspaces.find((workspace) => workspace.id === selectedId) ?? paginatedWorkspaces[0];
  const discoveryStatus = discoveryStatusSummary(discovery, discoveryRefreshing, tr, relativeTime);

  if (view === "storage") {
    return (
      <div className="grid gap-5">
        <WorkspacePageHeader
          view={view}
          onAddWorkspace={onAddWorkspace}
          onViewChange={onViewChange}
        />
        <WorkspaceStoragePage workspaces={workspaces} job={storageJob} />
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      <WorkspacePageHeader
        view={view}
        onAddWorkspace={onAddWorkspace}
        onViewChange={onViewChange}
      />
      <WorkspaceFilters
        query={query}
        status={status}
        agent={agent}
        resultCount={filtered.length}
        discoveryRefreshing={discoveryRefreshing}
        onQueryChange={setQuery}
        onStatusChange={setStatus}
        onAgentChange={setAgent}
        onRefreshDiscovery={onRefreshDiscovery}
      />
      <Button
        variant="ghost"
        className="h-auto min-h-8 justify-start gap-2 px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
        onClick={onOpenDiscoveryDetails}
        aria-label={tr("workspace.discoveryDetailsLink")}
      >
        <span
          className={cn(
            "size-1.5 rounded-full",
            discoveryStatus.tone === "error"
              ? "bg-destructive"
              : discoveryStatus.tone === "warning"
                ? "bg-amber-500"
                : discoveryStatus.tone === "success"
                  ? "bg-emerald-500"
                  : "bg-muted-foreground",
          )}
        />
        <span>{discoveryStatus.label}</span>
        {discoveryStatus.reportedAt && (
          <span className="text-muted-foreground/70">{discoveryStatus.reportedAt}</span>
        )}
        <span className="text-muted-foreground/70">·</span>
        <span>{tr("workspace.discoveryDetailsLink")}</span>
      </Button>
      <div className="grid items-start gap-5 min-[1024px]:grid-cols-[minmax(360px,1fr)_minmax(0,1.25fr)]">
        <WorkspaceListPanel
          workspaces={paginatedWorkspaces}
          selectedId={selectedId}
          pageStart={pageStart}
          pageEnd={pageEnd}
          filteredCount={filtered.length}
          activePage={activePage}
          totalPages={totalPages}
          favoriteWorkspaceIds={favoriteWorkspaceIds}
          onSelect={setSelectedId}
          onOpen={onOpen}
          onToggleFavorite={onToggleFavorite}
          onPageChange={setPage}
        />
        {selectedWorkspace && (
          <WorkspaceDetailsPanel
            workspace={selectedWorkspace}
            assetCount={assetCounts.get(selectedWorkspace.id) ?? selectedWorkspace.asset_count}
            catalogPending={catalogPending}
            catalogError={catalogError}
            refreshing={refreshingWorkspaceIds?.includes(selectedWorkspace.id) ?? false}
            onOpen={onOpen}
            onRefresh={onRefreshWorkspace}
            onExclude={onExclude}
          />
        )}
      </div>
    </div>
  );
}

export function discoveryStatusSummary(
  discovery: DiscoveryReport | undefined,
  refreshing: boolean,
  translateFn: typeof i18nTr,
  relativeTime: (value: string | Date) => string,
) {
  if (!discovery) {
    return {
      label: translateFn(
        refreshing ? "workspace.discoveryScanning" : "workspace.discoveryNotScanned",
      ),
      tone: "neutral" as const,
    };
  }
  const reportedAt = discovery.finished_at || discovery.started_at;
  const reportedLabel = reportedAt
    ? translateFn("workspace.discoveryReportedAt", { time: relativeTime(reportedAt) })
    : undefined;
  if (refreshing) {
    return {
      label: translateFn("workspace.discoveryScanning"),
      reportedAt: reportedLabel,
      tone: "neutral" as const,
    };
  }
  const sourceFailures =
    discovery.source_diagnostics?.filter((source) =>
      ["failed", "permission-denied"].includes(source.status),
    ).length ?? 0;
  if (discovery.errors.length || sourceFailures > 0) {
    return {
      label: translateFn("workspace.discoveryAttention", {
        count: discovery.errors.length + sourceFailures,
      }),
      reportedAt: reportedLabel,
      tone: "error" as const,
    };
  }
  if (
    discovery.source_diagnostics?.some((source) =>
      ["not-configured", "missing", "partial", "unsupported"].includes(source.status),
    )
  ) {
    return {
      label: translateFn("workspace.discoveryPartial"),
      reportedAt: reportedLabel,
      tone: "warning" as const,
    };
  }
  return {
    label: translateFn("workspace.discoveryComplete"),
    reportedAt: reportedLabel,
    tone: "success" as const,
  };
}

export function WorkspacesLoadError({ onRetry }: { onRetry: () => void }) {
  const { tr } = useI18n();
  return (
    <section
      role="alert"
      className="grid min-h-64 place-content-center justify-items-center gap-3 rounded-2xl border border-destructive/30 bg-card p-8 text-center"
    >
      <FolderGit2 size={26} className="text-destructive" />
      <h2 className="text-base font-semibold">{tr("nav.workspaces")}</h2>
      <p className="max-w-md text-sm text-muted-foreground">{tr("errors.generic")}</p>
      <Button onClick={onRetry}>{tr("runtime.retry")}</Button>
    </section>
  );
}
