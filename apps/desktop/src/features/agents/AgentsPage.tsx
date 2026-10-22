import { useI18n } from "@/core/useI18n";
import { useEffect, useMemo, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Search } from "lucide-react";
import { cn } from "cn";
import type {
  AgentInstallation,
  AgentKind,
  CatalogAsset,
  InsightsStatus,
  RemoteGatewaySummary,
  WorkspaceSummary,
} from "@/core/types";
import { AgentIcon } from "@/features/agents/AgentIcon";
import { agentSupportsInsights } from "@/features/insights/insights";
import { agentSupport } from "@/features/agents/agent-capabilities";
import { usePathDisplay } from "@/lib/usePathDisplay";
import { useAgentViewStore, type AgentDetailSection } from "./agent-view-store";
import type { AgentFilter } from "@/components/AppSidebar";
import { AGENT_LABELS as agentLabels } from "@/core/agents";
import { AgentOverviewPanel } from "./AgentOverviewPanel";
import { AgentAssetsPanel } from "./AgentAssetsPanel";
import { AgentWorkspacesPanel } from "./AgentWorkspacesPanel";
import { AgentUsagePanel } from "./AgentUsagePanel";

const agentKinds: AgentKind[] = [
  "codex",
  "claude-code",
  "antigravity",
  "cursor",
  "opencode",
  "open-claw",
  "hermes",
  "grok-build",
  "deepseek-harness",
];

