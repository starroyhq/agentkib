import { useI18n } from "@/core/useI18n";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { InsightsSkeleton } from "./InsightsSkeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { useEffect, useMemo, useState } from "react";
import {
  Award,
  CalendarDays,
  CircleAlert,
  Flame,
  GitCommitHorizontal,
  Sparkles,
} from "lucide-react";
import type { AgentKind, HeatmapPoint, InsightsQuery, WorkspaceSummary } from "@/core/types";
import { agentSupportsInsights } from "@/features/insights/insights";
import { AgentIcon } from "@/features/agents/AgentIcon";
import { AGENT_LABELS as agentLabels } from "@/core/agents";
import { cn } from "cn";
import { useInsightsRefreshJob, useInsightsView } from "./insights-query";
import { InsightsFilters } from "./InsightsFilters";
import {
  AchievementMetric,
  ActivityHeatmap,
  AgentUsageSummary,
  BreakdownPanel,
  Empty,
  heatmapCellClass,
  RankingLimit,
  TokenTrendCard,
} from "./InsightsComponents";
import { AchievementWall } from "./InsightsAchievements";
import { ProviderRow } from "./InsightsProviderRow";
import type { HeatmapMetric, InsightsSection } from "./InsightsTypes";

export type { InsightsSection } from "./InsightsTypes";

