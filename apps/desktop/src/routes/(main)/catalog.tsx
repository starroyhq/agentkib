import { McpChoice, McpDisclosure } from "@/features/mcp/McpControls";
import { McpPortField } from "@/features/mcp/McpPortField";
import { useOptionalAppNavigationContext } from "@/features/app/AppNavigationContext";
import { navigationStyles } from "@/components/navigationStyles";
import { useI18n } from "@/core/useI18n";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { AgentIcon } from "@/features/agents/AgentIcon";
import { SidebarPanel } from "@/features/app/SidebarPanel";
import { AssetCatalogPage } from "@/features/catalog/AssetCatalogPage";
import { SkillHubPage, type SkillHubSection } from "@/features/skills/SkillHubPage";
import {
  MCP_ALL_SCOPES,
  McpManagementPanel,
  type McpEditorState,
} from "@/features/mcp/McpManagementPanel";
import { CatalogSkeleton } from "@/features/catalog/CatalogSkeleton";
import { useAppDialogs } from "@/components/AppDialogProvider";
import { MemoryCard } from "@/features/catalog/MemoryCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectItem } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api } from "@/core/api";
import { groupCatalogAssets } from "@/features/catalog/catalog";
import { useAppStore } from "@/stores/app-store";
import {
  homeKeys,
  queryDefaults,
  useHomeCatalog,
  useHomeMemories,
  useHomeWorkspaces,
} from "@/features/home/home-query";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import {
  preparedManifestBaseline,
  resolveRefreshedManifest,
} from "@/features/workspace/manifest-draft";
import {
  Boxes,
  Brain,
  Check,
  CircleAlert,
  ExternalLink,
  FileCode2,
  Library,
  Pencil,
  PlugZap,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import type {
  ChangeSet,
  CatalogAsset,
  Manifest,
  McpInstallation,
  McpRegistryEntry,
  MemoryRecord,
  MemoryType,
  RuntimeInfo,
  WorkspaceSummary,
} from "@/core/types";
import { cn } from "cn";
import { withAsyncCleanup } from "@/lib/utils";

type AssetSection = "instructions" | "skills" | "mcp" | "memory" | "other";
type CatalogSearch = {
  assetSection?: AssetSection;
  catalogTarget?: "mcp-network";
  skillSection?: SkillHubSection;
};

function CatalogRoute() {
  const { localizeMessage, tr } = useI18n();
  const dialogs = useAppDialogs();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const search = useSearch({ strict: false }) as CatalogSearch;
  const section =
    search.assetSection ?? (search.catalogTarget === "mcp-network" ? "mcp" : "instructions");
  const assetsQuery = useHomeCatalog();
  const workspacesQuery = useHomeWorkspaces();
  const memoriesQuery = useHomeMemories();
  const assets = assetsQuery.data ?? [];
  const workspaces = workspacesQuery.data ?? [];
  const memories = memoriesQuery.data ?? [];
  const retryPending = useRef(false);
  const runtime = useAppStore((state) => state.runtime);
  const setRuntime = useAppStore((state) => state.setRuntime);
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
    setBusy,
    setMessage,
  } = useWorkspaceStore();

  useEffect(
    () => () => {
      openRequest.current += 1;
    },
    [],
  );

  const setSection = (nextSection: AssetSection) => {
    void navigate({
      to: "/catalog",
      search: (current) =>
        ({ ...current, assetSection: nextSection, catalogTarget: undefined }) as never,
    });
  };
  const setSkillSection = (skillSection: SkillHubSection) => {
    void navigate({
      to: "/catalog",
      search: (current) => ({ ...current, skillSection }) as never,
    });
  };
  const consumeMcpNetworkTarget = useCallback(() => {
    void navigate({
      to: "/catalog",
      replace: true,
      search: (current) => ({ ...current, assetSection: "mcp", catalogTarget: undefined }) as never,
    });
  }, [navigate]);
  const reload = async () => {
    await queryClient.invalidateQueries({ queryKey: homeKeys.all });
  };
  const sources = [
    { labelKey: "query.catalog", query: assetsQuery },
    { labelKey: "query.workspaces", query: workspacesQuery },
    { labelKey: "query.memories", query: memoriesQuery },
  ];
  const dependencies =
    section === "memory"
      ? ["query.workspaces", "query.memories"]
      : section === "skills" || section === "mcp"
        ? ["query.workspaces"]
        : ["query.catalog", "query.workspaces"];
  const activeSources = sources.filter(({ labelKey }) => dependencies.includes(labelKey));
  // Skills and global MCP load their own data. Workspace enumeration only adds
  // project choices there; its failure must remain visible without hiding them.
  const requiredSources = section === "skills" || section === "mcp" ? [] : activeSources;
  const failed = activeSources.filter(({ query }) => query.isError);
  const initiallyFailed = failed.some(({ query }) => query.data === undefined);
  const contentUnavailable = requiredSources.some(({ query }) => query.data === undefined);
  const retryFailed = async () => {
    if (retryPending.current) return;
    retryPending.current = true;
    try {
      await Promise.allSettled(failed.map(({ query }) => query.refetch()));
    } finally {
      retryPending.current = false;
    }
  };
  const feedback = failed.length ? (
    <CatalogQueryFeedback
      labels={failed.map(({ labelKey }) => labelKey)}
      initial={initiallyFailed}
      retrying={failed.some(({ query }) => query.isFetching)}
      onRetry={() => void retryFailed()}
    />
  ) : null;
  const loading = requiredSources.some(({ query }) => query.isPending && query.data === undefined);
  const openWorkspace = async (workspace: WorkspaceSummary): Promise<boolean> => {
    const requestId = ++openRequest.current;
    const initialState = useWorkspaceStore.getState();
    const initialDraft = initialState.workspaceDrafts[workspace.id];
    const initialBaseline = initialState.workspaceDraftBaselines[workspace.id] ?? "";
    setBusy(true);
    setMessage("");
    return withAsyncCleanup(
      async () => {
        try {
          const runtimePromise = useAppStore.getState().runtime
            ? Promise.resolve(useAppStore.getState().runtime)
            : api.runtime();
          const [nextScan, nextRuntime] = await Promise.all([
            api.scan(workspace.path),
            runtimePromise,
          ]);
          if (requestId !== openRequest.current) return false;
          let nextManifest: Manifest | undefined;
          try {
            nextManifest = await api.manifest(workspace.path);
          } catch (error) {
            if (requestId === openRequest.current) setMessage(localizeMessage(error));
          }
          if (requestId !== openRequest.current) return false;
          let conflictRetained = false;
          const resolvedManifest = await resolveRefreshedManifest({
            initialManifest: initialDraft,
            initialBaseline,
            acknowledgedDisk: initialState.workspaceDraftDisks[workspace.id],
            diskManifest: nextManifest,
            diskIsDefault: !nextScan.manifest_exists,
            onConflictRetained: () => {
              conflictRetained = true;
            },
            getCurrentManifest: () => useWorkspaceStore.getState().workspaceDrafts[workspace.id],
            confirmDiskVersion: () =>
              dialogs.confirm({
                title: tr("workspace.refreshConflictTitle"),
                description: tr("workspace.refreshConflict"),
                confirmLabel: tr("workspace.refreshLoadDisk"),
                cancelLabel: tr("workspace.refreshKeepDraft"),
                tone: "warning",
              }),
          });
          if (requestId !== openRequest.current) return false;
          setChangeSet(undefined);
          setChangeSetOrigin("standard");
          setHandoffLaunchRequest(undefined);
          setProject(workspace.path);
          setScan(nextScan);
          setManifest(resolvedManifest);
          const nextBaseline = nextManifest
            ? conflictRetained
              ? preparedManifestBaseline(initialBaseline, nextManifest, !nextScan.manifest_exists)
              : JSON.stringify(nextManifest)
            : initialBaseline;
          setBaselineManifest(nextBaseline);
          useWorkspaceStore
            .getState()
            .cacheWorkspaceDraft(
              workspace.id,
              resolvedManifest,
              nextBaseline,
              nextManifest ? JSON.stringify(nextManifest) : undefined,
            );
          setRuntime(nextRuntime);
          setSelectedWorkspace(workspace);
          setBusy(false);
          await navigate({
            to: resolvedManifest ? "/workspace/$workspaceId" : "/workspace/$workspaceId/doctor",
            params: { workspaceId: workspace.id },
          });
          return Boolean(resolvedManifest);
        } catch (error) {
          if (requestId === openRequest.current) setMessage(localizeMessage(error));
          return false;
        }
      },
      () => {
        if (requestId === openRequest.current) setBusy(false);
      },
    );
  };
  const openWorkspaceById = async (id: string) => {
    const workspace = workspaces.find((item) => item.id === id);
    if (workspace) await openWorkspace(workspace);
  };
  const planMigration = async (project: string, planned: ChangeSet) => {
    const workspace = workspaces.find((item) => item.path === project);
    if (!workspace) return;
    if (!(await openWorkspace(workspace))) return;
    setChangeSet(planned);
    setChangeSetOrigin("standard");
    setHandoffLaunchRequest(undefined);
    await navigate({
      to: "/workspace/$workspaceId/changes",
      params: { workspaceId: workspace.id },
    });
  };

  return (
    <div className="grid gap-4">
      <CatalogPage
        section={section}
        onSection={setSection}
        skillSection={search.skillSection}
        onSkillSection={setSkillSection}
        assets={assets}
        assetsAvailable={assetsQuery.data !== undefined}
        workspaces={workspaces}
        memories={memories}
        memoriesAvailable={memoriesQuery.data !== undefined}
        runtime={runtime}
        onReload={reload}
        onRuntimeChanged={setRuntime}
        onOpen={(id) => void openWorkspaceById(id)}
        onMigrationPlanned={planMigration}
        focusMcpNetwork={section === "mcp" && search.catalogTarget === "mcp-network"}
        onMcpNetworkFocused={consumeMcpNetworkTarget}
        feedback={feedback}
        contentUnavailable={contentUnavailable}
        loading={loading}
      />
    </div>
  );
}

