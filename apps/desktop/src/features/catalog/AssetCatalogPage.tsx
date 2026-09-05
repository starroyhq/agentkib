import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { AgentIcon } from "@/features/agents/AgentIcon";
import {
  ChevronLeft,
  ChevronRight,
  FileCode2,
  Grid2X2,
  Library,
  List,
  Search,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { tr } from "@/core/i18n";
import type { AgentKind, WorkspaceSummary } from "@/core/types";
import type { CatalogAssetGroup } from "@/features/catalog/catalog";

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

const ASSETS_PER_PAGE = 6;

function shortPath(path: string) {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : path;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatCatalogDateTime(value: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(value))
      .map(({ type, value: part }) => [type, part]),
  );
  return `${parts.year}.${parts.month}.${parts.day} ${parts.hour}:${parts.minute}`;
}

function AssetIcon() {
  return (
    <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-border bg-muted/40 text-foreground">
      <FileCode2 size={17} />
    </span>
  );
}

interface AssetCatalogPageProps {
  assets: CatalogAssetGroup[];
  workspaces: WorkspaceSummary[];
  onOpen: (id: string) => void;
}

export function AssetCatalogPage({ assets, workspaces, onOpen }: AssetCatalogPageProps) {
  const [query, setQuery] = useState("");
  const [agent, setAgent] = useState<"all" | AgentKind>("all");
  const [kind, setKind] = useState("all");
  const [workspaceId, setWorkspaceId] = useState("all");
  const [ownership, setOwnership] = useState<"all" | "shared" | "native">("all");
  const [selectedId, setSelectedId] = useState<string>();
  const [viewMode, setViewMode] = useState<"table" | "grid">("table");
  const [page, setPage] = useState(1);

  const kinds = useMemo(() => [...new Set(assets.map((asset) => asset.kind))].sort(), [assets]);
  const showKind = kinds.length > 1;
  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return assets.filter((asset) => {
      const searchable =
        `${asset.name} ${asset.path} ${asset.summary} ${asset.kind} ${asset.agents.map((value) => agentLabels[value]).join(" ")}`.toLowerCase();
      return (
        (!normalizedQuery || searchable.includes(normalizedQuery)) &&
        (agent === "all" || asset.agents.includes(agent)) &&
        (kind === "all" || asset.kind === kind) &&
        (workspaceId === "all" || asset.workspace_id === workspaceId) &&
        (ownership === "all" || (ownership === "shared" ? asset.shared : asset.agents.length > 0))
      );
    });
  }, [agent, assets, kind, ownership, query, workspaceId]);
  useEffect(() => {
    setPage(1);
  }, [agent, kind, ownership, query, workspaceId]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / ASSETS_PER_PAGE));
  const activePage = Math.min(page, totalPages);
  const paginated = filtered.slice(
    (activePage - 1) * ASSETS_PER_PAGE,
    activePage * ASSETS_PER_PAGE,
  );
  const pageStart = filtered.length ? (activePage - 1) * ASSETS_PER_PAGE + 1 : 0;
  const pageEnd = Math.min(activePage * ASSETS_PER_PAGE, filtered.length);
  const selected = paginated.find((asset) => asset.id === selectedId);
  const activeSelectedId = selected?.id;
  const goToPage = (nextPage: number) => {
    const nextActivePage = Math.min(Math.max(1, nextPage), totalPages);
    setPage(nextActivePage);
    setSelectedId(filtered[(nextActivePage - 1) * ASSETS_PER_PAGE]?.id);
  };
  const workspaceName = (id?: string) =>
    workspaces.find((workspace) => workspace.id === id)?.name ?? "—";
  const controlClass = "h-10 w-[136px] min-w-0";

  const filterControls = (
    <div className="flex flex-wrap gap-2">
      <Select
        value={workspaceId}
        onValueChange={(value) => {
          if (value !== null) setWorkspaceId(String(value));
        }}
      >
        <SelectTrigger className={controlClass} aria-label={tr("workspace.all")}>
          <SelectValue>
            {workspaceId === "all"
              ? tr("workspace.all")
              : (workspaces.find((workspace) => workspace.id === workspaceId)?.name ??
                tr("workspace.all"))}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{tr("workspace.all")}</SelectItem>
          {workspaces.map((workspace) => (
            <SelectItem key={workspace.id} value={workspace.id}>
              {workspace.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={agent}
        onValueChange={(value) => {
          if (value !== null) setAgent(String(value) as typeof agent);
        }}
      >
        <SelectTrigger className={controlClass} aria-label={tr("workspace.allAgents")}>
          <SelectValue>
            {agent === "all" ? tr("workspace.allAgents") : agentLabels[agent]}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{tr("workspace.allAgents")}</SelectItem>
          {Object.entries(agentLabels).map(([value, label]) => (
            <SelectItem key={value} value={value}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {showKind && (
        <Select
          value={kind}
          onValueChange={(value) => {
            if (value !== null) setKind(String(value));
          }}
        >
          <SelectTrigger className={controlClass} aria-label={tr("catalog.allTypes")}>
            <SelectValue>
              {kind === "all" ? tr("catalog.allTypes") : tr(`status.asset.${kind}`)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{tr("catalog.allTypes")}</SelectItem>
            {kinds.map((value) => (
              <SelectItem key={value} value={value}>
                {tr(`status.asset.${value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <Select
        value={ownership}
        onValueChange={(value) => {
          if (value !== null) setOwnership(String(value) as typeof ownership);
        }}
      >
        <SelectTrigger className={controlClass} aria-label={tr("catalog.allOwnership")}>
          <SelectValue>
            {ownership === "all" ? tr("catalog.allOwnership") : tr(`catalog.${ownership}`)}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{tr("catalog.allOwnership")}</SelectItem>
          <SelectItem value="shared">{tr("catalog.shared")}</SelectItem>
          <SelectItem value="native">{tr("catalog.native")}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );

  return (
    <div className="grid min-w-0 gap-4">
      <section className="rounded-2xl border border-border bg-card p-3 shadow-sm">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
          <label className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-xl border border-border bg-card px-3 text-muted-foreground shadow-xs transition-colors focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/15">
            <Search size={16} aria-hidden="true" />
            <Input
              className="h-8 border-0 bg-transparent px-0 text-sm text-foreground shadow-none placeholder:text-muted-foreground focus-visible:ring-0"
              aria-label={tr("catalog.searchPlaceholder")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={tr("catalog.searchPlaceholder")}
            />
            {query && (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={tr("common.clear")}
                onClick={() => setQuery("")}
              >
                <X size={14} />
              </Button>
            )}
          </label>
          <div className="flex flex-wrap gap-2 xl:justify-end">{filterControls}</div>
        </div>
      </section>
      <div
        className={cn(
          "grid min-w-0 gap-4",
          selected && "grid-cols-[minmax(0,1fr)_minmax(300px,380px)] max-[500px]:grid-cols-1",
        )}
      >
        <Card className="min-w-0 overflow-hidden rounded-2xl border-border bg-card shadow-sm">
          <CardHeader className="flex min-h-[58px] flex-row items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
            <div>
              <h2 className="text-sm font-semibold tracking-tight">{tr("catalog.asset")}</h2>
              <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">
                {filtered.length} {tr("common.assets")}
              </p>
            </div>
            <div className="flex items-center gap-1 rounded-lg border border-border bg-background p-1">
              <Button
                variant="ghost"
                size="icon-sm"
                className={viewMode === "table" ? "bg-muted text-foreground" : ""}
                aria-label={tr("catalog.viewTable")}
                aria-pressed={viewMode === "table"}
                onClick={() => setViewMode("table")}
              >
                <List size={15} />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                className={viewMode === "grid" ? "bg-muted text-foreground" : ""}
                aria-label={tr("catalog.viewGrid")}
                aria-pressed={viewMode === "grid"}
                onClick={() => setViewMode("grid")}
              >
                <Grid2X2 size={15} />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <div className="h-[456px] overflow-y-auto">
              {viewMode === "table" ? (
                <Table className="w-full table-fixed min-w-0 border-separate border-spacing-0 [&_th]:h-11 [&_th]:overflow-hidden [&_th]:bg-muted/30 [&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-foreground [&_td]:h-[68px] [&_td]:overflow-hidden">
                  <TableHeader>
                    <TableRow className="border-border hover:bg-transparent">
                      <TableHead className="w-[38%]">{tr("catalog.asset")}</TableHead>
                      {showKind && (
                        <TableHead className="w-[100px]">{tr("catalog.type")}</TableHead>
                      )}
                      <TableHead className="hidden w-[20%] md:table-cell">
                        {tr("catalog.workspace")}
                      </TableHead>
                      <TableHead className="hidden w-[128px] min-w-[128px] whitespace-nowrap lg:table-cell">
                        {tr("catalog.visibleAgents")}
                      </TableHead>
                      <TableHead className="hidden w-[92px] whitespace-nowrap sm:table-cell">
                        {tr("assets.size")}
                      </TableHead>
                      <TableHead className="hidden w-[150px] whitespace-nowrap xl:table-cell">
                        {tr("catalog.modified")}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paginated.map((asset) => {
                      const visibleAgents = asset.agents.slice(0, 2);
                      const hiddenAgentCount = asset.agents.length - visibleAgents.length;
                      const allAgents = asset.agents.map((value) => agentLabels[value]).join(", ");
                      const allOwners = [allAgents, ...(asset.shared ? [tr("catalog.shared")] : [])]
                        .filter(Boolean)
                        .join(", ");
                      return (
                        <TableRow
                          key={asset.id}
                          tabIndex={0}
                          role="button"
                          aria-selected={activeSelectedId === asset.id}
                          data-state={activeSelectedId === asset.id ? "selected" : undefined}
                          className={cn(
                            "cursor-pointer transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                            activeSelectedId === asset.id && "bg-muted/60 hover:bg-muted/70",
                          )}
                          onClick={() => setSelectedId(asset.id)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              setSelectedId(asset.id);
                            }
                          }}
                        >
                          <TableCell className="max-w-[420px]">
                            <div className="flex min-w-0 items-center gap-3">
                              <AssetIcon />
                              <span className="min-w-0">
                                <strong className="block truncate text-sm font-semibold text-foreground">
                                  {asset.name}
                                </strong>
                                <small
                                  className="mt-0.5 block truncate text-xs text-muted-foreground"
                                  title={asset.path}
                                >
                                  {shortPath(asset.path)}
                                </small>
                              </span>
                            </div>
                          </TableCell>
                          {showKind && (
                            <TableCell>
                              <Badge variant="secondary" className="font-medium">
                                {tr(`status.asset.${asset.kind}`)}
                              </Badge>
                            </TableCell>
                          )}
                          <TableCell className="hidden max-w-0 truncate text-sm text-muted-foreground md:table-cell">
                            {workspaceName(asset.workspace_id)}
                          </TableCell>
                          <TableCell className="hidden w-[128px] min-w-[128px] lg:table-cell">
                            <div className="flex min-w-0 items-center gap-0" aria-label={allOwners}>
                              {visibleAgents.map((value) => (
                                <span
                                  className="grid size-5 shrink-0 place-items-center overflow-hidden rounded-md border border-border bg-background"
                                  key={value}
                                  title={agentLabels[value]}
                                  aria-label={agentLabels[value]}
                                >
                                  <AgentIcon agent={value} compact />
                                </span>
                              ))}
                              {hiddenAgentCount > 0 && (
                                <span
                                  className="grid size-5 shrink-0 place-items-center rounded-md bg-muted text-[9px] font-semibold text-muted-foreground"
                                  title={`${hiddenAgentCount} more agents`}
                                  aria-label={`${hiddenAgentCount} more agents`}
                                >
                                  +{hiddenAgentCount}
                                </span>
                              )}
                              {asset.shared && (
                                <span
                                  className="grid size-5 shrink-0 place-items-center rounded-md bg-muted text-[9px] font-semibold text-muted-foreground"
                                  title={tr("catalog.shared")}
                                  aria-label={tr("catalog.shared")}
                                >
                                  ···
                                </span>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="hidden max-w-0 truncate whitespace-nowrap text-sm tabular-nums text-muted-foreground sm:table-cell">
                            {formatBytes(asset.size)}
                          </TableCell>
                          <TableCell className="hidden max-w-0 truncate whitespace-nowrap text-sm text-muted-foreground xl:table-cell">
                            {asset.modified_at ? formatCatalogDateTime(asset.modified_at) : "—"}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              ) : (
                <div className="grid gap-3 p-3 sm:grid-cols-2 xl:grid-cols-3">
                  {paginated.map((asset) => (
                    <Button
                      key={asset.id}
                      variant="bare"
                      size="content"
                      className={cn(
                        "grid min-w-0 gap-3 rounded-xl border border-border bg-background p-4 text-left transition-colors hover:border-primary/35 hover:bg-muted/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        activeSelectedId === asset.id && "border-primary bg-primary/[0.06]",
                      )}
                      onClick={() => setSelectedId(asset.id)}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-3">
                          <AssetIcon />
                          <span className="min-w-0">
                            <strong className="block truncate text-sm text-foreground">
                              {asset.name}
                            </strong>
                            <small className="mt-0.5 block truncate text-xs text-muted-foreground">
                              {shortPath(asset.path)}
                            </small>
                          </span>
                        </div>
                        <ChevronRight size={15} className="mt-1 shrink-0 text-muted-foreground" />
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        <Badge variant="secondary">{tr(`status.asset.${asset.kind}`)}</Badge>
                        {asset.shared && <Badge variant="outline">{tr("catalog.shared")}</Badge>}
                      </div>
                      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                        <span className="truncate">{workspaceName(asset.workspace_id)}</span>
                        <span className="shrink-0 tabular-nums">{formatBytes(asset.size)}</span>
                      </div>
                    </Button>
                  ))}
                </div>
              )}
              {!filtered.length && (
                <div className="grid min-h-[240px] place-items-center px-6 py-10 text-center">
                  <div className="grid justify-items-center gap-2">
                    <span className="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground">
                      <Library size={18} />
                    </span>
                    <h3 className="text-sm font-semibold text-foreground">
                      {tr("catalog.noMatch")}
                    </h3>
                    <p className="max-w-sm text-sm leading-6 text-muted-foreground">
                      {tr("catalog.noMatchText")}
                    </p>
                  </div>
                </div>
              )}
            </div>
            {filtered.length > 0 && (
              <div className="flex min-h-[58px] items-center justify-between gap-3 border-t border-border px-4 py-3 sm:px-5">
                <span className="text-xs tabular-nums text-muted-foreground">
                  {pageStart}–{pageEnd} / {filtered.length}
                </span>
                {totalPages > 1 && (
                  <div className="flex items-center gap-1" aria-label={tr("catalog.pagination")}>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={tr("catalog.previousPage")}
                      disabled={activePage === 1}
                      onClick={() => goToPage(activePage - 1)}
                    >
                      <ChevronLeft size={15} />
                    </Button>
                    <span className="min-w-[52px] text-center text-xs tabular-nums text-muted-foreground">
                      {activePage} / {totalPages}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={tr("catalog.nextPage")}
                      disabled={activePage === totalPages}
                      onClick={() => goToPage(activePage + 1)}
                    >
                      <ChevronRight size={15} />
                    </Button>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {selected && (
          <aside className="sticky top-4 grid h-fit max-h-[calc(100vh-6rem)] w-full grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden rounded-2xl border border-border bg-card text-sm text-card-foreground shadow-sm">
            <header className="relative border-b border-border px-5 py-4 pr-12">
              <div className="flex min-w-0 items-center gap-3">
                <AssetIcon />
                <div className="min-w-0">
                  <span className="block text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
                    {tr("catalog.asset")}
                  </span>
                  <h2
                    id="catalog-asset-title"
                    className="truncate text-lg font-semibold"
                    title={selected.name}
                  >
                    {selected.name}
                  </h2>
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                className="absolute right-3 top-3"
                onClick={() => setSelectedId(undefined)}
                aria-label={tr("common.close")}
              >
                <X size={15} />
              </Button>
            </header>
            <div className="overflow-y-auto px-5 py-4">
              {selected.summary && (
                <p className="mb-4 leading-6 text-muted-foreground">{selected.summary}</p>
              )}
              <dl className="grid gap-4">
                <div className="grid gap-1.5">
                  <dt className="text-xs font-medium uppercase tracking-[0.1em] text-muted-foreground">
                    {tr("catalog.type")}
                  </dt>
                  <dd className="text-sm font-medium text-foreground">
                    {tr(`status.asset.${selected.kind}`)}
                  </dd>
                </div>
                <div className="grid gap-1.5">
                  <dt className="text-xs font-medium uppercase tracking-[0.1em] text-muted-foreground">
                    {tr("catalog.workspace")}
                  </dt>
                  <dd className="text-sm font-medium text-foreground">
                    {workspaceName(selected.workspace_id)}
                  </dd>
                </div>
                <div className="grid gap-1.5">
                  <dt className="text-xs font-medium uppercase tracking-[0.1em] text-muted-foreground">
                    {tr("catalog.visibleAgents")}
                  </dt>
                  <dd className="text-sm font-medium text-foreground">
                    {[
                      ...selected.agents.map((value) => agentLabels[value]),
                      ...(selected.shared ? [tr("catalog.shared")] : []),
                    ].join(" · ")}
                  </dd>
                </div>
                <div className="grid gap-1.5">
                  <dt className="text-xs font-medium uppercase tracking-[0.1em] text-muted-foreground">
                    {tr("catalog.path")}
                  </dt>
                  <dd className="break-all font-mono text-xs leading-5 text-muted-foreground">
                    {selected.path}
                  </dd>
                </div>
              </dl>
            </div>
            {selected.workspace_id && (
              <Button
                className="mx-5 mb-5 w-[calc(100%-2.5rem)] justify-between rounded-xl"
                onClick={() => {
                  setSelectedId(undefined);
                  onOpen(selected.workspace_id!);
                }}
              >
                {tr("catalog.openWorkspace")}
                <ChevronRight size={15} />
              </Button>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
