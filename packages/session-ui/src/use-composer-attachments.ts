import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { UploadedAttachment, WebClient } from "@agentkib/web-client";

type ComposerAttachment = {
  key: string;
  name: string;
  file?: File;
  percent: number;
  result?: UploadedAttachment;
  failed?: boolean;
  previewUrl?: string;
};

export function useComposerAttachments({
  client,
  sessionId,
  authority,
  granted,
  canUpload,
  onError,
  copy,
}: {
  client: Pick<WebClient, "uploadAttachment" | "request">;
  sessionId: string;
  authority: object;
  granted: boolean;
  canUpload: boolean;
  onError: (value: string) => void;
  copy: { limit: string; uploadFailed: string; error: string };
}) {
  const [uploads, setUploads] = useState<ComposerAttachment[]>([]);
  const [previewKey, setPreviewKey] = useState<string>();
  const previewUrls = useRef(new Map<string, string>());
  const active = useRef(new Map<string, AbortController>());
  const count = useRef(0);
  const generation = useRef(0);

  const releaseFiles = useCallback(() => {
    generation.current++;
    for (const abort of active.current.values()) abort.abort();
    active.current.clear();
    for (const url of previewUrls.current.values()) URL.revokeObjectURL(url);
    previewUrls.current.clear();
    count.current = 0;
  }, []);

  const clear = useCallback(() => {
    releaseFiles();
    setUploads([]);
    setPreviewKey(undefined);
  }, [releaseFiles]);

  useLayoutEffect(() => {
    setUploads([]);
    setPreviewKey(undefined);
    return releaseFiles;
  }, [sessionId, authority, granted, releaseFiles]);

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

  function keepUnavailable(files: File[]) {
    clear();
    count.current = files.length;
    setUploads(
      files.map((file) => ({
        key: crypto.randomUUID(),
        name: file.name,
        file,
        percent: 0,
        failed: true,
      })),
    );
  }

  function add(files: File[]) {
    if (!canUpload) return;
    onError("");
    for (const file of files) {
      if (count.current >= 10) {
        onError(copy.limit);
        break;
      }
      count.current++;
      const key = crypto.randomUUID();
      const abort = new AbortController();
      // Preview only local raster files. Documents and SVG remain ordinary attachments.
      const previewUrl =
        ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type) &&
        typeof URL.createObjectURL === "function"
          ? URL.createObjectURL(file)
          : undefined;
      if (previewUrl) previewUrls.current.set(key, previewUrl);
      active.current.set(key, abort);
      setUploads((items) => [...items, { key, name: file.name, file, percent: 0, previewUrl }]);
      void client
        .uploadAttachment(
          sessionId,
          file,
          (percent) => {
            if (!abort.signal.aborted)
              setUploads((items) =>
                items.map((item) => (item.key === key ? { ...item, percent } : item)),
              );
          },
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
            onError(copy.uploadFailed);
          }
        })
        .finally(() => active.current.delete(key));
    }
  }

  async function remove(item: ComposerAttachment) {
    const requestGeneration = generation.current;
    active.current.get(item.key)?.abort();
    active.current.delete(item.key);
    releasePreview(item.key);
    count.current = Math.max(0, count.current - 1);
    setUploads((items) => items.filter((entry) => entry.key !== item.key));
    if (item.result) {
      try {
        await client.request("attachments/delete", {
          sessionId,
          attachmentId: item.result.id,
          version: item.result.version,
        });
      } catch {
        if (requestGeneration === generation.current) onError(copy.error);
      }
    }
  }

  const preview = uploads.find((item) => item.key === previewKey && item.previewUrl);
  return {
    uploads,
    add,
    remove,
    keepUnavailable,
    clear,
    preview,
    setPreviewKey,
    unavailablePreview,
  };
}
