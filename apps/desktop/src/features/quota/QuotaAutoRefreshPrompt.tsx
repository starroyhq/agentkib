import { useI18n } from "@/core/useI18n";
import { Button } from "@/components/ui/button";

import { cn } from "cn";
import { withAsyncCleanup } from "@/lib/utils";
import { Gauge } from "lucide-react";
import { useState } from "react";

export function QuotaAutoRefreshPrompt({
  compact = false,
  onEnableAutoRefresh,
  onNotNow,
}: {
  compact?: boolean;
  onEnableAutoRefresh: () => Promise<void>;
  onNotNow: () => Promise<void>;
}) {
  const { localizeMessage, tr } = useI18n();
  const [busy, setBusy] = useState(false);
  const [rawError, setError] = useState<unknown>("");
  const error = rawError === "" ? "" : localizeMessage(rawError);

  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    await withAsyncCleanup(
      async () => {
        try {
          await action();
        } catch (reason) {
          setError(reason);
        }
      },
      () => setBusy(false),
    );
  };

  return (
    <section
      className={cn(
        "rounded-2xl border border-primary/25 bg-primary/5 p-4",
        compact && "rounded-xl p-3",
      )}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-content-center rounded-xl bg-primary/10 text-primary">
          <Gauge size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="m-0 text-sm font-semibold text-foreground">
            {tr("quota.autoRefreshPromptTitle")}
          </h2>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button type="button" disabled={busy} onClick={() => void run(onEnableAutoRefresh)}>
              {tr("quota.enableAutoRefresh")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => void run(onNotNow)}
            >
              {tr("quota.notNow")}
            </Button>
          </div>
          {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
        </div>
      </div>
    </section>
  );
}
