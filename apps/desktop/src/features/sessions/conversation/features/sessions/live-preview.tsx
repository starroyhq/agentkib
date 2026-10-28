import { useId, useMemo, useState, type FormEvent } from "react";
import { ArrowLeft, ExternalLink, Globe, RotateCw } from "lucide-react";
import {
  localPreviewLabel,
  localPreviewTargets,
  parseLocalPreviewTarget,
  type LocalPreviewTarget,
} from "@agentkib/web-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/core/api";
import { livePreviewCopy } from "./live-preview-copy";
import { useSession } from "./session-context";

/** A dev server's address is in recent output; older loaded pages are not scanned. */
const SCANNED_EVENTS = 200;
/**
 * The page keeps its own origin (localhost, cross-origin to AgentKib), so it cannot reach the
 * app. It may not navigate the window, open windows or start downloads.
 */
const FRAME_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-modals";

/** Pages served on this computer, shown directly: the desktop app runs where the server runs. */
export function LivePreview() {
  const { page, live, locale } = useSession();
  const copy = livePreviewCopy(locale);
  const inputId = useId();
  const errorId = useId();
  const events = page?.events;
  const streamText = live?.streamText;
  const detected = useMemo(
    () =>
      localPreviewTargets([
        ...(events ?? []).slice(-SCANNED_EVENTS).map((event) => event.content ?? ""),
        streamText ?? "",
      ]),
    [events, streamText],
  );
  const [target, setTarget] = useState<LocalPreviewTarget>();
  const [address, setAddress] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [revision, setRevision] = useState(0);
  function submit(event: FormEvent) {
    event.preventDefault();
    const typed = parseLocalPreviewTarget(address);
    setInvalid(!typed);
    if (typed) setTarget(typed);
  }
  if (target)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-2 py-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 rounded-md text-muted-foreground"
            aria-label={copy.back}
            title={copy.back}
            onClick={() => setTarget(undefined)}
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
          </Button>
          <span
            className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground"
            title={target.url}
          >
            {localPreviewLabel(target)}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 rounded-md text-muted-foreground"
            aria-label={copy.reload}
            title={copy.reload}
            onClick={() => setRevision((value) => value + 1)}
          >
            <RotateCw className="size-4" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 rounded-md text-muted-foreground"
            aria-label={copy.external}
            title={copy.external}
            onClick={() => void api.openExternal(target.url).catch(() => {})}
          >
            <ExternalLink className="size-4" aria-hidden="true" />
          </Button>
        </div>
        <iframe
          key={revision}
          title={copy.frame}
          src={target.url}
          sandbox={FRAME_SANDBOX}
          referrerPolicy="no-referrer"
          className="min-h-0 w-full flex-1 border-0 bg-white"
        />
        <p className="shrink-0 border-t border-border/60 px-3 py-1.5 text-[11px] leading-4 text-muted-foreground">
          {copy.blank}
        </p>
      </div>
    );
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
                  onClick={() => setTarget(item)}
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
              setAddress(event.target.value);
              setInvalid(false);
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
