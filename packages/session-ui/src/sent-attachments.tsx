import type { ConversationSentAttachment } from "@agentkib/web-client";
import { RotateCw } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  AttachmentFilename,
  AttachmentTypeIcon,
  classifyAttachmentFile,
} from "./composer-attachments";
import {
  conversationImageCopy,
  type MessageImageLoader,
  type MessageImagePreview,
} from "./conversation-images";
import { useDelayedBusy } from "./delayed-busy";
import { messageImageCache, messageImageScope } from "./message-image-cache";

const sentAttachmentCopies = {
  "zh-CN": {
    listLabel: "已发送的附件",
    retry: "重试",
  },
  "zh-Hant": {
    listLabel: "已傳送的附件",
    retry: "重試",
  },
  "en-US": {
    listLabel: "Sent attachments",
    retry: "Retry",
  },
  "ja-JP": {
    listLabel: "送信済みの添付ファイル",
    retry: "再試行",
  },
} as const;

export function sentAttachmentCopy(locale: string) {
  return (
    sentAttachmentCopies[locale as keyof typeof sentAttachmentCopies] ??
    sentAttachmentCopies["en-US"]
  );
}

function formatScaledUnit(value: number, unit: string): string {
  const fixed = value < 10 ? value.toFixed(1).replace(/\.0$/, "") : String(Math.round(value));
  return `${fixed} ${unit}`;
}

export function formatAttachmentSize(bytes: number): string | undefined {
  if (!Number.isFinite(bytes) || bytes <= 0) return undefined;
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return formatScaledUnit(kib, "KB");
  const mib = kib / 1024;
  if (mib < 1024) return formatScaledUnit(mib, "MB");
  return formatScaledUnit(mib / 1024, "GB");
}

function SentFileCardBody({
  attachment,
  muted = false,
  retryLabel,
}: {
  attachment: ConversationSentAttachment;
  muted?: boolean;
  retryLabel?: string;
}) {
  const classification = useMemo(
    () => classifyAttachmentFile(attachment.name, attachment.mimeType),
    [attachment.name, attachment.mimeType],
  );
  const sizeLabel = formatAttachmentSize(attachment.size);

  return (
    <div className="flex size-full flex-col overflow-hidden rounded-[11px] bg-background">
      <div
        aria-hidden={retryLabel ? undefined : "true"}
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 bg-muted/35 px-2"
      >
        <AttachmentTypeIcon
          kind={classification.icon}
          className={`size-6 @max-[28rem]:size-5 ${
            muted ? "text-muted-foreground opacity-60" : classification.accentClass
          }`}
        />
        {retryLabel ? (
          <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-border/80 bg-background px-1.5 py-0.5 text-[10px] font-medium leading-none text-foreground shadow-xs">
            <RotateCw className="size-2.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{retryLabel}</span>
          </span>
        ) : (
          (classification.badge || sizeLabel) && (
            <div
              className={`flex max-w-full flex-col items-center gap-0.5 ${
                muted ? "opacity-60" : ""
              }`}
            >
              {classification.badge && (
                <span className="rounded bg-foreground/[0.07] px-1.5 py-0.5 text-[9px] font-semibold leading-none tracking-wide text-muted-foreground">
                  {classification.badge}
                </span>
              )}
              {sizeLabel && (
                <span className="max-w-full truncate text-[9px] leading-none tabular-nums text-muted-foreground/85">
                  {sizeLabel}
                </span>
              )}
            </div>
          )
        )}
      </div>
      <div
        className={`flex h-6 shrink-0 items-center gap-1 border-t border-border/60 bg-background/95 px-1.5 ${
          muted ? "opacity-80" : ""
        }`}
      >
        <AttachmentTypeIcon
          kind={classification.icon}
          className={`size-3 shrink-0 ${
            muted ? "text-muted-foreground" : classification.accentClass
          }`}
        />
        <AttachmentFilename name={attachment.name} />
      </div>
    </div>
  );
}

function SentFileAttachmentCard({
  attachment,
  unavailable,
}: {
  attachment: ConversationSentAttachment;
  unavailable: boolean;
}) {
  const sizeLabel = formatAttachmentSize(attachment.size);
  const accessibleLabel = sizeLabel ? `${attachment.name} · ${sizeLabel}` : attachment.name;

  return (
    <li
      data-slot="sent-attachment-card"
      data-sent-attachment-state={unavailable ? "unavailable" : "file"}
      aria-label={accessibleLabel}
      title={attachment.name}
      className="relative size-[104px] shrink-0 @max-[28rem]:size-20"
    >
      <div
        className={`relative size-full overflow-hidden rounded-xl border shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-colors ${
          unavailable
            ? "border-dashed border-border/75 bg-background/80"
            : "border-border/80 bg-background"
        }`}
      >
        <SentFileCardBody attachment={attachment} muted={unavailable} />
      </div>
    </li>
  );
}

