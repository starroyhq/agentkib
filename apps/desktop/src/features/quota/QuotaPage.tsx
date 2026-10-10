import { useI18n } from "@/core/useI18n";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { QuotaSkeleton } from "./QuotaSkeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useEffect, useMemo, useRef, useState } from "react";
import { CircleAlert, Gauge, RefreshCw, Search, Settings2 } from "lucide-react";
import { api } from "@/core/api";
import { desktopApi } from "@/core/desktop";

import { normalizePlatform } from "@/core/platform";
import { useAppStore } from "@/stores/app-store";
import { cn } from "cn";
import { withAsyncCleanup } from "@/lib/utils";
import {
  compareQuotaProviders,
  isQuotaProviderSupported,
  lowestRemaining,
  providerIsUnavailable,
} from "@/features/quota/quota";
import type { QuotaProvider, QuotaWindowSelector } from "@/core/types";
import { QuotaAutoRefreshPrompt } from "./QuotaAutoRefreshPrompt";
import { QuotaDiagnostics } from "./QuotaDiagnostics";
import { ProviderTabs, QuotaProviderDetail } from "./QuotaProviderPanels";
import { QuotaDisplaySettings } from "./QuotaDisplaySettings";
import { formatDateTime } from "./quota-format";
import {
  DEFAULT_QUOTA_PREFERENCES,
  useQuotaPreferences,
  useQuotaRefreshJob,
  useQuotaRefreshMutation,
  useQuotaSnapshot,
  useQuotaStatus,
} from "./quota-query";

type QuotaFilter = "all" | "healthy" | "warning" | "unavailable";

