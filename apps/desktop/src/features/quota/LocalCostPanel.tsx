import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useI18n } from "@/core/useI18n";
import type { LocalCostDay, LocalCostSnapshot } from "@/core/types";
import type { LocalCostsQuery } from "./local-cost-query";
import { formatDateTime } from "./quota-format";

type Metric = "cost" | "tokens";

export function LocalCostPanel({ costs }: { costs: LocalCostsQuery }) {
  const { tr, locale, localizeMessage } = useI18n();
  const [metric, setMetric] = useState<Metric>("cost");
  const snapshot = costs.snapshot;
  const state = costs.status?.state;
  const error = costs.error
    ? localizeMessage(costs.error)
    : costs.status?.error_key
      ? tr(costs.status.error_key)
      : costs.status?.error_detail;
  const statusLabel =
    state === "queued" || state === "running"
      ? tr(`quota.cost.state.${state}`)
      : costs.loading && !snapshot
        ? tr("quota.cost.loading")
        : undefined;
  return (
    <section
      aria-labelledby="local-cost-heading"
      className="min-w-0 rounded-2xl border border-border bg-card p-5 shadow-sm max-sm:p-4"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 id="local-cost-heading" className="text-base font-semibold">
            {tr("quota.cost.title")}
          </h2>
          <p className="mt-1 max-w-[70ch] text-xs leading-relaxed text-muted-foreground">
            {tr("quota.cost.explanation")}
          </p>
        </div>
        <Button
          variant="outline"
          size="icon"
          className="size-8 shrink-0 rounded-lg"
          disabled={costs.busy}
          aria-label={tr("quota.cost.refresh")}
          onClick={() => void costs.refresh().catch(() => undefined)}
        >
          <RefreshCw size={14} className={costs.busy ? "animate-spin" : undefined} />
        </Button>
      </header>
      <div
        role="status"
        aria-live="polite"
        className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
      >
        {statusLabel && <span>{statusLabel}</span>}
        {snapshot && (
          <>
            <span>{tr("quota.cost.timezone", { timezone: snapshot.timezone })}</span>
            <span>·</span>
            <time dateTime={snapshot.updated_at}>
              {tr("quota.updated", { time: formatDateTime(snapshot.updated_at, locale) })}
            </time>
          </>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-amber-600">
          {tr("quota.cost.refreshFailed")} {error}
        </p>
      )}
      {snapshot ? (
        <>
          {snapshot.range_end !== snapshot.today.date && (
            <p className="mt-3 text-xs text-amber-600">
              {tr("quota.cost.previousPeriod", { date: snapshot.range_end })}
            </p>
          )}
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <CostSummary
              label={tr("quota.cost.today")}
              value={money(snapshot.today.cost_usd, locale)}
              partial={snapshot.today.partial}
            />
            <CostSummary
              label={tr("quota.cost.last30Days")}
              value={money(snapshot.last_30_days.cost_usd, locale)}
              partial={snapshot.last_30_days.partial}
            />
            <CostSummary
              label={tr("quota.cost.todayTokens")}
              value={tokens(snapshot.today.tokens, locale)}
            />
          </div>
          {(!snapshot.history_complete || snapshot.unpriced_models.length > 0) && (
            <div className="mt-3 flex flex-wrap gap-2">
              {!snapshot.history_complete && (
                <Badge variant="outline" className="max-w-full whitespace-normal break-words">
                  {tr("quota.cost.historyIncomplete")}
                </Badge>
              )}
              {snapshot.unpriced_models.length > 0 && (
                <Badge variant="outline" className="max-w-full whitespace-normal break-words">
                  {tr("quota.cost.unpriced", { count: snapshot.unpriced_models.length })}
                </Badge>
              )}
            </div>
          )}
          <div className="mt-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-sm font-medium">{tr("quota.cost.trend")}</h3>
              <div
                className="flex gap-1 rounded-lg bg-muted p-0.5"
                role="group"
                aria-label={tr("quota.cost.metric")}
              >
                {(["cost", "tokens"] as const).map((value) => (
                  <Button
                    key={value}
                    size="sm"
                    variant={metric === value ? "secondary" : "ghost"}
                    aria-pressed={metric === value}
                    onClick={() => setMetric(value)}
                    className="h-7 rounded-md px-2 text-xs"
                  >
                    {tr(`quota.cost.metric.${value}`)}
                  </Button>
                ))}
              </div>
            </div>
            <CostTrend snapshot={snapshot} metric={metric} />
            <Collapsible className="mt-2 text-xs text-muted-foreground">
              <CollapsibleTrigger className="w-fit cursor-pointer py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                {tr("quota.cost.dailyDetails")}
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="overflow-x-auto">
                  <table className="mt-2 w-full text-left text-xs tabular-nums">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="py-2 font-medium">{tr("quota.cost.date")}</th>
                        <th className="px-2 py-2 text-right font-medium">
                          {tr("quota.cost.metric.cost")}
                        </th>
                        <th className="py-2 text-right font-medium">
                          {tr("quota.cost.metric.tokens")}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {snapshot.daily.map((day) => (
                        <tr key={day.date} className="border-b border-border/60">
                          <td className="py-2">{day.date}</td>
                          <td className="px-2 py-2 text-right">
                            {money(day.cost_usd, locale)}
                            {day.partial ? ` · ${tr("quota.cost.partial")}` : ""}
                          </td>
                          <td className="py-2 text-right">{tokens(day.tokens, locale)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>
          <Collapsible className="mt-4 border-t border-border pt-3">
            <CollapsibleTrigger className="w-fit cursor-pointer text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {tr("quota.cost.models")}
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="overflow-x-auto">
                <table className="mt-2 w-full text-left text-xs tabular-nums">
                  <thead>
                    <tr className="border-b border-border text-muted-foreground">
                      <th className="py-2 font-medium">{tr("quota.cost.model")}</th>
                      <th className="px-2 py-2 text-right font-medium">
                        {tr("quota.cost.metric.cost")}
                      </th>
                      <th className="py-2 text-right font-medium">
                        {tr("quota.cost.metric.tokens")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.models.map((model) => (
                      <tr key={model.model} className="border-b border-border/60">
                        <th className="max-w-[20ch] break-words py-2 text-left font-normal">
                          {model.model}
                        </th>
                        <td className="px-2 py-2 text-right">
                          {money(model.cost_usd, locale)}
                          {model.partial ? ` · ${tr("quota.cost.partial")}` : ""}
                        </td>
                        <td className="py-2 text-right">{tokens(model.tokens, locale)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {snapshot.models.length === 0 && (
                <p className="py-3 text-xs text-muted-foreground">{tr("quota.cost.noModels")}</p>
              )}
              {snapshot.unpriced_models.length > 0 && (
                <p className="mt-3 text-xs text-muted-foreground">
                  {tr("quota.cost.unpricedModels", { models: snapshot.unpriced_models.join(", ") })}
                </p>
              )}
            </CollapsibleContent>
          </Collapsible>
        </>
      ) : (
        <div className="grid min-h-36 place-content-center text-center text-sm text-muted-foreground">
          <p>{tr(costs.loading || costs.busy ? "quota.cost.loading" : "quota.cost.empty")}</p>
        </div>
      )}
    </section>
  );
}

function CostSummary({
  label,
  value,
  partial,
}: {
  label: string;
  value: string;
  partial?: boolean;
}) {
  const { tr } = useI18n();
  return (
    <div className="min-w-0 rounded-xl border border-border p-3">
      <h3 className="text-xs text-muted-foreground">{label}</h3>
      <p className="mt-2 break-words text-xl font-semibold tabular-nums">{value}</p>
      {partial && <p className="mt-1 text-[11px] text-amber-600">{tr("quota.cost.partial")}</p>}
    </div>
  );
}

export function CostTrend({ snapshot, metric }: { snapshot: LocalCostSnapshot; metric: Metric }) {
  const { tr, locale } = useI18n();
  const width = 600;
  const height = 150;
  const plotHeight = 110;
  const start = dayNumber(snapshot.range_start);
  const end = dayNumber(snapshot.range_end);
  const days = Math.max(1, end - start + 1);
  const valueOf = (day: LocalCostDay) => (metric === "cost" ? day.cost_usd : day.tokens);
  const maximum = Math.max(1, ...snapshot.daily.map((day) => valueOf(day) ?? 0));
  const barWidth = width / days;
  return (
    <svg
      className="mt-3 block h-auto w-full overflow-visible text-primary"
      viewBox={`0 0 ${width} ${height}`}
      role="group"
      aria-label={tr("quota.cost.trendLabel", {
        start: snapshot.range_start,
        end: snapshot.range_end,
      })}
    >
      <line x1="0" y1={plotHeight} x2={width} y2={plotHeight} className="stroke-border" />
      {snapshot.daily.map((day) => {
        const value = valueOf(day);
        const barHeight = value === null ? 0 : (value / maximum) * (plotHeight - 6);
        const x = (dayNumber(day.date) - start) * barWidth + 2;
        const text =
          tr("quota.cost.dayLabel", {
            date: day.date,
            cost: money(day.cost_usd, locale),
            tokens: tokens(day.tokens, locale),
          }) + (day.partial ? ` · ${tr("quota.cost.partial")}` : "");
        return (
          <g
            key={day.date}
            tabIndex={0}
            role="img"
            aria-label={text}
            className="rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
          >
            <title>{text}</title>
            <rect
              x={x}
              y={0}
              width={Math.max(1, barWidth - 4)}
              height={plotHeight + 4}
              fill="transparent"
            />
            {value === null ? (
              <text
                x={x + (barWidth - 4) / 2}
                y={plotHeight - 3}
                textAnchor="middle"
                className="fill-muted-foreground text-[10px]"
              >
                —
              </text>
            ) : (
              <rect
                x={x}
                y={plotHeight - Math.max(2, barHeight)}
                width={Math.max(1, barWidth - 4)}
                height={Math.max(2, barHeight)}
                rx="2"
                fill="currentColor"
                opacity={day.partial ? 0.45 : 0.8}
              />
            )}
          </g>
        );
      })}
      <text x="0" y={height - 12} className="fill-muted-foreground text-[11px]">
        {snapshot.range_start}
      </text>
      <text
        x={width}
        y={height - 12}
        textAnchor="end"
        className="fill-muted-foreground text-[11px]"
      >
        {snapshot.range_end}
      </text>
      {snapshot.daily.length === 0 && (
        <text
          x={width / 2}
          y={plotHeight / 2}
          textAnchor="middle"
          className="fill-muted-foreground text-[12px]"
        >
          {tr("quota.cost.noDays")}
        </text>
      )}
    </svg>
  );
}

function dayNumber(day: string) {
  return Math.floor(Date.parse(`${day}T12:00:00Z`) / 86_400_000);
}

function money(value: number | null, locale: string) {
  if (value === null) return "—";
  const format = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    currencyDisplay: "code",
    maximumFractionDigits: 6,
  });
  return value > 0 && value < 0.000001 ? `< ${format.format(0.000001)}` : format.format(value);
}

function tokens(value: number | null, locale: string) {
  return value === null
    ? "—"
    : new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value);
}