function SentImageAttachmentCard({
  attachment,
  imageId,
  load,
  locale,
  renderPreview,
}: {
  attachment: ConversationSentAttachment;
  imageId: string;
  load: MessageImageLoader;
  locale: string;
  renderPreview: (preview: MessageImagePreview) => ReactNode;
}) {
  const container = useRef<HTMLLIElement>(null);
  const cacheScope = messageImageScope(load);
  const scope = useMemo(() => ({ id: imageId, cacheScope }), [imageId, cacheScope]);
  const [visible, setVisible] = useState(
    () =>
      typeof IntersectionObserver === "undefined" ||
      messageImageCache.snapshot(scope.cacheScope, scope.id).phase === "ready",
  );
  const [failed, setFailed] = useState<typeof scope>();
  const subscribe = useCallback(
    (listener: () => void) =>
      messageImageCache.subscribe(scope.cacheScope, scope.id, (reason) => {
        if (reason) setFailed(scope);
        listener();
      }),
    [scope],
  );
  const snapshot = useCallback(
    () => messageImageCache.snapshot(scope.cacheScope, scope.id),
    [scope],
  );
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  const [decoded, setDecoded] = useState<typeof current>();
  const [attempted, setAttempted] = useState<typeof scope>();
  const [retry, setRetry] = useState(0);
  const [previewScope, setPreviewScope] = useState<{
    scope: typeof scope;
    resource: typeof current;
  }>();
  const preview =
    previewScope?.scope === scope && previewScope.resource === current && current.phase === "ready";
  const active = visible || preview;
  if (current.phase !== "idle" && attempted !== scope) setAttempted(scope);
  if (current.phase === "error" && failed !== scope) setFailed(scope);
  if (current.phase === "ready" && failed === scope) setFailed(undefined);
  const error =
    current.phase === "error" ||
    (current.phase === "idle" && (failed === scope || attempted === scope));
  const imageDecoded = current.phase === "ready" && decoded === current;
  const loading = active && !error && !imageDecoded;
  const showSkeleton = useDelayedBusy(loading);
  const imageCopy = conversationImageCopy(locale);
  const copy = sentAttachmentCopy(locale);
  const name = attachment.name || imageCopy.image;

  useEffect(() => {
    const target = container.current;
    if (!target || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => setVisible(entries.some((entry) => entry.isIntersecting)),
      { rootMargin: "200px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!active || failed === scope) return;
    return messageImageCache.acquire(scope.cacheScope, scope.id, load);
  }, [active, failed, scope, load, retry]);

  const cardState = error ? "retry" : imageDecoded ? "image" : "loading";

  return (
    <li
      ref={container}
      data-slot="sent-attachment-card"
      data-sent-attachment-state={cardState}
      data-message-image-pending={!imageDecoded ? "true" : undefined}
      className="group/sent-attachment relative size-[104px] shrink-0 @max-[28rem]:size-20"
    >
      <button
        type="button"
        title={name}
        aria-label={`${error ? imageCopy.retry : imageCopy.preview}: ${name}`}
        aria-busy={loading || undefined}
        aria-description={showSkeleton ? imageCopy.loading : undefined}
        className={`relative block size-full overflow-hidden rounded-xl border bg-background text-left shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
          error
            ? "border-dashed border-border/80 hover:border-foreground/30"
            : "border-border/80 bg-muted/20 hover:border-foreground/30"
        }`}
        onClick={() => {
          if (current.phase === "ready" && imageDecoded) {
            setPreviewScope({ scope, resource: current });
          } else if (error || current.phase === "idle") {
            setFailed(undefined);
            setRetry((value) => value + 1);
            messageImageCache.retry(scope.cacheScope, scope.id, load);
            setVisible(true);
          } else {
            setVisible(true);
          }
        }}
      >
        {current.phase === "ready" ? (
          <img
            src={current.src}
            alt={name}
            className={`size-full object-cover transition-[opacity,transform] duration-150 group-hover/sent-attachment:scale-[1.02] motion-reduce:transition-none ${
              imageDecoded ? "opacity-100" : "opacity-0"
            }`}
            onLoad={() => {
              if (snapshot() === current) setDecoded(current);
            }}
            onError={() => {
              if (snapshot() !== current) return;
              setPreviewScope(undefined);
              setFailed(scope);
              messageImageCache.invalidate(scope.cacheScope, scope.id);
            }}
          />
        ) : error ? (
          <SentFileCardBody attachment={attachment} muted retryLabel={copy.retry} />
        ) : !active ? (
          <SentFileCardBody attachment={attachment} />
        ) : null}
        {showSkeleton && (
          <span
            className="pointer-events-none absolute inset-0 animate-pulse rounded-[inherit] bg-border motion-reduce:animate-none"
            aria-hidden="true"
          />
        )}
      </button>
      {preview &&
        current.phase === "ready" &&
        renderPreview({
          src: current.src,
          name,
          onClose: () => setPreviewScope(undefined),
        })}
    </li>
  );
}

export interface SentAttachmentStripProps {
  attachments: readonly ConversationSentAttachment[];
  load?: MessageImageLoader;
  locale: string;
  align?: "start" | "end";
  renderPreview: (preview: MessageImagePreview) => ReactNode;
}

export function SentAttachmentStrip({
  attachments,
  load,
  locale,
  align = "end",
  renderPreview,
}: SentAttachmentStripProps) {
  if (!attachments.length) return null;
  const copy = sentAttachmentCopy(locale);

  return (
    <ul
      role="list"
      aria-label={copy.listLabel}
      data-slot="sent-attachment-strip"
      className={`not-prose m-0 mb-2 flex max-w-full list-none flex-wrap gap-2 p-0 ${
        align === "start" ? "justify-start" : "justify-end"
      }`}
    >
      {attachments.map((attachment, index) => {
        const key = `${attachment.imageId ?? attachment.name}:${index}`;
        if (attachment.kind === "image" && attachment.available && attachment.imageId && load) {
          return (
            <SentImageAttachmentCard
              key={key}
              attachment={attachment}
              imageId={attachment.imageId}
              load={load}
              locale={locale}
              renderPreview={renderPreview}
            />
          );
        }
        return (
          <SentFileAttachmentCard
            key={key}
            attachment={attachment}
            unavailable={!attachment.available || attachment.kind === "image"}
          />
        );
      })}
    </ul>
  );
}
