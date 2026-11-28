import { useI18n } from "@/core/useI18n";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useAppStore } from "@/stores/app-store";

import type { QuotaCollectorStatus } from "@/core/types";

export function QuotaDiagnostics({ status }: { status?: QuotaCollectorStatus }) {
  const { locale, tr } = useI18n();
  const autoRefreshEnabled = useAppStore((state) => state.runtime?.quota_auto_refresh_enabled);
  if (!status)
    return (
      <div className="px-4 py-3 text-xs text-muted-foreground">{tr("quota.statusUnavailable")}</div>
    );
  const serviceStatus = [
    tr(status.sidecar_available ? "quota.available" : "quota.unavailable"),
    status.backend_version,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="divide-y divide-border/60">
      <DiagnosticRow label={tr("quota.sidecar")} value={serviceStatus} />
      <DiagnosticRow
        label={tr("quota.configSource")}
        value={tr(`quota.config.${status.config_source}`)}
      />
      <DiagnosticRow
        label={tr("settings.quotaAutoRefresh")}
        value={
          autoRefreshEnabled === undefined
            ? "—"
            : tr(autoRefreshEnabled ? "common.enabled" : "common.disabled")
        }
      />
      <DiagnosticRow
        label={tr("quota.lastAttempt")}
        value={status.last_attempt_at ? formatDateTime(status.last_attempt_at, locale) : "—"}
      />
      <DiagnosticRow
        label={tr("quota.lastSuccess")}
        value={status.last_success_at ? formatDateTime(status.last_success_at, locale) : "—"}
      />
      {status.error_key && (
        <div className="flex flex-col gap-2 bg-destructive/5 px-5 py-4 text-sm text-destructive-text">
          <strong>{tr(status.error_key)}</strong>
          {status.error_detail && (
            <Collapsible>
              <CollapsibleTrigger className="text-xs font-medium underline-offset-4 hover:underline">
                {tr("common.details")}
              </CollapsibleTrigger>
              <CollapsibleContent>
                <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-background/70 p-3 text-xs text-muted-foreground">
                  {status.error_detail}
                </pre>
              </CollapsibleContent>
            </Collapsible>
          )}
        </div>
      )}
    </div>
  );
}

function DiagnosticRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-h-14 items-center justify-between gap-5 px-5 py-3.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <strong className="text-right font-medium">{value}</strong>
    </div>
  );
}
function formatDateTime(value: string, locale: ReturnType<typeof useI18n>["locale"]) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}