function CatalogQueryFeedback({
  labels,
  initial,
  retrying,
  onRetry,
}: {
  labels: string[];
  initial: boolean;
  retrying: boolean;
  onRetry: () => void;
}) {
  const { tr } = useI18n();
  return (
    <section
      role="alert"
      className="grid gap-3 rounded-xl border border-destructive/30 bg-card p-5"
    >
      <h2 className="text-base font-semibold">{tr("query.loadFailed")}</h2>
      <p className="text-sm text-muted-foreground">
        {tr(initial ? "query.initialUnavailable" : "query.staleData")}
      </p>
      <ul className="list-inside list-disc text-sm">
        {labels.map((label) => (
          <li key={label}>{tr(label)}</li>
        ))}
      </ul>
      <Button className="justify-self-start" disabled={retrying} onClick={onRetry}>
        {tr("runtime.retry")}
      </Button>
    </section>
  );
}

function CatalogPage({
  section,
  onSection,
  skillSection,
  onSkillSection,
  assets,
  assetsAvailable,
  workspaces,
  memories,
  memoriesAvailable,
  runtime,
  onReload,
  onRuntimeChanged,
  onOpen,
  onMigrationPlanned,
  focusMcpNetwork,
  onMcpNetworkFocused,
  feedback,
  contentUnavailable,
  loading,
}: {
  section: AssetSection;
  onSection: (section: AssetSection) => void;
  skillSection?: SkillHubSection;
  onSkillSection: (section: SkillHubSection) => void;
  assets: CatalogAsset[];
  assetsAvailable: boolean;
  workspaces: WorkspaceSummary[];
  memories: MemoryRecord[];
  memoriesAvailable: boolean;
  runtime?: RuntimeInfo;
  onReload: () => Promise<void>;
  onRuntimeChanged: (runtime: RuntimeInfo) => void;
  onOpen: (id: string) => void;
  onMigrationPlanned: (project: string, changeSet: ChangeSet) => Promise<void>;
  focusMcpNetwork?: boolean;
  onMcpNetworkFocused: () => void;
  feedback: ReactNode;
  contentUnavailable: boolean;
  loading: boolean;
}) {
  const { tr } = useI18n();
  const pending = memories.filter((item) => item.status === "pending").length;
  const workspaceAssets = useMemo(
    () => groupCatalogAssets(assets.filter((asset) => asset.scope === "workspace")),
    [assets],
  );
  const instructionAssets = workspaceAssets.filter((asset) => asset.kind === "instruction");
  const otherAssets = workspaceAssets.filter(
    (asset) => !["instruction", "skill", "connection", "memory"].includes(asset.kind),
  );
  const pendingMemoryLabel = pending ? tr("memory.pendingCount", { count: pending }) : undefined;
  const AssetPage = AssetCatalogPage;
  const catalogSections: Array<{
    id: AssetSection;
    label: string;
    icon: ComponentType<{ size?: number }>;
    count?: number;
    badgeLabel?: string;
  }> = [
    {
      id: "instructions",
      label: tr("assets.instructions"),
      icon: FileCode2,
      count: assetsAvailable ? instructionAssets.length : undefined,
    },
    { id: "skills", label: tr("assets.skills"), icon: Sparkles },
    { id: "mcp", label: "MCP", icon: PlugZap },
    {
      id: "memory",
      label: tr("assets.memories"),
      icon: Brain,
      count: memoriesAvailable ? memories.length : undefined,
      badgeLabel: pendingMemoryLabel,
    },
    {
      id: "other",
      label: tr("assets.hooksProfiles"),
      icon: Boxes,
      count: assetsAvailable ? otherAssets.length : undefined,
    },
  ];
  return (
    <div className="relative grid gap-5 pb-8">
      <SidebarPanel>
        {/* 这是切换本页分区的导航，不是带面板的 Tabs：用按钮 + aria-current。 */}
        <nav className="catalog-sidebar-navigation grid gap-0.5" aria-label={tr("nav.assets")}>
          {catalogSections.map(({ id, label, icon: Icon, count, badgeLabel }) => (
            <Button
              key={id}
              variant="bare"
              size="content"
              data-sidebar-navigate
              className={cn(
                navigationStyles.appSidebarItem,
                "h-10 gap-2 px-3",
                section === id && navigationStyles.appSidebarItemActive,
              )}
              aria-current={section === id ? "page" : undefined}
              aria-label={count === undefined ? label : `${label} ${badgeLabel ?? count}`}
              onClick={() => onSection(id)}
            >
              <Icon size={15} />
              {label}
              {count !== undefined && (
                <span
                  className={cn(
                    "ml-auto min-w-5 text-center text-[11px] tabular-nums",
                    id === "memory" && pending > 0
                      ? "text-amber-700 dark:text-amber-400"
                      : "text-muted-foreground",
                  )}
                  aria-label={badgeLabel}
                  title={badgeLabel}
                >
                  {count}
                </span>
              )}
            </Button>
          ))}
        </nav>
      </SidebarPanel>
      {feedback}
      {loading && <CatalogSkeleton />}
      {!contentUnavailable && section === "instructions" && (
        <AssetPage assets={instructionAssets} workspaces={workspaces} onOpen={onOpen} />
      )}
      {!contentUnavailable && section === "skills" && (
        <SkillHubPage
          section={skillSection}
          onSectionChange={onSkillSection}
          workspaces={workspaces}
          onOpen={onOpen}
          onReload={onReload}
        />
      )}
      {!contentUnavailable && section === "other" && (
        <AssetPage assets={otherAssets} workspaces={workspaces} onOpen={onOpen} />
      )}
      {!contentUnavailable && section === "memory" && (
        <GlobalMemoryInbox records={memories} workspaces={workspaces} onReload={onReload} />
      )}
      {!contentUnavailable && section === "mcp" && (
        <McpHubPage
          runtime={runtime}
          workspaces={workspaces}
          onRuntimeChanged={onRuntimeChanged}
          onMigrationPlanned={onMigrationPlanned}
          focusNetworkSettings={focusMcpNetwork}
          onNetworkSettingsFocused={onMcpNetworkFocused}
        />
      )}
    </div>
  );
}

