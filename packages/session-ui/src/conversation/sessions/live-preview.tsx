import { Globe } from "lucide-react";
import { useId, useMemo, useState, type FormEvent } from "react";
import {
  localPreviewLabel,
  localPreviewTargets,
  localPreviewTexts,
  parseLocalPreviewTarget,
  type ConversationEventPage,
  type Live,
  type LocalPreviewTarget,
  type WebClient,
} from "@agentkib/web-client";
import type { InteractionLocale } from "../../interaction-model";
import { useDelayedBusy } from "../../delayed-busy";
import { LoadingSkeleton } from "../../loading-feedback";
import { useSessionPlatform } from "../../session-platform";
import type { SessionSurface } from "../../session-surface-copy";
import { livePreviewCopy } from "./live-preview-copy";

export type LivePreviewProps = {
  client: WebClient;
  locale: InteractionLocale;
  page?: ConversationEventPage;
  live?: Live;
};

/** A dev server's address is in recent output; older loaded pages are not scanned. */
const SCANNED_EVENTS = 200;

export function LivePreviewPicker({
  locale,
  surface,
  page,
  live,
  address,
  invalid,
  onAddressChange,
  onInvalidChange,
  onOpen,
}: Pick<LivePreviewProps, "locale" | "page" | "live"> & {
  surface: SessionSurface;
  address: string;
  invalid: boolean;
  onAddressChange(value: string): void;
  onInvalidChange(value: boolean): void;
  onOpen(target: LocalPreviewTarget): void;
}) {
  const { Button, Input } = useSessionPlatform().components;
  const copy = livePreviewCopy(locale, surface);
  const inputId = useId();
  const errorId = useId();
  const events = page?.events;
  const streamText = live?.streamText;
  const detected = useMemo(
    () =>
      localPreviewTargets([
        ...localPreviewTexts((events ?? []).slice(-SCANNED_EVENTS)),
        streamText ?? "",
      ]),
    [events, streamText],
  );
  function submit(event: FormEvent) {
    event.preventDefault();
    const typed = parseLocalPreviewTarget(address);
    onInvalidChange(!typed);
    if (typed) onOpen(typed);
  }
  return (
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
      <p className="text-xs leading-5 text-muted-foreground">{copy.intro}</p>
      <section className="space-y-1">
        <h3 className="text-[11px] font-medium text-muted-foreground">{copy.found}</h3>
        {detected.length ? (
          <ul className="min-w-0 divide-y divide-border/60">
            {detected.map((item) => (
              <li key={item.port} className="min-w-0">
                <Button
                  variant="ghost"
                  size="content"
                  className="flex min-h-11 w-full min-w-0 items-center justify-start gap-3 rounded-lg px-2 py-2 text-left font-normal hover:bg-muted/60"
                  title={item.url}
                  onClick={() => onOpen(item)}
                >
                  <Globe className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">
                    {localPreviewLabel(item)}
                  </span>
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="py-2 text-xs text-muted-foreground">{copy.none}</p>
        )}
      </section>
      <form className="space-y-2" onSubmit={submit}>
        <label htmlFor={inputId} className="block text-[11px] font-medium text-muted-foreground">
          {copy.address}
        </label>
        <div className="flex gap-2">
          <Input
            id={inputId}
            value={address}
            placeholder={copy.placeholder}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? errorId : undefined}
            className="h-11 flex-1 bg-background font-mono text-xs sm:h-9"
            onChange={(event) => {
              onAddressChange(event.target.value);
              onInvalidChange(false);
            }}
          />
          <Button type="submit" className="min-h-11 sm:min-h-9" disabled={!address.trim()}>
            {copy.open}
          </Button>
        </div>
        {invalid && (
          <p id={errorId} role="alert" className="text-xs text-destructive-text">
            {copy.invalid}
          </p>
        )}
      </form>
    </div>
  );
}

/** The preview origin stays isolated from AgentKib and cannot navigate or open a window. */
export function LivePreviewFrame({
  url,
  title,
  openingLabel,
  timeoutHint,
  retryLabel,
  onRetry,
}: {
  url: string;
  title: string;
  openingLabel: string;
  timeoutHint: string;
  retryLabel?: string;
  onRetry?: () => void;
}) {
  const [loadedUrl, setLoadedUrl] = useState<string>();
  const [failedUrl, setFailedUrl] = useState<string>();
  const loading = loadedUrl !== url;
  const failed = failedUrl === url;
  const slow = useDelayedBusy(loading, 3000);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <iframe
        title={title}
        src={url}
        sandbox="allow-scripts allow-same-origin allow-forms allow-modals"
        referrerPolicy="no-referrer"
        className="min-h-0 w-full flex-1 border-0 bg-white"
        onLoad={() => {
          setLoadedUrl(url);
          setFailedUrl(undefined);
        }}
        onErrorCapture={() => setFailedUrl(url)}
      />
      {loading && !failed && (
        <div className="pointer-events-none absolute inset-0 p-4">
          <LoadingSkeleton label={openingLabel} layout="code" rows={5} />
        </div>
      )}
      {(slow || failed) && (
        <div
          role="status"
          className="absolute bottom-3 left-3 right-3 flex items-center gap-3 rounded-md border bg-background p-3 text-xs text-muted-foreground"
        >
          <p>{timeoutHint}</p>
          {onRetry && (
            <button
              type="button"
              className="ml-auto min-h-8 shrink-0 rounded-md border px-3 text-foreground hover:bg-muted"
              onClick={onRetry}
            >
              {retryLabel}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