export function InsightsPage({
  section,
  workspaces,
}: {
  section: InsightsSection;
  workspaces: WorkspaceSummary[];
}) {
  const { formatCompactNumber, formatNumber, locale, localizeMessage, tr } = useI18n();
  const [agent, setAgent] = useState<"all" | AgentKind>("all");
  const [workspaceId, setWorkspaceId] = useState("all");
  const [repository, setRepository] = useState("all");
  const [range, setRange] = useState<"52w" | "year">("52w");
  const [metric, setMetric] = useState<HeatmapMetric>("tokens");
  // 选中的工作区/仓库被移除后，标签会回落成"全部"；查询也必须按"全部"发，不能继续带着旧 id。
  const activeWorkspaceId = workspaces.some((value) => value.id === workspaceId)
    ? workspaceId
    : "all";
  const activeRepository = workspaces.some((value) => value.repository_group_id === repository)
    ? repository
    : "all";
  const day = useLocalDay();
  const query = useMemo<InsightsQuery>(() => {
    const [year, month, date] = day.split("-").map(Number);
    const today = new Date(year, month - 1, date);
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
      workspace_id: tokenView && activeWorkspaceId !== "all" ? activeWorkspaceId : undefined,
      repository_group_id: commitView && activeRepository !== "all" ? activeRepository : undefined,
    };
  }, [agent, activeWorkspaceId, activeRepository, range, section, day]);
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
  // 换了筛选条件、新数据还没到时，显示的是上一组条件的数据（keepPreviousData）。
  // 必须标出来，否则旧的总数会顶着新的筛选标签显示。
  const stale = viewQuery.isPlaceholderData === true;
  // 刷新任务失败由路由顶部统一提示（那里也有手动刷新的错误），这里不再重复一份。
  const error =
    (viewQuery.error ? localizeMessage(viewQuery.error) : "") ||
    (refreshJobQuery.error ? localizeMessage(refreshJobQuery.error) : "");
  const metricLabels: Record<HeatmapMetric, string> = {
    tokens: tr("insights.tokens"),
    my_commits: tr("insights.myCommits"),
    all_commits: tr("insights.allCommits"),
    attributed_commits: tr("insights.attributedCommits"),
    sessions: tr("common.sessions"),
  };
  const showRange = !["milestones", "sources"].includes(section);
  const max = Math.max(1, ...points.map((point) => point[metric]));
  const padding = points.length ? (new Date(`${points[0].date}T00:00:00`).getDay() + 6) % 7 : 0;
  // 年份取自请求本身：切换到"今年"时，旧的 52 周数据还作为占位显示，points[0] 可能是去年。
  const heatmapYear = Number(query.from!.slice(0, 4));
  const heatmapPadding =
    range === "year" ? (new Date(heatmapYear, 0, 1).getDay() + 6) % 7 : padding;
  // 全年天数（365/366）。new Date(y + 1, 0, 0).getDate() 只是 12 月的天数 31。
  const heatmapDays =
    range === "year"
      ? (Date.UTC(heatmapYear + 1, 0, 1) - Date.UTC(heatmapYear, 0, 1)) / 86_400_000
      : points.length;
  const heatmapColumns = Math.max(1, Math.ceil((heatmapPadding + heatmapDays) / 7));

  if (!view) {
    // 首次加载（或切换筛选后）失败时没有旧数据可显示；不能一直停在骨架屏，要给出错误和重试入口。
    if (viewQuery.isError)
      return (
        <Card className="rounded-2xl border-border bg-card shadow-sm">
          <div
            role="alert"
            className="grid justify-items-center gap-3 px-6 py-10 text-center text-sm"
          >
            <CircleAlert size={20} className="text-destructive" />
            <strong>{tr("insights.loadFailed")}</strong>
            <p className="text-muted-foreground">{localizeMessage(viewQuery.error)}</p>
            <Button
              variant="outline"
              disabled={viewQuery.isFetching}
              onClick={() => void viewQuery.refetch()}
            >
              {tr("insights.retry")}
            </Button>
          </div>
        </Card>
      );
    return <InsightsSkeleton section={section} />;
  }

  return (
    <div
      className={cn(
        "relative grid gap-5",
        stale && "[&>*:not(:first-child)]:opacity-60 [&>*:not(:first-child)]:transition-opacity",
      )}
      aria-busy={stale || undefined}
    >
      <section className="grid gap-3">
        {(stale || error) && (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {stale && (
              <Badge variant="secondary" role="status">
                {tr("insights.refreshing")}
              </Badge>
            )}
            {error && (
              <div
                role="alert"
                className="flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                <CircleAlert size={16} />
                {error}
              </div>
            )}
          </div>
        )}
        <InsightsFilters
          section={section}
          workspaces={workspaces}
          metric={metric}
          onMetricChange={setMetric}
          agent={agent}
          onAgentChange={setAgent}
          workspaceId={activeWorkspaceId}
          onWorkspaceChange={setWorkspaceId}
          repository={activeRepository}
          onRepositoryChange={setRepository}
          range={range}
          onRangeChange={setRange}
        />
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
                value={formatCompactNumber(summary.total_tokens)}
                detail={
                  summary.coverage_from ? `${summary.coverage_from} — ${summary.coverage_to}` : ""
                }
              />
              <AchievementMetric
                icon={GitCommitHorizontal}
                tone="violet"
                label={tr("insights.myCommits")}
                value={formatCompactNumber(summary.my_commits)}
                detail={tr("insights.allActivity", {
                  count: formatCompactNumber(summary.all_commits),
                })}
              />
              <AchievementMetric
                icon={CalendarDays}
                tone="green"
                label={tr("insights.activeDays")}
                value={tr("insights.days", {
                  count: summary.active_days,
                  value: formatNumber(summary.active_days),
                })}
                detail={tr("insights.recordedSessions", {
                  count: summary.session_count,
                  value: formatCompactNumber(summary.session_count),
                })}
              />
              <AchievementMetric
                icon={Flame}
                tone="amber"
                label={tr("insights.currentStreak")}
                value={tr("insights.days", {
                  count: summary.current_streak,
                  value: formatNumber(summary.current_streak),
                })}
                detail={tr("insights.longestStreak", {
                  count: summary.longest_streak,
                  value: formatNumber(summary.longest_streak),
                })}
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
                  <ActivityHeatmap
                    points={points}
                    metric={metric}
                    range={range}
                    year={heatmapYear}
                    from={query.from!}
                    to={query.to!}
                    padding={heatmapPadding}
                    columns={heatmapColumns}
                    days={heatmapDays}
                    max={max}
                  />
                  <div className="flex items-center justify-end gap-1 border-t border-border px-5 py-3 text-[10px] text-muted-foreground">
                    <span>{tr("insights.less")}</span>
                    {[0, 1, 2, 3, 4].map((level) => (
                      <i key={level} className={heatmapCellClass(level)} aria-hidden="true" />
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
                        {tr("insights.sessions", {
                          count: value.session_count,
                          value: formatNumber(value.session_count),
                        })}
                      </small>
                    </span>
                    <div className="grid justify-items-end">
                      <strong className="text-sm tabular-nums">
                        {formatCompactNumber(value.total_tokens)}
                      </strong>
                      <small className="text-xs text-muted-foreground">
                        {tr("insights.tokens")}
                      </small>
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
                detail: tr("insights.sessions", {
                  count: value.session_count,
                  value: formatNumber(value.session_count),
                }),
                value: value.total_tokens,
              }))}
            />
            <BreakdownPanel
              title={tr("insights.workspaceUsage")}
              values={workspaceUsage.map((value) => ({
                key: value.workspace_id ?? "unlinked",
                label: value.name,
                detail: tr("insights.sessions", {
                  count: value.session_count,
                  value: formatNumber(value.session_count),
                }),
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
                    <strong className="truncate text-sm" title={value.name}>
                      {value.name}
                    </strong>
                    <small className="text-xs text-muted-foreground">
                      {tr("insights.repositoryDetail", {
                        all: formatNumber(value.all_commits),
                        attributed: formatNumber(value.attributed_commits),
                      })}
                    </small>
                  </span>
                  <strong className="text-sm tabular-nums">{formatNumber(value.my_commits)}</strong>
                </div>
              ))}
              <RankingLimit shown={20} total={repositories.length} />
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
            <LastRefreshed value={status?.refreshed_at} />
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

function LastRefreshed({ value }: { value?: string }) {
  const { formatRelativeTime, formatDateTime, tr } = useI18n();
  const [, tick] = useState(0);
  useEffect(() => {
    if (!value) return;
    const update = () => tick((previous) => previous + 1);
    const timer = window.setInterval(update, 30_000);
    window.addEventListener("focus", update);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", update);
    };
  }, [value]);
  return (
    <Badge variant="outline" title={value ? formatDateTime(value) : undefined}>
      {value
        ? tr("home.updated", { time: formatRelativeTime(value) })
        : tr("insights.notRefreshed")}
    </Badge>
  );
}

function useLocalDay() {
  const [day, setDay] = useState(() => localDate(new Date()));
  useEffect(() => {
    const timer = window.setInterval(() => setDay(localDate(new Date())), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return day;
}
function localDate(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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