export function QuotaPage({
  initialProvider,
  initialWindow,
  configurePopoverRequest = 0,
  popoverSupported: popoverSupportedProp,
}: {
  initialProvider?: string;
  initialWindow?: QuotaWindowSelector;
  configurePopoverRequest?: number;
  popoverSupported?: boolean;
}) {
  let popoverSupported = popoverSupportedProp;
  if (popoverSupported === undefined)
    popoverSupported = normalizePlatform(desktopApi().platform) === "macos";
  const { locale, localizeMessage, tr } = useI18n();
  const snapshotQuery = useQuotaSnapshot();
  const statusQuery = useQuotaStatus();
  const preferencesQuery = useQuotaPreferences();
  const refreshJobQuery = useQuotaRefreshJob();
  const refreshMutation = useQuotaRefreshMutation();
  const snapshot = snapshotQuery.data;
  const status = statusQuery.data;
  const preferences = preferencesQuery.data ?? DEFAULT_QUOTA_PREFERENCES;
  const refreshJob = refreshJobQuery.data;
  const [selectedId, setSelectedId] = useState(initialProvider ?? initialWindow?.provider_id ?? "");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<QuotaFilter>("all");
  const [showPreferences, setShowPreferences] = useState(
    popoverSupported && configurePopoverRequest > 0,
  );
  const [requestPending, setRequestPending] = useState(false);
  const [rawManualError, setManualError] = useState<unknown>("");
  const manualError = rawManualError === "" ? "" : localizeMessage(rawManualError);
  const autoRefreshEnabled = useAppStore(
    (state) => state.runtime?.quota_auto_refresh_enabled === true,
  );
  const promptSeen = useAppStore((state) => state.runtime?.quota_auto_refresh_prompt_seen === true);
  const setRuntime = useAppStore((state) => state.setRuntime);
  const requestedInitialRefresh = useRef(false);
  const initializing = snapshotQuery.isPending;
  const queryError =
    snapshotQuery.error ?? statusQuery.error ?? preferencesQuery.error ?? refreshJobQuery.error;
  const refreshError = refreshJob?.state === "failed" ? refreshJob.error : undefined;
  const error =
    manualError || (queryError ? localizeMessage(queryError) : "") || refreshError || "";

  useEffect(() => {
    if (
      snapshotQuery.isPending ||
      refreshJobQuery.isPending ||
      !autoRefreshEnabled ||
      requestedInitialRefresh.current ||
      (refreshJob && ["queued", "running", "backoff"].includes(refreshJob.state)) ||
      snapshot?.freshness === "fresh"
    )
      return;
    requestedInitialRefresh.current = true;
    void refreshMutation.mutateAsync().catch((reason) => setManualError(reason));
  }, [
    autoRefreshEnabled,
    refreshJob,
    refreshJobQuery.isPending,
    refreshMutation,
    snapshot,
    snapshotQuery.isPending,
  ]);

  const refreshActive = refreshJob?.state === "queued" || refreshJob?.state === "running";

  useEffect(() => {
    if (initialProvider || initialWindow)
      setSelectedId(initialProvider ?? initialWindow?.provider_id ?? "");
    if (popoverSupported && configurePopoverRequest > 0) setShowPreferences(true);
  }, [configurePopoverRequest, initialProvider, initialWindow, popoverSupported]);

  const providers = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return [...(snapshot?.providers ?? [])]
      .filter(isQuotaProviderSupported)
      .filter((provider) => {
        const haystack = [
          provider.name,
          provider.id,
          provider.identity?.account_email,
          provider.identity?.plan,
          ...provider.accounts.flatMap((account) => [
            account.id,
            account.label,
            account.identity?.account_email,
            account.identity?.plan,
          ]),
        ]
          .filter(Boolean)
          .join(" ")
          .toLocaleLowerCase();
        return (!needle || haystack.includes(needle)) && matchesFilter(provider, filter);
      })
      .sort(compareQuotaProviders);
  }, [snapshot, query, filter]);

  useEffect(() => {
    if (!providers.length) return;
    if (!providers.some((provider) => provider.id === selectedId)) setSelectedId(providers[0].id);
  }, [providers, selectedId]);

  useEffect(() => {
    if (!initialWindow || selectedId !== initialWindow.provider_id) return;
    const timer = window.setTimeout(() => {
      document
        .querySelector<HTMLElement>('[data-quota-target="true"]')
        ?.scrollIntoView({ block: "center" });
    }, 50);
    return () => window.clearTimeout(timer);
  }, [initialWindow, selectedId]);

  const selected = providers.find((provider) => provider.id === selectedId);
  const busy = requestPending || refreshActive;
  const refresh = async () => {
    setRequestPending(true);
    setManualError("");
    await withAsyncCleanup(
      async () => {
        try {
          await refreshMutation.mutateAsync();
        } catch (reason) {
          setManualError(reason);
        }
      },
      () => setRequestPending(false),
    );
  };
  const markPromptSeen = async () => {
    setRuntime(await api.setQuotaAutoRefreshPromptSeen(true));
  };
  const enableAutoRefresh = async () => {
    setRuntime(await api.setQuotaAutoRefreshEnabled(true));
  };
  const refreshLabel =
    refreshJob?.state === "queued"
      ? tr("quota.refreshPreparing")
      : refreshJob?.state === "running"
        ? tr("quota.refreshRunning")
        : undefined;
  const emptyLabel =
    requestPending || refreshJob?.state === "queued"
      ? tr("quota.refreshPreparing")
      : refreshJob?.state === "running"
        ? tr("quota.refreshRunning")
        : refreshJob?.state === "backoff" && refreshJob.next_allowed_at
          ? tr("quota.refreshBackoff", { time: formatDateTime(refreshJob.next_allowed_at, locale) })
          : refreshJob?.state === "failed"
            ? tr("quota.refreshFailed")
            : status?.error_key
              ? tr(status.error_key)
              : tr("quota.empty");
  const emptyDetail = error || (refreshJob?.state === "failed" ? refreshJob.error : undefined);

  if (initializing) return <QuotaSkeleton />;

  return (
    <div className="relative grid gap-5 pb-8">
      <Collapsible open={showPreferences} onOpenChange={setShowPreferences}>
        <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-3 shadow-sm lg:flex-row lg:items-center">
          <Label className="!flex !h-10 min-w-0 items-center gap-2 rounded-xl border border-border bg-background px-3 text-muted-foreground">
            <Search size={14} />
            <Input
              className="!border-0 !bg-transparent !px-0 !text-foreground !shadow-none placeholder:!text-muted-foreground focus-visible:!ring-0"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={tr("quota.search")}
              aria-label={tr("quota.search")}
            />
          </Label>
          <ToggleGroup
            className="segmented-control w-fit max-w-full max-sm:w-full"
            value={[filter]}
            onValueChange={(values) => {
              const value = values[0];
              if (value) setFilter(value as QuotaFilter);
            }}
            aria-label={tr("quota.filterLabel")}
          >
            {(["all", "healthy", "warning", "unavailable"] as QuotaFilter[]).map((value) => (
              <ToggleGroupItem
                key={value}
                value={value}
                className="segmented-control-item h-9 min-h-9 flex-1 px-4 text-xs font-semibold"
              >
                {tr(`quota.filter.${value}`)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <div className="flex items-center gap-2 lg:ml-auto">
            {popoverSupported && (
              <CollapsibleTrigger
                className="inline-flex min-h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl border border-border bg-background px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                type="button"
              >
                <Settings2 size={15} />
                {tr("quota.popoverSettings")}
              </CollapsibleTrigger>
            )}
            <Button
              variant="outline"
              size="icon"
              className="size-10 rounded-xl"
              onClick={() => void refresh()}
              disabled={busy}
              title={tr("quota.refresh")}
              aria-label={tr(busy ? "quota.refreshRunning" : "quota.refresh")}
              aria-busy={busy}
            >
              <RefreshCw size={15} className={busy ? "animate-spin" : ""} />
            </Button>
            {snapshot && refreshLabel && (
              <Badge
                variant="secondary"
                className="hidden whitespace-nowrap sm:inline-flex"
                aria-hidden="true"
              >
                {refreshLabel}
              </Badge>
            )}
            <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
              {busy ? (refreshLabel ?? tr("quota.refreshPreparing")) : ""}
            </span>
          </div>
        </div>

        {error && snapshot && (
          <div
            role="alert"
            aria-atomic="true"
            className="mt-3 flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          >
            <CircleAlert size={16} />
            {error}
          </div>
        )}

        {popoverSupported && snapshot && (
          <CollapsibleContent>
            <QuotaDisplaySettings
              snapshot={snapshot}
              preferences={preferences}
              onClose={() => setShowPreferences(false)}
            />
          </CollapsibleContent>
        )}
      </Collapsible>

      {!autoRefreshEnabled && !promptSeen && (
        <QuotaAutoRefreshPrompt onEnableAutoRefresh={enableAutoRefresh} onNotNow={markPromptSeen} />
      )}

      {!snapshot && (
        <div className="grid min-h-[240px] place-content-center justify-items-center gap-3 text-muted-foreground">
          <Gauge size={26} />
          <strong className="text-foreground">{emptyLabel}</strong>
          {emptyDetail && (
            <small
              role="alert"
              aria-atomic="true"
              className="max-w-[520px] whitespace-pre-wrap text-center text-xs"
            >
              {emptyDetail}
            </small>
          )}
          <Button onClick={() => void refresh()} disabled={busy}>
            {tr("quota.refresh")}
          </Button>
        </div>
      )}
      {snapshot && (
        <>
          <div className="grid gap-4 lg:grid-cols-[minmax(250px,0.36fr)_minmax(0,1fr)]">
            <section className="grid content-start gap-3 rounded-2xl border border-border bg-card p-4 shadow-sm max-[900px]:p-3">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold tracking-tight">{tr("quota.providers")}</h2>
                <Badge variant="outline">{tr(`quota.freshness.${snapshot.freshness}`)}</Badge>
              </div>
              <ProviderTabs
                providers={providers}
                selectedId={selectedId}
                onSelect={setSelectedId}
              />
            </section>
            {selected && (
              <QuotaProviderDetail
                provider={selected}
                snapshot={snapshot}
                targetWindow={initialWindow}
              />
            )}
          </div>
          {!providers.length && (
            <div className="grid min-h-[180px] place-content-center text-sm text-muted-foreground">
              {tr("quota.noMatch")}
            </div>
          )}
        </>
      )}
      <Collapsible className="overflow-hidden rounded-xl border border-border bg-card">
        <CollapsibleTrigger className="w-full px-5 py-3 text-left text-sm font-medium">
          {tr("quota.diagnostics")}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <QuotaDiagnostics status={status} />
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

function matchesFilter(provider: QuotaProvider, filter: QuotaFilter) {
  if (filter === "all") return true;
  const remaining = lowestRemaining(provider);
  if (filter === "unavailable") return providerIsUnavailable(provider);
  if (remaining === undefined) return false;
  return filter === "warning" ? remaining <= 20 : remaining > 20;
}