function GlobalMemoryInbox({
  records,
  workspaces,
  onReload,
}: {
  records: MemoryRecord[];
  workspaces: WorkspaceSummary[];
  onReload: () => Promise<void>;
}) {
  const { tr } = useI18n();
  const pendingCount = records.filter((item) => item.status === "pending").length;
  const approvedCount = records.filter((item) => item.status === "approved").length;
  const review = async (
    id: string,
    status: "approved" | "rejected" | "invalidated",
    editedContent?: string,
  ) => {
    await api.reviewMemory(id, status, editedContent);
    await onReload();
  };
  return (
    <div className="mx-auto grid w-full max-w-6xl gap-4 pb-8">
      <Card className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-4 border-b border-border px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="grid size-11 shrink-0 place-items-center rounded-xl bg-muted text-foreground">
              <Brain size={21} />
            </div>
            <div className="min-w-0">
              <CardTitle className="text-lg">{tr("memory.globalTitle")}</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                {tr("memory.globalPending", { count: pendingCount })}
              </p>
            </div>
          </div>
          <div className="flex w-full max-w-full flex-wrap items-center gap-2 sm:w-auto">
            <span className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-background px-3 text-sm text-muted-foreground">
              {tr("assets.memories")}
              <strong className="font-semibold text-foreground">{records.length}</strong>
            </span>
            <span
              className={cn(
                "inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-sm",
                pendingCount > 0
                  ? "border-[color-mix(in_srgb,var(--amber)_40%,transparent)] bg-[color-mix(in_srgb,var(--amber)_10%,transparent)] text-[var(--amber)]"
                  : "border-border bg-background text-muted-foreground",
              )}
            >
              {tr("status.memory.pending")}
              <strong className="font-semibold">{pendingCount}</strong>
            </span>
            {approvedCount > 0 && (
              <span className="inline-flex h-9 items-center gap-2 rounded-lg border border-[color-mix(in_srgb,var(--green)_40%,transparent)] bg-[color-mix(in_srgb,var(--green)_10%,transparent)] px-3 text-sm text-[var(--green)]">
                {tr("status.memory.approved")}
                <strong className="font-semibold">{approvedCount}</strong>
              </span>
            )}
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-9 rounded-lg"
              aria-label={tr("common.refresh")}
              title={tr("common.refresh")}
              onClick={() => void onReload()}
            >
              <RefreshCw size={15} />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-4 sm:p-5">
          {records.map((record) => (
            <div
              key={record.id}
              className="mb-3 grid gap-2 rounded-xl border border-border bg-background p-4 last:mb-0"
            >
              <span className="text-xs font-semibold text-muted-foreground">
                {workspaces.find((item) => item.manifest_workspace_id === record.project_id)
                  ?.name ?? record.project_id.slice(0, 8)}
              </span>
              <MemoryCard record={record} onReview={review} />
            </div>
          ))}
          {!records.length && (
            <div className="grid min-h-56 place-items-center rounded-xl border border-dashed border-border bg-muted/20 px-5 py-8 text-center">
              <div className="grid max-w-lg justify-items-center gap-3">
                <div className="grid size-12 place-items-center rounded-2xl border border-border bg-card text-muted-foreground shadow-sm">
                  <Brain size={22} />
                </div>
                <div className="grid gap-1.5">
                  <h3 className="m-0 text-base font-semibold text-foreground">
                    {tr("memory.empty")}
                  </h3>
                  <p className="m-0 text-sm leading-relaxed text-muted-foreground">
                    {tr("memory.globalEmptyText")}
                  </p>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function McpHubPage({
  runtime,
  workspaces: suppliedWorkspaces,
  onRuntimeChanged,
  focusNetworkSettings = false,
  onNetworkSettingsFocused,
}: {
  runtime?: RuntimeInfo;
  workspaces: WorkspaceSummary[];
  onRuntimeChanged: (runtime: RuntimeInfo) => void;
  onMigrationPlanned: (project: string, changeSet: ChangeSet) => Promise<void>;
  focusNetworkSettings?: boolean;
  onNetworkSettingsFocused?: () => void;
}) {
  const { localizeMessage, tr } = useI18n();
  const workspaces = suppliedWorkspaces.filter((workspace) => !workspace.remote);
  const navigation = useOptionalAppNavigationContext();
  const networkSettings = useRef<HTMLDivElement>(null);
  const networkFocusHandled = useRef(false);
  const [advanced, setAdvanced] = useState({
    requested: focusNetworkSettings,
    open: focusNetworkSettings,
  });
  // A new navigation request opens this panel without remounting its editable fields.
  if (advanced.requested !== focusNetworkSettings) {
    setAdvanced({ requested: focusNetworkSettings, open: advanced.open || focusNetworkSettings });
  }
  useEffect(() => {
    if (!focusNetworkSettings) {
      networkFocusHandled.current = false;
      return;
    }
    if (networkFocusHandled.current) return;
    const target = networkSettings.current;
    target?.scrollIntoView?.({ block: "start" });
    // Keep an active field focused: moving focus would trigger its blur-to-save handler.
    if (target && !target.contains(document.activeElement)) target.focus({ preventScroll: true });
    if (target) {
      networkFocusHandled.current = true;
      onNetworkSettingsFocused?.();
    }
  }, [focusNetworkSettings, onNetworkSettingsFocused]);
  const dialogs = useAppDialogs();
  const queryClient = useQueryClient();
  const [registryRequest, setRegistryRequest] = useState<string>();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState(MCP_ALL_SCOPES);
  const [registryTarget, setRegistryTarget] = useState<string>();
  const [drafts] = useState(() => new Map<string, McpEditorState>());
  const [actionBusy, setBusy] = useState(false);
  const [actionError, setError] = useState("");
  const actionPending = useRef(false);
  const scopeEpoch = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      scopeEpoch.current += 1;
    };
  }, []);
  const allScopes = scope === MCP_ALL_SCOPES;
  const project = allScopes ? undefined : scope || undefined;
  const registryProject = allScopes
    ? registryTarget === "__global_scope__"
      ? undefined
      : registryTarget
    : project;
  const registryDestinationChosen = !allScopes || registryTarget !== undefined;
  const installationsQuery = useQuery({
    ...queryDefaults,
    queryKey: ["mcp", "installations"],
    queryFn: () => api.mcpInstallations(),
    staleTime: 0,
  });
  const runtimesQuery = useQuery({
    ...queryDefaults,
    queryKey: ["mcp", "runtimes"],
    queryFn: () => api.mcpRuntimes(),
    staleTime: 0,
  });
  const runtimeQuery = useQuery({
    ...queryDefaults,
    queryKey: ["mcp", "runtime"],
    queryFn: () => api.runtime(),
    staleTime: 0,
  });
  const registryQuery = useQuery({
    ...queryDefaults,
    queryKey: ["mcp", "registry", registryRequest],
    queryFn: () => api.searchMcpRegistry(registryRequest!),
    enabled: registryRequest !== undefined,
    staleTime: 0,
  });
  const registry = registryQuery.data ?? [];
  const busy = actionBusy || registryQuery.isFetching;
  const installations = installationsQuery.data ?? [];
  // Older runtimes do not report ownership; never infer it from the selected scope.
  const runtimes = (runtimesQuery.data ?? []).filter(
    (item) =>
      item.project !== undefined &&
      (allScopes
        ? item.project === null || workspaces.some((workspace) => workspace.path === item.project)
        : item.project === (project ?? null)),
  );
  const queryError = installationsQuery.error ?? runtimesQuery.error ?? runtimeQuery.error;
  const error = actionError || (queryError ? localizeMessage(queryError) : "");
  const runtimeChanged = useRef(onRuntimeChanged);
  useEffect(() => {
    runtimeChanged.current = onRuntimeChanged;
  }, [onRuntimeChanged]);
  useEffect(() => {
    if (runtimeQuery.data) runtimeChanged.current(runtimeQuery.data);
  }, [runtimeQuery.data]);
  const refreshHost = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["mcp", "installations"] }),
      queryClient.invalidateQueries({ queryKey: ["mcp", "runtimes"] }),
      queryClient.invalidateQueries({ queryKey: ["mcp", "runtime"] }),
    ]);
  };
  const load = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["mcp", "management"] }),
      refreshHost(),
    ]);
  };
  const changeScope = (nextScope: string) => {
    if (nextScope === scope) return;
    scopeEpoch.current += 1;
    setError("");
    setRegistryTarget(undefined);
    setScope(nextScope);
  };
  const runAction = async (
    action: (isCurrent: () => boolean) => Promise<void>,
    errorScope: "scope" | "global" = "scope",
  ) => {
    if (actionPending.current) return;
    actionPending.current = true;
    const epoch = scopeEpoch.current;
    const isCurrent = () => alive.current && epoch === scopeEpoch.current;
    setBusy(true);
    setError("");
    try {
      await action(isCurrent);
    } catch (reason) {
      if (alive.current && (errorScope === "global" || isCurrent()))
        setError(localizeMessage(reason));
    } finally {
      actionPending.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const searchRegistry = async () => {
    if (actionPending.current || registryQuery.isFetching) return;
    setError("");
    if (registryRequest === query) await registryQuery.refetch({ cancelRefetch: false });
    else setRegistryRequest(query);
  };
  const install = async (entry: McpRegistryEntry) => {
    if (!registryDestinationChosen) return;
    const command =
      entry.package_kind === "remote"
        ? entry.url
        : `${entry.package_kind === "npm" ? "npm" : "uv"} · ${entry.identifier}@${entry.version}`;
    await runAction(async (isCurrent) => {
      if (!(await dialogs.confirm(tr("mcp.installConfirm", { name: entry.name, command })))) return;
      if (!isCurrent()) return;
      const env = await dialogs.requestSecrets(entry.required_env);
      if (env === null || !isCurrent()) return;
      const result = await api.installMcp(entry, registryProject);
      if (Object.keys(env).length)
        await api.saveMcpLocalValues(result.server.id, env, {}, registryProject);
      await load();
    });
  };
  const updateInstallation = async (installation: McpInstallation, entry: McpRegistryEntry) => {
    if (!registryDestinationChosen) return;
    await runAction(async (isCurrent) => {
      if (
        !(await dialogs.confirm(
          tr("mcp.updateConfirm", { name: installation.name, version: entry.version }),
        )) ||
        !isCurrent()
      )
        return;
      const env = await dialogs.requestSecrets(entry.required_env);
      if (env === null || !isCurrent()) return;
      const result = await api.updateMcp(installation.id, entry, registryProject);
      if (Object.keys(env).length)
        await api.saveMcpLocalValues(result.server.id, env, {}, registryProject);
      await load();
    });
  };
  const updateNetwork = async (lanEnabled: boolean) => {
    await runAction(async (isCurrent) => {
      if (
        lanEnabled &&
        !(await dialogs.confirm({ description: tr("mcp.lanWarning"), tone: "warning" }))
      )
        return;
      if (!isCurrent()) return;
      await api.updateMcpNetwork({
        port: runtime?.mcp_network?.port ?? 47653,
        lan_enabled: lanEnabled,
        lan_risk_accepted: lanEnabled,
      });
      const nextRuntime = await api.runtime();
      if (alive.current) onRuntimeChanged(nextRuntime);
    }, "global");
  };
  const updatePort = async (port: number): Promise<number | undefined> => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) return;
    let confirmedPort: number | undefined;
    await runAction(async () => {
      // Retire an older runtime read before saving so it cannot overwrite the readback.
      await queryClient.cancelQueries({ queryKey: ["mcp", "runtime"], exact: true });
      await api.updateMcpNetwork({
        port,
        lan_enabled: runtime?.mcp_network?.lan_enabled ?? false,
        lan_risk_accepted: runtime?.mcp_network?.lan_risk_accepted ?? false,
      });
      const nextRuntime = await api.runtime();
      if (!alive.current) return;
      // Other MCP panels can refresh during the write; retire those older reads as well.
      await queryClient.cancelQueries({ queryKey: ["mcp", "runtime"], exact: true });
      if (!alive.current) return;
      queryClient.setQueryData(["mcp", "runtime"], nextRuntime);
      if (nextRuntime.mcp_network.port !== port) throw new Error(tr("mcp.portUnconfirmed"));
      confirmedPort = nextRuntime.mcp_network.port;
    }, "global");
    return confirmedPort;
  };
  return (
    <div className="grid gap-5">
      <header className="grid gap-1">
        <h1 className="text-xl font-semibold">{tr("mcp.servicesTitle")}</h1>
        <p role="note" className="text-sm text-muted-foreground">
          {tr("mcp.hubExplanation")}
        </p>
      </header>
      <McpManagementPanel
        key={scope}
        scope={scope}
        onScopeChange={changeScope}
        onOpenIntegrations={
          navigation
            ? () => navigation.app.openSettings("integrations", "integrations-mcp")
            : undefined
        }
        project={project}
        workspaces={workspaces}
        onChanged={refreshHost}
        drafts={drafts}
      />
      {error && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive-text"
        >
          <CircleAlert size={16} />
          {error}
        </div>
      )}
      {actionBusy && (
        <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <RefreshCw size={14} className="animate-spin" />
          {tr("common.loading")}
        </div>
      )}
      <McpDisclosure
        className="rounded-xl border"
        title={<>{tr("mcp.manage.advanced")}</>}
        description={tr("mcp.manage.advancedSections")}
        open={advanced.open}
        onOpenChange={(open) => setAdvanced((current) => ({ ...current, open }))}
      >
        {allScopes && (
          <McpChoice
            value={registryTarget ?? "__choose_scope__"}
            aria-label={tr("mcp.manage.targetScope")}
            onValueChange={(value) => {
              scopeEpoch.current += 1;
              setError("");
              setRegistryTarget(value);
            }}
          >
            <SelectItem value="__choose_scope__" disabled>
              {tr("mcp.manage.chooseScope")}
            </SelectItem>
            <SelectItem value="__global_scope__">{tr("mcp.globalScope")}</SelectItem>
            {workspaces.map((workspace) => (
              <SelectItem key={workspace.id} value={workspace.path}>
                {workspace.name}
              </SelectItem>
            ))}
          </McpChoice>
        )}
        <div className="grid gap-4 rounded-2xl border border-border bg-card p-5 md:grid-cols-[minmax(0,1fr)_auto]">
          <div className="grid gap-1.5">
            <span className="text-xs font-semibold uppercase tracking-[.12em] text-muted-foreground">
              {tr("mcp.hubLabel")}
            </span>
            <h2>{tr("mcp.title")}</h2>
          </div>
          <div className="grid gap-1.5 text-right text-sm text-muted-foreground">
            <span
              className={cn(
                "font-medium",
                runtime?.mcp_hub?.running ? "text-emerald-600" : "text-destructive-text",
              )}
            >
              {tr(runtime?.mcp_hub?.running ? "mcp.running" : "mcp.stopped")}
            </span>
            <code>{runtime?.mcp_hub ? runtime.mcp_hub.accessible_addresses.join(" · ") : "—"}</code>
            <small>{tr("mcp.runtimeCount", { count: runtime?.mcp_hub?.runtime_count ?? 0 })}</small>
          </div>
        </div>
        <div
          ref={networkSettings}
          id="catalog-mcp-network"
          tabIndex={-1}
          aria-label={tr("mcp.network")}
          className="grid scroll-mt-6 gap-5 rounded-2xl border border-border bg-card p-5 shadow-sm outline-none md:grid-cols-[minmax(0,1fr)_auto]"
        >
          <div className="grid gap-1.5">
            <h2>{tr("mcp.network")}</h2>
          </div>
          <div className="flex flex-wrap items-end gap-4">
            <McpPortField
              port={runtime?.mcp_network?.port ?? 47653}
              disabled={busy}
              onCommit={updatePort}
            />
            <Label className="!grid gap-2">
              <span>{tr("mcp.lanMode")}</span>
              <Switch
                disabled={busy}
                checked={runtime?.mcp_network?.lan_enabled ?? false}
                onCheckedChange={(checked) => void updateNetwork(checked)}
              />
            </Label>
          </div>
        </div>
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
            <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-5">
              <div className="grid gap-1.5">
                <h2>{tr("mcp.registry")}</h2>
              </div>
            </div>
            <div className="flex items-center gap-2 p-5">
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void searchRegistry();
                }}
                placeholder={tr("mcp.searchPlaceholder")}
              />
              <Button
                className="bg-primary text-primary-foreground hover:bg-[var(--primary-hover-strong)]"
                disabled={busy}
                onClick={() => void searchRegistry()}
              >
                <Search size={14} />
                {tr("common.search")}
              </Button>
            </div>
            <div className="grid divide-y divide-border px-5">
              {registry.map((entry) => (
                <article
                  className="grid gap-4 py-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center"
                  key={`${entry.name}-${entry.version}`}
                >
                  <div className="grid gap-1">
                    <strong>{entry.name}</strong>
                    <small>{entry.description}</small>
                    <span>
                      {entry.package_kind} · {entry.version}
                      {entry.required_env.length
                        ? ` · ${tr("mcp.requiredEnv", { count: entry.required_env.length })}`
                        : ""}
                    </span>
                  </div>
                  <Button
                    className="border border-transparent bg-transparent text-foreground hover:bg-muted"
                    disabled={busy || !registryDestinationChosen}
                    onClick={() => void install(entry)}
                  >
                    {tr("mcp.install")}
                  </Button>
                </article>
              ))}
              {registryQuery.isError && (
                <p role="alert" className="py-6 text-sm text-destructive-text">
                  {tr("mcp.registrySearchFailed")} {localizeMessage(registryQuery.error)}
                </p>
              )}
              {!registry.length && !registryQuery.isError && (
                <p
                  role={registryQuery.isFetching ? "status" : undefined}
                  className="py-6 text-sm text-muted-foreground"
                >
                  {tr(
                    registryQuery.isFetching
                      ? "mcp.registrySearching"
                      : registryRequest === undefined
                        ? "mcp.registryEmpty"
                        : "mcp.registryNoResults",
                  )}
                </p>
              )}
            </div>
          </div>
        </div>
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
            <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-5">
              <div className="grid gap-1.5">
                <h2>{tr("mcp.installations")}</h2>
                <p>{runtime?.mcp_package_root}</p>
                <p className="text-sm text-muted-foreground">{tr("mcp.checkUpdatesHint")}</p>
              </div>
              <Badge variant="outline">{installations.length}</Badge>
            </div>
            <div className="grid divide-y divide-border px-5">
              {installations.map((item) => {
                const update = registry.find(
                  (entry) =>
                    entry.package_kind === item.package_kind &&
                    entry.identifier === item.identifier &&
                    entry.version !== item.version,
                );
                return (
                  <article
                    className="grid gap-4 py-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center"
                    key={item.id}
                  >
                    <div className="grid gap-1">
                      <strong>{item.name}</strong>
                      <small>{item.identifier}</small>
                      <span>
                        {item.package_kind} · {item.version ?? "—"}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {update && (
                        <Button
                          className="border border-transparent bg-transparent text-foreground hover:bg-muted"
                          disabled={busy || !registryDestinationChosen}
                          onClick={() => void updateInstallation(item, update)}
                        >
                          {tr("mcp.update")}
                        </Button>
                      )}
                      <Button
                        variant="destructive"
                        size="icon"
                        disabled={busy}
                        aria-label={`${tr("mcp.uninstall")} ${item.name}`}
                        title={`${tr("mcp.uninstall")} ${item.name}`}
                        onClick={() =>
                          void runAction(async (isCurrent) => {
                            if (
                              !(await dialogs.confirm({
                                description: tr("mcp.uninstallConfirm", { name: item.name }),
                                tone: "destructive",
                              })) ||
                              !isCurrent()
                            )
                              return;
                            await api.uninstallMcp(item.id);
                            await load();
                          }, "global")
                        }
                      >
                        <Trash2 size={14} />
                      </Button>
                    </div>
                  </article>
                );
              })}
              {!installations.length && (
                <p className="py-6 text-sm text-muted-foreground">{tr("mcp.installationsEmpty")}</p>
              )}
            </div>
          </div>
          <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
            <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-5">
              <div className="grid gap-1.5">
                <h2>{tr("mcp.runtimes")}</h2>
              </div>
              <Button
                className="border border-transparent bg-transparent text-foreground hover:bg-muted"
                disabled={busy}
                onClick={() => void runAction(async () => load())}
              >
                <RefreshCw size={13} />
                {tr("common.refresh")}
              </Button>
            </div>
            <div className="grid divide-y divide-border px-5">
              {runtimes.map((item) => (
                <article
                  className="grid gap-4 py-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center"
                  key={JSON.stringify([item.project, item.config_hash])}
                >
                  <div className="grid gap-1">
                    <strong>{item.server_name}</strong>
                    {allScopes && (
                      <Badge variant="secondary" className="justify-self-start">
                        {item.project
                          ? tr("mcp.manage.projectScope", {
                              name:
                                workspaces.find((workspace) => workspace.path === item.project)
                                  ?.name ?? item.project,
                            })
                          : tr("mcp.globalScope")}
                      </Badge>
                    )}
                    <small>{item.config_hash.slice(0, 16)}…</small>
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 rounded-md text-xs font-medium",
                        item.state === "running" ? "text-emerald-600" : "text-destructive-text",
                      )}
                    >
                      {tr(`mcp.runtime.${item.state}`)}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      className="border border-transparent bg-transparent text-foreground hover:bg-muted"
                      disabled={busy}
                      onClick={() =>
                        void runAction(async () => {
                          await api.restartMcpRuntime(item.server_id, item.project ?? undefined);
                          await load();
                        })
                      }
                    >
                      {tr("mcp.restart")}
                    </Button>
                    <Button
                      className="border border-transparent bg-transparent text-foreground hover:bg-muted"
                      disabled={busy}
                      onClick={() =>
                        void runAction(async (isCurrent) => {
                          if (
                            !(await dialogs.confirm({
                              description: tr("mcp.stopAllScopesConfirm", {
                                name: item.server_name,
                              }),
                              tone: "warning",
                            })) ||
                            !isCurrent()
                          )
                            return;
                          await api.stopMcpRuntime(item.server_id);
                          await load();
                        }, "global")
                      }
                    >
                      {tr("mcp.stopAllScopes")}
                    </Button>
                  </div>
                </article>
              ))}
              {!runtimes.length && (
                <p className="py-6 text-sm text-muted-foreground">{tr("mcp.runtimesEmpty")}</p>
              )}
            </div>
          </div>
        </div>
      </McpDisclosure>
    </div>
  );
}
function CatalogEmpty({ title, text }: { title: string; text: string }) {
  return (
    <div className="grid min-h-[260px] place-content-center justify-items-center gap-1.5 p-[30px] text-center text-muted-foreground">
      <Brain size={28} className="mb-1.5" />
      <h3 className="m-0 text-[13px] font-semibold text-foreground">{title}</h3>
      <p className="m-0 max-w-[380px] leading-relaxed">{text}</p>
    </div>
  );
}

export const Route = createFileRoute("/(main)/catalog")({
  staticData: { appRoute: { kind: "global", page: "catalog" } },
  component: CatalogRoute,
});
