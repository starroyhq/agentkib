import { navigationStyles } from "@/components/navigationStyles";
import { useI18n } from "@/core/useI18n";
import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { AgentIcon } from "@/features/agents/AgentIcon";
import { SidebarPanel } from "@/features/app/SidebarPanel";
import { AssetCatalogPage } from "@/features/catalog/AssetCatalogPage";
import { SkillHubPage } from "@/features/skills/SkillHubPage";
import { CatalogSkeleton } from "@/features/catalog/CatalogSkeleton";
import { useAppDialogs } from "@/components/AppDialogProvider";
import { MemoryCard } from "@/features/catalog/MemoryCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api } from "../core/api";
import { groupCatalogAssets } from "@/features/catalog/catalog";
import { useAppStore } from "../stores/app-store";
import {
  homeKeys,
  useHomeCatalog,
  useHomeMemories,
  useHomeWorkspaces,
} from "@/features/home/home-query";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
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
  McpRuntimeStatus,
  McpServerConfig,
  MemoryRecord,
  MemoryType,
  RuntimeInfo,
  WorkspaceSummary,
} from "../core/types";
import { cn, withAsyncCleanup } from "@/lib/utils";
import { AGENT_LABELS as agentLabels } from "@/core/agents";

type AssetSection = "instructions" | "skills" | "mcp" | "memory" | "other";
type CatalogSearch = { assetSection?: AssetSection };

function CatalogRoute() {
  const { localizeMessage } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const search = useSearch({ strict: false }) as CatalogSearch;
  const section = search.assetSection ?? "instructions";
  const { data: assets = [], isPending: assetsPending } = useHomeCatalog();
  const { data: workspaces = [], isPending: workspacesPending } = useHomeWorkspaces();
  const { data: memories = [], isPending: memoriesPending } = useHomeMemories();
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
    workspaceDrafts,
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
      search: (current) => ({ ...current, assetSection: nextSection }) as never,
    });
  };
  const reload = async () => {
    await queryClient.invalidateQueries({ queryKey: homeKeys.all });
  };
  if (assetsPending || workspacesPending || memoriesPending) return <CatalogSkeleton />;
  const openWorkspace = async (workspace: WorkspaceSummary): Promise<boolean> => {
    const requestId = ++openRequest.current;
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
          setChangeSet(undefined);
          setChangeSetOrigin("standard");
          setHandoffLaunchRequest(undefined);
          setProject(workspace.path);
          setScan(nextScan);
          setManifest(nextManifest ? (workspaceDrafts[workspace.id] ?? nextManifest) : undefined);
          setBaselineManifest(nextManifest ? JSON.stringify(nextManifest) : "");
          setRuntime(nextRuntime);
          setSelectedWorkspace(workspace);
          setBusy(false);
          await navigate({
            to: nextManifest ? "/workspace/$workspaceId" : "/workspace/$workspaceId/doctor",
            params: { workspaceId: workspace.id },
          });
          return Boolean(nextManifest);
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
    <CatalogPage
      section={section}
      onSection={setSection}
      assets={assets}
      workspaces={workspaces}
      memories={memories}
      runtime={runtime}
      onReload={reload}
      onRuntimeChanged={setRuntime}
      onOpen={(id) => void openWorkspaceById(id)}
      onMigrationPlanned={planMigration}
    />
  );
}

