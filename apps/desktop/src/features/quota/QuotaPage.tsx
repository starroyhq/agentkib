import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { QuotaSkeleton } from "./QuotaSkeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  CircleAlert,
  Gauge,
  RefreshCw,
  Search,
  Settings2,
  X,
} from "lucide-react";
import { api } from "@/core/api";
import { desktopApi } from "@/core/desktop";
import { formatRelativeTime, localizeMessage, tr } from "@/core/i18n";
import { normalizePlatform } from "@/core/platform";
import { useAppStore } from "@/stores/app-store";
import { cn } from "@/lib/utils";
import {
  compareQuotaProviders,
  flattenQuotaWindows,
  isQuotaProviderSupported,
  lowestRemaining,
  providerHasPartialData,
  providerIsUnavailable,
  quotaSeverity,
  quotaWindowKey,
} from "@/features/quota/quota";
import type {
  QuotaPopoverPreferences,
  QuotaProvider,
  QuotaSnapshot,
  QuotaWindowSelector,
} from "@/core/types";
import { ProviderIcon, QuotaWindowRow } from "./QuotaDisplay";
import { QuotaAutoRefreshPrompt } from "./QuotaAutoRefreshPrompt";
import {
  DEFAULT_QUOTA_PREFERENCES,
  useQuotaPreferences,
  useQuotaRefreshJob,
  useQuotaRefreshMutation,
  useQuotaSnapshot,
  useQuotaStatus,
  useSetQuotaPreferencesMutation,
} from "./quota-query";

type QuotaFilter = "all" | "healthy" | "warning" | "unavailable";

