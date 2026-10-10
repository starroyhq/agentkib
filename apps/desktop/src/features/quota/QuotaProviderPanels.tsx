import { useI18n } from "@/core/useI18n";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Gauge } from "lucide-react";
import { cn } from "cn";
import {
  flattenQuotaWindows,
  lowestRemaining,
  providerHasPartialData,
  providerIsUnavailable,
  quotaSeverity,
  quotaWindowKey,
} from "@/features/quota/quota";
import type { QuotaProvider, QuotaSnapshot, QuotaWindowSelector } from "@/core/types";
import { ProviderIcon, QuotaWindowRow } from "./QuotaDisplay";
import { formatDateTime, formatNumber } from "./quota-format";

export function ProviderTabs({
  providers,
  selectedId,
  onSelect,
}: {
  providers: QuotaProvider[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const { tr } = useI18n();
  return (
    <Tabs value={selectedId} onValueChange={onSelect}>
      <TabsList
        className="grid !h-auto w-full grid-flow-col auto-cols-[minmax(210px,1fr)] items-stretch gap-2 overflow-x-auto overflow-y-hidden bg-transparent p-0 lg:grid-flow-row lg:grid-cols-1 lg:auto-cols-auto"
        variant="default"
        aria-label={tr("quota.providers")}
      >
        {providers.map((provider) => {
          const remaining = lowestRemaining(provider);
          const unavailable = remaining === undefined;
          const severity = remaining === undefined ? undefined : quotaSeverity(remaining);
          const isActive = provider.id === selectedId;
          return (
            <TabsTrigger
              key={provider.id}
              value={provider.id}
              className={cn(
                "relative grid h-auto min-h-[86px] min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] grid-rows-[auto_auto] items-start gap-x-2.5 gap-y-0.5 justify-start rounded-xl border border-border bg-background px-3.5 py-3.5 text-left transition-colors hover:border-foreground/25 hover:bg-muted/30 data-active:!border-primary data-active:!bg-background data-active:!text-foreground data-active:!shadow-[0_0_0_1px_var(--primary)]",
                unavailable && "opacity-60",
              )}
            >
              <ProviderIcon provider={provider} />
              <span className="min-w-0 grid gap-0.5">
                <strong className="truncate text-[13px]">{provider.name}</strong>
                <small
                  className={cn(
                    "truncate text-[11px] text-muted-foreground",
                    isActive && "text-foreground/70",
                  )}
                >
                  {provider.identity?.account_email ??
                    provider.identity?.plan ??
                    tr(unavailable ? "quota.unavailable" : "quota.available")}
                </small>
              </span>
              {remaining === undefined ? (
                <em className="text-[13px] font-bold not-italic">—</em>
              ) : (
                <>
                  <span className="grid justify-items-end gap-0.5">
                    <em
                      className={cn(
                        "text-[13px] font-bold not-italic",
                        isActive && "text-primary",
                        !isActive && severity === "healthy" && "text-green-600",
                        !isActive && severity === "warning" && "text-amber-600",
                        !isActive && severity === "danger" && "text-red-600",
                      )}
                    >
                      {Math.round(remaining)}%
                    </em>
                    <small className="text-[10px] leading-none text-muted-foreground">
                      {tr("quota.lowestRemaining")}
                    </small>
                  </span>
                  <i
                    className={cn(
                      "absolute inset-x-3 bottom-2 h-1 overflow-hidden rounded-full bg-muted",
                      isActive && "bg-primary/20",
                    )}
                  >
                    <b
                      className={cn(
                        "block h-full rounded-full bg-primary",
                        isActive && "bg-primary",
                        !isActive && severity === "warning" && "bg-amber-500",
                        !isActive && severity === "danger" && "bg-red-500",
                      )}
                      style={{ width: `${remaining}%` }}
                    />
                  </i>
                </>
              )}
            </TabsTrigger>
          );
        })}
      </TabsList>
    </Tabs>
  );
}

export function QuotaProviderDetail({
  provider,
  snapshot,
  targetWindow,
}: {
  provider: QuotaProvider;
  snapshot: QuotaSnapshot;
  targetWindow?: QuotaWindowSelector;
}) {
  const { formatRelativeTime, locale, tr } = useI18n();
  const windows = flattenQuotaWindows(provider);
  const direct = windows.filter((item) => !item.account);
  const accountGroups = provider.accounts.map((account) => ({
    account,
    windows: windows.filter((item) => item.account?.id === account.id),
  }));
  const targetKey = targetWindow ? quotaWindowKey(targetWindow) : undefined;
  const unavailable = providerIsUnavailable(provider);
  return (
    <section className="h-full w-full max-w-none overflow-hidden rounded-2xl border border-border bg-card px-5 pb-5 shadow-sm max-[900px]:px-4">
      <header className="-mx-5 grid min-h-[82px] grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-3 border-b border-border px-5 max-[900px]:mx-[-16px] max-[900px]:grid-cols-[auto_minmax(0,1fr)_auto] max-[900px]:px-4">
        <ProviderIcon provider={provider} />
        <div className="min-w-0">
          <h2 className="text-[21px]">{provider.name}</h2>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {[provider.identity?.account_email, provider.identity?.plan, provider.source]
              .filter(Boolean)
              .join(" · ") || tr("quota.identityUnavailable")}
          </p>
        </div>
        <div className="grid justify-items-end gap-0.5 text-xs text-muted-foreground">
          <span
            className={cn(
              snapshot.freshness === "stale" && "text-amber-600",
              snapshot.freshness === "unavailable" && "text-red-600",
            )}
          >
            {tr(`quota.freshness.${snapshot.freshness}`)}
          </span>
          <time>{tr("quota.updated", { time: formatRelativeTime(snapshot.fetched_at) })}</time>
        </div>
        {provider.credits && provider.credits.remaining > 0 && (
          <span className="inline-flex h-[30px] items-center rounded-md border border-border px-2.5 text-xs text-muted-foreground max-[900px]:hidden">
            {formatNumber(provider.credits.remaining, locale)} {provider.credits.unit}
          </span>
        )}
      </header>

      {direct.length > 0 && (
        <div className="grid gap-3 px-1 pt-5">
          {direct.map((item) => (
            <QuotaWindowRow
              key={item.key}
              item={item}
              snapshot={snapshot}
              target={item.key === targetKey}
            />
          ))}
        </div>
      )}
      {accountGroups.map(
        ({ account, windows: accountWindows }) =>
          accountWindows.length > 0 && (
            <section className="px-1 pt-5" key={account.id}>
              <header className="flex min-h-[42px] items-center justify-between gap-4">
                <div className="grid gap-0.5">
                  <strong className="text-sm">
                    {account.identity?.account_email ?? account.label}
                  </strong>
                  <span className="text-xs text-muted-foreground">
                    {[
                      account.identity?.plan,
                      account.active ? tr("quota.activeAccount") : undefined,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </div>
                {account.updated_at && (
                  <time className="text-xs text-muted-foreground">
                    {formatRelativeTime(account.updated_at)}
                  </time>
                )}
              </header>
              <div className="grid gap-3">
                {accountWindows.map((item) => (
                  <QuotaWindowRow
                    key={item.key}
                    item={item}
                    snapshot={snapshot}
                    target={item.key === targetKey}
                  />
                ))}
              </div>
              {account.error && (
                <Collapsible className="mt-3 text-xs text-muted-foreground">
                  <CollapsibleTrigger className="w-fit cursor-pointer bg-transparent">
                    {tr("quota.partialData")}
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2">
                      {account.error}
                    </pre>
                  </CollapsibleContent>
                </Collapsible>
              )}
            </section>
          ),
      )}

      {unavailable && (
        <div className="grid min-h-[210px] place-content-center justify-items-center gap-2 text-muted-foreground">
          <Gauge size={24} />
          <strong className="text-sm text-foreground">{tr("quota.providerUnavailable")}</strong>
          <span className="text-xs">{tr("quota.noWindows")}</span>
        </div>
      )}
      {provider.error && (
        <Collapsible
          className={cn(
            "mt-3 text-xs",
            providerHasPartialData(provider) ? "text-amber-600" : "text-muted-foreground",
          )}
        >
          <CollapsibleTrigger className="w-fit cursor-pointer bg-transparent">
            {tr(providerHasPartialData(provider) ? "quota.partialData" : "common.details")}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2">
              {provider.error}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      )}
    </section>
  );
}
