import { useRef, useState, type ComponentType, type KeyboardEvent } from "react";
import { useI18n } from "@/core/useI18n";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AgentIcon } from "@/features/agents/AgentIcon";
import {
  insightsMetadataLabel,
  buildHeatmapMonthMarkers,
  trimHeatmapMonthMarkers,
} from "@/features/insights/insights";
import type { AgentUsageBreakdown, HeatmapPoint } from "@/core/types";
import { AGENT_LABELS as agentLabels } from "@/core/agents";
import { cn } from "cn";
import type { HeatmapMetric } from "./InsightsTypes";

export function RankingLimit({ shown, total }: { shown: number; total: number }) {
  const { formatNumber, tr } = useI18n();
  if (total <= shown) return null;
  return (
    <p className="px-4 py-3 text-xs text-muted-foreground">
      {tr("insights.rankingLimit", { shown: formatNumber(shown), total: formatNumber(total) })}
    </p>
  );
}

function HeatmapWeekdays() {
  const { locale } = useI18n();
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
  const { locale } = useI18n();
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
    : trimHeatmapMonthMarkers(buildHeatmapMonthMarkers(points, padding, locale));
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

export function heatmapCellClass(level: number) {
  return cn(
    "block size-[11px] rounded-[3px] max-[1200px]:size-[8px] max-[1200px]:rounded-[2px]",
    level === 0 && "bg-muted",
    level === 1 && "bg-[color-mix(in_srgb,var(--blue)_18%,transparent)]",
    level === 2 && "bg-[color-mix(in_srgb,var(--blue)_38%,transparent)]",
    level === 3 && "bg-[color-mix(in_srgb,var(--blue)_66%,transparent)]",
    level === 4 && "bg-[var(--blue)]",
  );
}

export function ActivityHeatmap({
  points,
  metric,
  range,
  year,
  from,
  to,
  padding,
  columns,
  days,
  max,
}: {
  points: HeatmapPoint[];
  metric: HeatmapMetric;
  range: "52w" | "year";
  year: number;
  from: string;
  to: string;
  padding: number;
  columns: number;
  days: number;
  max: number;
}) {
  const { formatCompactNumber, formatNumber, locale, tr } = useI18n();
  const [focusedIndex, setFocusedIndex] = useState(0);
  const cellRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const metricLabel = metricLabelFor(metric, tr);
  const formatDay = (value: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(`${value}T00:00:00`));
  const activeCount = points.filter((point) => point[metric] > 0).length;
  const summary = tr("insights.heatmapSummary", {
    count: activeCount,
    metric: metricLabel,
    from: formatDay(from),
    to: formatDay(to),
    active: formatCompactNumber(activeCount),
    peak: formatCompactNumber(points.length ? max : 0),
  });
  const moveFocus = (index: number, event: KeyboardEvent<HTMLSpanElement>) => {
    const offset =
      event.key === "ArrowUp"
        ? -1
        : event.key === "ArrowDown"
          ? 1
          : event.key === "ArrowLeft"
            ? -7
            : event.key === "ArrowRight"
              ? 7
              : 0;
    if (!offset) return;
    event.preventDefault();
    const nextIndex = index + offset;
    if (nextIndex >= 0 && nextIndex < points.length) cellRefs.current[nextIndex]?.focus();
  };

  return (
    <div className="px-5 pb-4 pt-4">
      <div className="flex items-start gap-2">
        <HeatmapWeekdays />
        <div className="min-w-0 flex-1 overflow-x-auto">
          <HeatmapMonths
            points={points}
            padding={padding}
            columns={columns}
            year={range === "year" ? year : undefined}
          />
          <span role="img" aria-label={summary} className="sr-only" />
          <div
            role="group"
            aria-label={summary}
            aria-description={tr("insights.heatmapKeyboardHelp")}
            className="[--heatmap-cell-size:11px] grid w-full grid-flow-col grid-rows-[repeat(7,11px)] auto-cols-[11px] gap-1 max-[1200px]:[--heatmap-cell-size:8px] max-[1200px]:grid-rows-[repeat(7,8px)] max-[1200px]:auto-cols-[8px] max-[1200px]:gap-[2px]"
            style={{
              gridTemplateColumns: `repeat(${columns}, var(--heatmap-cell-size))`,
              justifyContent: "space-between",
            }}
          >
            {Array.from({ length: padding }, (_, index) => (
              <span
                className="invisible block size-[11px] rounded-[3px]"
                key={`padding-${index}`}
              />
            ))}
            {points.map((point, index) => {
              const value = point[metric];
              const level = value ? Math.max(1, Math.ceil((value / max) * 4)) : 0;
              const day = formatDay(point.date);
              const accessibleValue = `${day}, ${metricLabel}: ${formatNumber(value)}`;
              return (
                <span
                  key={point.date}
                  ref={(element) => {
                    cellRefs.current[index] = element;
                  }}
                  role="img"
                  className={cn(
                    heatmapCellClass(level),
                    "cursor-default focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
                  )}
                  title={accessibleValue}
                  aria-label={accessibleValue}
                  tabIndex={index === focusedIndex ? 0 : -1}
                  onFocus={() => setFocusedIndex(index)}
                  onKeyDown={(event) => moveFocus(index, event)}
                />
              );
            })}
            {Array.from({ length: Math.max(0, days - points.length) }, (_, index) => (
              <span className={heatmapCellClass(0)} key={`future-${index}`} aria-hidden="true" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function metricLabelFor(metric: HeatmapMetric, tr: ReturnType<typeof useI18n>["tr"]) {
  const keys: Record<HeatmapMetric, string> = {
    tokens: "insights.tokens",
    my_commits: "insights.myCommits",
    all_commits: "insights.allCommits",
    attributed_commits: "insights.attributedCommits",
    sessions: "common.sessions",
  };
  return tr(keys[metric]);
}

export function TokenTrendCard({
  points,
  metric,
  metricLabel,
}: {
  points: HeatmapPoint[];
  metric: HeatmapMetric;
  metricLabel: string;
}) {
  const { formatCompactNumber, formatNumber, locale, tr } = useI18n();
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
  const monthFormatter = new Intl.DateTimeFormat(locale, { month: "short" });
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
              aria-label={tr("insights.trendSummary", {
                label: trendLabel,
                values: series
                  .map(
                    ([key, value]) =>
                      `${monthFormatter.format(new Date(`${key}-01T00:00:00`))} ${formatNumber(value)}`,
                  )
                  .join(", "),
              })}
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
            <div className="mt-2 flex justify-between gap-1 text-center text-[10px] text-muted-foreground">
              {series.map(([key, value]) => {
                const month = monthFormatter.format(new Date(`${key}-01T00:00:00`));
                return (
                  <span
                    className="grid min-w-0 gap-0.5"
                    key={key}
                    title={`${month}: ${formatNumber(value)}`}
                  >
                    <span className="truncate">{month}</span>
                    <strong className="font-medium tabular-nums text-foreground">
                      {formatCompactNumber(value)}
                    </strong>
                  </span>
                );
              })}
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

export function AgentUsageSummary({ agents }: { agents: AgentUsageBreakdown[] }) {
  const { formatCompactNumber, tr } = useI18n();
  const values = [...agents]
    .sort((left, right) => right.total_tokens - left.total_tokens)
    .slice(0, 5);
  const max = Math.max(1, ...values.map((value) => value.total_tokens));
  return (
    <Card className="overflow-hidden rounded-2xl border-border bg-card shadow-sm">
      <CardHeader className="flex min-h-[58px] flex-row items-center justify-between gap-3 border-b border-border px-5 py-4">
        <h2 className="m-0 text-base font-semibold">{tr("insights.agentUsage")}</h2>
        <span className="text-xs text-muted-foreground">{tr("insights.tokens")}</span>
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
              <strong className="text-sm tabular-nums">
                {formatCompactNumber(value.total_tokens)}
              </strong>
            </div>
          ))}
          <RankingLimit shown={5} total={agents.length} />
          {!values.length && (
            <p className="px-4 py-6 text-sm text-muted-foreground">{tr("insights.noToken")}</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function AchievementMetric({
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
      icon: "bg-[color-mix(in_srgb,var(--blue)_12%,transparent)] text-[var(--blue)]",
      border: "hover:border-[color-mix(in_srgb,var(--blue)_38%,var(--border))]",
    },
    violet: {
      icon: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
      border: "hover:border-violet-500/40",
    },
    green: {
      icon: "bg-[color-mix(in_srgb,var(--green)_12%,transparent)] text-[var(--green)]",
      border: "hover:border-[color-mix(in_srgb,var(--green)_38%,var(--border))]",
    },
    amber: {
      icon: "bg-[color-mix(in_srgb,var(--amber)_12%,transparent)] text-[var(--amber)]",
      border: "hover:border-[color-mix(in_srgb,var(--amber)_38%,var(--border))]",
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
      <small className="truncate text-[11px] text-muted-foreground" title={detail}>
        {detail}
      </small>
    </Card>
  );
}
export function BreakdownPanel({
  title,
  values,
}: {
  title: string;
  values: Array<{ key: string; label: string; detail: string; value: number }>;
}) {
  const { formatCompactNumber, tr } = useI18n();
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
                <strong className="truncate text-sm" title={insightsMetadataLabel(item.label, tr)}>
                  {insightsMetadataLabel(item.label, tr)}
                </strong>
                <small className="text-xs text-muted-foreground">{item.detail}</small>
              </span>
              <strong className="text-sm tabular-nums">{formatCompactNumber(item.value)}</strong>
            </div>
          ))}
          <RankingLimit shown={10} total={values.length} />
          {!values.length && (
            <p className="px-4 py-6 text-sm text-muted-foreground">{tr("insights.noRecords")}</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
export function Empty({
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
