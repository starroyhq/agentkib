import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, ExternalLink, Globe, LoaderCircle, RotateCw } from "lucide-react";
import {
  ApiError,
  localPreviewLabel,
  localPreviewTargets,
  parseLocalPreviewTarget,
  type LivePreviewTicket,
  type LocalPreviewTarget,
} from "@agentkib/web-client";
import { Button, buttonVariants } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { livePreviewCopy } from "./live-preview-copy";
import { useSession } from "./session-context";

/** A dev server's address is in recent output; older loaded pages are not scanned. */
const SCANNED_EVENTS = 200;
/**
 * The page keeps the preview origin, isolated from the app. It may not navigate the window,
 * open windows or start downloads.
 */
const FRAME_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-modals";
const ICON_BUTTON = "size-8 shrink-0 rounded-md text-muted-foreground";

/**
 * Pages served on the computer running AgentKib. Each opened page gets a ticket from the host,
 * which shows it through the isolated preview origin; reloading asks for a new one.
 */
export function LivePreview() {
  const { client, page, live, locale } = useSession();
  const copy = livePreviewCopy(locale, "web");
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
  const [ticket, setTicket] = useState<LivePreviewTicket>();
  const [opening, setOpening] = useState(false);
  const [failure, setFailure] = useState("");
  const [address, setAddress] = useState("");
  const [invalid, setInvalid] = useState(false);
  const pending = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => pending.current?.abort(), []);
  function reason(error: unknown, port: number) {
    const code = error instanceof ApiError ? error.code : "";
    if (code === "live_preview_unreachable")
      return copy.unreachable.replace("{port}", String(port));
    if (code === "live_preview_port_reserved") return copy.reserved;
    if (code === "live_preview_port_blocked") return copy.blocked;
    if (error instanceof ApiError && error.status === 403) return copy.denied;
    return copy.failed;
  }
  async function open(next: LocalPreviewTarget) {
    pending.current?.abort();
    const abort = new AbortController();
    pending.current = abort;
    setTarget(next);
    setTicket(undefined);
    setFailure("");
    setOpening(true);
    try {
      const issued = await client.request<LivePreviewTicket>(
        "live-preview-tickets",
        { port: next.port, path: next.path, secure: next.secure },
        abort.signal,
      );
      if (!abort.signal.aborted) setTicket(issued);
    } catch (error) {
      if (!abort.signal.aborted) setFailure(reason(error, next.port));
    } finally {
      if (!abort.signal.aborted) setOpening(false);
    }
  }
  function back() {
    pending.current?.abort();
    setTarget(undefined);
    setTicket(undefined);
    setFailure("");
    setOpening(false);
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    const typed = parseLocalPreviewTarget(address);
    setInvalid(!typed);
    if (typed) void open(typed);
  }
  if (target)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-2 py-1">
          <Button
            variant="ghost"
            size="icon"
            className={ICON_BUTTON}
            aria-label={copy.back}
            title={copy.back}
            onClick={back}
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
            className={ICON_BUTTON}
            aria-label={copy.reload}
            title={copy.reload}
            disabled={opening}
            onClick={() => void open(target)}
          >
            <RotateCw
              className={`size-4 ${opening ? "animate-spin motion-reduce:animate-none" : ""}`}
              aria-hidden="true"
            />
          </Button>
          {ticket && (
            <a
              href={ticket.url}
              target="_blank"
              rel="noreferrer"
              className={buttonVariants({ variant: "ghost", size: "icon", className: ICON_BUTTON })}
              aria-label={copy.newTab}
              title={copy.newTab}
            >
              <ExternalLink className="size-4" aria-hidden="true" />
            </a>
          )}
        </div>
        {ticket ? (
          <iframe
            key={ticket.url}
            title={copy.frame}
            src={ticket.url}
            sandbox={FRAME_SANDBOX}
            referrerPolicy="no-referrer"
            className="min-h-0 w-full flex-1 border-0 bg-white"
          />
        ) : (
          <div className="min-h-0 flex-1 p-4">
            {opening && (
              <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
                <LoaderCircle
                  className="size-3.5 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
                {copy.opening}
              </p>
            )}
            {failure && (
              <p role="alert" className="break-words text-sm text-destructive-text">
                {failure}
              </p>
            )}
          </div>
        )}
        <p className="shrink-0 border-t border-border/60 px-3 py-1.5 text-[11px] leading-4 text-muted-foreground">
          {copy.remoteNote} {copy.blank}
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
                  onClick={() => void open(item)}
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
