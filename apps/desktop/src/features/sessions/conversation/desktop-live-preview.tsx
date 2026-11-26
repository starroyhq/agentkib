import { useState } from "react";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { localPreviewLabel, type LocalPreviewTarget } from "@agentkib/web-client";
import { Button } from "@/components/ui/button";
import { api } from "@/core/api";
import {
  LivePreviewFrame,
  LivePreviewPicker,
  livePreviewCopy,
  type LivePreviewProps,
} from "@agentkib/session-ui";

/** Pages served on this computer, shown directly: the desktop app runs where the server runs. */
export function LivePreview({ page, live, locale }: LivePreviewProps) {
  const copy = livePreviewCopy(locale);
  const [target, setTarget] = useState<LocalPreviewTarget>();
  const [address, setAddress] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [revision, setRevision] = useState(0);
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
            aria-label={copy.external}
            title={copy.external}
            onClick={() => void api.openExternal(target.url).catch(() => {})}
          >
            <ExternalLink className="size-4" aria-hidden="true" />
          </Button>
        </div>
        <LivePreviewFrame
          key={revision}
          title={copy.frame}
          url={target.url}
          openingLabel={copy.opening}
          timeoutHint={copy.blank}
          retryLabel={copy.reload}
          onRetry={() => setRevision((value) => value + 1)}
        />
      </div>
    );
  return (
    <LivePreviewPicker
      locale={locale}
      surface="desktop"
      page={page}
      live={live}
      address={address}
      invalid={invalid}
      onAddressChange={setAddress}
      onInvalidChange={setInvalid}
      onOpen={setTarget}
    />
  );
}
