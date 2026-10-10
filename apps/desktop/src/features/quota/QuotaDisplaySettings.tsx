import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/core/useI18n";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Check, ChevronDown, X } from "lucide-react";
import { api } from "@/core/api";
import { cn } from "cn";
import {
  flattenQuotaWindows,
  isQuotaProviderSupported,
  quotaWindowKey,
} from "@/features/quota/quota";
import type {
  QuotaPopoverPreferences,
  QuotaProvider,
  QuotaSnapshot,
  QuotaWindowSelector,
} from "@/core/types";
import { ProviderIcon } from "./QuotaDisplay";
import { useSetQuotaPreferencesMutation } from "./quota-query";

export function QuotaDisplaySettings({
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
  const { localizeMessage, tr } = useI18n();
  const [rawSaveError, setSaveError] = useState<unknown>("");
  const saveError = rawSaveError === "" ? "" : localizeMessage(rawSaveError);
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
        setSaveError(reason);
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
  const { tr } = useI18n();
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
