import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { InsightsSkeleton } from "./InsightsSkeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useMemo, useState, type ComponentType } from "react";
import {
  Activity,
  Award,
  Brain,
  CalendarCheck2,
  CalendarDays,
  Check,
  ChevronRight,
  CircleAlert,
  Flame,
  FolderGit2,
  GitCommitHorizontal,
  LockKeyhole,
  MessageSquareText,
  Moon,
  Network,
  PlugZap,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Workflow,
  X,
} from "lucide-react";
import {
  achievementReached,
  buildAchievementWallItems,
  selectDefaultTrackMilestone,
  type AchievementCategory,
  type AchievementTrack,
  type AchievementWallItem,
} from "@/features/insights/achievements";
import {
  formatCompactNumber,
  formatDateTime,
  formatRelativeTime,
  localizeMessage,
  currentLocale,
  tr,
} from "@/core/i18n";
import {
  agentSupportsInsights,
  buildHeatmapMonthMarkers,
  insightsAgentKinds,
} from "@/features/insights/insights";
import type {
  AgentUsageBreakdown,
  Achievement,
  AgentKind,
  HeatmapPoint,
  InsightsQuery,
  InsightsStatus,
  WorkspaceSummary,
} from "@/core/types";
import { AgentIcon } from "@/features/agents/AgentIcon";
import { cn } from "@/lib/utils";
import { useInsightsRefreshJob, useInsightsView } from "./insights-query";

type HeatmapMetric = "tokens" | "my_commits" | "all_commits" | "attributed_commits" | "sessions";
export type InsightsSection = "overview" | "tokens" | "commits" | "milestones" | "sources";

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