export function QuotaPage({
  initialProvider,
  initialWindow,
  configurePopoverRequest = 0,
  popoverSupported = normalizePlatform(desktopApi().platform) === "macos",
}: {
  initialProvider?: string;
  initialWindow?: QuotaWindowSelector;
  configurePopoverRequest?: number;
  popoverSupported?: boolean;
}) {
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
  const [manualError, setManualError] = useState("");
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
    void refreshMutation.mutateAsync().catch((reason) => setManualError(localizeMessage(reason)));
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
    try {
      await refreshMutation.mutateAsync();
    } catch (reason) {
      setManualError(localizeMessage(reason));
    } finally {
      setRequestPending(false);
    }
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
          ? tr("quota.refreshBackoff", { time: formatDateTime(refreshJob.next_allowed_at) })
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
              aria-label={tr("quota.refresh")}
            >
              <RefreshCw size={15} className={busy ? "animate-spin" : ""} />
            </Button>
            {snapshot && refreshLabel && (
              <Badge variant="secondary" className="hidden whitespace-nowrap sm:inline-flex">
                {refreshLabel}
              </Badge>
            )}
          </div>
        </div>

        {error && snapshot && (
          <div className="mt-3 flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
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
            <small className="max-w-[520px] whitespace-pre-wrap text-center text-xs">
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
    </div>
  );
}

function ProviderTabs({
  providers,
  selectedId,
  onSelect,
}: {
  providers: QuotaProvider[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
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

function QuotaProviderDetail({
  provider,
  snapshot,
  targetWindow,
}: {
  provider: QuotaProvider;
  snapshot: QuotaSnapshot;
  targetWindow?: QuotaWindowSelector;
}) {
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
            {formatNumber(provider.credits.remaining)} {provider.credits.unit}
          </span>
        )}
      </header>

      {direct.length > 0 && (
        <div className="grid gap-3 px-1 pt-5">
          {direct.map((item) => (
            <QuotaWindowRow key={item.key} item={item} target={item.key === targetKey} />
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
                  <QuotaWindowRow key={item.key} item={item} target={item.key === targetKey} />
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

function QuotaDisplaySettings({
  snapshot,
  preferences,
  onChange,
  onClose,
}: {
  snapshot: QuotaSnapshot;
  preferences: QuotaPopoverPreferences;
  onChange?: (preferences: QuotaPopoverPreferences) => void;
  onClose: () => void;
}) {
  const [saveError, setSaveError] = useState("");
  const preferencesMutation = useSetQuotaPreferencesMutation();
  const currentPreferences = useRef(preferences);
  const saveSequence = useRef(0);
  useEffect(() => {
    currentPreferences.current = preferences;
  }, [preferences]);
  const persist = async (next: QuotaPopoverPreferences) => {
    const sequence = ++saveSequence.current;
    const previous = currentPreferences.current;
    currentPreferences.current = next;
    onChange?.(next);
    setSaveError("");
    try {
      const stored = await preferencesMutation.mutateAsync(next);
      if (sequence === saveSequence.current) {
        currentPreferences.current = stored;
        onChange?.(stored);
      }
    } catch (reason) {
      if (sequence === saveSequence.current) {
        currentPreferences.current = previous;
        onChange?.(previous);
        setSaveError(localizeMessage(reason));
      }
    }
  };
  const toggleProvider = (providerId: string) => {
    const current = currentPreferences.current;
    const hidden = current.hidden_providers.includes(providerId);
    void persist({
      ...current,
      hidden_providers: hidden
        ? current.hidden_providers.filter((id) => id !== providerId)
        : [...current.hidden_providers, providerId],
    });
  };
  const toggleWindow = (selector: QuotaWindowSelector) => {
    const current = currentPreferences.current;
    const key = quotaWindowKey(selector);
    const hidden = current.hidden_windows.some((item) => quotaWindowKey(item) === key);
    void persist({
      ...current,
      hidden_windows: hidden
        ? current.hidden_windows.filter((item) => quotaWindowKey(item) !== key)
        : [...current.hidden_windows, selector],
    });
  };
  return (
    <aside
      className="absolute right-0 top-14 z-20 grid max-h-[min(620px,calc(100vh-150px))] w-[min(420px,calc(100vw-72px))] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-xl border border-border bg-card shadow-xl"
      aria-label={tr("quota.popoverSettings")}
    >
      <header className="flex items-start justify-between border-b border-border px-3.5 pb-3 pt-3.5">
        <div className="grid gap-1">
          <strong className="text-sm">{tr("quota.popoverSettings")}</strong>
        </div>
        <Button
          variant="outline"
          size="icon"
          type="button"
          onClick={onClose}
          aria-label={tr("common.close")}
        >
          <X size={15} />
        </Button>
      </header>
      <div className="overflow-auto p-1.5">
        {snapshot.providers.filter(isQuotaProviderSupported).map((provider) => (
          <QuotaDisplayProviderOption
            key={provider.id}
            provider={provider}
            preferences={preferences}
            onToggleProvider={toggleProvider}
            onToggleWindow={toggleWindow}
          />
        ))}
      </div>
      {saveError && (
        <div
          className="border-t border-border-subtle px-3 py-2 text-xs text-destructive"
          role="alert"
        >
          {saveError}
        </div>
      )}
      <footer className="flex justify-end border-t border-border px-3 py-2.5">
        <Button
          variant="outline"
          type="button"
          onClick={() => void persist({ hidden_providers: [], hidden_windows: [] })}
        >
          <Check size={14} />
          {tr("quota.restorePopoverDefaults")}
        </Button>
      </footer>
    </aside>
  );
}

function QuotaDisplayProviderOption({
  provider,
  preferences,
  onToggleProvider,
  onToggleWindow,
}: {
  provider: QuotaProvider;
  preferences: QuotaPopoverPreferences;
  onToggleProvider: (providerId: string) => void;
  onToggleWindow: (selector: QuotaWindowSelector) => void;
}) {
  const windows = flattenQuotaWindows(provider);
  const providerVisible = !preferences.hidden_providers.includes(provider.id);
  const [expanded, setExpanded] = useState(providerVisible && windows.length > 0);
  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <div className="flex min-h-[52px] items-center justify-between px-2 py-1.5">
        <Label className="grid min-w-0 flex-1 grid-cols-[auto_auto_minmax(0,1fr)] items-center gap-2">
          <Checkbox
            checked={providerVisible}
            disabled={!windows.length}
            onCheckedChange={() => onToggleProvider(provider.id)}
          />
          <ProviderIcon provider={provider} />
          <span className="grid min-w-0 gap-0.5">
            <strong className="truncate text-[13px]">{provider.name}</strong>
            <small className="truncate text-xs text-muted-foreground">
              {windows.length
                ? tr("quota.windowCount", { count: windows.length })
                : tr("quota.noWindows")}
            </small>
          </span>
        </Label>
        <CollapsibleTrigger
          className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={tr("common.details")}
        >
          <ChevronDown size={14} />
        </CollapsibleTrigger>
      </div>
      {windows.length > 0 && (
        <CollapsibleContent className="grid gap-1 px-2 pb-2 pl-11">
          {windows.map((item) => (
            <Label
              className="grid min-h-[42px] grid-cols-[auto_minmax(0,1fr)] items-center gap-2"
              key={item.key}
            >
              <Checkbox
                checked={
                  providerVisible &&
                  !preferences.hidden_windows.some((hidden) => quotaWindowKey(hidden) === item.key)
                }
                disabled={!providerVisible}
                onCheckedChange={() => onToggleWindow(item.selector)}
              />
              <span className="grid min-w-0 gap-0.5">
                <strong className="truncate text-[13px]">
                  {item.window.label || tr(`quota.window.${item.window.kind}`)}
                </strong>
                <small className="truncate text-xs text-muted-foreground">
                  {item.accountLabel ??
                    provider.identity?.account_email ??
                    provider.identity?.plan ??
                    provider.name}
                </small>
              </span>
            </Label>
          ))}
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}

function matchesFilter(provider: QuotaProvider, filter: QuotaFilter) {
  if (filter === "all") return true;
  const remaining = lowestRemaining(provider);
  if (filter === "unavailable") return providerIsUnavailable(provider);
  if (remaining === undefined) return false;
  return filter === "warning" ? remaining <= 20 : remaining > 20;
}

function formatDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(document.documentElement.lang || "en-US", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}

function formatNumber(value: number) {
  return new Intl.NumberFormat(document.documentElement.lang || "en-US", {
    maximumFractionDigits: 2,
  }).format(value);
}
