import { CircleAlert, Info } from "lucide-react";
import { Button } from "@agentkib/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useI18n } from "@/core/useI18n";

function diagnosticText(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function historyErrorKey(detail: string) {
  if (/TRANSCRIPT_CURSOR_(?:INVALID|STALE)|invalid.*cursor|stale.*cursor/i.test(detail)) {
    return "history.error.cursor";
  }
  if (/Transcript exceeds the 256 MiB read limit/.test(detail)) {
    return "history.error.legacyLimit";
  }
  if (
    /TRANSCRIPT_UNREADABLE|REMOTE_SESSION_NOT_FOUND|Transcript is no longer available/.test(detail)
  ) {
    return "history.error.unavailable";
  }
  if (detail.includes("TRANSCRIPT_SCAN_STATE_LIMIT")) return "history.error.scanState";
  return "history.error.read";
}

export function HistoryError({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { tr } = useI18n();
  const detail = diagnosticText(error);
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-xl border border-destructive/25 bg-destructive/5 p-4 text-sm text-destructive-text"
    >
      <CircleAlert size={17} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p>{tr(historyErrorKey(detail))}</p>
        {onRetry && (
          <Button variant="ghost" onClick={onRetry}>
            {tr("sessions.retry")}
          </Button>
        )}
        <Collapsible className="mt-2 text-xs">
          <CollapsibleTrigger className="cursor-pointer bg-transparent text-left">
            {tr("errors.details")}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all">
              {detail.slice(0, 4096)}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </div>
  );
}

export function HistoryWarning({ warning }: { warning: string }) {
  const { tr } = useI18n();
  const known: Record<string, string> = {
    TRANSCRIPT_SCAN_BUDGET: "history.warning.scanBudget",
    TRANSCRIPT_OVERSIZED_LINES: "history.warning.oversized",
    TRANSCRIPT_DAMAGED_LINES: "conversations.damagedLines",
    TRANSCRIPT_ASSOCIATION_WINDOW: "history.warning.associationWindow",
    "source-content-truncated": "history.warning.responseBudget",
  };
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-xl border border-border bg-muted/40 p-4 text-sm text-muted-foreground"
    >
      <Info size={17} className="mt-0.5 shrink-0" />
      <div className="min-w-0">
        <p>{tr(known[warning] ?? "history.warning.partial")}</p>
        {!known[warning] && (
          <Collapsible className="mt-2 text-xs">
            <CollapsibleTrigger className="cursor-pointer bg-transparent text-left">
              {tr("errors.details")}
            </CollapsibleTrigger>
            <CollapsibleContent>
              <pre className="mt-2 whitespace-pre-wrap break-all">{warning.slice(0, 4096)}</pre>
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>
    </div>
  );
}
