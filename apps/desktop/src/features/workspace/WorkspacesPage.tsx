import { useI18n } from "@/core/useI18n";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { WorkspaceStoragePage } from "@/features/workspace/WorkspaceStoragePage";
import { cn } from "cn";
import { History, RefreshCw, TriangleAlert } from "lucide-react";
import { AGENT_LABELS } from "@/core/agents";
import { getWorkspaceStatus, type WorkspaceDisplayState } from "./workspace-status";
import { FolderGit2 } from "lucide-react";
import type {
  AgentKind,
  ContextDoctorSummary,
  DiscoveryReport,
  MemoryRecord,
  RefreshJobStatus,
  WorkspaceSummary,
} from "@/core/types";
import { tr as i18nTr } from "@/core/i18n";
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
  doctorSummaries,
  memories,
  discoveryRefreshing,
  refreshingWorkspaceIds,
  onAddWorkspace,
  onViewChange,
  onOpen,
  onRefreshDiscovery,
  onOpenDiscoveryDetails,
  onRefreshWorkspace,
  onExclude,
  onReveal,
}: {
  view: WorkspaceView;
  storageJob?: RefreshJobStatus;
  workspaces: WorkspaceSummary[];
  favoriteWorkspaceIds: string[];
  onToggleFavorite: (workspaceId: string) => void;
  discovery?: DiscoveryReport;
  doctorSummaries: Record<string, ContextDoctorSummary>;
  memories: MemoryRecord[];
  discoveryRefreshing: boolean;
  refreshingWorkspaceIds?: string[];
  onAddWorkspace: () => void;
  onViewChange: (view: WorkspaceView) => void;
  onOpen: (workspace: WorkspaceSummary) => Promise<void>;
  onRefreshDiscovery: () => void;
  onOpenDiscoveryDetails: () => void;
  onRefreshWorkspace: (id: string) => Promise<void>;
  onExclude: (id: string) => Promise<void>;
  onReveal: (id: string) => Promise<void>;
}) {
  const { tr, formatRelativeTime: relativeTime } = useI18n();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | WorkspaceDisplayState>("all");
  const [agent, setAgent] = useState<"all" | AgentKind>("all");
  const [page, setPage] = useState(1);
  const statuses = useMemo(
    () =>
      new Map(
        workspaces.map((workspace) => [
          workspace.id,
          getWorkspaceStatus(workspace.id, doctorSummaries[workspace.id], memories),
        ]),
      ),
    [workspaces, doctorSummaries, memories],
  );
  const filtered = useMemo(
    () =>
      workspaces.filter(
        (item) =>
          `${item.name} ${item.path}`.toLowerCase().includes(query.toLowerCase()) &&
          (status === "all" || statuses.get(item.id)?.state === status) &&
          (agent === "all" || item.sources.some((source) => source.agent === agent)),
      ),
    [agent, query, status, workspaces, statuses],
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
        onQueryChange={setQuery}
        onStatusChange={setStatus}
        onAgentChange={setAgent}
      />
      <div
        className={cn(
          "flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-xs",
          discoveryStatus.tone === "warning" ? "text-[var(--amber)]" : "text-muted-foreground",
        )}
      >
        {discoveryStatus.tone === "warning" ? (
          <TriangleAlert size={14} aria-hidden="true" />
        ) : (
          <History size={14} aria-hidden="true" />
        )}
        <span>{discoveryStatus.label}</span>
        {discoveryStatus.reportedAt && (
          <>
            <span>·</span>
            <span>{discoveryStatus.reportedAt}</span>
          </>
        )}
        <span>·</span>
        <Button
          variant="link"
          className="h-auto p-0 text-xs text-primary-text"
          onClick={onOpenDiscoveryDetails}
        >
          {tr("workspace.discoverySettings")}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto text-muted-foreground"
          aria-label={tr("workspace.refreshDiscovery")}
          title={tr("workspace.refreshDiscovery")}
          aria-busy={discoveryRefreshing}
          disabled={discoveryRefreshing}
          onClick={onRefreshDiscovery}
        >
          <RefreshCw size={14} className={discoveryRefreshing ? "animate-spin" : ""} />
        </Button>
      </div>
      <WorkspaceListPanel
        workspaces={paginatedWorkspaces}
        totalCount={workspaces.length}
        statuses={statuses}
        pageStart={pageStart}
        pageEnd={pageEnd}
        filteredCount={filtered.length}
        activePage={activePage}
        totalPages={totalPages}
        favoriteWorkspaceIds={favoriteWorkspaceIds}
        refreshingWorkspaceIds={refreshingWorkspaceIds}
        onOpen={onOpen}
        onToggleFavorite={onToggleFavorite}
        onPageChange={setPage}
        onRefresh={onRefreshWorkspace}
        onReveal={onReveal}
        onExclude={onExclude}
      />
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
      ["failed", "permission-denied", "partial"].includes(source.status),
    ).length ?? 0;
  if (discovery.errors.length || sourceFailures > 0) {
    return {
      label: translateFn("workspace.discoveryAttention", {
        count: Math.max(discovery.errors.length, sourceFailures),
      }),
      reportedAt: reportedLabel,
      tone: "warning" as const,
    };
  }
  const sources = [
    ...new Set(
      discovery.source_diagnostics?.flatMap((source) => {
        if (!source.agent || !(source.included_count ?? source.candidate_count ?? 0)) return [];
        const agent = AGENT_LABELS[source.agent];
        return [
          source.source === "history-and-index"
            ? translateFn("workspace.discoveryHistorySource", { agent })
            : agent,
        ];
      }) ?? [],
    ),
  ];
  return {
    label: sources.length
      ? translateFn("workspace.discoveryFoundFrom", {
          count: discovery.discovered_count,
          sources: sources.join(" · "),
        })
      : translateFn("workspace.discoveryFound", { count: discovery.discovered_count }),
    reportedAt: reportedAt ? relativeTime(reportedAt) : undefined,
    tone: "neutral" as const,
  };
}

export function WorkspacesLoadError({
  onRetry,
  retrying = false,
}: {
  onRetry: () => void;
  retrying?: boolean;
}) {
  const { tr } = useI18n();
  return (
    <section
      role="alert"
      className="grid min-h-64 place-content-center justify-items-center gap-3 rounded-2xl border border-destructive/30 bg-card p-8 text-center"
    >
      <FolderGit2 size={26} className="text-destructive-icon" />
      <h2 className="text-base font-semibold">{tr("nav.workspaces")}</h2>
      <p className="max-w-md text-sm text-muted-foreground">{tr("errors.generic")}</p>
      <Button disabled={retrying} onClick={onRetry}>
        {tr("runtime.retry")}
      </Button>
    </section>
  );
}
