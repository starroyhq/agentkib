import { useI18n } from "@/core/useI18n";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useEffect, useState } from "react";
import {
  Check,
  ChevronRight,
  CircleAlert,
  FileCode2,
  FolderGit2,
  LockKeyhole,
  PlugZap,
  Search,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { tr } from "@/core/i18n";
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
import type { AgentFilter } from "@/components/AppSidebar";

type AgentDetailSection = "overview" | "assets" | "workspaces" | "usage";

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
const agentLabels: Record<AgentKind, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  antigravity: "Antigravity",
  cursor: "Cursor",
  opencode: "OpenCode",
  "open-claw": "OpenClaw",
  hermes: "Hermes",
  "grok-build": "Grok Build",
  "deepseek-harness": "DeepSeek Harness",
};

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
}) {
  const { tr, formatRelativeTime } = useI18n();
  const [selected, setSelected] = useState<AgentKind>(selectedAgent ?? "codex");
  const [section, setSection] = useState<AgentDetailSection>("overview");
  const [agentQuery, setAgentQuery] = useState("");
  const [agentSort, setAgentSort] = useState<"name" | "status">("status");
  const [assetQuery, setAssetQuery] = useState("");
  const [assetKind, setAssetKind] = useState("all");
  const installation = installations.find((item) => item.agent === selected);
  const provider = insightsStatus?.providers.find((item) => item.agent === selected);
  const homeAssets = assets.filter((item) => item.agent === selected);
  const assetKinds = [...new Set(homeAssets.map((item) => item.kind))].sort();
  const visibleHomeAssets = homeAssets.filter(
    (item) =>
      `${item.name} ${item.path} ${item.kind}`.toLowerCase().includes(assetQuery.toLowerCase()) &&
      (assetKind === "all" || item.kind === assetKind),
  );
  const linkedWorkspaces = workspaces.filter((workspace) =>
    workspace.sources.some((source) => source.agent === selected),
  );
  const recentLinkedWorkspaces = [...linkedWorkspaces]
    .sort((left, right) => (right.last_active_at ?? "").localeCompare(left.last_active_at ?? ""))
    .slice(0, 5);
  const homeAssetKinds = [
    ...homeAssets
      .reduce(
        (counts, asset) => counts.set(asset.kind, (counts.get(asset.kind) ?? 0) + 1),
        new Map<string, number>(),
      )
      .entries(),
  ].sort((left, right) => right[1] - left[1]);
  const selectedRemoteGateways = remoteGateways.filter((gateway) => gateway.kind === selected);
  const support = agentSupport(installation);
  const remoteWorkspaceCount = selectedRemoteGateways.reduce(
    (total, gateway) => total + gateway.workspaces.length,
    0,
  );
  const visibleAgentKinds = agentKinds
    .filter((agent) => {
      const item = installations.find((installation) => installation.agent === agent);
      if (!agentLabels[agent].toLowerCase().includes(agentQuery.trim().toLowerCase())) return false;
      if (filter === "enabled") return Boolean(item?.installed);
      if (filter === "available") return Boolean(item?.configured && !item.installed);
      return true;
    })
    .sort((left, right) => {
      if (agentSort === "name") return agentLabels[left].localeCompare(agentLabels[right]);
      const leftInstalled = installations.find((item) => item.agent === left)?.installed ? 1 : 0;
      const rightInstalled = installations.find((item) => item.agent === right)?.installed ? 1 : 0;
      return rightInstalled - leftInstalled;
    });

  useEffect(() => {
    if (selectedAgent && selectedAgent !== selected) {
      setSelected(selectedAgent);
      setSection("overview");
    }
  }, [selected, selectedAgent]);

  useEffect(() => {
    if (visibleAgentKinds.length > 0 && !visibleAgentKinds.includes(selected)) {
      const next = visibleAgentKinds[0];
      setSelected(next);
      setSection("overview");
      onSelectedAgentChange(next);
    }
  }, [onSelectedAgentChange, selected, visibleAgentKinds]);

  return (
    <div className="grid gap-3 pb-8">
      <section className="flex flex-wrap items-center justify-end gap-2 border-b border-border pb-4">
        <div className="flex items-center gap-2">
          <label className="flex h-9 min-w-[220px] items-center gap-2 rounded-lg border border-border bg-background px-3">
            <Search size={14} className="text-muted-foreground" />
            <Input
              className="h-8 border-0 px-0 shadow-none focus-visible:ring-0"
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
            <SelectTrigger className="h-9" aria-label={tr("agents.status")}>
              <SelectValue>
                {agentSort === "status" ? tr("agents.status") : tr("agents.name")}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="status">{tr("agents.status")}</SelectItem>
              <SelectItem value="name">{tr("agents.name")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </section>
      <div className="relative grid items-start gap-5 min-[1024px]:grid-cols-[360px_minmax(0,1fr)]">
        <div className="grid gap-4">
          <Card className="overflow-hidden rounded-2xl border-border shadow-sm">
            <CardContent className="grid gap-2 p-3">
              {visibleAgentKinds.map((agent) => {
                const item = installations.find((value) => value.agent === agent);
                const remoteCount = remoteGateways
                  .filter((gateway) => gateway.kind === agent)
                  .reduce((total, gateway) => total + gateway.workspaces.length, 0);
                const count =
                  workspaces.filter((workspace) =>
                    workspace.sources.some((source) => source.agent === agent),
                  ).length + remoteCount;
                const isSelected = selected === agent;
                return (
                  <Button
                    variant="bare"
                    size="content"
                    key={agent}
                    aria-pressed={isSelected}
                    className={cn(
                      "grid min-h-[76px] w-full grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors",
                      isSelected
                        ? "border-foreground/25 bg-muted/40 text-foreground shadow-sm"
                        : "border-transparent text-muted-foreground hover:border-border hover:bg-muted/30 hover:text-foreground",
                    )}
                    onClick={() => {
                      setSelected(agent);
                      setSection("overview");
                      onSelectedAgentChange(agent);
                    }}
                  >
                    <AgentIcon agent={agent} />
                    <span className="min-w-0">
                      <strong className="flex items-center gap-2 truncate text-sm text-foreground">
                        {agentLabels[agent]}
                        {agent === "deepseek-harness" && (
                          <Badge variant="outline">{tr("common.beta")}</Badge>
                        )}
                      </strong>
                      <small className="mt-1 block text-xs text-muted-foreground">
                        {count} {tr("common.workspaces")}
                      </small>
                    </span>
                    <Badge variant={item?.installed ? "secondary" : "outline"}>
                      {tr(
                        item?.installed
                          ? "common.installed"
                          : item?.configured
                            ? "agents.localDataFound"
                            : "common.notInstalled",
                      )}
                    </Badge>
                    <ChevronRight size={16} className="text-muted-foreground" />
                  </Button>
                );
              })}
              {visibleAgentKinds.length === 0 && (
                <p className="px-3 py-10 text-center text-sm text-muted-foreground">
                  {tr("agents.noAgents")}
                </p>
              )}
            </CardContent>
          </Card>
        </div>

        <Card className="min-h-[420px] overflow-hidden rounded-2xl border-border shadow-sm">
          <CardHeader className="flex min-h-[78px] flex-row items-center gap-3 border-b border-border px-5 py-4">
            <AgentIcon agent={selected} />
            <div className="mr-auto min-w-0">
              <h2 className="truncate text-lg font-semibold tracking-tight">
                {agentLabels[selected]}
              </h2>
              {installation?.version && (
                <span className="mt-1 block text-xs text-muted-foreground">
                  {installation.version}
                </span>
              )}
            </div>
            {selected === "deepseek-harness" && (
              <Badge variant="outline">{tr("common.beta")}</Badge>
            )}
            <Tabs
              value={section}
              onValueChange={(value) => setSection(value as AgentDetailSection)}
              className="shrink-0"
            >
              <TabsList
                className="segmented-control !h-auto w-fit justify-start"
                variant="default"
                aria-label={agentLabels[selected]}
              >
                {(agentSupportsInsights(selected)
                  ? (["overview", "assets", "workspaces", "usage"] as AgentDetailSection[])
                  : (["overview", "assets", "workspaces"] as AgentDetailSection[])
                ).map((value) => (
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
            <div className="grid gap-5 p-5">
              {selected === "deepseek-harness" && (
                <div className="flex items-center gap-3 rounded-xl border border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
                  <CircleAlert size={16} />
                  {tr("agents.deepseekReadOnly")}
                </div>
              )}

              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {[
                  [tr("agents.linkedWorkspaces"), linkedWorkspaces.length + remoteWorkspaceCount],
                  [tr("agents.homeAssets"), homeAssets.length],
                  [
                    tr("agents.provider"),
                    provider?.available ? tr("quota.available") : tr("insights.noData"),
                  ],
                  [
                    tr("agents.continuationCapability"),
                    support === undefined
                      ? tr("agents.capability.unknown")
                      : support.continuation
                        ? tr("agents.capability.supported")
                        : tr("agents.capability.unavailable"),
                  ],
                ].map(([label, value]) => (
                  <div
                    className="grid min-h-[92px] content-center gap-2 rounded-xl border border-border bg-muted/20 p-4"
                    key={label}
                  >
                    <span className="text-xs text-muted-foreground">{label}</span>
                    <strong className="text-lg tracking-tight">{value}</strong>
                  </div>
                ))}
              </div>

              <section className="grid gap-3 rounded-xl border border-border bg-background p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="text-sm font-semibold">{tr("agents.capabilities")}</h3>
                  <span className="text-xs text-muted-foreground">
                    {tr("agents.capabilitiesDescription")}
                  </span>
                </div>
                <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,12rem),1fr))] gap-2">
                  {[
                    ["workspace_discovery", tr("agents.capability.workspaceDiscovery")],
                    ["session_list", tr("agents.capability.sessionList")],
                    ["history_read", tr("agents.capability.historyRead")],
                    ["continuation", tr("agents.capability.continuation")],
                  ].map(([key, label]) => {
                    const value = support?.[key as keyof typeof support];
                    const known = typeof value === "boolean";
                    const enabled = value === true;
                    return (
                      <div
                        className="grid min-h-[68px] content-center gap-2 rounded-lg bg-muted/25 px-3 py-2 text-sm"
                        key={key}
                      >
                        <span className="min-w-0 text-muted-foreground">{label}</span>
                        <span
                          className={cn(
                            "inline-flex w-fit shrink-0 items-center gap-1 whitespace-nowrap text-xs font-medium",
                            !known
                              ? "text-muted-foreground"
                              : enabled
                                ? "text-emerald-600"
                                : "text-muted-foreground",
                          )}
                        >
                          {!known ? null : enabled ? <Check size={14} /> : <X size={14} />}
                          {tr(
                            !known
                              ? "agents.capability.unknown"
                              : enabled
                                ? "agents.capability.supported"
                                : "agents.capability.unavailable",
                          )}
                        </span>
                      </div>
                    );
                  })}
                  <div className="grid min-h-[68px] content-center gap-2 rounded-lg bg-muted/25 px-3 py-2 text-sm">
                    <span className="min-w-0 text-muted-foreground">
                      {tr("agents.capability.control")}
                    </span>
                    <span className="inline-flex w-fit shrink-0 items-center gap-1 whitespace-nowrap text-xs font-medium text-muted-foreground">
                      <LockKeyhole size={14} />
                      {tr(
                        support
                          ? `agents.capability.control.${support.control}`
                          : "agents.capability.unknown",
                      )}
                    </span>
                  </div>
                </div>
              </section>

              {installation?.home && (
                <div className="flex min-w-0 items-center gap-3 rounded-xl border border-border bg-background px-4 py-3">
                  <FolderGit2 size={16} className="shrink-0 text-muted-foreground" />
                  <code className="block min-w-0 truncate text-xs text-muted-foreground">
                    {installation.home}
                  </code>
                </div>
              )}
              {installation?.warnings.map((warning) => (
                <div
                  className="flex items-center gap-3 rounded-xl border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive"
                  key={warning}
                >
                  <CircleAlert size={16} />
                  {installationWarningLabel(warning, tr)}
                </div>
              ))}

              <div className="grid gap-4 lg:grid-cols-2">
                <section className="rounded-xl border border-border bg-background p-4">
                  <h3 className="mb-3 text-sm font-semibold">{tr("agents.recentWorkspaces")}</h3>
                  <div className="grid gap-1">
                    {recentLinkedWorkspaces.map((workspace) => (
                      <Button
                        variant="bare"
                        size="content"
                        className="grid min-h-[58px] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-lg px-2 py-2 text-left text-sm hover:bg-muted/40"
                        key={workspace.id}
                        onClick={() => void onOpen(workspace)}
                      >
                        <FolderGit2 size={15} className="text-muted-foreground" />
                        <span className="min-w-0 truncate">
                          {workspace.name}
                          <small
                            className="mt-1 block truncate text-xs text-muted-foreground"
                            title={workspace.path}
                          >
                            {workspace.path}
                          </small>
                        </span>
                        <small className="text-xs text-muted-foreground">
                          {workspace.last_active_at
                            ? formatRelativeTime(workspace.last_active_at)
                            : tr("common.never")}
                        </small>
                      </Button>
                    ))}
                    {!recentLinkedWorkspaces.length && (
                      <p className="px-2 py-4 text-sm text-muted-foreground">
                        {tr("agents.noRecentWorkspaces")}
                      </p>
                    )}
                  </div>
                </section>

                <section className="rounded-xl border border-border bg-background p-4">
                  <h3 className="mb-3 text-sm font-semibold">{tr("agents.homeAssetTypes")}</h3>
                  <dl className="grid gap-1">
                    {homeAssetKinds.map(([kind, count]) => (
                      <div
                        className="flex min-h-[42px] items-center justify-between rounded-lg px-2 text-sm odd:bg-muted/20"
                        key={kind}
                      >
                        <dt className="text-muted-foreground">{tr(`status.asset.${kind}`)}</dt>
                        <dd className="font-medium">{count}</dd>
                      </div>
                    ))}
                    {!homeAssetKinds.length && (
                      <div className="flex min-h-[42px] items-center justify-between rounded-lg bg-muted/20 px-2 text-sm">
                        <dt className="text-muted-foreground">{tr("agents.noHomeAssets")}</dt>
                        <dd className="font-medium">0</dd>
                      </div>
                    )}
                  </dl>
                </section>
              </div>

              {selectedRemoteGateways.length > 0 && (
                <RemoteAgentGatewayDetails gateways={selectedRemoteGateways} />
              )}
            </div>
          )}

          {section === "assets" && (
            <div className="grid gap-4 p-5">
              <div className="grid gap-3 rounded-xl border border-border bg-muted/20 p-3 md:grid-cols-[minmax(0,1fr)_auto]">
                <label className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-background px-3">
                  <Search size={15} className="shrink-0 text-muted-foreground" />
                  <Input
                    className="h-9 border-0 px-0 shadow-none focus-visible:ring-0"
                    aria-label={tr("catalog.searchPlaceholder")}
                    value={assetQuery}
                    onChange={(event) => setAssetQuery(event.target.value)}
                    placeholder={tr("catalog.searchPlaceholder")}
                  />
                </label>
                {assetKinds.length > 1 && (
                  <Select
                    value={assetKind}
                    onValueChange={(value) => {
                      if (value !== null) setAssetKind(String(value));
                    }}
                  >
                    <SelectTrigger
                      aria-label={tr("catalog.allTypes")}
                      className="h-9 w-full md:w-auto md:min-w-[150px]"
                    >
                      <SelectValue>
                        {assetKind === "all"
                          ? tr("catalog.allTypes")
                          : tr(`status.asset.${assetKind}`)}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{tr("catalog.allTypes")}</SelectItem>
                      {assetKinds.map((value) => (
                        <SelectItem key={value} value={value}>
                          {tr(`status.asset.${value}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
              <div className="grid gap-2">
                {visibleHomeAssets.map((asset) => (
                  <div
                    className="grid min-h-[64px] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-xl border border-border bg-background px-3 py-2 text-sm"
                    key={asset.id}
                  >
                    <span className="grid size-8 place-items-center rounded-lg bg-muted/40">
                      <FileCode2 size={15} className="text-muted-foreground" />
                    </span>
                    <span className="min-w-0 truncate">
                      <strong className="block truncate">{asset.name}</strong>
                      <small className="mt-1 block truncate text-xs text-muted-foreground">
                        {shortPath(asset.path)}
                      </small>
                    </span>
                    <em className="not-italic text-xs text-muted-foreground">
                      {tr(`status.asset.${asset.kind}`)}
                    </em>
                  </div>
                ))}
                {!visibleHomeAssets.length && (
                  <Empty icon={FileCode2} title={tr("agents.noHomeAssets")} />
                )}
              </div>
            </div>
          )}

          {section === "workspaces" && (
            <div className="grid gap-4 p-5">
              <div className="grid gap-2">
                {linkedWorkspaces.map((workspace) => (
                  <div
                    className="grid min-h-[64px] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-xl border border-border bg-background px-3 py-2 text-sm"
                    key={workspace.id}
                  >
                    <span className="grid size-8 place-items-center rounded-lg bg-muted/40">
                      <FolderGit2 size={15} className="text-muted-foreground" />
                    </span>
                    <span className="min-w-0 truncate">
                      <strong className="block truncate">{workspace.name}</strong>
                      <small className="mt-1 block truncate text-xs text-muted-foreground">
                        {workspace.path}
                      </small>
                    </span>
                    <small className="text-xs text-muted-foreground">{workspace.asset_count}</small>
                  </div>
                ))}
              </div>
              {selectedRemoteGateways.length > 0 && (
                <RemoteAgentGatewayDetails gateways={selectedRemoteGateways} />
              )}
              {!linkedWorkspaces.length && !selectedRemoteGateways.length && (
                <Empty icon={FolderGit2} title={tr("workspace.noMatch")} />
              )}
            </div>
          )}

          {section === "usage" && (
            <div className="grid gap-4 p-5">
              <section className="grid gap-2 rounded-xl border border-border bg-muted/20 p-4">
                <span className="text-xs text-muted-foreground">{tr("agents.provider")}</span>
                <strong className="text-base">
                  {provider?.available ? tr("quota.available") : tr("insights.noData")}
                </strong>
                {provider?.coverage_from && (
                  <small className="text-xs text-muted-foreground">
                    {provider.coverage_from} — {provider.coverage_to}
                  </small>
                )}
              </section>
              {(provider?.error_key || provider?.error) && (
                <Collapsible className="rounded-xl border border-border p-4">
                  <CollapsibleTrigger className="text-sm font-medium">
                    {provider.error_key
                      ? tr(provider.error_key, { defaultValue: tr("insights.providerUnavailable") })
                      : tr("insights.providerUnavailable")}
                  </CollapsibleTrigger>
                  {provider.error && (
                    <CollapsibleContent className="pt-3">
                      <pre className="rounded-lg bg-muted p-3 text-xs whitespace-pre-wrap">
                        {provider.error}
                      </pre>
                    </CollapsibleContent>
                  )}
                </Collapsible>
              )}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function RemoteAgentGatewayDetails({ gateways }: { gateways: RemoteGatewaySummary[] }) {
  const { tr } = useI18n();
  const sectionClass = "grid gap-3 rounded-xl border border-border bg-background p-4";
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <section className={sectionClass}>
        <h3 className="text-sm font-semibold">{tr("gateway.title")}</h3>
        <div className="grid gap-2">
          {gateways.map((gateway) => (
            <div
              className="grid min-h-[58px] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-lg bg-muted/20 px-2 text-sm"
              key={gateway.id}
            >
              <PlugZap size={15} className="text-muted-foreground" />
              <span className="min-w-0 truncate">
                <strong className="block truncate">{gateway.name}</strong>
                <small className="block truncate text-xs text-muted-foreground">
                  {gateway.url}
                </small>
              </span>
              <em className={`not-italic text-xs gateway-${gateway.state}`}>
                {tr(`gateway.state.${gateway.state}`)}
              </em>
            </div>
          ))}
        </div>
      </section>
      <section className={sectionClass}>
        <h3 className="text-sm font-semibold">{tr("gateway.remoteWorkspaces")}</h3>
        <div className="grid gap-2">
          {gateways.flatMap((gateway) =>
            gateway.workspaces.map((workspace) => (
              <div
                className="grid min-h-[58px] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-lg bg-muted/20 px-2 text-sm"
                key={`${gateway.id}:${workspace.id}`}
              >
                <FolderGit2 size={15} className="text-muted-foreground" />
                <span className="min-w-0 truncate">
                  <strong className="block truncate">{workspace.name}</strong>
                  <small className="block truncate text-xs text-muted-foreground">
                    {workspace.path ?? gateway.name}
                  </small>
                </span>
                <small className="text-xs text-muted-foreground">
                  {tr("common.sessions")} {workspace.session_count}
                </small>
              </div>
            )),
          )}
        </div>
      </section>
      <section className={sectionClass}>
        <h3 className="text-sm font-semibold">{tr("gateway.remoteAssets")}</h3>
        <div className="grid gap-2">
          {gateways.flatMap((gateway) =>
            gateway.assets.map((asset) => (
              <div
                className="grid min-h-[58px] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-lg bg-muted/20 px-2 text-sm"
                key={`${gateway.id}:${asset.id}`}
              >
                <FileCode2 size={15} className="text-muted-foreground" />
                <span className="min-w-0 truncate">
                  <strong className="block truncate">{asset.name}</strong>
                  <small className="block truncate text-xs text-muted-foreground">
                    {asset.path}
                  </small>
                </span>
                <em className="not-italic text-xs text-muted-foreground">{asset.kind}</em>
              </div>
            )),
          )}
          {gateways.every((gateway) => !gateway.assets.length) && (
            <p className="pt-2 text-sm text-muted-foreground">
              {tr(
                gateways.every((gateway) => gateway.kind === "hermes")
                  ? "gateway.hermesPartial"
                  : "gateway.noRemoteAssets",
              )}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

function installationWarningLabel(warning: string, translate = tr) {
  if (warning === "DeepSeek Harness workspace storage version is not supported")
    return translate("errors.deepseekWorkspaceVersion");
  return warning;
}

function shortPath(path: string) {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : path;
}

function Empty({ icon: Icon, title }: { icon: typeof FileCode2; title: string }) {
  return (
    <div className="grid min-h-[120px] place-content-center justify-items-center gap-2 rounded-xl border border-dashed border-border p-4 text-center text-muted-foreground">
      <Icon size={28} />
      <h3 className="m-0 text-sm font-medium">{title}</h3>
    </div>
  );
}
