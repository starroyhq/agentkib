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
  messageImageCache,
  messageImageScope,
  type MessageImageLoader,
} from "./message-image-cache";
export type { MessageImageLoader } from "./message-image-cache";

export interface MessageImage {
  id: string;
  mimeType?: string;
  name?: string;
}
export interface MessageImagePreview {
  src: string;
  name: string;
  onClose: () => void;
}

const copies = {
  "zh-CN": {
    image: "图片",
    loading: "正在读取图片",
    unavailable: "图片不可用",
    retry: "重试图片",
    preview: "查看图片",
    close: "关闭",
  },
  "zh-TW": {
    image: "圖片",
    loading: "正在讀取圖片",
    unavailable: "圖片無法使用",
    retry: "重試圖片",
    preview: "檢視圖片",
    close: "關閉",
  },
  "en-US": {
    image: "Image",
    loading: "Loading image",
    unavailable: "Image unavailable",
    retry: "Retry image",
    preview: "View image",
    close: "Close",
  },
  "ja-JP": {
    image: "画像",
    loading: "画像を読み込み中",
    unavailable: "画像を表示できません",
    retry: "画像を再読み込み",
    preview: "画像を表示",
    close: "閉じる",
  },
};
export function conversationImageCopy(locale: string) {
  return copies[locale as keyof typeof copies] ?? copies["en-US"];
}

function ImageThumbnail({
  image,
  load,
  locale,
  renderPreview,
}: {
  image: MessageImage;
  load: MessageImageLoader;
  locale: string;
  renderPreview: (preview: MessageImagePreview) => ReactNode;
}) {
  const container = useRef<HTMLDivElement>(null);
  const cacheScope = messageImageScope(load);
  const scope = useMemo(() => ({ id: image.id, cacheScope }), [image.id, cacheScope]);
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
  const copy = conversationImageCopy(locale);
  const name = image.name || copy.image;
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
    // Leaving the viewport unpins media without replacing a warm <img>. Only
    // eviction withdraws it; a newly mounted DOM must still report its own load.
    return messageImageCache.acquire(scope.cacheScope, scope.id, load);
  }, [active, failed, scope, load, retry]);
  return (
    <div
      ref={container}
      className="min-w-0"
      data-message-image-pending={!imageDecoded ? "true" : undefined}
    >
      <button
        type="button"
        className="relative flex h-28 w-36 max-w-full items-center justify-center overflow-hidden rounded-xl border border-border bg-muted text-center text-xs text-foreground transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
        aria-label={`${error ? copy.retry : copy.preview}: ${name}`}
        aria-busy={
          active && (current.phase === "loading" || (current.phase === "ready" && !imageDecoded))
            ? true
            : undefined
        }
        onClick={() => {
          if (current.phase === "ready" && imageDecoded)
            setPreviewScope({ scope, resource: current });
          else if (error || current.phase === "idle") {
            setFailed(undefined);
            setRetry((value) => value + 1);
            messageImageCache.retry(scope.cacheScope, scope.id, load);
            setVisible(true);
          } else setVisible(true);
        }}
      >
        {current.phase === "ready" ? (
          <img
            src={current.src}
            alt={name}
            className="size-full object-cover"
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
        ) : (
          <span className="grid min-w-0 gap-1 p-2">
            <span className="font-medium">
              {error ? copy.unavailable : active ? copy.loading : copy.image}
            </span>
            {image.name && <span className="max-w-32 truncate text-muted-foreground">{name}</span>}
            {error && <span className="underline">{copy.retry}</span>}
          </span>
        )}
      </button>
      {preview &&
        current.phase === "ready" &&
        renderPreview({ src: current.src, name, onClose: () => setPreviewScope(undefined) })}
    </div>
  );
}

/** Only native attachment references are loaded; Markdown URLs stay inert. */
export function ConversationImages({
  images,
  load,
  locale,
  align = "end",
  renderPreview,
}: {
  images: readonly MessageImage[];
  load: MessageImageLoader;
  locale: string;
  align?: "start" | "end";
  renderPreview: (preview: MessageImagePreview) => ReactNode;
}) {
  return (
    <div
      className={`not-prose mb-2 flex max-w-full flex-wrap gap-2 ${align === "start" ? "justify-start" : "justify-end"}`}
    >
      {images.map((image) => (
        <ImageThumbnail
          key={image.id}
          image={image}
          load={load}
          locale={locale}
          renderPreview={renderPreview}
        />
      ))}
    </div>
  );
}
