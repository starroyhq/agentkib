import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ExternalLink } from "lucide-react";
import {
  ApiError,
  localPreviewLabel,
  type LivePreviewTicket,
  type LocalPreviewTarget,
} from "@agentkib/web-client";
import { Button, buttonVariants } from "./components/ui/button";
import {
  LivePreviewFrame,
  LivePreviewPicker,
  LoadingSkeleton,
  livePreviewCopy,
  type LivePreviewProps,
} from "@agentkib/session-ui";

const ICON_BUTTON = "size-8 shrink-0 rounded-md text-muted-foreground";

/**
 * Pages served on the computer running AgentKib. Each opened page gets a ticket from the host,
 * which shows it through the isolated preview origin; reloading asks for a new one.
 */
export function LivePreview({ client, page, live, locale }: LivePreviewProps) {
  const copy = livePreviewCopy(locale, "web");
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
          <LivePreviewFrame
            key={ticket.url}
            title={copy.frame}
            url={ticket.url}
            openingLabel={copy.opening}
            timeoutHint={copy.blank}
            retryLabel={copy.reload}
            onRetry={() => void open(target)}
          />
        ) : (
          <div className="min-h-0 flex-1 p-4">
            {opening && <LoadingSkeleton label={copy.opening} layout="code" rows={5} />}
            {failure && (
              <div className="flex flex-wrap items-center gap-2">
                <p role="alert" className="break-words text-sm text-destructive-text">
                  {failure}
                </p>
                <Button variant="outline" size="sm" onClick={() => void open(target)}>
                  {copy.reload}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    );
  return (
    <LivePreviewPicker
      locale={locale}
      surface="web"
      page={page}
      live={live}
      address={address}
      invalid={invalid}
      onAddressChange={setAddress}
      onInvalidChange={setInvalid}
      onOpen={open}
    />
  );
}
