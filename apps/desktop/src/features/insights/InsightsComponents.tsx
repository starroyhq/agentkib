import { useRef, useState, type ComponentType, type KeyboardEvent } from "react";
import { useI18n } from "@/core/useI18n";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { AgentIcon } from "@/features/agents/AgentIcon";
import {
  insightsMetadataLabel,
  buildHeatmapMonthMarkers,
  trimHeatmapMonthMarkers,
} from "@/features/insights/insights";
import type { AgentUsageBreakdown, HeatmapPoint } from "@/core/types";
import { AGENT_LABELS as agentLabels } from "@/core/agents";
import { cn } from "cn";
import type { HeatmapMetric, InsightsRange } from "./InsightsTypes";
import { buildTrendSeries, smoothTrendPath, type TrendGranularity } from "./insights-trend";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

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
    <div className="grid w-7 shrink-0 grid-rows-[repeat(7,var(--heatmap-cell-size))] items-center gap-1 pt-[22px] text-[10px] text-muted-foreground max-[1200px]:gap-[2px]">
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
  compact,
}: {
  points: HeatmapPoint[];
  padding: number;
  columns: number;
  year?: number;
  compact: boolean;
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
        "mb-2 min-h-3.5 w-full text-[10px] text-muted-foreground",
        year
          ? "grid grid-cols-12"
          : "grid grid-flow-col auto-cols-[var(--heatmap-cell-size)] gap-1 max-[1200px]:gap-[2px]",
      )}
      style={
        year
          ? undefined
          : {
              gridTemplateColumns: `repeat(${columns}, var(--heatmap-cell-size))`,
              justifyContent: compact ? "start" : "space-between",
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
  range: InsightsRange;
  year: number;
  from: string;
  to: string;
  padding: number;
  columns: number;
  days: number;
  max: number;
}) {
  const { formatCompactNumber, formatNumber, locale, tr } = useI18n();
  const compact =
    range === "7d" || range === "30d" || range === "90d" || (range === "custom" && days <= 100);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const tabStopIndex = Math.min(focusedIndex, Math.max(0, points.length - 1));
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
    <div
      className={cn(
        "px-5 pb-4 pt-4",
        compact
          ? "[--heatmap-cell-size:16px]"
          : "[--heatmap-cell-size:11px] max-[1200px]:[--heatmap-cell-size:8px]",
      )}
    >
      <div className="flex items-start gap-2">
        <HeatmapWeekdays />
        <div className="min-w-0 flex-1 overflow-x-auto">
          <HeatmapMonths
            points={points}
            padding={padding}
            columns={columns}
            year={range === "year" ? year : undefined}
            compact={compact}
          />
          <span role="img" aria-label={summary} className="sr-only" />
          <div
            role="group"
            aria-label={summary}
            aria-description={tr("insights.heatmapKeyboardHelp")}
            className="grid w-full grid-flow-col grid-rows-[repeat(7,var(--heatmap-cell-size))] auto-cols-[var(--heatmap-cell-size)] gap-1 max-[1200px]:gap-[2px]"
            style={{
              gridTemplateColumns: `repeat(${columns}, var(--heatmap-cell-size))`,
              justifyContent: compact ? "start" : "space-between",
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
                    compact && "!size-4",
                    "cursor-default focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
                  )}
                  title={accessibleValue}
                  aria-label={accessibleValue}
                  tabIndex={index === tabStopIndex ? 0 : -1}
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
  granularity: initialGranularity,
}: {
  points: HeatmapPoint[];
  metric: HeatmapMetric;
  metricLabel: string;
  granularity: TrendGranularity;
}) {
  const { formatNumber, locale, tr } = useI18n();
  const [granularity, setGranularity] = useState(initialGranularity);
  const [active, setActive] = useState<number | null>(null);
  const [focused, setFocused] = useState(0);
  const targets = useRef<Array<SVGGElement | null>>([]);
  const series = buildTrendSeries(points, metric, granularity);
  const max = Math.max(1, ...series.map((point) => point.value ?? 0));
  const coordinates = series.map((point, index) =>
    point.value === null
      ? null
      : {
          x: series.length === 1 ? 260 : 6 + (index / (series.length - 1)) * 508,
          y: 150 - (point.value / max) * 124,
        },
  );
  const trendLabel = tr("insights.trend", { metric: metricLabel });
  const granularityItems = [
    { value: "day", label: tr("insights.byDay") },
    { value: "week", label: tr("insights.byWeek") },
    { value: "month", label: tr("insights.byMonth") },
  ];
  const dateFormatter = new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const formatDate = (date: string) => dateFormatter.format(new Date(`${date}T00:00:00`));
  const dateLabel = (index: number) =>
    series[index].date === series[index].endDate
      ? formatDate(series[index].date)
      : `${formatDate(series[index].date)} — ${formatDate(series[index].endDate)}`;
  const detail = (index: number) =>
    `${dateLabel(index)}, ${metricLabel}: ${series[index].value === null ? "—" : formatNumber(series[index].value)}`;
  const available = series.flatMap((point, index) => (point.value === null ? [] : [index]));
  const tabStop = available.includes(focused) ? focused : available[0];
  const activeIndex = active !== null && coordinates[active] ? active : null;
  const moveFocus = (index: number, event: KeyboardEvent<SVGGElement>) => {
    const position = available.indexOf(index);
    const target =
      event.key === "ArrowLeft"
        ? available[position - 1]
        : event.key === "ArrowRight"
          ? available[position + 1]
          : event.key === "Home"
            ? available[0]
            : event.key === "End"
              ? available.at(-1)
              : undefined;
    if (target === undefined) return;
    event.preventDefault();
    targets.current[target]?.focus();
  };
  const ticks = [
    ...new Set([
      0,
      Math.round((series.length - 1) / 4),
      Math.round((series.length - 1) / 2),
      Math.round(((series.length - 1) * 3) / 4),
      series.length - 1,
    ]),
  ].filter((index) => index >= 0);
  return (
    <Card className="overflow-hidden rounded-2xl border-border bg-card shadow-sm">
      <CardHeader className="flex min-h-[58px] flex-row items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="m-0 text-base font-semibold">{trendLabel}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{metricLabel}</p>
        </div>
        <Select
          items={granularityItems}
          value={granularity}
          onValueChange={(value) => {
            if (value !== null) {
              setGranularity(value as TrendGranularity);
              setActive(null);
              setFocused(0);
            }
          }}
        >
          <SelectTrigger aria-label={tr("insights.trendGranularity")} className="w-auto">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {granularityItems.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </CardHeader>
      <CardContent className="px-5 pb-4 pt-5">
        {series.length ? (
          <>
            <div className="relative" onMouseLeave={() => setActive(null)}>
              <span
                role="img"
                className="sr-only"
                aria-label={tr("insights.trendSummary", {
                  label: trendLabel,
                  values: series.map((_, index) => detail(index)).join(", "),
                })}
              />
              <svg
                viewBox="0 0 520 170"
                className="h-[170px] w-full overflow-visible"
                preserveAspectRatio="none"
                role="group"
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
                    strokeOpacity=".1"
                    strokeDasharray="3 4"
                  />
                ))}
                <path
                  d={smoothTrendPath(coordinates)}
                  fill="none"
                  stroke="var(--primary)"
                  strokeWidth="2.25"
                  vectorEffect="non-scaling-stroke"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                {coordinates.map(
                  (coordinate, index) =>
                    coordinate && (
                      <g
                        key={series[index].date}
                        ref={(element) => {
                          targets.current[index] = element;
                        }}
                        role="img"
                        aria-label={detail(index)}
                        tabIndex={index === tabStop ? 0 : -1}
                        onFocus={() => {
                          setActive(index);
                          setFocused(index);
                        }}
                        onBlur={() => setActive(null)}
                        onMouseEnter={() => setActive(index)}
                        onKeyDown={(event) => moveFocus(index, event)}
                        className="outline-none"
                      >
                        <rect
                          x={coordinate.x - (series.length === 1 ? 260 : 254 / (series.length - 1))}
                          y="0"
                          width={series.length === 1 ? 520 : 508 / (series.length - 1)}
                          height="170"
                          fill="transparent"
                        />
                        <circle
                          cx={coordinate.x}
                          cy={coordinate.y}
                          r="3.5"
                          fill="var(--primary)"
                          style={{
                            opacity:
                              activeIndex === index ||
                              (coordinates[index - 1] == null && coordinates[index + 1] == null)
                                ? 1
                                : 0,
                          }}
                          vectorEffect="non-scaling-stroke"
                        />
                      </g>
                    ),
                )}
              </svg>
              {activeIndex !== null && (
                <div
                  role="tooltip"
                  className="pointer-events-none absolute top-0 z-10 max-w-full rounded-md border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md"
                  style={{
                    left: `${Math.max(0, Math.min(100, (coordinates[activeIndex]!.x / 520) * 100))}%`,
                    transform: `translateX(${activeIndex < series.length / 3 ? 0 : activeIndex > (series.length * 2) / 3 ? -100 : -50}%)`,
                  }}
                >
                  {detail(activeIndex)}
                </div>
              )}
            </div>
            <div
              className="mt-2 flex justify-between gap-2 text-[10px] text-muted-foreground"
              aria-hidden="true"
            >
              {ticks.map((index) => (
                <span key={series[index].date}>
                  {new Intl.DateTimeFormat(locale, {
                    month: "short",
                    ...(granularity === "month" ? {} : { day: "numeric" }),
                  }).format(new Date(`${series[index].date}T00:00:00`))}
                </span>
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
