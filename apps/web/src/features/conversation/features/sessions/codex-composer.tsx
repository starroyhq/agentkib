import { HistoryReferenceChips } from "../history/history-search-controls";
import { validHistoryMessage } from "../history/history-reference-model";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { ArrowUp, Square, X } from "lucide-react";
import { type UploadedAttachment } from "@agentkib/web-client";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/dialog";
import { Textarea } from "../../components/ui/textarea";
import { useSession } from "./session-context";
import { ContextUsageGauge } from "./context-usage";
import { contextUsageCopyForSurface } from "./context-usage-copy";
import { sessionDisplayState } from "./session-display-state";
import { composerLayoutCopy } from "./composer-layout-copy";
import { codexCopyForSurface, codexReason } from "./codex-copy";
import { MAX_MESSAGE_LENGTH } from "./session-model";
import { CodexComposerControls, type CodexResource } from "./codex-session-controls";
import { PermissionModeNotice } from "./permission-mode-notice";

type Upload = {
  key: string;
  name: string;
  percent: number;
  result?: UploadedAttachment;
  failed?: boolean;
  previewUrl?: string;
};
export function CodexComposer() {
  const session = useSession();
  const {
    historyReferences = [],
    setHistoryReferences,
    selected,
    current,
    live,
    client,
    access,
    locale,
    t,
    message,
    setMessage,
    control,
    codexAction,
    capabilities,
    canSend,
    canStop,
    busy,
    online,
    controlReady,
    notice,
  } = session;
  const isClaude = current?.agent === "claude-code";
  const copy = codexCopyForSurface(locale, "web");
  const layout = composerLayoutCopy[locale];
  const display = sessionDisplayState(session, "web");
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!textarea.current) return;
    textarea.current.style.height = "auto";
    textarea.current.style.height = `${Math.min(160, Math.max(64, textarea.current.scrollHeight))}px`;
  }, [message]);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");
  const [resources, setResources] = useState<CodexResource[]>([]);
  const [previewKey, setPreviewKey] = useState<string>();
  const previewUrls = useRef(new Map<string, string>());
  const active = useRef(new Map<string, AbortController>());
  const fileInput = useRef<HTMLInputElement>(null);
  const count = useRef(0);
  const generation = useRef(0);
  const uploadPermission = !!(
    access?.device?.attachments &&
    capabilities?.sessionId === selected &&
    capabilities.features.attachments?.available
  );
  useEffect(() => {
    const controllers = active.current;
    const urls = previewUrls.current;
    setUploads([]);
    setResources([]);
    setSubmitted(false);
    setError("");
    setPreviewKey(undefined);
    count.current = 0;
    return () => {
      generation.current++;
      for (const abort of controllers.values()) abort.abort();
      controllers.clear();
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, [selected]);
  useEffect(() => {
    if (access?.device?.attachments) return;
    for (const abort of active.current.values()) abort.abort();
    active.current.clear();
    for (const url of previewUrls.current.values()) URL.revokeObjectURL(url);
    previewUrls.current.clear();
    setPreviewKey(undefined);
    count.current = 0;
    setUploads([]);
  }, [access?.device?.attachments]);
  useEffect(() => {
    if (!submitted) return;
    if (notice === "accepted") {
      for (const url of previewUrls.current.values()) URL.revokeObjectURL(url);
      previewUrls.current.clear();
      setPreviewKey(undefined);
      setUploads([]);
      setResources([]);
      setHistoryReferences?.([]);
      count.current = 0;
      setMessage("");
      setSubmitted(false);
    } else if (notice === "notDispatched") setSubmitted(false);
  }, [notice, submitted, setMessage, setHistoryReferences]);
  function releasePreview(key: string) {
    const url = previewUrls.current.get(key);
    if (url) URL.revokeObjectURL(url);
    previewUrls.current.delete(key);
    setPreviewKey((current) => (current === key ? undefined : current));
  }
  function unavailablePreview(key: string) {
    releasePreview(key);
    setUploads((items) =>
      items.map((item) => (item.key === key ? { ...item, previewUrl: undefined } : item)),
    );
  }
  async function add(files: File[]) {
    if (!uploadPermission || busy || submitted) return;
    setError("");
    for (const file of files) {
      if (count.current >= 10) {
        setError(copy.limit);
        break;
      }
      count.current++;
      const key = crypto.randomUUID();
      const abort = new AbortController();
      // Only local raster files are rendered, through <img>. Documents and SVG
      // remain ordinary attachments; no remote URL or executable preview is opened.
      const previewUrl =
        ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type) &&
        typeof URL.createObjectURL === "function"
          ? URL.createObjectURL(file)
          : undefined;
      if (previewUrl) previewUrls.current.set(key, previewUrl);
      active.current.set(key, abort);
      setUploads((items) => [...items, { key, name: file.name, percent: 0, previewUrl }]);
      void client
        .uploadAttachment(
          selected,
          file,
          (percent) =>
            setUploads((items) =>
              items.map((item) => (item.key === key ? { ...item, percent } : item)),
            ),
          abort.signal,
        )
        .then((result) => {
          if (!abort.signal.aborted)
            setUploads((items) =>
              items.map((item) => (item.key === key ? { ...item, percent: 100, result } : item)),
            );
        })
        .catch(() => {
          if (!abort.signal.aborted) {
            releasePreview(key);
            setUploads((items) =>
              items.map((item) =>
                item.key === key ? { ...item, failed: true, previewUrl: undefined } : item,
              ),
            );
            setError(copy.uploadFailed);
          }
        })
        .finally(() => active.current.delete(key));
    }
  }
  async function remove(item: Upload) {
    const requestGeneration = generation.current;
    active.current.get(item.key)?.abort();
    active.current.delete(item.key);
    releasePreview(item.key);
    count.current = Math.max(0, count.current - 1);
    setUploads((items) => items.filter((entry) => entry.key !== item.key));
    if (item.result) {
      try {
        await client.request("attachments/delete", {
          sessionId: selected,
          attachmentId: item.result.id,
          version: item.result.version,
        });
      } catch {
        if (requestGeneration === generation.current) setError(copy.error);
      }
    }
  }
  const ready = uploads.every((item) => !!item.result);
  const attachmentIds = uploads.flatMap((item) => (item.result ? [item.result.id] : []));
  const resourceIds = resources.map((item) => item.id);
  const valid = ready && validHistoryMessage(message, historyReferences, attachmentIds.length > 0);
  const resourceNeedsMessage =
    resourceIds.length > 0 && !message.trim() && !attachmentIds.length && !historyReferences.length;
  async function send(action: "send" | "steer" | "queue-add") {
    if (!valid || busy || submitted || (live?.activity === "compacting" && action !== "queue-add"))
      return;
    const requestGeneration = generation.current;
    setSubmitted(true);
    const result =
      action === "send"
        ? await control("send", undefined, undefined, undefined, undefined, {
            attachmentIds,
            ...(resourceIds.length ? { resourceIds } : {}),
          })
        : await codexAction(action, {
            text: message.trim(),
            ...(historyReferences.length
              ? { historyReferences: historyReferences.map((item) => item.reference) }
              : {}),
            ...(attachmentIds.length ? { attachmentIds } : {}),
            ...(resourceIds.length ? { resourceIds } : {}),
            ...(action === "steer" ? { turnId: live?.turnId } : {}),
          });
    if (result && requestGeneration === generation.current) {
      for (const url of previewUrls.current.values()) URL.revokeObjectURL(url);
      previewUrls.current.clear();
      setPreviewKey(undefined);
      setUploads([]);
      setResources([]);
      setHistoryReferences?.([]);
      count.current = 0;
      setMessage("");
      setSubmitted(false);
    }
  }
  const preview = uploads.find((item) => item.key === previewKey && item.previewUrl);
  const compacting = live?.activity === "compacting";
  const running = live?.status === "running";
  const connectionToastId = useId();
  const connectionFailure =
    !canSend &&
    !running &&
    !compacting &&
    display.reason === codexReason(locale, "codex-connection-failed", "web").text;
  useEffect(() => {
    if (!connectionFailure) return;
    toast.error(display.reason, { id: connectionToastId });
    return () => {
      toast.dismiss(connectionToastId);
    };
  }, [connectionFailure, connectionToastId, display.reason, selected]);
  const canAdvanced = !!(access?.device?.advancedControl && controlReady && online && !busy);
  const primaryAction = canStop ? (
    <Button
      type="button"
      variant="destructive"
      className="size-11 shrink-0 p-0"
      aria-label={t.stop}
      onClick={() => void control("stop")}
    >
      <Square size={17} />
    </Button>
  ) : (
    <Button
      className="size-11 shrink-0 p-0"
      aria-label={t.send}
      disabled={!canSend || compacting || !valid || submitted}
    >
      <ArrowUp size={20} />
    </Button>
  );
  return (
    <form
      className="mx-2 mb-[max(.5rem,env(safe-area-inset-bottom))] mt-2 w-[calc(100%-1rem)] max-w-3xl shrink-0 self-center space-y-2 rounded-2xl border bg-card p-2 shadow-sm md:mx-4 md:mb-4 md:w-[calc(100%-2rem)] md:p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSend && !compacting) void send("send");
      }}
    >
      {isClaude && (live?.model || live?.cliVersion) && (
        <p className="px-1 text-xs text-muted-foreground">
          {[live.model, live.cliVersion && `Claude Code ${live.cliVersion}`]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}
      {isClaude && <PermissionModeNotice permission={live?.permission} locale={locale} />}
      <label className="sr-only" htmlFor="message">
        {t.message}
      </label>
      <Textarea
        ref={textarea}
        id="message"
        className="min-h-16 max-h-40 resize-none overflow-y-auto border-0 shadow-none"
        value={message}
        maxLength={MAX_MESSAGE_LENGTH}
        onChange={(event) => setMessage(event.target.value)}
        placeholder={t.message}
        disabled={!online || busy || submitted}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.files);
          if (files.length && uploadPermission) {
            event.preventDefault();
            void add(files);
          }
        }}
      />
      <HistoryReferenceChips />
      {uploads.length > 0 && (
        <ul className="space-y-2">
          {uploads.map((item) => (
            <li key={item.key} className="flex items-center gap-2 text-xs">
              {item.previewUrl && (
                <Button
                  type="button"
                  variant="outline"
                  className="size-11 shrink-0 overflow-hidden p-0"
                  aria-label={`${copy.previewAttachment}: ${item.name}`}
                  onClick={() => setPreviewKey(item.key)}
                >
                  <img
                    src={item.previewUrl}
                    alt=""
                    className="size-full object-cover"
                    onError={() => unavailablePreview(item.key)}
                  />
                </Button>
              )}
              <span className="min-w-0 flex-1 truncate">{item.name}</span>
              <span role="status">
                {item.failed
                  ? copy.uploadFailed
                  : item.result
                    ? "100%"
                    : `${copy.uploading} ${item.percent}%`}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="size-11 shrink-0 p-0"
                aria-label={`${copy.remove}: ${item.name}`}
                disabled={busy || submitted}
                onClick={() => void remove(item)}
              >
                <X size={14} />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {preview?.previewUrl && (
        <Dialog
          title={`${copy.previewAttachment}: ${preview.name}`}
          closeLabel={copy.close}
          onClose={() => setPreviewKey(undefined)}
        >
          <img
            src={preview.previewUrl}
            alt={preview.name}
            className="mx-auto max-h-[65dvh] max-w-full object-contain"
            onError={() => unavailablePreview(preview.key)}
          />
        </Dialog>
      )}
      {resourceNeedsMessage && (
        <p role="status" className="text-sm text-muted-foreground">
          {layout.resourceNeedsMessage}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive-text">
          {error}
        </p>
      )}
      <div className="space-y-2">
        <input
          ref={fileInput}
          className="hidden"
          type="file"
          multiple
          aria-label={copy.attachment}
          disabled={!uploadPermission || busy || submitted}
          onChange={(event) => {
            void add(Array.from(event.target.files ?? []));
            event.target.value = "";
          }}
        />
        {access?.device?.accessMode === "full" && (
          <CodexComposerControls
            resources={resources}
            setResources={setResources}
            openPhoneFiles={() => fileInput.current?.click()}
            disabled={busy || submitted || !online}
            action={primaryAction}
          />
        )}
        {access?.device?.accessMode !== "full" && (
          <div className="flex min-w-0 items-center justify-between gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="min-h-11"
              disabled={!uploadPermission || busy || submitted}
              title={
                uploadPermission
                  ? copy.attachmentNote
                  : capabilities?.features.attachments?.reason
                    ? codexReason(locale, capabilities.features.attachments.reason, "web").text
                    : copy.permission
              }
              onClick={() => fileInput.current?.click()}
            >
              {copy.attachment}
            </Button>
            <div className="flex min-w-0 items-center gap-1">
              <ContextUsageGauge />
              {primaryAction}
            </div>
          </div>
        )}
        {(running || compacting) &&
          (!isClaude ||
            capabilities?.features.steer?.available ||
            capabilities?.features["queue-add"]?.available) && (
            <div className="space-y-2 border-t pt-2">
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  className="min-h-11"
                  variant="outline"
                  disabled={
                    compacting ||
                    !canAdvanced ||
                    !capabilities?.features.steer?.available ||
                    !valid ||
                    submitted
                  }
                  onClick={() => void send("steer")}
                >
                  {copy.steer}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="min-h-11"
                  variant="outline"
                  disabled={
                    !canAdvanced ||
                    !capabilities?.features["queue-add"]?.available ||
                    !valid ||
                    submitted
                  }
                  onClick={() => void send("queue-add")}
                >
                  {copy.queueAdd}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">{layout.queue}</p>
            </div>
          )}
      </div>
      {compacting && (
        <p role="status" className="px-1 text-xs leading-5 text-muted-foreground">
          {contextUsageCopyForSurface(locale, "web").compactingDetail}
        </p>
      )}
      {!canSend && !running && !compacting && !connectionFailure && !display.loading && (
        <p role="status" className="px-1 text-xs leading-5 text-muted-foreground">
          {display.reason}
        </p>
      )}
      {!isClaude && access?.device?.accessMode !== "full" && (
        <details className="px-1 text-xs text-muted-foreground">
          <summary className="min-h-11 cursor-pointer content-center">{layout.help}</summary>
          <p className="pb-2 leading-5">{copy.composerHint}</p>
        </details>
      )}
    </form>
  );
}
