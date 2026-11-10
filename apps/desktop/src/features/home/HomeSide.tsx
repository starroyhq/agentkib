import type { ReactNode } from "react";
import { Brain, ChevronRight, CircleArrowUp, Hourglass, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { AGENT_LABELS } from "@/core/agents";
import { useI18n } from "@/core/useI18n";
import { cn } from "cn";
import type { HomeMaintenanceItem, HomeQuotaRow, HomeRemoteSummary } from "./home-side";

const BAR = {
  healthy: "bg-primary",
  warning: "bg-amber-500",
  danger: "bg-destructive",
} as const;

export interface HomeSideProps {
  quota: HomeQuotaRow[];
  remote?: HomeRemoteSummary;
  maintenance: HomeMaintenanceItem[];
  onOpenQuota: () => void;
  onOpenRemote: () => void;
  onOpenMaintenance: (kind: "config" | "memories" | "tools") => void;
}

/** Each card hides when it has nothing to say; with none left the main column takes the width. */
export function hasHomeSide({ quota, remote, maintenance }: HomeSideProps) {
  return quota.length > 0 || remote !== undefined || maintenance.length > 0;
}

export function HomeSide(props: HomeSideProps) {
  const { tr } = useI18n();
  const { quota, remote, maintenance, onOpenQuota, onOpenRemote, onOpenMaintenance } = props;
  if (!hasHomeSide(props)) return null;
  const relay = !remote
    ? undefined
    : remote.relayExhausted
      ? { tone: "text-destructive-text", text: tr("home.side.relayExhausted") }
      : remote.relayPercent !== undefined && remote.relayPercent >= 95
        ? {
            tone: "text-amber-700 dark:text-amber-300",
            text: tr("home.side.relayAlmost", { percent: remote.relayPercent }),
          }
        : remote.relayPercent !== undefined && remote.relayPercent >= 80
          ? {
              tone: "text-amber-700 dark:text-amber-300",
              text: tr("home.side.relayUsed", { percent: remote.relayPercent }),
            }
          : undefined;
  return (
    <aside
      aria-label={tr("home.side.label")}
      className="grid content-start gap-3 sm:grid-cols-3 lg:grid-cols-1"
    >
      {quota.length > 0 && (
        <CardButton title={tr("nav.quota")} onClick={onOpenQuota}>
          <ul className="grid gap-3">
            {quota.map((row) => (
              <li key={row.providerId} className="grid gap-1.5">
                <span className="flex items-center justify-between gap-2 text-xs">
                  <span className="truncate">
                    {row.name} · {row.window.label || tr(`quota.window.${row.window.kind}`)}
                  </span>
                  <span className="tabular-nums text-muted-foreground">{row.usedPercent}%</span>
                </span>
                <span className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
                  <span
                    className={cn("block h-full rounded-full", BAR[row.severity])}
                    style={{ width: `${row.usedPercent}%` }}
                  />
                </span>
              </li>
            ))}
          </ul>
        </CardButton>
      )}
      {remote && (
        <CardButton title={tr("home.side.remote")} onClick={onOpenRemote}>
          <span className="flex items-center gap-2 text-sm">
            <span aria-hidden className="size-2 shrink-0 rounded-full bg-emerald-500" />
            {tr("home.side.remoteOn", { count: remote.devices })}
          </span>
          {relay && <span className={cn("text-xs leading-relaxed", relay.tone)}>{relay.text}</span>}
        </CardButton>
      )}
      {maintenance.length > 0 && (
        <Card className="gap-0 rounded-xl border-border bg-card py-2 shadow-none">
          <h2 className="px-4 pb-1 pt-2 text-sm font-semibold">{tr("home.side.maintenance")}</h2>
          <ul>
            {maintenance.map((item) =>
              item.kind === "undiagnosed" ? (
                <li
                  key={item.kind}
                  className="flex items-center gap-2.5 px-4 py-2 text-xs text-muted-foreground"
                >
                  <Hourglass size={15} aria-hidden className="shrink-0" />
                  {tr("home.side.undiagnosed", { count: item.count })}
                </li>
              ) : (
                <li key={item.kind}>
                  <Button
                    variant="bare"
                    size="content"
                    className="flex w-full items-center justify-start gap-2.5 px-4 py-2 text-left text-sm font-normal hover:bg-muted/40"
                    onClick={() => onOpenMaintenance(item.kind)}
                  >
                    {item.kind === "config" ? (
                      <TriangleAlert size={15} aria-hidden className="shrink-0 text-amber-600" />
                    ) : item.kind === "memories" ? (
                      <Brain size={15} aria-hidden className="shrink-0 text-muted-foreground" />
                    ) : (
                      <CircleArrowUp
                        size={15}
                        aria-hidden
                        className="shrink-0 text-muted-foreground"
                      />
                    )}
                    <span className="min-w-0 flex-1 truncate">
                      {item.kind === "config"
                        ? tr("home.side.config", { count: item.count })
                        : item.kind === "memories"
                          ? tr("home.side.memories", { count: item.count })
                          : item.agents.length === 1
                            ? tr("home.side.toolUpdate", { agent: AGENT_LABELS[item.agents[0]!] })
                            : tr("home.side.toolUpdates", { count: item.agents.length })}
                    </span>
                    <ChevronRight
                      size={15}
                      aria-hidden
                      className="shrink-0 text-muted-foreground"
                    />
                  </Button>
                </li>
              ),
            )}
          </ul>
        </Card>
      )}
    </aside>
  );
}

function CardButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      variant="bare"
      size="content"
      onClick={onClick}
      className="grid content-start items-stretch justify-stretch gap-3 rounded-xl border border-border bg-card p-4 text-left font-normal hover:bg-muted/40"
    >
      <span className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold">{title}</span>
        <ChevronRight size={15} aria-hidden className="text-muted-foreground" />
      </span>
      {children}
    </Button>
  );
}
