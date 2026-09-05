import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useAppDialogs } from "@/components/AppDialogProvider";
import { WorkspaceStoragePage } from "@/features/workspace/WorkspaceStoragePage";
import { WorkspacesSkeleton } from "@/features/workspace/WorkspaceSkeleton";
import { AgentIcon } from "@/features/agents/AgentIcon";
import { api } from "../core/api";
import { groupCatalogAssets, workspaceAssetCounts } from "@/features/catalog/catalog";
import { formatRelativeTime, localizeMessage, tr } from "../core/i18n";
import {
  homeKeys,
  useHomeCatalog,
  useHomeRefreshJobs,
  useHomeWorkspaces,
} from "@/features/home/home-query";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import { ChevronLeft, ChevronRight, FolderGit2, RefreshCw, Search, Trash2 } from "lucide-react";
import type { AgentKind, RefreshJobStatus, WorkspaceSummary } from "../core/types";
import { cn } from "@/lib/utils";

type WorkspaceView = "list" | "storage";
type WorkspacesSearch = { workspaceView?: WorkspaceView };
const WORKSPACES_PER_PAGE = 8;
const agentLabels: Record<AgentKind, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  cursor: "Cursor",
  opencode: "OpenCode",
  "open-claw": "OpenClaw",
  hermes: "Hermes",
  "grok-build": "Grok Build",
  "deepseek-harness": "DeepSeek Harness",
};

function WorkspacesRoute() {
  const navigate = useNavigate();
  const dialogs = useAppDialogs();
  const queryClient = useQueryClient();
  const search = useSearch({ strict: false }) as WorkspacesSearch;
  const view = search.workspaceView ?? "list";
  const { data: workspaces = [], isPending: workspacesPending } = useHomeWorkspaces();
  const { data: catalog = [], isPending: catalogPending } = useHomeCatalog();
  const { data: refreshJobs = [] } = useHomeRefreshJobs();
  const openRequest = useRef(0);
  const {
    setProject,
    setSelectedWorkspace,
    setScan,
    setManifest,
    setBaselineManifest,
    setChangeSet,
    setChangeSetOrigin,
    setHandoffLaunchRequest,
    setMessage,
  } = useWorkspaceStore();
  const assetCounts = useMemo(() => workspaceAssetCounts(groupCatalogAssets(catalog)), [catalog]);
  const discoveryRefreshing = refreshJobs.some(
    (job) => job.kind === "discovery" && (job.state === "queued" || job.state === "running"),
  );
  const storageJob = refreshJobs.find((job) => job.kind === "storage");

  useEffect(
    () => () => {
      openRequest.current += 1;
    },
    [],
  );

  const setView = (nextView: WorkspaceView) => {
    void navigate({
      to: "/workspaces",
      search: (current) => ({ ...current, workspaceView: nextView }) as never,
    });
  };

  const openWorkspace = async (workspace: WorkspaceSummary) => {
    const requestId = ++openRequest.current;
    setMessage("");
    if (requestId !== openRequest.current) return;
    setChangeSet(undefined);
    setChangeSetOrigin("standard");
    setHandoffLaunchRequest(undefined);
    setProject(workspace.path);
    setScan(undefined);
    setManifest(undefined);
    setBaselineManifest("");
    setSelectedWorkspace(workspace);
    await navigate({
      to: "/workspace/$workspaceId",
      params: { workspaceId: workspace.id },
    });
  };

  const addWorkspace = async () => {
    if (useWorkspaceStore.getState().applyingChanges) {
      await dialogs.notify(tr("dialog.quit.changesApplying"));
      return;
    }
    const selected = await api.pickDirectory(tr("dialog.addWorkspace"));
    if (typeof selected !== "string") return;
    try {
      if (useWorkspaceStore.getState().applyingChanges) {
        await dialogs.notify(tr("dialog.quit.changesApplying"));
        return;
      }
      setMessage("");
      const workspace = await api.addWorkspace(selected);
      await queryClient.invalidateQueries({ queryKey: homeKeys.all });
      if (useWorkspaceStore.getState().applyingChanges) {
        await dialogs.notify(tr("dialog.quit.changesApplying"));
        return;
      }
      await openWorkspace(workspace);
    } catch (error) {
      setMessage(localizeMessage(error));
    }
  };

  const refreshDiscovery = async () => {
    try {
      await api.requestRefresh("discovery", true);
    } catch (error) {
      setMessage(localizeMessage(error));
    }
  };

  const refreshWorkspace = async (id: string) => {
    try {
      await api.refreshWorkspace(id);
      await queryClient.invalidateQueries({ queryKey: homeKeys.workspaces() });
    } catch (error) {
      setMessage(localizeMessage(error));
    }
  };

  const excludeWorkspace = async (id: string) => {
    if (
      !(await dialogs.confirm({ description: tr("workspace.ignoreConfirm"), tone: "destructive" }))
    )
      return;
    try {
      await api.excludeWorkspace(id);
      await queryClient.invalidateQueries({ queryKey: homeKeys.all });
    } catch (error) {
      setMessage(localizeMessage(error));
    }
  };

  if (workspacesPending || catalogPending) return <WorkspacesSkeleton view={view} />;

  return (
    <WorkspacesPage
      view={view}
      storageJob={storageJob}
      workspaces={workspaces}
      assetCounts={assetCounts}
      discoveryRefreshing={discoveryRefreshing}
      onAddWorkspace={() => void addWorkspace()}
      onViewChange={setView}
      onOpen={openWorkspace}
      onRefreshDiscovery={refreshDiscovery}
      onRefreshWorkspace={refreshWorkspace}
      onExclude={excludeWorkspace}
    />
  );
}