function CatalogPage({
  section,
  onSection,
  assets,
  workspaces,
  memories,
  runtime,
  onReload,
  onRuntimeChanged,
  onOpen,
  onMigrationPlanned,
}: {
  section: AssetSection;
  onSection: (section: AssetSection) => void;
  assets: CatalogAsset[];
  workspaces: WorkspaceSummary[];
  memories: MemoryRecord[];
  runtime?: RuntimeInfo;
  onReload: () => Promise<void>;
  onRuntimeChanged: (runtime: RuntimeInfo) => void;
  onOpen: (id: string) => void;
  onMigrationPlanned: (project: string, changeSet: ChangeSet) => Promise<void>;
}) {
  const { tr } = useI18n();
  const pending = memories.filter((item) => item.status === "pending").length;
  const workspaceAssets = useMemo(
    () => groupCatalogAssets(assets.filter((asset) => asset.scope === "workspace")),
    [assets],
  );
  const instructionAssets = workspaceAssets.filter((asset) => asset.kind === "instruction");
  const skillAssets = workspaceAssets.filter((asset) => asset.kind === "skill");
  const connectionAssets = workspaceAssets.filter((asset) => asset.kind === "connection");
  const otherAssets = workspaceAssets.filter(
    (asset) => !["instruction", "skill", "connection", "memory"].includes(asset.kind),
  );
  const pendingMemoryLabel = pending ? tr("memory.pendingCount", { count: pending }) : undefined;
  const AssetPage = AssetCatalogPage;
  const catalogSections: Array<{
    id: AssetSection;
    label: string;
    icon: ComponentType<{ size?: number }>;
    count: number;
    badgeLabel?: string;
    highlight?: boolean;
  }> = [
    {
      id: "instructions",
      label: tr("assets.instructions"),
      icon: FileCode2,
      count: instructionAssets.length,
    },
    { id: "skills", label: tr("assets.skills"), icon: Sparkles, count: skillAssets.length },
    { id: "mcp", label: "MCP", icon: PlugZap, count: connectionAssets.length },
    {
      id: "memory",
      label: tr("assets.memories"),
      icon: Brain,
      count: memories.length,
      badgeLabel: pendingMemoryLabel,
      highlight: !!pending,
    },
    { id: "other", label: tr("assets.hooksProfiles"), icon: Boxes, count: otherAssets.length },
  ];
  return (
    <div className="relative grid gap-5 pb-8">
      <SidebarPanel>
        {/* 这是切换本页分区的导航，不是带面板的 Tabs：用按钮 + aria-current。 */}
        <nav className="catalog-sidebar-navigation grid gap-0.5" aria-label={tr("nav.assets")}>
          {catalogSections.map(({ id, label, icon: Icon, count, badgeLabel, highlight }) => (
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
              onClick={() => onSection(id)}
            >
              <Icon size={15} />
              {label}
              <Badge
                variant="secondary"
                className={cn(
                  "ml-auto min-w-5 justify-center rounded-full px-1.5 py-0 text-[11px]",
                  highlight &&
                    "border-[color-mix(in_srgb,var(--amber)_45%,transparent)] bg-[color-mix(in_srgb,var(--amber)_16%,transparent)] text-[var(--amber)]",
                )}
                aria-label={badgeLabel}
                title={badgeLabel}
              >
                {count}
              </Badge>
            </Button>
          ))}
        </nav>
      </SidebarPanel>
      {section === "instructions" && (
        <AssetPage assets={instructionAssets} workspaces={workspaces} onOpen={onOpen} />
      )}
      {section === "skills" && (
        <SkillHubPage
          workspaceAssets={skillAssets}
          workspaces={workspaces}
          onOpen={onOpen}
          onReload={onReload}
        />
      )}
      {section === "other" && (
        <AssetPage assets={otherAssets} workspaces={workspaces} onOpen={onOpen} />
      )}
      {section === "memory" && (
        <GlobalMemoryInbox records={memories} workspaces={workspaces} onReload={onReload} />
      )}
      {section === "mcp" && (
        <McpHubPage
          runtime={runtime}
          workspaces={workspaces}
          onRuntimeChanged={onRuntimeChanged}
          onMigrationPlanned={onMigrationPlanned}
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

function McpHubPage({
  runtime,
  workspaces,
  onRuntimeChanged,
  onMigrationPlanned,
}: {
  runtime?: RuntimeInfo;
  workspaces: WorkspaceSummary[];
  onRuntimeChanged: (runtime: RuntimeInfo) => void;
  onMigrationPlanned: (project: string, changeSet: ChangeSet) => Promise<void>;
}) {
  const { localizeMessage, tr } = useI18n();
  const dialogs = useAppDialogs();
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [installations, setInstallations] = useState<McpInstallation[]>([]);
  const [runtimes, setRuntimes] = useState<McpRuntimeStatus[]>([]);
  const [registry, setRegistry] = useState<McpRegistryEntry[]>([]);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const project = scope || undefined;
  const load = async () => {
    const [nextServers, nextInstallations, nextRuntimes, nextRuntime] = await Promise.all([
      api.mcpServers(project),
      api.mcpInstallations(),
      api.mcpRuntimes(),
      api.runtime(),
    ]);
    setServers(nextServers);
    setInstallations(nextInstallations);
    setRuntimes(nextRuntimes);
    onRuntimeChanged(nextRuntime);
  };
  useEffect(() => {
    void load().catch((reason) => setError(localizeMessage(reason)));
  }, [scope]);
  const searchRegistry = async () => {
    setBusy(true);
    setError("");
    await withAsyncCleanup(
      async () => {
        try {
          setRegistry(await api.searchMcpRegistry(query));
        } catch (reason) {
          setError(localizeMessage(reason));
        }
      },
      () => setBusy(false),
    );
  };
  const install = async (entry: McpRegistryEntry) => {
    const command =
      entry.package_kind === "remote"
        ? entry.url
        : `${entry.package_kind === "npm" ? "npm" : "uv"} · ${entry.identifier}@${entry.version}`;
    if (!(await dialogs.confirm(tr("mcp.installConfirm", { name: entry.name, command })))) return;
    const env = await dialogs.requestSecrets(entry.required_env);
    if (env === null) return;
    setBusy(true);
    setError("");
    await withAsyncCleanup(
      async () => {
        try {
          const result = await api.installMcp(entry, project);
          if (Object.keys(env).length)
            await api.saveMcpLocalValues(result.server.id, env, {}, project);
          await load();
        } catch (reason) {
          setError(localizeMessage(reason));
        }
      },
      () => setBusy(false),
    );
  };
  const updateInstallation = async (installation: McpInstallation, entry: McpRegistryEntry) => {
    if (
      !(await dialogs.confirm(
        tr("mcp.updateConfirm", { name: installation.name, version: entry.version }),
      ))
    )
      return;
    const env = await dialogs.requestSecrets(entry.required_env);
    if (env === null) return;
    setBusy(true);
    setError("");
    await withAsyncCleanup(
      async () => {
        try {
          const result = await api.updateMcp(installation.id, entry, project);
          if (Object.keys(env).length)
            await api.saveMcpLocalValues(result.server.id, env, {}, project);
          await load();
        } catch (reason) {
          setError(localizeMessage(reason));
        }
      },
      () => setBusy(false),
    );
  };
  const updateNetwork = async (lanEnabled: boolean) => {
    if (
      lanEnabled &&
      !(await dialogs.confirm({ description: tr("mcp.lanWarning"), tone: "warning" }))
    )
      return;
    try {
      await api.updateMcpNetwork({
        port: runtime?.mcp_network?.port ?? 47653,
        lan_enabled: lanEnabled,
        lan_risk_accepted: lanEnabled,
      });
      onRuntimeChanged(await api.runtime());
    } catch (reason) {
      setError(localizeMessage(reason));
    }
  };
  const updatePort = async (port: number) => {
    if (!Number.isInteger(port) || port < 1 || port > 65535 || port === runtime?.mcp_network?.port)
      return;
    try {
      await api.updateMcpNetwork({
        port,
        lan_enabled: runtime?.mcp_network?.lan_enabled ?? false,
        lan_risk_accepted: runtime?.mcp_network?.lan_risk_accepted ?? false,
      });
      onRuntimeChanged(await api.runtime());
    } catch (reason) {
      setError(localizeMessage(reason));
    }
  };
  const authorize = async (serverId: string) => {
    try {
      const result = await api.startMcpOAuth(serverId, project);
      await api.openExternal(result.authorization_url);
    } catch (reason) {
      setError(localizeMessage(reason));
    }
  };
  return (
    <div className="grid gap-5">
      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <CircleAlert size={16} />
          {error}
        </div>
      )}
      <div className="grid gap-4 rounded-2xl border border-border bg-card p-5 md:grid-cols-[minmax(0,1fr)_auto]">
        <div className="grid gap-1.5">
          <span className="text-xs font-semibold uppercase tracking-[.12em] text-muted-foreground">
            STREAMABLE HTTP MCP HUB
          </span>
          <h2>{tr("mcp.title")}</h2>
        </div>
        <div className="grid gap-1.5 text-right text-sm text-muted-foreground">
          <span
            className={cn(
              "font-medium",
              runtime?.mcp_hub?.running ? "text-emerald-600" : "text-destructive",
            )}
          >
            {tr(runtime?.mcp_hub?.running ? "mcp.running" : "mcp.stopped")}
          </span>
          <code>{runtime?.mcp_hub ? runtime.mcp_hub.accessible_addresses.join(" · ") : "—"}</code>
          <small>{tr("mcp.runtimeCount", { count: runtime?.mcp_hub?.runtime_count ?? 0 })}</small>
        </div>
      </div>
      <div className="grid gap-5 rounded-2xl border border-border bg-card p-5 shadow-sm md:grid-cols-[minmax(0,1fr)_auto]">
        <div className="grid gap-1.5">
          <h2>{tr("mcp.network")}</h2>
        </div>
        <div className="flex flex-wrap items-end gap-4">
          <Label className="!grid gap-2">
            <span>{tr("mcp.port")}</span>
            <Input
              className="w-32"
              type="number"
              min="1"
              max="65535"
              defaultValue={runtime?.mcp_network?.port ?? 47653}
              onBlur={(event) => void updatePort(Number(event.target.value))}
            />
          </Label>
          <Label className="!grid gap-2">
            <span>{tr("mcp.lanMode")}</span>
            <Switch
              checked={runtime?.mcp_network?.lan_enabled ?? false}
              onCheckedChange={(checked) => void updateNetwork(checked)}
            />
          </Label>
        </div>
      </div>
      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-5">
          <div className="grid gap-1.5">
            <h2>{tr("mcp.scope")}</h2>
          </div>
          <Select
            value={scope || "__global_scope__"}
            onValueChange={(value) => {
              if (value !== null) {
                const nextScope = String(value);
                setScope(nextScope === "__global_scope__" ? "" : nextScope);
              }
            }}
          >
            <SelectTrigger className="min-w-40" aria-label={tr("mcp.scope")}>
              <SelectValue>
                {workspaces.find((workspace) => workspace.path === scope)?.name ??
                  tr("mcp.globalScope")}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__global_scope__">{tr("mcp.globalScope")}</SelectItem>
              {workspaces.map((workspace) => (
                <SelectItem key={workspace.id} value={workspace.path}>
                  {workspace.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <McpServerEditor project={project} onSaved={load} />
      <McpMigrationInventory
        key={project ?? "global"}
        project={project}
        onPlanned={onMigrationPlanned}
      />
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
              className="bg-primary text-primary-foreground hover:bg-primary/90"
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
                  onClick={() => void install(entry)}
                >
                  {tr("mcp.install")}
                </Button>
              </article>
            ))}
            {!registry.length && (
              <p className="py-6 text-sm text-muted-foreground">{tr("mcp.registryEmpty")}</p>
            )}
          </div>
        </div>
        <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
          <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-5">
            <div className="grid gap-1.5">
              <h2>{tr("mcp.configured")}</h2>
            </div>
            <Badge variant="outline">{servers.length}</Badge>
          </div>
          <div className="grid divide-y divide-border px-5">
            {servers.map((server) => (
              <article
                className="grid gap-4 py-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center"
                key={server.id}
              >
                <div className="grid gap-1">
                  <strong>{server.name}</strong>
                  <small>{server.transport === "stdio" ? server.command : server.url}</small>
                  <span>
                    {server.targets.length
                      ? server.targets.map((agent) => agentLabels[agent]).join(" · ")
                      : tr("mcp.allAgents")}
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {server.transport === "streamable-http" && (
                    <Button
                      className="border border-transparent bg-transparent text-foreground hover:bg-muted"
                      onClick={() => void authorize(server.id)}
                    >
                      {tr("mcp.authorize")}
                    </Button>
                  )}
                  <Button
                    className="border border-transparent bg-transparent text-foreground hover:bg-muted"
                    onClick={async () => {
                      try {
                        await api.probeMcpRuntime(server.id, project);
                        await load();
                      } catch (reason) {
                        setError(localizeMessage(reason));
                      }
                    }}
                  >
                    {tr("mcp.probe")}
                  </Button>
                  <Button
                    className="text-destructive hover:bg-destructive/10"
                    onClick={async () => {
                      await api.removeMcpServer(server.id, project);
                      await load();
                    }}
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
              </article>
            ))}
            {!servers.length && (
              <p className="py-6 text-sm text-muted-foreground">{tr("mcp.configuredEmpty")}</p>
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
                        disabled={busy}
                        onClick={() => void updateInstallation(item, update)}
                      >
                        {tr("mcp.update")}
                      </Button>
                    )}
                    <Button
                      className="text-destructive hover:bg-destructive/10"
                      onClick={async () => {
                        if (
                          !(await dialogs.confirm({
                            description: tr("mcp.uninstallConfirm", { name: item.name }),
                            tone: "destructive",
                          }))
                        )
                          return;
                        await api.uninstallMcp(item.id);
                        await load();
                      }}
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
              onClick={() => void load()}
            >
              <RefreshCw size={13} />
              {tr("common.refresh")}
            </Button>
          </div>
          <div className="grid divide-y divide-border px-5">
            {runtimes.map((item) => (
              <article
                className="grid gap-4 py-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center"
                key={item.config_hash}
              >
                <div className="grid gap-1">
                  <strong>{item.server_name}</strong>
                  <small>{item.config_hash.slice(0, 16)}…</small>
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 rounded-md text-xs font-medium",
                      item.state === "running" ? "text-emerald-600" : "text-destructive",
                    )}
                  >
                    {tr(`mcp.runtime.${item.state}`)}
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    className="border border-transparent bg-transparent text-foreground hover:bg-muted"
                    onClick={async () => {
                      try {
                        await api.restartMcpRuntime(item.server_id, project);
                        await load();
                      } catch (reason) {
                        setError(localizeMessage(reason));
                      }
                    }}
                  >
                    {tr("mcp.restart")}
                  </Button>
                  <Button
                    className="border border-transparent bg-transparent text-foreground hover:bg-muted"
                    onClick={async () => {
                      await api.stopMcpRuntime(item.server_id);
                      await load();
                    }}
                  >
                    {tr("mcp.stop")}
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
    </div>
  );
}

function McpServerEditor({ project, onSaved }: { project?: string; onSaved: () => Promise<void> }) {
  const { tr, localizeMessage } = useI18n();
  const defaultConfig = JSON.stringify(
    {
      id: "my-server",
      name: "My Server",
      enabled: true,
      transport: "streamable-http",
      url: "https://example.com/mcp",
      targets: [],
      allow_tools: [],
      lan_allow_tools: [],
      supports_parallel_tool_calls: false,
    },
    null,
    2,
  );
  const [config, setConfig] = useState(defaultConfig);
  const [env, setEnv] = useState("");
  const [headers, setHeaders] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const parseSecretLines = (value: string) =>
    Object.fromEntries(
      value
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const separator = line.indexOf("=");
          if (separator <= 0) throw new Error(tr("mcp.secretFormatError"));
          return [line.slice(0, separator).trim(), line.slice(separator + 1)];
        }),
    );
  const save = async () => {
    setSaving(true);
    setError("");
    await withAsyncCleanup(
      async () => {
        try {
          const server = JSON.parse(config) as McpServerConfig;
          if (!server.id || !server.name || !server.transport) {
            setError(tr("mcp.configRequired"));
            return;
          }
          if (server.transport === "sse") {
            setError(tr("mcp.sseImportOnly"));
            return;
          }
          await api.saveMcpServer(server, project);
          await api.saveMcpLocalValues(
            server.id,
            parseSecretLines(env),
            parseSecretLines(headers),
            project,
          );
          setEnv("");
          setHeaders("");
          await onSaved();
        } catch (reason) {
          setError(localizeMessage(reason));
        }
      },
      () => setSaving(false),
    );
  };
  return (
    <Card className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-5">
        <div className="grid gap-1.5">
          <h2>{tr("mcp.editor")}</h2>
        </div>
        <Button
          className="bg-primary text-primary-foreground hover:bg-primary/90"
          disabled={saving}
          onClick={() => void save()}
        >
          {tr("common.save")}
        </Button>
      </div>
      {error && (
        <div className="mx-5 mt-5 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <CircleAlert size={16} />
          {error}
        </div>
      )}
      <div className="grid gap-5 p-5 lg:grid-cols-2">
        <Label className="!grid !items-stretch gap-2.5">
          <span className="text-sm font-medium">{tr("mcp.publicJson")}</span>
          <Textarea
            className="min-h-[230px]"
            value={config}
            onChange={(event) => setConfig(event.target.value)}
            spellCheck={false}
          />
        </Label>
        <div className="grid gap-5">
          <Label className="!grid !items-stretch gap-2.5">
            <span className="text-sm font-medium">{tr("mcp.environmentSecrets")}</span>
            <Textarea
              value={env}
              onChange={(event) => setEnv(event.target.value)}
              placeholder="API_TOKEN=…"
              spellCheck={false}
            />
          </Label>
          <Label className="!grid !items-stretch gap-2.5">
            <span className="text-sm font-medium">{tr("mcp.headerSecrets")}</span>
            <Textarea
              value={headers}
              onChange={(event) => setHeaders(event.target.value)}
              placeholder="Authorization=Bearer …"
              spellCheck={false}
            />
          </Label>
        </div>
      </div>
    </Card>
  );
}

function McpMigrationInventory({
  project,
  onPlanned,
}: {
  project?: string;
  onPlanned: (project: string, changeSet: ChangeSet) => Promise<void>;
}) {
  const { tr, localizeMessage } = useI18n();
  const dialogs = useAppDialogs();
  const [candidates, setCandidates] = useState<import("../core/types").McpMigrationCandidate[]>([]);
  const [scanned, setScanned] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const scan = async () => {
    setCandidates(await api.nativeMcpCandidates(project));
    setScanned(true);
  };
  const plan = async () => {
    if (!project || !selected.length) return;
    if (!(await dialogs.confirm(tr("mcp.migrationConfirm", { count: selected.length })))) return;
    setBusy(true);
    setError("");
    await withAsyncCleanup(
      async () => {
        try {
          await onPlanned(project, await api.planMcpMigration(project, selected));
        } catch (reason) {
          setError(localizeMessage(reason));
        }
      },
      () => setBusy(false),
    );
  };
  const toggle = (id: string, checked: boolean) =>
    setSelected((current) =>
      checked ? [...current, id] : current.filter((value) => value !== id),
    );
  return (
    <Card className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-5">
        <div className="grid gap-1.5">
          <h2>{tr("mcp.migration")}</h2>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            className="border border-transparent bg-transparent text-foreground hover:bg-muted"
            onClick={() => void scan()}
          >
            <Search size={13} />
            {tr("common.scan")}
          </Button>
          <Button
            className="bg-primary text-primary-foreground hover:bg-primary/90"
            disabled={!project || !selected.length || busy}
            onClick={() => void plan()}
          >
            {tr("mcp.planMigration")}
          </Button>
        </div>
      </div>
      <div className="grid gap-3 px-5 py-5">
        {!project && (
          <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-3 text-sm text-amber-700">
            <CircleAlert size={14} />
            {tr("mcp.projectRequired")}
          </div>
        )}
        {error && (
          <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-3 text-sm text-destructive">
            <CircleAlert size={16} />
            {error}
          </div>
        )}
      </div>
      {scanned && (
        <div className="grid divide-y divide-border px-5 pb-5">
          {candidates.map((candidate) => (
            <article
              className="grid gap-3 py-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center"
              key={candidate.id}
            >
              <Label className="!grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3">
                <Checkbox
                  className="mt-0.5"
                  disabled={!candidate.supported || !project}
                  checked={selected.includes(candidate.id)}
                  onCheckedChange={(checked) => toggle(candidate.id, checked)}
                />
                <span className="grid gap-1">
                  <strong>{candidate.name}</strong>
                  <small>
                    {agentLabels[candidate.agent]} · {candidate.source_path}
                  </small>
                  <em>
                    {candidate.transport} · {candidate.endpoint}
                    {candidate.has_secret_values ? ` · ${tr("mcp.secretReentry")}` : ""}
                  </em>
                </span>
              </Label>
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded-md text-xs font-medium",
                  candidate.supported ? "text-emerald-600" : "text-destructive",
                )}
              >
                {tr(candidate.supported ? "mcp.importable" : "mcp.unsupported")}
              </span>
            </article>
          ))}
          {!candidates.length && (
            <p className="py-5 text-sm text-muted-foreground">{tr("mcp.migrationEmpty")}</p>
          )}
        </div>
      )}
    </Card>
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

export const Route = createFileRoute("/catalog")({ component: CatalogRoute });
