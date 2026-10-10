import { useI18n } from "@/core/useI18n";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Gauge, RefreshCw, Settings2 } from "lucide-react";
import { api } from "@/core/api";
import { desktopApi } from "@/core/desktop";
import { changeLocale } from "@/core/i18n";
import {
  compareQuotaProviders,
  isQuotaProviderSupported,
  lowestRemaining,
  visibleQuotaWindows,
} from "@/features/quota/quota";
import { applyTheme } from "@/core/theme";
import type { EffectiveTheme, QuotaProvider } from "@/core/types";
import { ProviderIcon, QuotaWindowRow } from "./QuotaDisplay";
import { QuotaAutoRefreshPrompt } from "./QuotaAutoRefreshPrompt";
import { cn } from "cn";
import {
  DEFAULT_QUOTA_PREFERENCES,
  quotaKeys,
  useQuotaPreferences,
  useQuotaQueryEvents,
  useQuotaRefreshJob,
  useQuotaRefreshMutation,
  useQuotaSnapshot,
} from "./quota-query";
import { useAppStore } from "@/stores/app-store";

export function QuotaPopover() {
  const { formatRelativeTime, localizeMessage, tr } = useI18n();
  const snapshotQuery = useQuotaSnapshot();
  const preferencesQuery = useQuotaPreferences();
  const refreshJobQuery = useQuotaRefreshJob();
  const refreshMutation = useQuotaRefreshMutation();
  const snapshot = snapshotQuery.data;
  const preferences = preferencesQuery.data ?? DEFAULT_QUOTA_PREFERENCES;
  const refreshJob = refreshJobQuery.data;
  const [selectedId, setSelectedId] = useState("");
  const [rawManualError, setManualError] = useState<unknown>("");
  const manualError = rawManualError === "" ? "" : localizeMessage(rawManualError);
  const initialRefreshRequested = useRef(false);
  const runtime = useAppStore((state) => state.runtime);
  const autoRefreshEnabled = runtime?.quota_auto_refresh_enabled === true;
  const promptSeen = runtime?.quota_auto_refresh_prompt_seen === true;
  const setRuntime = useAppStore((state) => state.setRuntime);
  const error =
    manualError ||
    (snapshotQuery.error
      ? localizeMessage(snapshotQuery.error)
      : preferencesQuery.error
        ? localizeMessage(preferencesQuery.error)
        : refreshJobQuery.error
          ? localizeMessage(refreshJobQuery.error)
          : "") ||
    (refreshJob?.state === "failed" ? refreshJob.error : undefined) ||
    "";
  const desktop = useMemo(() => desktopApi(), []);
  const queryClient = useQueryClient();

  useQuotaQueryEvents();

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") void desktop.shell.hideWindow();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [desktop]);

  const refreshActive = refreshJob?.state === "queued" || refreshJob?.state === "running";
  useEffect(() => {
    if (
      snapshotQuery.isPending ||
      refreshJobQuery.isPending ||
      !autoRefreshEnabled ||
      initialRefreshRequested.current ||
      (refreshJob && ["queued", "running", "backoff"].includes(refreshJob.state)) ||
      snapshot?.freshness === "fresh"
    )
      return;
    initialRefreshRequested.current = true;
    void refreshMutation.mutateAsync().catch((reason) => setManualError(reason));
  }, [
    autoRefreshEnabled,
    refreshJob,
    refreshJobQuery.isPending,
    refreshMutation,
    snapshot,
    snapshotQuery.isPending,
  ]);

  useEffect(() => {
    let disposed = false;
    const syncAppearance = async () => {
      try {
        const runtime = await api.runtime();
        if (disposed) return;
        applyTheme(runtime.effective_theme);
        await changeLocale(runtime.effective_locale);
        await queryClient.invalidateQueries({ queryKey: quotaKeys.preferences() });
      } catch {
        // The main bootstrap already supplied a safe browser/system fallback.
      }
    };
    const unlistenTheme = desktopApi().events.onThemeChanged((theme: EffectiveTheme) =>
      applyTheme(theme),
    );
    window.addEventListener("focus", syncAppearance);
    return () => {
      disposed = true;
      unlistenTheme();
      window.removeEventListener("focus", syncAppearance);
    };
  }, [queryClient]);

  const providers = useMemo(
    () =>
      (snapshot?.providers ?? [])
        .filter(isQuotaProviderSupported)
        .filter((provider) => visibleQuotaWindows(provider, preferences).length > 0)
        .sort(compareQuotaProviders),
    [preferences, snapshot],
  );

  useEffect(() => {
    if (!providers.length) return;
    if (!providers.some((provider) => provider.id === selectedId)) setSelectedId(providers[0].id);
  }, [providers, selectedId]);

  const selected = providers.find((provider) => provider.id === selectedId);
  const windows = selected ? visibleQuotaWindows(selected, preferences) : [];
  const busy = refreshActive;
  const refresh = async () => {
    setManualError("");
    try {
      await refreshMutation.mutateAsync();
    } catch (reason) {
      setManualError(reason);
    }
  };
  const markPromptSeen = async () => {
    setRuntime(await api.setQuotaAutoRefreshPromptSeen(true));
  };
  const enableAutoRefresh = async () => {
    setRuntime(await api.setQuotaAutoRefreshEnabled(true));
  };
  const openDashboard = async (
    provider?: QuotaProvider,
    configure = false,
    windowIndex?: number,
  ) => {
    const item = windowIndex === undefined ? undefined : windows[windowIndex];
    await api.openQuotaDashboard(provider?.id, item?.selector, configure);
  };

  return (
    <main className="fixed inset-0 grid grid-rows-[48px_auto_minmax(0,1fr)_48px] overflow-hidden bg-background text-foreground">
      <header className="app-window-toolbar flex items-center gap-2 border-b border-border px-3">
        <strong>{tr("nav.quota")}</strong>
        {snapshot && (
          <span
            className={cn(
              "ml-auto text-xs text-muted-foreground",
              snapshot.freshness === "stale" && "text-amber-600",
            )}
          >
            {snapshot.freshness === "stale"
              ? tr("quota.freshness.stale")
              : tr("quota.updated", { time: formatRelativeTime(snapshot.fetched_at) })}
          </span>
        )}
        <Button
          variant="outline"
          size="icon"
          type="button"
          onClick={() => void refresh()}
          disabled={busy}
          aria-label={tr("quota.refresh")}
        >
          <RefreshCw size={15} className={busy ? "animate-spin" : ""} />
        </Button>
      </header>

      {providers.length > 0 && (
        <Tabs value={selectedId} onValueChange={setSelectedId}>
          <TabsList
            className="segmented-control w-full gap-1 p-2"
            variant="default"
            aria-label={tr("quota.providers")}
          >
            {providers.map((provider) => {
              const remaining = lowestRemaining(provider);
              return (
                <TabsTrigger
                  className="segmented-control-item h-auto min-w-[72px] flex-none flex-col gap-1 border border-transparent px-1 py-2 text-xs transition-colors data-active:!border-primary data-active:!bg-background data-active:!text-foreground data-active:!shadow-[0_0_0_1px_var(--primary)]"
                  key={provider.id}
                  value={provider.id}
                >
                  <ProviderIcon provider={provider} />
                  <span className="max-w-[68px] truncate">{provider.name}</span>
                  <i className="h-0.5 w-10 overflow-hidden rounded-full bg-muted">
                    <b
                      className={cn(
                        "block h-full bg-primary",
                        remaining !== undefined && remaining < 30 && "bg-amber-500",
                      )}
                      style={{ width: `${remaining ?? 0}%` }}
                    />
                  </i>
                </TabsTrigger>
              );
            })}
          </TabsList>
        </Tabs>
      )}

      <section className="overflow-y-auto p-4">
        {!autoRefreshEnabled && !promptSeen && (
          <QuotaAutoRefreshPrompt
            compact
            onEnableAutoRefresh={enableAutoRefresh}
            onNotNow={markPromptSeen}
          />
        )}
        {!snapshot && (
          <div className="grid min-h-[300px] place-content-center justify-items-center gap-2 text-center text-muted-foreground">
            <Gauge size={25} />
            <strong className="text-sm text-foreground">
              {busy ? tr("quota.refreshRunning") : tr("quota.empty")}
            </strong>
            {error && <small className="max-w-[270px] text-xs leading-relaxed">{error}</small>}
          </div>
        )}
        {snapshot && !providers.length && (
          <div className="grid min-h-[300px] place-content-center justify-items-center gap-2 text-center text-muted-foreground">
            <Gauge size={25} />
            <strong className="text-sm text-foreground">{tr("quota.popoverEmpty")}</strong>
          </div>
        )}
        {selected && (
          <>
            <div className="flex items-center gap-2.5 pb-2">
              <ProviderIcon provider={selected} />
              <div className="min-w-0">
                <h1 className="m-0 text-lg">{selected.name}</h1>
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                  {selected.identity?.account_email ?? selected.identity?.plan ?? "—"}
                </span>
              </div>
            </div>
            <div>
              {windows.map((item, index) => (
                <div key={item.key}>
                  {item.accountLabel && (
                    <small className="mt-3 block text-xs text-muted-foreground">
                      {item.accountLabel}
                    </small>
                  )}
                  <QuotaWindowRow
                    item={item}
                    snapshot={snapshot}
                    onOpen={() => void openDashboard(selected, false, index)}
                  />
                </div>
              ))}
            </div>
            {selected.error && (
              <Collapsible className="mt-3 text-xs text-amber-600">
                <CollapsibleTrigger className="w-fit cursor-pointer bg-transparent">
                  {tr("quota.partialData")}
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 text-muted-foreground">
                    {selected.error}
                  </pre>
                </CollapsibleContent>
              </Collapsible>
            )}
          </>
        )}
      </section>

      <footer className="flex items-center justify-between border-t border-border px-2 py-1.5">
        <Button type="button" onClick={() => void openDashboard(selected)}>
          <ExternalLink size={15} />
          {tr("quota.openDashboard")}
        </Button>
        <Button type="button" onClick={() => void openDashboard(selected, true)}>
          <Settings2 size={15} />
          {tr("quota.popoverSettings")}
        </Button>
      </footer>
    </main>
  );
}