export function AgentsPage({
  installations,
  assets,
  workspaces,
  remoteGateways,
  insightsStatus,
  onOpen,
  filter,
  selectedAgent,
  onSelectedAgentChange,
  onFilterChange,
  onClearFilters,
  loading = {},
  errors = {},
  onRetry = {},
}: {
  installations: AgentInstallation[];
  assets: CatalogAsset[];
  workspaces: WorkspaceSummary[];
  remoteGateways: RemoteGatewaySummary[];
  insightsStatus?: InsightsStatus;
  onOpen: (workspace: WorkspaceSummary) => Promise<void>;
  filter: AgentFilter;
  selectedAgent?: AgentKind;
  onSelectedAgentChange: (agent: AgentKind) => void;
  onFilterChange?: (filter: AgentFilter) => void;
  onClearFilters?: () => void;
  loading?: Partial<Record<"assets" | "workspaces" | "gateways" | "insights", boolean>>;
  errors?: Partial<Record<"assets" | "workspaces" | "gateways" | "insights", boolean>>;
  onRetry?: Partial<Record<"assets" | "workspaces" | "gateways" | "insights", () => void>>;
}) {
  const { tr } = useI18n();
  const displayPath = usePathDisplay();
  const initialSelectionDone = useRef(Boolean(selectedAgent));
  const [selected, setSelected] = useState<AgentKind>(selectedAgent ?? "codex");
  const section = useAgentViewStore((state) => state.sections[selected] ?? "overview");
  const saveSection = useAgentViewStore((state) => state.setSection);
  const setSection = (nextSection: AgentDetailSection) => saveSection(selected, nextSection);
  const agentQuery = useAgentViewStore((state) => state.query);
  const setAgentQuery = useAgentViewStore((state) => state.setQuery);
  const agentSort = useAgentViewStore((state) => state.sort);
  const setAgentSort = useAgentViewStore((state) => state.setSort);
  const [assetQuery, setAssetQuery] = useState("");
  const [assetKind, setAssetKind] = useState("all");
  const installation = installations.find((item) => item.agent === selected);
  const provider = insightsStatus?.providers.find((item) => item.agent === selected);
  const homeAssets = useMemo(
    () => assets.filter((item) => item.agent === selected),
    [assets, selected],
  );
  const assetKinds = useMemo(
    () => [...new Set(homeAssets.map((item) => item.kind))].sort(),
    [homeAssets],
  );
  const visibleHomeAssets = useMemo(
    () =>
      homeAssets.filter(
        (item) =>
          `${item.name} ${item.path} ${item.kind}`
            .toLowerCase()
            .includes(assetQuery.toLowerCase()) &&
          (assetKind === "all" || item.kind === assetKind),
      ),
    [assetKind, assetQuery, homeAssets],
  );
  const linkedWorkspaces = useMemo(
    () =>
      workspaces.filter((workspace) =>
        workspace.sources.some((source) => source.agent === selected),
      ),
    [selected, workspaces],
  );
  const recentLinkedWorkspaces = useMemo(
    () =>
      [...linkedWorkspaces].sort((left, right) =>
        (right.last_active_at ?? "").localeCompare(left.last_active_at ?? ""),
      ),
    [linkedWorkspaces],
  );
  const homeAssetKinds = useMemo(() => {
    const counts = homeAssets.reduce(
      (result, asset) => result.set(asset.kind, (result.get(asset.kind) ?? 0) + 1),
      new Map<string, number>(),
    );
    return [...counts.entries()].sort((left, right) => right[1] - left[1]);
  }, [homeAssets]);
  const selectedRemoteGateways = useMemo(
    () => remoteGateways.filter((gateway) => gateway.kind === selected),
    [remoteGateways, selected],
  );
  const support = agentSupport(installation);
  const visibleAgentKinds = useMemo(
    () =>
      agentKinds
        .filter((agent) => {
          const item = installations.find((value) => value.agent === agent);
          if (!agentLabels[agent].toLowerCase().includes(agentQuery.trim().toLowerCase()))
            return false;
          if (filter === "enabled") return Boolean(item?.installed);
          if (filter === "available") return Boolean(item?.configured && !item.installed);
          return true;
        })
        .sort((left, right) => {
          if (agentSort === "name") return agentLabels[left].localeCompare(agentLabels[right]);
          const leftInstalled = installations.find((item) => item.agent === left)?.installed
            ? 1
            : 0;
          const rightInstalled = installations.find((item) => item.agent === right)?.installed
            ? 1
            : 0;
          return rightInstalled - leftInstalled;
        }),
    [agentQuery, agentSort, filter, installations],
  );

  useEffect(() => {
    if (selectedAgent) {
      initialSelectionDone.current = true;
      setSelected(selectedAgent);
      saveSection(selectedAgent, "overview");
    }
  }, [selectedAgent, saveSection]);

  useEffect(() => {
    // Wait for all sources, otherwise the first completed query would choose the Agent.
    // A deliberate click or deep link always wins over a later async response.
    if (
      initialSelectionDone.current ||
      Object.values(loading).some(Boolean) ||
      Object.values(errors).some(Boolean)
    )
      return;
    const next =
      visibleAgentKinds.find(
        (agent) =>
          workspaces.some((workspace) =>
            workspace.sources.some((source) => source.agent === agent),
          ) ||
          assets.some((asset) => asset.agent === agent) ||
          remoteGateways.some(
            (gateway) =>
              gateway.kind === agent &&
              (gateway.workspaces.length > 0 || gateway.assets.length > 0),
          ) ||
          insightsStatus?.providers.some(
            (item) => item.agent === agent && item.available && item.imported_events > 0,
          ),
      ) ?? visibleAgentKinds[0];
    if (!next) return;
    initialSelectionDone.current = true;
    setSelected(next);
    saveSection(next, "overview");
  }, [
    assets,
    errors,
    insightsStatus,
    loading,
    remoteGateways,
    saveSection,
    visibleAgentKinds,
    workspaces,
  ]);

  useEffect(() => {
    if (visibleAgentKinds.length > 0 && !visibleAgentKinds.includes(selected)) {
      const next = visibleAgentKinds[0];
      setSelected(next);
      saveSection(next, "overview");
      if (initialSelectionDone.current) onSelectedAgentChange(next);
    }
  }, [onSelectedAgentChange, selected, visibleAgentKinds, saveSection]);

  useEffect(() => {
    setAssetQuery("");
    setAssetKind("all");
  }, [selected]);

  const clearFilters = () => {
    setAgentQuery("");
    onClearFilters?.();
  };
  const selectedVisible = visibleAgentKinds.includes(selected);
  const pageTabs: AgentDetailSection[] = agentSupportsInsights(selected)
    ? ["overview", "assets", "workspaces", "usage"]
    : ["overview", "assets", "workspaces"];

  return (
    <div className="grid min-w-0 items-start gap-5 min-[880px]:grid-cols-[230px_minmax(0,1fr)]">
      <aside
        className="min-w-0 rounded-2xl border border-border bg-card p-3"
        aria-label={tr("nav.agents")}
      >
        <section className="agent-sidebar-tools mb-3">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
            <label className="flex h-9 min-w-0 items-center gap-2 rounded-lg border border-border bg-background px-3">
              <Search size={14} className="text-muted-foreground" aria-hidden="true" />
              <Input
                className="h-8 border-0 px-0 shadow-none focus-visible:ring-0"
                aria-label={tr("common.search")}
                value={agentQuery}
                onChange={(event) => setAgentQuery(event.target.value)}
                placeholder={tr("common.search")}
              />
            </label>
            <Select
              value={agentSort}
              onValueChange={(value) => {
                if (value !== null) setAgentSort(String(value) as typeof agentSort);
              }}
            >
              <SelectTrigger className="h-9" aria-label={tr("agents.sortBy")}>
                <SelectValue>
                  {agentSort === "status" ? tr("agents.status") : tr("agents.name")}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>{tr("agents.sortBy")}</SelectLabel>
                  <SelectItem value="status">{tr("agents.status")}</SelectItem>
                  <SelectItem value="name">{tr("agents.name")}</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          {onFilterChange && (
            <Select
              value={filter}
              onValueChange={(value) => {
                if (value) onFilterChange(value as AgentFilter);
              }}
            >
              <SelectTrigger className="mt-2 h-9 w-full" aria-label={tr("agents.filters")}>
                <SelectValue>{tr(`agents.filter.${filter}`)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>{tr("agents.filters")}</SelectLabel>
                  {(["all", "enabled", "available"] as const).map((value) => (
                    <SelectItem key={value} value={value}>
                      {tr(`agents.filter.${value}`)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          )}
        </section>
        <div className="agent-sidebar-list [&_small]:leading-normal">
          <div className="grid gap-1">
            {([true, false] as const).map((installed) => {
              const group = visibleAgentKinds.filter(
                (agent) =>
                  Boolean(installations.find((item) => item.agent === agent)?.installed) ===
                  installed,
              );
              if (!group.length) return null;
              return (
                <section key={String(installed)} className="grid gap-1">
                  <h3 className="px-2 pb-1 pt-2 text-xs font-medium text-muted-foreground">
                    {tr(installed ? "agents.group.installed" : "agents.group.uninstalled")}
                  </h3>
                  {group.map((agent) => {
                    const item = installations.find((value) => value.agent === agent);
                    const remoteCount = remoteGateways
                      .filter((gateway) => gateway.kind === agent)
                      .reduce((total, gateway) => total + gateway.workspaces.length, 0);
                    const workspaceCount = workspaces.filter((workspace) =>
                      workspace.sources.some((source) => source.agent === agent),
                    ).length;
                    const count = workspaceCount + remoteCount;
                    const isSelected = selected === agent;
                    return (
                      <Button
                        variant="bare"
                        size="content"
                        key={agent}
                        data-sidebar-navigate
                        aria-pressed={isSelected}
                        className={cn(
                          "grid min-h-[64px] w-full grid-cols-[auto_minmax(0,1fr)] items-center gap-2 rounded-lg border px-2 py-2 text-left transition-colors",
                          isSelected
                            ? "border-foreground/25 bg-muted/40 text-foreground shadow-sm"
                            : "border-transparent text-muted-foreground hover:border-border hover:bg-muted/30 hover:text-foreground",
                        )}
                        onClick={() => {
                          initialSelectionDone.current = true;
                          setSelected(agent);
                          saveSection(agent, "overview");
                          onSelectedAgentChange(agent);
                        }}
                      >
                        <span className={cn(!item?.installed && "opacity-50")}>
                          <AgentIcon agent={agent} />
                        </span>
                        <span className="min-w-0">
                          <strong className="flex items-center gap-1 truncate text-sm text-foreground">
                            {agentLabels[agent]}
                            {agent === "deepseek-harness" && (
                              <Badge variant="outline">{tr("common.beta")}</Badge>
                            )}
                          </strong>{" "}
                          <small className="mt-1 block text-xs text-muted-foreground">
                            {item?.installed
                              ? loading.workspaces || loading.gateways
                                ? tr("common.loading")
                                : errors.workspaces || errors.gateways
                                  ? tr("errors.generic")
                                  : count > 0
                                    ? tr("agents.workspaceCount", { count })
                                    : tr("agents.noWorkspacesYet")
                              : tr("common.notInstalled")}
                            {!item?.installed && item?.configured && (
                              <> · {tr("agents.localDataFound")}</>
                            )}
                          </small>
                        </span>
                      </Button>
                    );
                  })}
                </section>
              );
            })}
            {!visibleAgentKinds.length && (
              <div className="grid justify-items-center gap-2 px-3 py-8 text-center">
                <p className="text-sm text-muted-foreground">{tr("agents.noAgents")}</p>
                <Button variant="outline" size="sm" onClick={clearFilters}>
                  {tr("common.clear")}
                </Button>
              </div>
            )}
          </div>
        </div>
      </aside>

      <div className="min-w-0">
        {!selectedVisible ? (
          <Card className="grid min-h-[420px] place-content-center justify-items-center gap-3 rounded-2xl border-border p-8 text-center shadow-sm">
            <Search size={28} className="text-muted-foreground" />
            <h2 className="text-base font-semibold">{tr("agents.noAgents")}</h2>
            <Button variant="outline" onClick={clearFilters}>
              {tr("common.clear")}
            </Button>
          </Card>
        ) : (
          <Card className="min-h-[420px] overflow-hidden rounded-2xl border-border shadow-sm">
            <CardHeader className="flex min-h-[78px] flex-row flex-wrap items-center gap-3 border-b border-border px-5 py-4">
              <AgentIcon agent={selected} />
              <div className="mr-auto min-w-0">
                <h2 className="truncate text-lg font-semibold tracking-tight">
                  {agentLabels[selected]}{" "}
                  <Badge variant="outline" className="ml-2 align-middle text-xs font-normal">
                    {tr(installation?.installed ? "common.installed" : "common.notInstalled")}
                  </Badge>
                </h2>
                {installation?.version && (
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {installation.version}
                  </span>
                )}
              </div>
              {installation?.home && (
                <code
                  title={installation.home}
                  className="order-3 w-full truncate text-xs text-muted-foreground"
                >
                  {displayPath(installation.home)}
                </code>
              )}
              {selected === "deepseek-harness" && (
                <Badge variant="outline">{tr("common.beta")}</Badge>
              )}
              <Tabs
                value={section}
                onValueChange={(value) => setSection(value as AgentDetailSection)}
                className="max-w-full shrink-0"
              >
                <TabsList
                  className="segmented-control !h-auto w-fit max-w-full justify-start overflow-x-auto"
                  variant="default"
                  aria-label={agentLabels[selected]}
                >
                  {pageTabs.map((value) => (
                    <TabsTrigger
                      className="segmented-control-item h-9 min-h-9 flex-none px-3"
                      value={value}
                      key={value}
                    >
                      {tr(`agents.section.${value}`)}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            </CardHeader>

            {section === "overview" && (
              <AgentOverviewPanel
                agent={selected}
                installation={installation}
                support={support}
                provider={provider}
                linkedWorkspaces={linkedWorkspaces}
                recentLinkedWorkspaces={recentLinkedWorkspaces}
                homeAssets={homeAssets}
                homeAssetKinds={homeAssetKinds}
                remoteGateways={selectedRemoteGateways}
                workspacesPending={loading.workspaces ?? false}
                workspacesError={errors.workspaces ?? false}
                assetsPending={loading.assets ?? false}
                assetsError={errors.assets ?? false}
                gatewaysPending={loading.gateways ?? false}
                gatewaysError={errors.gateways ?? false}
                insightsPending={loading.insights ?? false}
                insightsError={errors.insights ?? false}
                onOpenWorkspace={onOpen}
                onRetryWorkspaces={onRetry.workspaces ?? (() => undefined)}
                onRetryAssets={onRetry.assets ?? (() => undefined)}
                onRetryGateways={onRetry.gateways ?? (() => undefined)}
                onRetryInsights={onRetry.insights ?? (() => undefined)}
              />
            )}
            {section === "assets" && (
              <AgentAssetsPanel
                homeAssets={homeAssets}
                assetKinds={assetKinds}
                visibleAssets={visibleHomeAssets}
                query={assetQuery}
                kind={assetKind}
                loading={loading.assets ?? false}
                error={errors.assets ?? false}
                onQueryChange={setAssetQuery}
                onKindChange={setAssetKind}
                onRetry={onRetry.assets ?? (() => undefined)}
              />
            )}
            {section === "workspaces" && (
              <AgentWorkspacesPanel
                workspaces={linkedWorkspaces}
                remoteGateways={selectedRemoteGateways}
                loading={(loading.workspaces ?? false) || (loading.gateways ?? false)}
                error={(errors.workspaces ?? false) || (errors.gateways ?? false)}
                onOpen={onOpen}
                onRetry={
                  errors.workspaces
                    ? (onRetry.workspaces ?? (() => undefined))
                    : (onRetry.gateways ?? (() => undefined))
                }
              />
            )}
            {section === "usage" && (
              <AgentUsagePanel
                provider={provider}
                loading={loading.insights ?? false}
                error={errors.insights ?? false}
                onRetry={onRetry.insights ?? (() => undefined)}
              />
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
