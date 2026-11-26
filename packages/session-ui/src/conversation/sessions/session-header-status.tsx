import { useDelayedBusy } from "../../delayed-busy";
import { DelayedSpinner } from "../../loading-feedback";
import type { InteractionLocale } from "../../interaction-model";
import type { sessionDisplayState } from "./session-display-state";
import { webLayoutCopy } from "./web-layout-copy";

export function SessionHeaderStatus({
  locale,
  status,
  reconnecting,
}: {
  locale: InteractionLocale;
  status: ReturnType<typeof sessionDisplayState>;
  reconnecting: boolean;
}) {
  const showReconnect = useDelayedBusy(reconnecting, 2000);
  const copy = webLayoutCopy[locale];
  if (reconnecting && status.label !== copy.uncertain)
    return showReconnect ? (
      <span role="status" className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap">
        <span aria-hidden className="size-1.5 rounded-full bg-amber-500" />
        {copy.streamReconnecting}
      </span>
    ) : null;
  if (!status.label || status.label === copy.ready) return null;
  if (status.continuation === "status-unknown")
    return (
      <span role="status" aria-label={status.reason} title={status.reason}>
        <span aria-hidden className="block size-1.5 rounded-full bg-amber-500" />
      </span>
    );
  if (status.label === copy.verifying || (status.loading && status.continuation !== "starting"))
    return (
      <span
        role="status"
        aria-label={status.label}
        title={status.reason === status.label ? undefined : status.reason}
        className="inline-flex shrink-0 items-center"
      >
        <DelayedSpinner active />
      </span>
    );

  const label =
    status.label === copy.readonly || status.label === copy.unverified
      ? copy.readonlyShort
      : status.label === copy.uncertain
        ? copy.uncertainShort
        : status.label;
  return (
    <span
      role="status"
      className={`shrink-0 whitespace-nowrap ${status.tone === "warning" ? "text-amber-700 dark:text-amber-300" : ""}`}
      title={status.reason || undefined}
    >
      {label}
    </span>
  );
}