function WorkspacesPage({
  view,
  storageJob,
  workspaces,
  assetCounts,
  discoveryRefreshing,
  onAddWorkspace,
  onViewChange,
  onOpen,
  onRefreshDiscovery,
  onRefreshWorkspace,
  onExclude,
}: {
  view: WorkspaceView;
  storageJob?: RefreshJobStatus;
  workspaces: WorkspaceSummary[];
  assetCounts: Map<string, number>;
  discoveryRefreshing: boolean;
  onAddWorkspace: () => void;
  onViewChange: (view: WorkspaceView) => void;
  onOpen: (workspace: WorkspaceSummary) => Promise<void>;
  onRefreshDiscovery: () => Promise<void>;
  onRefreshWorkspace: (id: string) => Promise<void>;
  onExclude: (id: string) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | WorkspaceSummary["status"]>("all");
  const [agent, setAgent] = useState<"all" | AgentKind>("all");
  const [selectedId, setSelectedId] = useState(workspaces[0]?.id ?? "");
  const [page, setPage] = useState(1);
  const filtered = workspaces.filter(
    (item) =>
      `${item.name} ${item.path}`.toLowerCase().includes(query.toLowerCase()) &&
      (status === "all" || item.status === status) &&
      (agent === "all" || item.sources.some((source) => source.agent === agent)),
  );
  useEffect(() => {
    setPage(1);
  }, [agent, query, status]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / WORKSPACES_PER_PAGE));
  const activePage = Math.min(page, totalPages);
  const paginatedWorkspaces = filtered.slice(
    (activePage - 1) * WORKSPACES_PER_PAGE,
    activePage * WORKSPACES_PER_PAGE,
  );
  const pageStart = filtered.length ? (activePage - 1) * WORKSPACES_PER_PAGE + 1 : 0;
  const pageEnd = Math.min(activePage * WORKSPACES_PER_PAGE, filtered.length);
  useEffect(() => {
    if (!paginatedWorkspaces.some((workspace) => workspace.id === selectedId)) {
      setSelectedId(paginatedWorkspaces[0]?.id ?? "");
    }
  }, [paginatedWorkspaces, selectedId]);
  const selectedWorkspace =
    paginatedWorkspaces.find((workspace) => workspace.id === selectedId) ?? paginatedWorkspaces[0];
  const viewControls = (
    <ToggleGroup
      spacing={0}
      variant="default"
      className="segmented-control shrink-0"
      value={[view]}
      onValueChange={(values) => {
        const value = values[0];
        if (value === "list" || value === "storage") onViewChange(value);
      }}
      aria-label={tr("workspace.viewLabel")}
    >
      <ToggleGroupItem
        value="list"
        className="segmented-control-item h-9 min-h-9 min-w-[68px] font-semibold"
      >
        {tr("workspace.view.list")}
      </ToggleGroupItem>
      <ToggleGroupItem
        value="storage"
        className="segmented-control-item h-9 min-h-9 min-w-[68px] font-semibold"
      >
        {tr("workspace.view.storage")}
      </ToggleGroupItem>
    </ToggleGroup>
  );
  const pageIntro = (
    <section className="flex flex-wrap items-center justify-between gap-3">
      <div>
        {view === "list" && (
          <Button className="h-9 rounded-lg px-3.5" onClick={onAddWorkspace}>
            <FolderGit2 size={15} />
            {tr("workspace.addManually")}
          </Button>
        )}
      </div>
      {viewControls}
    </section>
  );
  const filterBar = (
    <Card className="overflow-hidden rounded-2xl border-border/70 bg-card shadow-sm">
      <CardContent className="grid gap-3 p-4 sm:p-5">
        <div className="grid gap-3 lg:grid-cols-[minmax(260px,1fr)_auto] lg:items-center">
          <div className="flex h-10 min-w-0 items-center gap-2 rounded-xl border border-input bg-background px-3 text-muted-foreground transition-[border-color,box-shadow] focus-within:border-primary/45 focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--primary)_10%,transparent)]">
            <Search size={16} />
            <Input
              className="!h-8 !border-0 !bg-transparent !px-0 !text-foreground !shadow-none placeholder:!text-muted-foreground focus-visible:!ring-0"
              aria-label={tr("workspace.searchPlaceholder")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={tr("workspace.searchPlaceholder")}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={agent}
              onValueChange={(value) => {
                if (value !== null) setAgent(String(value) as typeof agent);
              }}
            >
              <SelectTrigger
                aria-label={tr("workspace.allAgents")}
                className="h-10 min-w-[146px] max-[520px]:min-w-0 max-[520px]:flex-1"
              >
                <SelectValue>
                  {agent === "all" ? tr("workspace.allAgents") : agentLabels[agent]}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{tr("workspace.allAgents")}</SelectItem>
                {Object.entries(agentLabels).map(([value, label]) => (
                  <SelectItem value={value} key={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={status}
              onValueChange={(value) => {
                if (value !== null) setStatus(String(value) as typeof status);
              }}
            >
              <SelectTrigger
                aria-label={tr("workspace.allStatuses")}
                className="h-10 min-w-[146px] max-[520px]:min-w-0 max-[520px]:flex-1"
              >
                <SelectValue>
                  {status === "all" ? tr("workspace.allStatuses") : workspaceStatusLabel(status)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{tr("workspace.allStatuses")}</SelectItem>
                <SelectItem value="healthy">{workspaceStatusLabel("healthy")}</SelectItem>
                <SelectItem value="attention">{workspaceStatusLabel("attention")}</SelectItem>
              </SelectContent>
            </Select>
            <Badge
              variant="outline"
              className="h-8 rounded-lg border-border bg-muted px-2.5 text-xs tabular-nums text-muted-foreground"
            >
              {tr("workspace.resultCount", { count: filtered.length })}
            </Badge>
            <Button
              variant="outline"
              size="icon"
              className="size-10 rounded-xl"
              title={tr("workspace.refreshDiscovery")}
              aria-label={tr("workspace.refreshDiscovery")}
              aria-busy={discoveryRefreshing}
              onClick={() => void onRefreshDiscovery()}
              disabled={discoveryRefreshing}
            >
              <RefreshCw size={15} className={discoveryRefreshing ? "animate-spin" : ""} />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
  if (view === "storage")
    return (
      <div className="grid gap-5">
        {pageIntro}
        <WorkspaceStoragePage workspaces={workspaces} job={storageJob} />
      </div>
    );
  return (
    <div className="grid gap-4">
      {pageIntro}
      {filterBar}
      <div className="grid items-start gap-5 min-[1024px]:grid-cols-[minmax(360px,1fr)_minmax(0,1.25fr)]">
        <section className="flex max-h-[680px] min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
          <header className="flex min-h-[58px] items-center justify-between gap-3 border-b border-border px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold text-foreground">{tr("nav.workspaces")}</h2>
              <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">
                {tr("workspace.resultCount", { count: filtered.length })}
              </p>
            </div>
            <span className="grid size-8 place-items-center rounded-lg bg-muted/70 text-muted-foreground">
              <FolderGit2 size={15} />
            </span>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {paginatedWorkspaces.map((workspace) => {
              const sourceAgents = workspace.sources
                .flatMap((source) => (source.agent ? [source.agent] : []))
                .filter((value, index, values) => values.indexOf(value) === index);
              const sourceLabel = sourceAgents.length
                ? sourceAgents.map((value) => agentLabels[value]).join(" · ")
                : tr("workspace.source.manual");
              return (
                <Button
                  key={workspace.id}
                  variant="bare"
                  size="content"
                  className={cn(
                    "group grid min-h-[72px] w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-xl px-3 py-2.5 text-left",
                    selectedWorkspace?.id === workspace.id
                      ? "bg-muted text-foreground shadow-xs"
                      : "text-muted-foreground hover:bg-muted/55 hover:text-foreground",
                  )}
                  onClick={() => setSelectedId(workspace.id)}
                  onDoubleClick={() => void onOpen(workspace)}
                >
                  <span className="grid size-9 place-items-center rounded-xl border border-border bg-background text-foreground transition-colors group-hover:border-primary/30">
                    <FolderGit2 size={16} />
                  </span>
                  <span className="min-w-0">
                    <strong
                      className="block truncate text-sm font-semibold text-foreground"
                      title={workspace.name}
                    >
                      {workspace.name}
                    </strong>
                    <small className="mt-1 block truncate text-xs" title={workspace.path}>
                      {workspace.path}
                    </small>
                  </span>
                  <span className="grid justify-items-end gap-1.5">
                    {workspace.status === "attention" ? (
                      <Badge variant="destructive" className="text-[10px]">
                        {workspaceStatusLabel("attention")}
                      </Badge>
                    ) : (
                      <span
                        className="size-1.5 rounded-full bg-[var(--green)]"
                        title={workspaceStatusLabel("healthy")}
                      />
                    )}
                    <span
                      className="flex items-center gap-0.5"
                      aria-label={sourceLabel}
                      title={sourceLabel}
                    >
                      {sourceAgents.length ? (
                        sourceAgents.slice(0, 3).map((value) => (
                          <span
                            className="grid size-5 place-items-center rounded-md border border-border bg-background"
                            key={value}
                          >
                            <AgentIcon agent={value} compact />
                          </span>
                        ))
                      ) : (
                        <small className="text-[11px]">{tr("workspace.source.manual")}</small>
                      )}
                      {sourceAgents.length > 3 && (
                        <span className="grid size-5 place-items-center rounded-md bg-muted text-[9px] font-semibold">
                          +{sourceAgents.length - 3}
                        </span>
                      )}
                    </span>
                  </span>
                </Button>
              );
            })}
            {!filtered.length && (
              <WorkspaceEmptyState
                title={tr("workspace.noMatch")}
                text={tr("workspace.noMatchText")}
              />
            )}
          </div>
          {filtered.length > 0 && (
            <footer className="flex min-h-[58px] items-center justify-between gap-3 border-t border-border px-4 py-3">
              <span className="text-xs tabular-nums text-muted-foreground">
                {pageStart}–{pageEnd} / {filtered.length}
              </span>
              {totalPages > 1 && (
                <div className="flex items-center gap-1" aria-label={tr("workspace.pagination")}>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={tr("workspace.previousPage")}
                    disabled={activePage === 1}
                    onClick={() => setPage((value) => Math.max(1, value - 1))}
                  >
                    <ChevronLeft size={15} />
                  </Button>
                  <span className="min-w-[52px] text-center text-xs tabular-nums text-muted-foreground">
                    {activePage} / {totalPages}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={tr("workspace.nextPage")}
                    disabled={activePage === totalPages}
                    onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
                  >
                    <ChevronRight size={15} />
                  </Button>
                </div>
              )}
            </footer>
          )}
        </section>
        {selectedWorkspace && (
          <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
            <header className="flex items-start justify-between gap-4 border-b border-border p-5">
              <div className="flex min-w-0 items-start gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-border bg-muted/50 text-foreground">
                  <FolderGit2 size={18} />
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="truncate text-lg font-semibold">{selectedWorkspace.name}</h2>
                    {selectedWorkspace.status === "attention" && (
                      <Badge variant="destructive" className="text-[10px]">
                        {workspaceStatusLabel("attention")}
                      </Badge>
                    )}
                  </div>
                  <code
                    className="mt-1 block truncate text-xs text-muted-foreground"
                    title={selectedWorkspace.path}
                  >
                    {selectedWorkspace.path}
                  </code>
                </div>
              </div>
              <Button
                className="shrink-0 rounded-lg"
                onClick={() => void onOpen(selectedWorkspace)}
              >
                {tr("common.details")}
                <ChevronRight size={15} />
              </Button>
            </header>
            <div className="grid grid-cols-3 divide-x divide-border border-b border-border">
              {[
                [tr("workspace.agentColumn"), selectedWorkspace.sources.length],
                [
                  tr("workspace.assetsColumn"),
                  assetCounts.get(selectedWorkspace.id) ?? selectedWorkspace.asset_count,
                ],
                [
                  tr("workspace.activityColumn"),
                  selectedWorkspace.last_active_at
                    ? relativeTime(selectedWorkspace.last_active_at)
                    : tr("common.never"),
                ],
              ].map(([label, value]) => (
                <div className="grid min-h-[84px] content-center gap-1 px-4" key={label}>
                  <span className="text-xs text-muted-foreground">{label}</span>
                  <strong className="truncate text-sm">{value}</strong>
                </div>
              ))}
            </div>
            <div className="grid gap-3 p-5">
              <div className="flex items-center justify-between gap-4 rounded-lg bg-muted/60 px-4 py-3">
                <span className="text-sm text-muted-foreground">
                  {tr("workspace.discoverySources")}
                </span>
                <strong className="text-sm">
                  {selectedWorkspace.sources
                    .flatMap((source) => (source.agent ? [agentLabels[source.agent]] : []))
                    .filter((value, index, values) => values.indexOf(value) === index)
                    .join(" · ") || tr("workspace.source.manual")}
                </strong>
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() => void onRefreshWorkspace(selectedWorkspace.id)}
                >
                  <RefreshCw size={15} />
                  {tr("common.scan")}
                </Button>
                <Button
                  variant="outline"
                  className="text-destructive"
                  onClick={() => void onExclude(selectedWorkspace.id)}
                >
                  <Trash2 size={15} />
                  {tr("workspace.ignore")}
                </Button>
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function WorkspaceEmptyState({ title, text }: { title: string; text: string }) {
  return (
    <div className="grid min-h-[260px] place-content-center justify-items-center gap-1.5 p-[30px] text-center text-muted-foreground">
      <FolderGit2 size={28} className="mb-1.5" />
      <h3 className="m-0 text-[13px] font-semibold text-foreground">{title}</h3>
      <p className="m-0 max-w-[380px] leading-relaxed">{text}</p>
    </div>
  );
}
function workspaceStatusLabel(status: WorkspaceSummary["status"]) {
  return tr(`status.workspace.${status}`);
}
function relativeTime(value: string) {
  return formatRelativeTime(value);
}

export const Route = createFileRoute("/workspaces")({ component: WorkspacesRoute });