export function InsightsPage({
  section,
  workspaces,
}: {
  section: InsightsSection;
  workspaces: WorkspaceSummary[];
}) {
  const [agent, setAgent] = useState<"all" | AgentKind>("all");
  const [workspaceId, setWorkspaceId] = useState("all");
  const [repository, setRepository] = useState("all");
  const [range, setRange] = useState<"52w" | "year">("52w");
  const [metric, setMetric] = useState<HeatmapMetric>("tokens");
  const query = useMemo<InsightsQuery>(() => {
    const today = new Date();
    const from =
      range === "year"
        ? new Date(today.getFullYear(), 0, 1)
        : new Date(today.getFullYear(), today.getMonth(), today.getDate() - 363);
    const tokenView = section === "overview" || section === "tokens";
    const commitView = section === "overview" || section === "commits";
    return {
      from: localDate(from),
      to: localDate(today),
      agent: tokenView && agent !== "all" ? agent : undefined,
      workspace_id: tokenView && workspaceId !== "all" ? workspaceId : undefined,
      repository_group_id: commitView && repository !== "all" ? repository : undefined,
    };
  }, [agent, workspaceId, repository, range, section]);
  const viewQuery = useInsightsView(query);
  const refreshJobQuery = useInsightsRefreshJob();
  const view = viewQuery.data;
  const summary = view?.summary;
  const points = view?.heatmap ?? [];
  const agents = view?.agents ?? [];
  const models = view?.models ?? [];
  const workspaceUsage = view?.workspaces ?? [];
  const repositories = view?.repositories ?? [];
  const achievements = view?.achievements ?? [];
  const status = view?.status;
  const refreshJob = refreshJobQuery.data;
  const busy =
    view?.status.running === true ||
    refreshJob?.state === "queued" ||
    refreshJob?.state === "running";
  const error =
    (viewQuery.error ? localizeMessage(viewQuery.error) : "") ||
    (refreshJobQuery.error ? localizeMessage(refreshJobQuery.error) : "") ||
    (refreshJob?.state === "failed" ? refreshJob.error : undefined) ||
    "";
  const metricLabels: Record<HeatmapMetric, string> = {
    tokens: "Token",
    my_commits: tr("insights.myCommits"),
    all_commits: tr("insights.allCommits"),
    attributed_commits: tr("insights.attributedCommits"),
    sessions: tr("common.sessions"),
  };
  const max = Math.max(1, ...points.map((point) => point[metric]));
  const padding = points.length ? (new Date(`${points[0].date}T00:00:00`).getDay() + 6) % 7 : 0;
  const heatmapYear = points.length ? Number(points[0].date.slice(0, 4)) : new Date().getFullYear();
  const heatmapPadding =
    range === "year" ? (new Date(heatmapYear, 0, 1).getDay() + 6) % 7 : padding;
  const heatmapDays = range === "year" ? new Date(heatmapYear + 1, 0, 0).getDate() : points.length;
  const heatmapColumns = Math.max(1, Math.ceil((heatmapPadding + heatmapDays) / 7));
  const repositoryOptions = [
    ...new Map(
      workspaces
        .filter((value) => value.repository_group_id)
        .map((value) => [value.repository_group_id!, value.name]),
    ).entries(),
  ];
  const showTokenFilters = section === "overview" || section === "tokens";
  const showCommitFilters = section === "overview" || section === "commits";
  const showRange = !["milestones", "sources"].includes(section);
  const showMetricTabs = section === "overview";
  const filterClass = "h-10 min-w-[132px] max-[520px]:min-w-0 max-[520px]:flex-1";

  if (!view) return <InsightsSkeleton section={section} />;

  return (
    <div className="relative grid gap-5">
      <section className="grid gap-3">
        <div className="flex flex-wrap items-center justify-end gap-2">
          {busy && <Badge variant="secondary">{tr("tray.refreshInsights")}</Badge>}
          {error && (
            <div className="flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <CircleAlert size={16} />
              {error}
            </div>
          )}
        </div>
        <div className="flex min-w-0 items-center gap-3 overflow-x-auto pb-1">
          {showMetricTabs && (
            <Tabs
              value={metric}
              onValueChange={(value) => setMetric(value as HeatmapMetric)}
              className="shrink-0"
            >
              <TabsList
                className="segmented-control !h-auto w-fit max-w-full justify-start"
                variant="default"
                aria-label={tr("insights.heatmap")}
              >
                {(Object.keys(metricLabels) as HeatmapMetric[]).map((value) => (
                  <TabsTrigger
                    className="segmented-control-item h-9 min-h-9 flex-none px-3"
                    key={value}
                    value={value}
                  >
                    {metricLabels[value]}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          )}
          <div className="flex shrink-0 flex-nowrap items-center justify-end gap-2">
            {showTokenFilters && (
              <Select
                value={agent}
                onValueChange={(value) => {
                  if (value !== null) setAgent(String(value) as typeof agent);
                }}
              >
                <SelectTrigger className={filterClass} aria-label={tr("workspace.allAgents")}>
                  <SelectValue>
                    {agent === "all" ? tr("workspace.allAgents") : agentLabels[agent]}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{tr("workspace.allAgents")}</SelectItem>
                  {insightsAgentKinds.map((value) => (
                    <SelectItem key={value} value={value}>
                      {agentLabels[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {showTokenFilters && (
              <Select
                value={workspaceId}
                onValueChange={(value) => {
                  if (value !== null) setWorkspaceId(String(value));
                }}
              >
                <SelectTrigger className={filterClass} aria-label={tr("workspace.all")}>
                  <SelectValue>
                    {workspaceId === "all"
                      ? tr("workspace.all")
                      : (workspaces.find((value) => value.id === workspaceId)?.name ??
                        tr("workspace.all"))}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{tr("workspace.all")}</SelectItem>
                  {workspaces.map((value) => (
                    <SelectItem key={value.id} value={value.id}>
                      {value.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {showCommitFilters && (
              <Select
                value={repository}
                onValueChange={(value) => {
                  if (value !== null) setRepository(String(value));
                }}
              >
                <SelectTrigger className={filterClass} aria-label={tr("insights.allRepositories")}>
                  <SelectValue>
                    {repository === "all"
                      ? tr("insights.allRepositories")
                      : (repositoryOptions.find(([id]) => id === repository)?.[1] ??
                        tr("insights.allRepositories"))}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{tr("insights.allRepositories")}</SelectItem>
                  {repositoryOptions.map(([id, name]) => (
                    <SelectItem key={id} value={id}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {showRange && (
              <Select
                value={range}
                onValueChange={(value) => {
                  if (value !== null) setRange(String(value) as typeof range);
                }}
              >
                <SelectTrigger className={filterClass} aria-label={tr("insights.range52w")}>
                  <SelectValue>
                    {range === "52w" ? tr("insights.range52w") : tr("insights.rangeYear")}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="52w">{tr("insights.range52w")}</SelectItem>
                  <SelectItem value="year">{tr("insights.rangeYear")}</SelectItem>
                </SelectContent>
              </Select>
            )}
          </div>
        </div>
      </section>
      {!summary && (
        <Card className="rounded-2xl border-border bg-card shadow-sm">
          <Empty
            icon={Award}
            title={tr("insights.preparing")}
            text={tr("insights.preparingText")}
          />
        </Card>
      )}
      {summary && section === "overview" && (
        <>
          <div className="grid gap-4">
            <div className="grid grid-cols-4 gap-3 max-[900px]:grid-cols-2 max-[560px]:grid-cols-1">
              <AchievementMetric
                icon={Sparkles}
                tone="blue"
                label={tr("insights.totalToken")}
                value={formatCompact(summary.total_tokens)}
                detail={
                  summary.coverage_from ? `${summary.coverage_from} — ${summary.coverage_to}` : ""
                }
              />
              <AchievementMetric
                icon={GitCommitHorizontal}
                tone="violet"
                label={tr("insights.myCommits")}
                value={formatCompact(summary.my_commits)}
                detail={tr("insights.allActivity", { count: formatCompact(summary.all_commits) })}
              />
              <AchievementMetric
                icon={CalendarDays}
                tone="green"
                label={tr("insights.activeDays")}
                value={`${summary.active_days} ${tr("common.days")}`}
                detail={tr("insights.recordedSessions", {
                  count: formatCompact(summary.session_count),
                })}
              />
              <AchievementMetric
                icon={Flame}
                tone="amber"
                label={tr("insights.currentStreak")}
                value={`${summary.current_streak} ${tr("common.days")}`}
                detail={tr("insights.longestStreak", { count: summary.longest_streak })}
              />
            </div>
            <div>
              <Card className="overflow-hidden rounded-2xl border-border bg-card shadow-sm">
                <CardHeader className="flex min-h-[62px] flex-row items-center justify-between gap-3 border-b border-border px-5 py-3">
                  <div>
                    <h2 className="text-base font-semibold text-foreground">
                      {tr("insights.heatmap")}
                    </h2>
                    <p className="mt-0.5 text-xs text-muted-foreground">{metricLabels[metric]}</p>
                  </div>
                  <Badge variant="outline">
                    {showRange
                      ? range === "year"
                        ? tr("insights.rangeYear")
                        : tr("insights.range52w")
                      : tr("nav.insights")}
                  </Badge>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="px-5 pb-4 pt-4">
                    <div className="flex items-start gap-2">
                      <HeatmapWeekdays />
                      <div className="min-w-0 flex-1 overflow-x-auto">
                        <HeatmapMonths
                          points={points}
                          padding={heatmapPadding}
                          columns={heatmapColumns}
                          year={range === "year" ? heatmapYear : undefined}
                        />
                        <div
                          className="[--heatmap-cell-size:11px] grid w-full grid-flow-col grid-rows-[repeat(7,11px)] auto-cols-[11px] gap-1 max-[1200px]:[--heatmap-cell-size:8px] max-[1200px]:grid-rows-[repeat(7,8px)] max-[1200px]:auto-cols-[8px] max-[1200px]:gap-[2px]"
                          style={{
                            gridTemplateColumns: `repeat(${heatmapColumns}, var(--heatmap-cell-size))`,
                            justifyContent: "space-between",
                          }}
                        >
                          {Array.from({ length: heatmapPadding }, (_, index) => (
                            <span
                              className="invisible block size-[11px] rounded-[3px]"
                              key={`padding-${index}`}
                            />
                          ))}
                          {points.map((point) => {
                            const value = point[metric];
                            const level = value ? Math.max(1, Math.ceil((value / max) * 4)) : 0;
                            return (
                              <span
                                key={point.date}
                                className={heatmapCellClass(level)}
                                title={`${point.date} · ${metricLabels[metric]} ${formatCompact(value)}`}
                              />
                            );
                          })}
                          {Array.from(
                            { length: Math.max(0, heatmapDays - points.length) },
                            (_, index) => (
                              <span
                                className={heatmapCellClass(0)}
                                key={`future-${index}`}
                                aria-hidden="true"
                              />
                            ),
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center justify-end gap-1 border-t border-border px-5 py-3 text-[10px] text-muted-foreground">
                    <span>{tr("insights.less")}</span>
                    {[0, 1, 2, 3, 4].map((level) => (
                      <i key={level} className={heatmapCellClass(level)} />
                    ))}
                    <span>{tr("insights.more")}</span>
                  </div>
                </CardContent>
              </Card>
            </div>
            <div className="grid items-stretch gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(280px,0.6fr)]">
              <TokenTrendCard points={points} metric={metric} metricLabel={metricLabels[metric]} />
              <AgentUsageSummary agents={agents} />
            </div>
          </div>
        </>
      )}
      {summary && section === "tokens" && (
        <>
          <Card className="overflow-hidden rounded-2xl border-border bg-card shadow-sm">
            <CardHeader className="flex min-h-[58px] items-center border-b border-border px-5 py-4">
              <h2 className="m-0 text-base font-semibold">{tr("insights.agentUsage")}</h2>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y divide-border">
                {agents.map((value) => (
                  <div
                    className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3"
                    key={value.agent}
                  >
                    <AgentIcon agent={value.agent} />
                    <span className="grid min-w-0 gap-0.5">
                      <strong className="truncate text-sm">{agentLabels[value.agent]}</strong>
                      <small className="text-xs text-muted-foreground">
                        {value.session_count} {tr("common.sessions")}
                      </small>
                    </span>
                    <div className="grid justify-items-end">
                      <strong className="text-sm tabular-nums">
                        {formatCompact(value.total_tokens)}
                      </strong>
                      <small className="text-xs text-muted-foreground">Token</small>
                    </div>
                  </div>
                ))}
                {!agents.length && (
                  <p className="px-4 py-6 text-sm text-muted-foreground">
                    {tr("insights.noToken")}
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
          <div className="grid gap-4 lg:grid-cols-2">
            <BreakdownPanel
              title={tr("insights.modelUsage")}
              values={models.map((value) => ({
                key: value.model,
                label: value.model,
                detail: `${value.session_count} ${tr("common.sessions")}`,
                value: value.total_tokens,
              }))}
            />
            <BreakdownPanel
              title={tr("insights.workspaceUsage")}
              values={workspaceUsage.map((value) => ({
                key: value.workspace_id ?? "unlinked",
                label: value.name,
                detail: `${value.session_count} ${tr("common.sessions")}`,
                value: value.total_tokens,
              }))}
            />
          </div>
        </>
      )}
      {summary && section === "commits" && (
        <Card className="overflow-hidden rounded-2xl border-border bg-card shadow-sm">
          <CardHeader className="flex min-h-[58px] items-center border-b border-border px-5 py-4">
            <h2 className="m-0 text-base font-semibold">{tr("insights.repositoryCommits")}</h2>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-border">
              {repositories.slice(0, 20).map((value) => (
                <div
                  className="flex items-center justify-between gap-4 px-4 py-3"
                  key={value.repository_group_id}
                >
                  <span className="grid min-w-0 gap-0.5">
                    <strong className="truncate text-sm">{value.name}</strong>
                    <small className="text-xs text-muted-foreground">
                      {tr("insights.repositoryDetail", {
                        all: value.all_commits,
                        attributed: value.attributed_commits,
                      })}
                    </small>
                  </span>
                  <strong className="text-sm tabular-nums">{value.my_commits}</strong>
                </div>
              ))}
              {!repositories.length && (
                <p className="px-4 py-6 text-sm text-muted-foreground">
                  {tr("insights.noCommits")}
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}
      {section === "milestones" && <AchievementWall achievements={achievements} />}
      {section === "sources" && (
        <Card className="overflow-hidden rounded-2xl border-border bg-card shadow-sm">
          <CardHeader className="flex min-h-[58px] items-center justify-between border-b border-border px-5 py-4">
            <h2 className="m-0 text-base font-semibold">{tr("insights.providers")}</h2>
            <Badge variant="outline">
              {status?.refreshed_at
                ? tr("home.updated", { time: formatRelativeTime(status.refreshed_at) })
                : tr("insights.notRefreshed")}
            </Badge>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-border">
              {status?.providers
                .filter((provider) => agentSupportsInsights(provider.agent))
                .map((provider) => (
                  <ProviderRow key={provider.agent} provider={provider} />
                ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function HeatmapWeekdays() {
  const locale = document.documentElement.lang || "en-US";
  const labels = Array.from({ length: 7 }, (_, index) =>
    new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(
      new Date(Date.UTC(2024, 0, 1 + index)),
    ),
  );
  return (
    <div className="grid w-7 shrink-0 grid-rows-[repeat(7,11px)] gap-1 pt-[18px] text-[10px] leading-[11px] text-muted-foreground max-[1200px]:grid-rows-[repeat(7,8px)] max-[1200px]:gap-[2px] max-[1200px]:leading-[8px]">
      {labels.map((label) => (
        <span key={label}>{label}</span>
      ))}
    </div>
  );
}

function HeatmapMonths({
  points,
  padding,
  columns,
  year,
}: {
  points: HeatmapPoint[];
  padding: number;
  columns: number;
  year?: number;
}) {
  const locale = document.documentElement.lang || "en-US";
  const markers = year
    ? Array.from({ length: 12 }, (_, month) => {
        const date = new Date(year, month, 1);
        const dayOfYear = (Date.UTC(year, month, 1) - Date.UTC(year, 0, 1)) / (24 * 60 * 60 * 1000);
        return {
          key: `${year}-${month}`,
          label: new Intl.DateTimeFormat(locale, { month: "short" }).format(date),
          column: Math.floor((padding + dayOfYear) / 7) + 1,
        };
      })
    : buildHeatmapMonthMarkers(points, padding, locale).slice(0, 12);
  return (
    <div
      className={cn(
        "[--heatmap-cell-size:11px] mb-2 min-h-3.5 w-full text-[10px] text-muted-foreground max-[1200px]:[--heatmap-cell-size:8px]",
        year
          ? "grid grid-cols-12"
          : "grid grid-flow-col auto-cols-[11px] gap-1 max-[1200px]:auto-cols-[8px] max-[1200px]:gap-[2px]",
      )}
      style={
        year
          ? undefined
          : {
              gridTemplateColumns: `repeat(${columns}, var(--heatmap-cell-size))`,
              justifyContent: "space-between",
            }
      }
    >
      {markers.map((marker, index) => (
        <span
          className="whitespace-nowrap"
          key={marker.key}
          style={
            year
              ? {
                  gridColumn: index + 1,
                  justifySelf:
                    index === 0 ? "start" : index === markers.length - 1 ? "end" : "center",
                }
              : { gridColumn: marker.column, gridRow: 1 }
          }
        >
          {marker.label}
        </span>
      ))}
    </div>
  );
}

function heatmapCellClass(level: number) {
  return cn(
    "block size-[11px] rounded-[3px] max-[1200px]:size-[8px] max-[1200px]:rounded-[2px]",
    level === 0 && "bg-muted",
    level === 1 && "bg-[color-mix(in_srgb,var(--blue)_18%,transparent)]",
    level === 2 && "bg-[color-mix(in_srgb,var(--blue)_38%,transparent)]",
    level === 3 && "bg-[color-mix(in_srgb,var(--blue)_66%,transparent)]",
    level === 4 && "bg-[var(--blue)]",
  );
}

const milestoneIcons: Record<AchievementCategory, typeof Activity> = {
  token: Sparkles,
  session: MessageSquareText,
  commit: GitCommitHorizontal,
  "active-days": CalendarCheck2,
  streak: Flame,
  workspaces: FolderGit2,
  agents: Network,
};
const specialAchievementIcons: Record<string, typeof Activity> = {
  "special-first-changeset": ShieldCheck,
  "special-first-memory": Brain,
  "special-shared-workspace": Network,
  "special-exact-attribution": GitCommitHorizontal,
  "special-remote-handshake": PlugZap,
  "special-night-owl": Moon,
  "special-comeback": RotateCcw,
  "special-same-day-delivery": Workflow,
};

function AchievementWall({ achievements }: { achievements: Achievement[] }) {
  const [selected, setSelected] = useState<AchievementWallItem>();
  if (!achievements.length)
    return (
      <Card className="rounded-2xl border-border bg-card shadow-sm">
        <Empty icon={Award} title={tr("insights.preparing")} />
      </Card>
    );
  const items = buildAchievementWallItems(achievements);
  const tracks = items.filter((item) => item.kind === "track");
  const specials = items.filter((item) => item.kind === "special");
  const completedMilestones = tracks.reduce((count, item) => count + item.track.completed, 0);
  const milestoneCount = tracks.reduce((count, item) => count + item.track.milestones.length, 0);
  const completedSpecials = specials.filter((item) => item.unlocked).length;
  return (
    <Card className="h-full overflow-hidden rounded-2xl border-border bg-card shadow-sm">
      <CardHeader className="flex min-h-[58px] flex-row items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <div className="m-0 text-base font-semibold">{tr("insights.milestones")}</div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {completedMilestones} / {milestoneCount}
          </p>
        </div>
        <div className="flex items-center gap-2 max-[520px]:items-end max-[520px]:flex-col">
          <Badge variant="outline">
            {tr("achievementWall.milestones", {
              completed: completedMilestones,
              total: milestoneCount,
            })}
          </Badge>
          <Badge variant="outline">
            {tr("achievementWall.specials", {
              completed: completedSpecials,
              total: specials.length,
            })}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4 bg-muted/20 p-5 max-[760px]:grid-cols-2 max-[520px]:grid-cols-1">
          {items.map((item) => (
            <AchievementWallCard key={item.id} item={item} onOpen={() => setSelected(item)} />
          ))}
        </div>
      </CardContent>
      {selected && (
        <AchievementDetailDialog
          key={selected.id}
          item={selected}
          onClose={() => setSelected(undefined)}
        />
      )}
    </Card>
  );
}

function AchievementWallCard({ item, onOpen }: { item: AchievementWallItem; onOpen: () => void }) {
  if (item.kind === "track") {
    const Icon = milestoneIcons[item.track.category];
    const title = tr(`achievements.${achievementTranslationKey(item.cover.code)}.title`);
    return (
      <Button
        variant="bare"
        size="content"
        className={cn(
          "group relative grid min-h-[156px] min-w-0 grid-cols-[38px_minmax(0,1fr)] grid-rows-[auto_auto_1fr_auto] gap-x-3 gap-y-1.5 rounded-[11px] border border-border bg-card p-4 text-left text-muted-foreground transition hover:-translate-y-px hover:border-foreground/20 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          item.unlocked &&
            "border-[color-mix(in_srgb,var(--green)_30%,var(--border))] bg-[color-mix(in_srgb,var(--green)_7%,transparent)]",
        )}
        onClick={onOpen}
        aria-label={tr("achievementWall.openTrack", {
          category: tr(`milestones.category.${item.track.category}`),
        })}
      >
        <span
          className={cn(
            "row-span-2 grid size-[38px] place-items-center rounded-[10px] border border-border bg-background text-muted-foreground",
            item.unlocked &&
              "border-[color-mix(in_srgb,var(--green)_35%,var(--border))] bg-[color-mix(in_srgb,var(--green)_12%,transparent)] text-[var(--green)]",
          )}
        >
          <Icon size={20} />
        </span>
        <span className="self-end truncate text-xs font-semibold">
          {tr(`milestones.category.${item.track.category}`)}
        </span>
        <strong className="self-start truncate text-base text-foreground">{title}</strong>
        <small className="col-span-full self-center truncate text-xs">
          {formatMilestoneValue(item.track.category, item.cover.threshold)}
        </small>
        <span
          className={cn(
            "col-span-full flex min-w-0 items-center justify-between gap-2 border-t border-border pt-2 text-xs",
            item.unlocked && "text-[var(--green)]",
          )}
        >
          <span className="truncate">
            {tr("milestones.completed", {
              completed: item.track.completed,
              total: item.track.milestones.length,
            })}
          </span>
          <ChevronRight size={15} />
        </span>
      </Button>
    );
  }
  const { achievement, secret, unlocked } = item.special;
  const hidden = secret && !unlocked;
  const Icon = hidden ? LockKeyhole : (specialAchievementIcons[achievement.code] ?? Award);
  const title = hidden
    ? tr("special.mystery")
    : tr(`achievements.${achievementTranslationKey(achievement.code)}.title`);
  const status = achievement.unlocked_at
    ? tr("insights.unlockedAt", { date: formatDateTime(achievement.unlocked_at) })
    : unlocked
      ? tr("special.reachedDateUnknown")
      : tr("milestones.locked");
  return (
    <Button
      variant="bare"
      size="content"
      className={cn(
        "group relative grid min-h-[156px] min-w-0 grid-cols-[38px_minmax(0,1fr)] grid-rows-[auto_auto_1fr_auto] gap-x-3 gap-y-1.5 rounded-[11px] border border-border bg-card p-4 text-left text-muted-foreground transition hover:-translate-y-px hover:border-foreground/20 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        unlocked &&
          "border-[color-mix(in_srgb,var(--green)_30%,var(--border))] bg-[color-mix(in_srgb,var(--green)_7%,transparent)]",
      )}
      onClick={onOpen}
      aria-label={tr("achievementWall.openSpecial", { title })}
    >
      <span
        className={cn(
          "row-span-2 grid size-[38px] place-items-center rounded-[10px] border border-border bg-background text-muted-foreground",
          unlocked &&
            "border-[color-mix(in_srgb,var(--green)_35%,var(--border))] bg-[color-mix(in_srgb,var(--green)_12%,transparent)] text-[var(--green)]",
        )}
      >
        <Icon size={20} />
      </span>
      <span className="self-end truncate text-xs font-semibold">{tr("special.title")}</span>
      <strong className="self-start truncate text-base text-foreground">{title}</strong>
      <small className="col-span-full self-center truncate text-xs">{status}</small>
      <span
        className={cn(
          "col-span-full flex min-w-0 items-center justify-between gap-2 border-t border-border pt-2 text-xs",
          unlocked && "text-[var(--green)]",
        )}
      >
        <span className="truncate">
          {unlocked ? tr("achievementWall.unlocked") : tr("milestones.locked")}
        </span>
        <ChevronRight size={15} />
      </span>
    </Button>
  );
}

function AchievementDetailDialog({
  item,
  onClose,
}: {
  item: AchievementWallItem;
  onClose: () => void;
}) {
  const title =
    item.kind === "track"
      ? tr(`milestones.category.${item.track.category}`)
      : item.special.secret && !item.special.unlocked
        ? tr("special.mystery")
        : tr(`achievements.${achievementTranslationKey(item.special.achievement.code)}.title`);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="grid max-h-[min(940px,calc(100vh-40px))] w-[min(1100px,calc(100%-32px))] max-w-[min(1100px,calc(100%-32px))] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden rounded-[14px] border-[var(--border-strong)] bg-card p-0 shadow-2xl sm:!max-w-[min(1100px,calc(100%-32px))] max-[760px]:max-h-[calc(100vh-24px)] max-[760px]:w-[calc(100%-24px)] max-[760px]:!max-w-[calc(100%-24px)]"
        showCloseButton={false}
      >
        <DialogHeader className="flex min-h-[68px] flex-row items-center justify-between gap-4 border-b border-border px-5 py-3">
          <div className="min-w-0">
            <span className="mb-0.5 block text-xs font-semibold text-muted-foreground">
              {item.kind === "track" ? tr("achievementWall.track") : tr("special.title")}
            </span>
            <DialogTitle id="achievement-dialog-title" className="truncate text-xl">
              {title}
            </DialogTitle>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label={tr("common.close")}>
            <X size={17} />
          </Button>
        </DialogHeader>
        {item.kind === "track" ? (
          <AchievementTrackDetail track={item.track} />
        ) : (
          <SpecialAchievementDetail item={item} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function AchievementTrackDetail({ track }: { track: AchievementTrack }) {
  const [selected, setSelected] = useState(() => selectDefaultTrackMilestone(track));
  const progressPercent = Math.round(track.progressRatio * 100);
  const selectedReached = achievementReached(selected);
  const selectedCurrent = track.next?.code === selected.code;
  const milestoneCount = Math.max(1, track.milestones.length);
  return (
    <div className="min-h-0 overflow-auto">
      <div className="grid grid-cols-3 border-b border-border max-[760px]:grid-cols-1">
        {[
          [
            tr("achievementWall.currentValue"),
            formatMilestoneValue(track.category, track.progress),
          ],
          [
            tr("achievementWall.completedStages"),
            `${track.completed} / ${track.milestones.length}`,
          ],
          [
            tr("achievementWall.nextTarget"),
            track.next
              ? formatMilestoneValue(track.category, track.next.threshold)
              : tr("milestones.highest"),
          ],
        ].map(([label, value], index) => (
          <span
            className={cn(
              "grid min-h-[68px] content-center gap-1 px-5 py-3",
              index > 0 && "border-l border-border max-[760px]:border-l-0 max-[760px]:border-t",
            )}
            key={label}
          >
            <small className="text-xs text-muted-foreground">{label}</small>
            <strong className="truncate text-sm text-foreground">{value}</strong>
          </span>
        ))}
      </div>
      <div className="overflow-x-auto overflow-y-hidden border-b border-border px-5 pb-4 pt-7">
        <ToggleGroup
          className="segmented-control segmented-control-grid relative w-full min-w-0 gap-0 pb-2 max-[760px]:min-w-[640px]"
          value={[selected.code]}
          onValueChange={(values) => {
            const next = track.milestones.find((milestone) => milestone.code === values[0]);
            if (next) setSelected(next);
          }}
          style={{ gridTemplateColumns: `repeat(${milestoneCount}, minmax(0, 1fr))` }}
        >
          <Progress
            value={progressPercent}
            aria-label={tr("milestones.progress", {
              category: tr(`milestones.category.${track.category}`),
            })}
            style={{ left: `${50 / milestoneCount}%`, right: `${50 / milestoneCount}%` }}
            className="pointer-events-none absolute top-[35px] z-0 h-0.5 w-auto bg-border"
          />
          {track.milestones.map((milestone) => {
            const reached = achievementReached(milestone);
            const current = track.next?.code === milestone.code;
            return (
              <ToggleGroupItem
                value={milestone.code}
                className={cn(
                  "segmented-control-item relative z-1 grid h-auto min-h-[104px] min-w-0 items-center content-center justify-items-center gap-1.5 px-1 text-center focus-visible:ring-2 focus-visible:ring-ring",
                  reached && "text-foreground",
                  current && "text-[var(--blue)]",
                )}
                key={milestone.code}
              >
                <span
                  className={cn(
                    "grid size-[22px] place-items-center rounded-full border-2 border-[var(--border-strong)] bg-card text-muted-foreground",
                    reached && "border-[var(--green)] bg-[var(--green)] text-white",
                    current &&
                      "border-primary shadow-[0_0_0_4px_color-mix(in_srgb,var(--primary)_14%,transparent)]",
                  )}
                >
                  {reached ? <Check size={13} /> : ""}
                </span>
                <strong className="max-w-full whitespace-normal text-xs leading-tight">
                  {formatMilestoneValue(track.category, milestone.threshold)}
                </strong>
                <small className="max-w-full whitespace-normal text-xs leading-tight">
                  {tr(`achievements.${achievementTranslationKey(milestone.code)}.title`)}
                </small>
              </ToggleGroupItem>
            );
          })}
        </ToggleGroup>
      </div>
      <section className="grid min-h-24 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-5 gap-y-1.5 px-5 py-4 max-[760px]:grid-cols-1">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className={cn(
              "grid size-[30px] shrink-0 place-items-center rounded-full border border-border bg-muted text-muted-foreground",
              selectedReached && "border-[var(--green)] bg-[var(--green)] text-white",
              selectedCurrent && "border-[var(--blue)]",
            )}
          >
            {selectedReached ? <Check size={14} /> : <LockKeyhole size={13} />}
          </span>
          <div className="min-w-0">
            <small className="mb-0.5 block text-xs text-muted-foreground">
              {tr("achievementWall.stageDetail")}
            </small>
            <h3 className="truncate text-base font-semibold text-foreground">
              {tr(`achievements.${achievementTranslationKey(selected.code)}.title`)}
            </h3>
          </div>
        </div>
        <strong className="text-sm text-foreground">
          {formatMilestoneValue(track.category, selected.threshold)}
        </strong>
        <p className="col-span-full m-0 pl-[41px] text-xs text-muted-foreground max-[760px]:pl-[41px]">
          {selected.unlocked_at
            ? tr("insights.unlockedAt", { date: formatDateTime(selected.unlocked_at) })
            : selectedReached
              ? tr("special.reachedDateUnknown")
              : selectedCurrent
                ? tr("milestones.currentProgress", {
                    progress: formatMilestoneValue(track.category, track.progress),
                  })
                : tr("milestones.locked")}
        </p>
      </section>
    </div>
  );
}

function SpecialAchievementDetail({
  item,
}: {
  item: Extract<AchievementWallItem, { kind: "special" }>;
}) {
  const { achievement, secret, unlocked } = item.special;
  const hidden = secret && !unlocked;
  const key = achievementTranslationKey(achievement.code);
  const Icon = hidden ? LockKeyhole : (specialAchievementIcons[achievement.code] ?? Award);
  const title = hidden ? tr("special.mystery") : tr(`achievements.${key}.title`);
  const status = achievement.unlocked_at
    ? tr("insights.unlockedAt", { date: formatDateTime(achievement.unlocked_at) })
    : unlocked
      ? tr("special.reachedDateUnknown")
      : tr("milestones.locked");
  return (
    <div className="grid justify-items-center px-7 pb-10 pt-9 text-center">
      <span
        className={cn(
          "grid size-16 place-items-center rounded-2xl border border-border bg-muted text-muted-foreground",
          unlocked &&
            "border-[color-mix(in_srgb,var(--green)_35%,var(--border))] bg-[color-mix(in_srgb,var(--green)_12%,transparent)] text-[var(--green)]",
        )}
      >
        <Icon size={28} />
      </span>
      <h3 className="mt-3.5 text-xl font-semibold text-foreground">{title}</h3>
      <p className="my-2 max-w-[560px] text-sm leading-relaxed text-muted-foreground">
        {hidden ? tr("achievementWall.secretCondition") : tr(`achievements.${key}.description`)}
      </p>
      <Badge variant="outline">{status}</Badge>
    </div>
  );
}

function ProviderRow({ provider }: { provider: NonNullable<InsightsStatus["providers"]>[number] }) {
  const summary = provider.coverage_from
    ? `${provider.coverage_from} — ${provider.coverage_to}`
    : provider.error_key
      ? localizeMessage({ key: provider.error_key, params: provider.error_params })
      : provider.error
        ? tr("insights.providerUnavailable")
        : provider.available
          ? undefined
          : tr("insights.noData");
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <AgentIcon agent={provider.agent} />
      <span className="grid min-w-0 gap-1">
        <strong className="text-sm">{agentLabels[provider.agent]}</strong>
        {summary && <small className="text-xs text-muted-foreground">{summary}</small>}
        {provider.error && (
          <Collapsible>
            <CollapsibleTrigger className="text-xs text-muted-foreground underline-offset-2 hover:underline">
              {tr("common.details")}
            </CollapsibleTrigger>
            <CollapsibleContent>
              <pre className="mt-2 max-h-32 overflow-auto rounded-md bg-muted p-2 text-xs">
                {provider.error}
              </pre>
            </CollapsibleContent>
          </Collapsible>
        )}
      </span>
    </div>
  );
}

function TokenTrendCard({
  points,
  metric,
  metricLabel,
}: {
  points: HeatmapPoint[];
  metric: HeatmapMetric;
  metricLabel: string;
}) {
  const monthly = new Map<string, number>();
  for (const point of points) {
    const key = point.date.slice(0, 7);
    monthly.set(key, (monthly.get(key) ?? 0) + point[metric]);
  }
  const series = [...monthly.entries()].slice(-9);
  const values = series.map(([, value]) => value);
  const max = Math.max(1, ...values);
  const chartPoints = values
    .map((value, index) => {
      const x = series.length === 1 ? 260 : (index / (series.length - 1)) * 520;
      const y = 150 - (value / max) * 124;
      return `${x},${y}`;
    })
    .join(" ");
  const trendLabel = tr("insights.trend", { metric: metricLabel });
  const monthFormatter = new Intl.DateTimeFormat(currentLocale(), { month: "short" });
  return (
    <Card className="overflow-hidden rounded-2xl border-border bg-card shadow-sm">
      <CardHeader className="flex min-h-[58px] flex-row items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="m-0 text-base font-semibold">{trendLabel}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{metricLabel}</p>
        </div>
        <Badge variant="outline">{tr("insights.byMonth")}</Badge>
      </CardHeader>
      <CardContent className="px-5 pb-4 pt-5">
        {series.length ? (
          <>
            <svg
              viewBox="0 0 520 170"
              className="h-[170px] w-full overflow-visible"
              preserveAspectRatio="none"
              role="img"
              aria-label={trendLabel}
            >
              {[26, 67, 108, 150].map((y) => (
                <line
                  key={y}
                  x1="0"
                  x2="520"
                  y1={y}
                  y2={y}
                  stroke="currentColor"
                  strokeOpacity=".12"
                  strokeDasharray="3 4"
                />
              ))}
              <polyline
                points={chartPoints}
                fill="none"
                stroke="var(--primary)"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {values.map((value, index) => {
                const x = series.length === 1 ? 260 : (index / (series.length - 1)) * 520;
                const y = 150 - (value / max) * 124;
                return (
                  <circle
                    key={`${series[index][0]}-${value}`}
                    cx={x}
                    cy={y}
                    r="4"
                    fill="var(--primary)"
                  />
                );
              })}
            </svg>
            <div className="mt-1 flex justify-between gap-2 text-[11px] text-muted-foreground">
              {series.map(([key]) => (
                <span key={key}>{monthFormatter.format(new Date(`${key}-01T00:00:00`))}</span>
              ))}
            </div>
          </>
        ) : (
          <div className="grid min-h-[170px] place-items-center text-sm text-muted-foreground">
            {tr("insights.noRecords")}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AgentUsageSummary({ agents }: { agents: AgentUsageBreakdown[] }) {
  const values = [...agents]
    .sort((left, right) => right.total_tokens - left.total_tokens)
    .slice(0, 5);
  const max = Math.max(1, ...values.map((value) => value.total_tokens));
  return (
    <Card className="overflow-hidden rounded-2xl border-border bg-card shadow-sm">
      <CardHeader className="flex min-h-[58px] flex-row items-center justify-between gap-3 border-b border-border px-5 py-4">
        <h2 className="m-0 text-base font-semibold">{tr("insights.agentUsage")}</h2>
        <span className="text-xs text-muted-foreground">Token</span>
      </CardHeader>
      <CardContent className="p-0">
        <div className="divide-y divide-border">
          {values.map((value) => (
            <div
              className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3"
              key={value.agent}
            >
              <AgentIcon agent={value.agent} />
              <span className="grid min-w-0 gap-1">
                <strong className="truncate text-sm">{agentLabels[value.agent]}</strong>
                <span className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <span
                    className="block h-full rounded-full bg-primary"
                    style={{ width: `${(value.total_tokens / max) * 100}%` }}
                  />
                </span>
              </span>
              <strong className="text-sm tabular-nums">{formatCompact(value.total_tokens)}</strong>
            </div>
          ))}
          {!values.length && (
            <p className="px-4 py-6 text-sm text-muted-foreground">{tr("insights.noToken")}</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function AchievementMetric({
  icon: Icon,
  tone,
  label,
  value,
  detail,
}: {
  icon: ComponentType<{ size?: number; className?: string }>;
  tone: "blue" | "violet" | "green" | "amber";
  label: string;
  value: string;
  detail: string;
}) {
  const toneClasses = {
    blue: {
      icon: "bg-[color-mix(in_srgb,var(--primary)_12%,transparent)] text-primary",
      border: "hover:border-[color-mix(in_srgb,var(--primary)_38%,var(--border))]",
    },
    violet: {
      icon: "bg-[color-mix(in_srgb,var(--primary)_12%,transparent)] text-primary",
      border: "hover:border-[color-mix(in_srgb,var(--primary)_38%,var(--border))]",
    },
    green: {
      icon: "bg-[color-mix(in_srgb,var(--primary)_12%,transparent)] text-primary",
      border: "hover:border-[color-mix(in_srgb,var(--primary)_38%,var(--border))]",
    },
    amber: {
      icon: "bg-[color-mix(in_srgb,var(--primary)_12%,transparent)] text-primary",
      border: "hover:border-[color-mix(in_srgb,var(--primary)_38%,var(--border))]",
    },
  }[tone];
  return (
    <Card
      className={cn(
        "grid min-h-[136px] grid-cols-[auto_minmax(0,1fr)] grid-rows-[auto_auto_auto] gap-x-3 rounded-2xl border border-border bg-card p-5 shadow-sm transition-colors",
        toneClasses.border,
      )}
    >
      <span
        className={cn("row-span-3 grid size-9 place-items-center rounded-xl", toneClasses.icon)}
      >
        <Icon size={17} />
      </span>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <strong className="text-[25px] tracking-[-.04em] text-foreground tabular-nums">
        {value}
      </strong>
      <small className="truncate text-[11px] text-muted-foreground">{detail}</small>
    </Card>
  );
}
function BreakdownPanel({
  title,
  values,
}: {
  title: string;
  values: Array<{ key: string; label: string; detail: string; value: number }>;
}) {
  return (
    <Card className="overflow-hidden rounded-2xl border-border bg-card shadow-sm">
      <CardHeader className="flex min-h-[58px] items-center border-b border-border px-5 py-4">
        <h2 className="m-0 text-base font-semibold">{title}</h2>
      </CardHeader>
      <CardContent className="p-0">
        <div className="divide-y divide-border">
          {values.slice(0, 10).map((item) => (
            <div className="flex items-center justify-between gap-4 px-4 py-3" key={item.key}>
              <span className="grid min-w-0 gap-0.5">
                <strong className="truncate text-sm">{metadataLabel(item.label)}</strong>
                <small className="text-xs text-muted-foreground">{item.detail}</small>
              </span>
              <strong className="text-sm tabular-nums">{formatCompact(item.value)}</strong>
            </div>
          ))}
          {!values.length && (
            <p className="px-4 py-6 text-sm text-muted-foreground">{tr("insights.noRecords")}</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
function Empty({
  icon: Icon,
  title,
  text,
}: {
  icon: ComponentType<{ size?: number; className?: string }>;
  title: string;
  text?: string;
}) {
  return (
    <div className="grid min-h-[92px] grid-cols-[auto_minmax(0,auto)] place-content-center items-center gap-x-2.5 gap-y-1 p-4 text-left text-muted-foreground">
      <Icon className="row-span-2" size={28} />
      <h3 className="m-0 text-[13px] font-semibold text-foreground">{title}</h3>
      {text && <p className="m-0 max-w-[380px] leading-relaxed">{text}</p>}
    </div>
  );
}
function formatMilestoneValue(category: AchievementCategory, value: number) {
  return tr(`milestones.value.${category}`, { value: formatCompact(value) });
}
function formatCompact(value: number) {
  return formatCompactNumber(value);
}
function localDate(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
function metadataLabel(value: string) {
  if (value === "__unknown_model__") return tr("insights.unknownModel");
  if (value === "__unlinked_workspace__") return tr("insights.unlinkedWorkspace");
  if (value === "仓库 Git 身份") return tr("settings.gitIdentityRepository");
  if (value === "全局 Git 身份") return tr("settings.gitIdentityGlobal");
  if (value === "历史邮箱别名") return tr("settings.gitIdentityAlias");
  return value.startsWith("settings.gitIdentity") ? tr(value) : value;
}
function achievementTranslationKey(code: string) {
  return (
    (
      {
        "token-100000": "token_100k",
        "token-1000000": "token_1m",
        "token-10000000": "token_10m",
        "token-100000000": "token_100m",
        "token-1000000000": "token_1b",
        "token-10000000000": "token_10b",
        "token-100000000000": "token_100b",
        "token-1000000000000": "token_1t",
        "session-10": "session_10",
        "session-50": "session_50",
        "session-100": "session_100",
        "session-500": "session_500",
        "session-1000": "session_1000",
        "session-5000": "session_5000",
        "session-10000": "session_10000",
        "commit-1": "commit_1",
        "commit-10": "commit_10",
        "commit-100": "commit_100",
        "commit-1000": "commit_1000",
        "commit-5000": "commit_5000",
        "commit-10000": "commit_10000",
        "active-days-7": "active_days_7",
        "active-days-30": "active_days_30",
        "active-days-100": "active_days_100",
        "active-days-365": "active_days_365",
        "active-days-1000": "active_days_1000",
        "streak-3": "streak_3",
        "streak-7": "streak_7",
        "streak-14": "streak_14",
        "streak-30": "streak_30",
        "streak-60": "streak_60",
        "streak-100": "streak_100",
        "streak-180": "streak_180",
        "streak-365": "streak_365",
        "workspaces-1": "workspaces_1",
        "workspaces-5": "workspaces_5",
        "workspaces-10": "workspaces_10",
        "workspaces-25": "workspaces_25",
        "workspaces-50": "workspaces_50",
        "workspaces-100": "workspaces_100",
        "agents-1": "agents_1",
        "agents-2": "agents_2",
        "agents-3": "agents_3",
        "agents-4": "agents_4",
        "agents-5": "agents_5",
        "special-first-changeset": "special_first_changeset",
        "special-first-memory": "special_first_memory",
        "special-shared-workspace": "special_shared_workspace",
        "special-exact-attribution": "special_exact_attribution",
        "special-remote-handshake": "special_remote_handshake",
        "special-night-owl": "special_night_owl",
        "special-comeback": "special_comeback",
        "special-same-day-delivery": "special_same_day_delivery",
      } as Record<string, string>
    )[code] ?? code
  );
}
