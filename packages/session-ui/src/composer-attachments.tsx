import {
  AlertCircle,
  File,
  FileArchive,
  FileAudio,
  FileCode2,
  FileJson,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Image as ImageIcon,
  RotateCw,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ContextUsageRing } from "./context-usage-ring";
import { useDelayedBusy } from "./delayed-busy";
import type { InteractionLocale } from "./interaction-model";

export const COMPOSER_ATTACHMENT_PREVIEW_MAX_BYTES = 32 * 1024;
const PREVIEWABLE_RASTER_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_TABLE_ROWS = 6;
const MAX_TABLE_COLS = 4;
const MAX_TEXT_LINES = 9;
const MAX_LINE_CHARS = 72;

export type ComposerAttachmentCardItem = {
  key: string;
  name: string;
  file?: File;
  previewUrl?: string;
  uploading?: boolean;
  percent?: number;
  failed?: boolean;
};

export type ComposerAttachmentStripCopy = {
  listLabel: string;
  preview: string;
  uploading: string;
  uploadFailed: string;
  retry: string;
  remove: (name: string) => string;
};

export type AttachmentIconKind =
  | "table"
  | "code"
  | "json"
  | "text"
  | "pdf"
  | "word"
  | "presentation"
  | "archive"
  | "audio"
  | "video"
  | "image"
  | "file";

export type AttachmentFileClassification = {
  previewMode: "table" | "text" | "icon";
  delimiter?: "," | "\t";
  mono?: boolean;
  icon: AttachmentIconKind;
  badge?: string;
  accentClass: string;
};

export type AttachmentContentPreview =
  | { kind: "table"; rows: string[][] }
  | { kind: "text"; lines: string[] };

const composerAttachmentListLabels: Record<InteractionLocale, string> = {
  "zh-CN": "已添加的附件",
  "zh-Hant": "已新增的附件",
  "en-US": "Attachments",
  "ja-JP": "添付ファイル",
};

export function composerAttachmentCopy(locale: InteractionLocale) {
  return {
    listLabel: composerAttachmentListLabels[locale],
  };
}

export function isPreviewableRasterImage(file: Pick<File, "type">): boolean {
  return PREVIEWABLE_RASTER_MIMES.has(file.type);
}

export function splitAttachmentFilename(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1 || name.length - dot > 8) {
    return { stem: name, ext: "" };
  }
  return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

const CODE_EXTENSIONS = new Set([
  "js",
  "jsx",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "mts",
  "cts",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "kts",
  "swift",
  "c",
  "cc",
  "cpp",
  "cxx",
  "h",
  "hpp",
  "cs",
  "php",
  "sh",
  "bash",
  "zsh",
  "fish",
  "ps1",
  "sql",
  "graphql",
  "gql",
  "html",
  "htm",
  "xml",
  "css",
  "scss",
  "sass",
  "less",
  "vue",
  "svelte",
  "astro",
  "dart",
  "lua",
  "r",
  "ex",
  "exs",
  "prisma",
  "proto",
  "tf",
  "hcl",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "env",
  "properties",
  "diff",
  "patch",
  "dockerfile",
  "makefile",
  "gitignore",
  "editorconfig",
]);

const JSON_EXTENSIONS = new Set(["json", "jsonl", "ndjson", "jsonc"]);
const TEXT_EXTENSIONS = new Set(["txt", "md", "markdown", "mdx", "log", "tex", "rst", "adoc"]);
const TEXT_BASENAMES = new Set([
  "readme",
  "license",
  "makefile",
  "dockerfile",
  "procfile",
  "gemfile",
  "rakefile",
]);
const WORD_EXTENSIONS = new Set(["doc", "docx", "odt", "rtf", "pages"]);
const SHEET_EXTENSIONS = new Set(["xls", "xlsx", "ods", "numbers"]);
const SLIDE_EXTENSIONS = new Set(["ppt", "pptx", "odp", "key"]);
const ARCHIVE_EXTENSIONS = new Set(["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "m4a", "flac", "ogg", "aac"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "webm", "mkv", "avi", "m4v"]);
const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "bmp",
  "ico",
  "svg",
  "heic",
]);

export function classifyAttachmentFile(name: string, mime = ""): AttachmentFileClassification {
  const lowerMime = mime.toLowerCase();
  const lowerName = name.toLowerCase();
  const dot = lowerName.lastIndexOf(".");
  const ext = dot > 0 && dot < lowerName.length - 1 ? lowerName.slice(dot + 1) : "";
  const badge = ext && /^[a-z0-9]{1,5}$/.test(ext) ? ext.toUpperCase() : undefined;

  if (ext === "csv" || lowerMime === "text/csv") {
    return {
      previewMode: "table",
      delimiter: ",",
      icon: "table",
      badge: "CSV",
      accentClass: "text-emerald-600 dark:text-emerald-400",
    };
  }
  if (ext === "tsv" || lowerMime === "text/tab-separated-values") {
    return {
      previewMode: "table",
      delimiter: "\t",
      icon: "table",
      badge: "TSV",
      accentClass: "text-emerald-600 dark:text-emerald-400",
    };
  }
  if (ext === "pdf" || lowerMime === "application/pdf") {
    return {
      previewMode: "icon",
      icon: "pdf",
      badge: "PDF",
      accentClass: "text-rose-600 dark:text-rose-400",
    };
  }
  if (SHEET_EXTENSIONS.has(ext)) {
    return {
      previewMode: "icon",
      icon: "table",
      badge: badge ?? "XLS",
      accentClass: "text-emerald-600 dark:text-emerald-400",
    };
  }
  if (WORD_EXTENSIONS.has(ext)) {
    return {
      previewMode: "icon",
      icon: "word",
      badge: badge ?? "DOC",
      accentClass: "text-sky-600 dark:text-sky-400",
    };
  }
  if (SLIDE_EXTENSIONS.has(ext)) {
    return {
      previewMode: "icon",
      icon: "presentation",
      badge: badge ?? "PPT",
      accentClass: "text-amber-600 dark:text-amber-400",
    };
  }
  if (ARCHIVE_EXTENSIONS.has(ext) || lowerMime.includes("zip") || lowerMime.includes("tar")) {
    return {
      previewMode: "icon",
      icon: "archive",
      badge: badge ?? "ZIP",
      accentClass: "text-amber-600 dark:text-amber-400",
    };
  }
  if (AUDIO_EXTENSIONS.has(ext) || lowerMime.startsWith("audio/")) {
    return {
      previewMode: "icon",
      icon: "audio",
      badge,
      accentClass: "text-violet-600 dark:text-violet-400",
    };
  }
  if (VIDEO_EXTENSIONS.has(ext) || lowerMime.startsWith("video/")) {
    return {
      previewMode: "icon",
      icon: "video",
      badge,
      accentClass: "text-violet-600 dark:text-violet-400",
    };
  }
  if (lowerMime.startsWith("image/") || IMAGE_EXTENSIONS.has(ext)) {
    return {
      previewMode: "icon",
      icon: "image",
      badge,
      accentClass: "text-sky-600 dark:text-sky-400",
    };
  }
  if (JSON_EXTENSIONS.has(ext) || lowerMime === "application/json") {
    return {
      previewMode: "text",
      mono: true,
      icon: "json",
      badge: badge ?? "JSON",
      accentClass: "text-amber-600 dark:text-amber-400",
    };
  }
  if (
    CODE_EXTENSIONS.has(ext) ||
    lowerMime === "application/javascript" ||
    lowerMime === "application/typescript" ||
    lowerMime === "application/xml" ||
    lowerMime === "application/x-yaml"
  ) {
    return {
      previewMode: "text",
      mono: true,
      icon: "code",
      badge,
      accentClass: "text-sky-600 dark:text-sky-400",
    };
  }
  if (TEXT_EXTENSIONS.has(ext) || TEXT_BASENAMES.has(lowerName) || lowerMime.startsWith("text/")) {
    return {
      previewMode: "text",
      mono: ext === "log",
      icon: "text",
      badge: badge ?? "TXT",
      accentClass: "text-muted-foreground",
    };
  }
  return {
    previewMode: "icon",
    icon: "file",
    badge,
    accentClass: "text-muted-foreground",
  };
}

function hasBinaryBytes(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 0) return true;
  }
  return false;
}

export function parseDelimitedPreview(
  text: string,
  delimiter: "," | "\t",
  maxRows = MAX_TABLE_ROWS,
  maxCols = MAX_TABLE_COLS,
): string[][] | null {
  if (!text || hasBinaryBytes(text)) return null;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  const pushCell = () => {
    if (row.length < maxCols) row.push(field.trim().slice(0, 32));
    field = "";
  };

  const pushRow = () => {
    pushCell();
    if (row.some((cell) => cell.length > 0)) rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length && rows.length < maxRows; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field.length === 0) {
      inQuotes = true;
    } else if (ch === delimiter) {
      pushCell();
    } else if (ch === "\n") {
      pushRow();
    } else if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      pushRow();
    } else {
      field += ch;
    }
  }

  if (rows.length < maxRows && (field.length > 0 || row.length > 0)) {
    pushRow();
  }
  if (!rows.length) return null;
  const colCount = Math.min(maxCols, Math.max(...rows.map((cells) => cells.length), 1));
  return rows.map((cells) =>
    Array.from({ length: colCount }, (_, colIndex) => cells[colIndex] ?? ""),
  );
}

export function parseTextPreview(text: string, maxLines = MAX_TEXT_LINES): string[] | null {
  if (!text || hasBinaryBytes(text)) return null;
  const rawLines = text.replace(/\r\n?/g, "\n").split("\n");
  const lines: string[] = [];
  for (const line of rawLines) {
    if (!lines.length && !line.trim()) continue;
    lines.push(line.slice(0, MAX_LINE_CHARS));
    if (lines.length >= maxLines) break;
  }
  while (lines.length > 0 && !lines[lines.length - 1]!.trim()) lines.pop();
  return lines.length > 0 ? lines : null;
}

async function readFilePrefix(file: File): Promise<string | null> {
  try {
    const slice = file.slice(0, COMPOSER_ATTACHMENT_PREVIEW_MAX_BYTES);
    if (typeof slice.text === "function") return await slice.text();
    if (typeof FileReader !== "undefined") {
      return await new Promise<string | null>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
        reader.onerror = () => resolve(null);
        reader.readAsText(slice);
      });
    }
  } catch {
    return null;
  }
  return null;
}

const contentPreviewCache = new WeakMap<File, Promise<AttachmentContentPreview | null>>();

function loadAttachmentContentPreview(
  file: File,
  classification: AttachmentFileClassification,
): Promise<AttachmentContentPreview | null> {
  if (classification.previewMode === "icon") return Promise.resolve(null);
  const cached = contentPreviewCache.get(file);
  if (cached) return cached;
  const pending = readFilePrefix(file).then((text): AttachmentContentPreview | null => {
    if (!text) return null;
    if (classification.previewMode === "table") {
      const rows = parseDelimitedPreview(text, classification.delimiter ?? ",");
      return rows ? { kind: "table", rows } : null;
    }
    const lines = parseTextPreview(text);
    return lines ? { kind: "text", lines } : null;
  });
  contentPreviewCache.set(file, pending);
  return pending;
}

function useAttachmentContentPreview(
  file: File | undefined,
  classification: AttachmentFileClassification,
  enabled: boolean,
): AttachmentContentPreview | null {
  const [resolved, setResolved] = useState<{
    file: File;
    preview: AttachmentContentPreview | null;
  } | null>(null);

  useEffect(() => {
    if (!enabled || !file || classification.previewMode === "icon") return;
    let active = true;
    void loadAttachmentContentPreview(file, classification).then((preview) => {
      if (active) setResolved({ file, preview });
    });
    return () => {
      active = false;
    };
  }, [enabled, file, classification]);

  if (!enabled || !file || resolved?.file !== file) return null;
  return resolved.preview;
}

function AttachmentTypeIcon({ kind, className }: { kind: AttachmentIconKind; className?: string }) {
  switch (kind) {
    case "table":
      return <FileSpreadsheet className={className} aria-hidden="true" />;
    case "json":
      return <FileJson className={className} aria-hidden="true" />;
    case "code":
      return <FileCode2 className={className} aria-hidden="true" />;
    case "archive":
      return <FileArchive className={className} aria-hidden="true" />;
    case "audio":
      return <FileAudio className={className} aria-hidden="true" />;
    case "video":
      return <FileVideo className={className} aria-hidden="true" />;
    case "image":
      return <ImageIcon className={className} aria-hidden="true" />;
    case "text":
    case "pdf":
    case "word":
    case "presentation":
      return <FileText className={className} aria-hidden="true" />;
    default:
      return <File className={className} aria-hidden="true" />;
  }
}

function AttachmentUploadOverlay({ label, percent }: { label: string; percent: number }) {
  if (!useDelayedBusy(true)) return null;
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-[11px] bg-background/65 backdrop-blur-[1px]">
      <span
        role="progressbar"
        aria-label={label}
        aria-valuenow={percent}
        className="inline-flex size-8 items-center justify-center rounded-full bg-background/95 text-foreground shadow-xs ring-1 ring-border/70"
      >
        <ContextUsageRing percent={percent} />
      </span>
    </div>
  );
}

function AttachmentFilename({ name }: { name: string }) {
  const { stem, ext } = splitAttachmentFilename(name);
  if (!ext) {
    return (
      <span className="min-w-0 flex-1 truncate text-[10px] font-medium leading-none text-foreground/90">
        {name}
      </span>
    );
  }
  return (
    <span className="flex min-w-0 flex-1 items-baseline text-[10px] font-medium leading-none text-foreground/90">
      <span className="sr-only">{name}</span>
      <span aria-hidden="true" className="min-w-0 truncate">
        {stem}
      </span>
      <span aria-hidden="true" className="shrink-0">
        {ext}
      </span>
    </span>
  );
}

function ComposerAttachmentCard({
  item,
  copy,
  removeDisabled,
  retryDisabled,
  onPreview,
  onPreviewError,
  onRetry,
  onRemove,
}: {
  item: ComposerAttachmentCardItem;
  copy: ComposerAttachmentStripCopy;
  removeDisabled: boolean;
  retryDisabled: boolean;
  onPreview?: (item: ComposerAttachmentCardItem) => void;
  onPreviewError?: (item: ComposerAttachmentCardItem) => void;
  onRetry?: (item: ComposerAttachmentCardItem) => void;
  onRemove: (item: ComposerAttachmentCardItem) => void;
}) {
  const classification = useMemo(
    () => classifyAttachmentFile(item.name, item.file?.type ?? ""),
    [item.name, item.file?.type],
  );
  const showImage = !!item.previewUrl && !item.failed;
  const contentPreview = useAttachmentContentPreview(
    item.file,
    classification,
    !showImage && !item.failed,
  );
  const statusSuffix = item.failed
    ? ` · ${copy.uploadFailed}`
    : item.uploading
      ? ` · ${copy.uploading}${typeof item.percent === "number" ? ` ${item.percent}%` : ""}`
      : "";
  const accessibleLabel = `${item.name}${statusSuffix}`;

  return (
    <li
      data-slot="composer-attachment-card"
      aria-busy={item.uploading || undefined}
      aria-label={accessibleLabel}
      className="group/attachment relative size-[104px] shrink-0 @max-[28rem]:size-20"
      onKeyDown={(event) => {
        if (event.key !== "Delete" && event.key !== "Backspace") return;
        if (removeDisabled) return;
        event.preventDefault();
        event.stopPropagation();
        onRemove(item);
      }}
    >
      <div
        className={`relative size-full overflow-hidden rounded-xl border bg-background shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-colors ${
          item.failed ? "border-destructive/60" : "border-border/80"
        }`}
      >
        {showImage ? (
          <button
            type="button"
            className="block size-full overflow-hidden rounded-[11px] bg-muted/20 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
            aria-label={`${copy.preview}: ${item.name}`}
            title={item.name}
            onClick={() => onPreview?.(item)}
          >
            <img
              src={item.previewUrl}
              alt=""
              className="size-full object-cover transition-transform duration-150 group-hover/attachment:scale-[1.02]"
              onError={() => onPreviewError?.(item)}
            />
          </button>
        ) : (
          <div
            tabIndex={0}
            role="group"
            aria-label={accessibleLabel}
            title={item.name}
            className="flex size-full flex-col overflow-hidden rounded-[11px] bg-background outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <div className="relative min-h-0 flex-1 overflow-hidden bg-muted/30">
              {item.failed ? (
                <div className="flex size-full flex-col items-center justify-center gap-1 bg-destructive/[0.08] px-1.5 text-center">
                  <span className="inline-flex max-w-full items-center gap-1 text-[10px] font-medium leading-tight text-destructive-text">
                    <AlertCircle className="size-3 shrink-0" aria-hidden="true" />
                    <span role="status" className="truncate">
                      {copy.uploadFailed}
                    </span>
                  </span>
                  {onRetry && item.file && (
                    <button
                      type="button"
                      disabled={retryDisabled}
                      onClick={() => onRetry(item)}
                      className="inline-flex h-5 items-center gap-1 rounded-full border border-destructive/30 bg-background px-2 text-[10px] font-medium text-foreground shadow-xs transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-50"
                    >
                      <RotateCw className="size-2.5 shrink-0" aria-hidden="true" />
                      <span>{copy.retry}</span>
                    </button>
                  )}
                </div>
              ) : contentPreview?.kind === "table" ? (
                <div
                  aria-hidden="true"
                  data-attachment-preview="table"
                  className="relative size-full overflow-hidden bg-background p-1"
                >
                  <table className="w-full table-fixed border-collapse text-[6px] leading-[1.35] text-foreground/75">
                    <tbody>
                      {contentPreview.rows.map((row, rowIndex) => (
                        <tr
                          key={rowIndex}
                          className={
                            rowIndex === 0 ? "bg-muted/75 font-semibold text-foreground/90" : ""
                          }
                        >
                          {row.map((cell, cellIndex) => (
                            <td
                              key={cellIndex}
                              className="truncate border border-border/60 px-0.5 py-[1px] align-top"
                            >
                              {cell}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 h-4 bg-gradient-to-t from-background to-transparent" />
                </div>
              ) : contentPreview?.kind === "text" ? (
                <div
                  aria-hidden="true"
                  data-attachment-preview="text"
                  className={`relative size-full overflow-hidden bg-background px-1.5 pt-1.5 text-[6px] leading-[1.4] text-foreground/75 ${
                    classification.mono ? "font-mono" : ""
                  }`}
                >
                  <div className="space-y-[1px]">
                    {contentPreview.lines.map((line, lineIndex) => (
                      <div key={lineIndex} className="truncate whitespace-pre">
                        {line || "\u00A0"}
                      </div>
                    ))}
                  </div>
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 h-4 bg-gradient-to-t from-background to-transparent" />
                </div>
              ) : (
                <div
                  aria-hidden="true"
                  data-attachment-preview="icon"
                  className="flex size-full flex-col items-center justify-center gap-1 bg-muted/35 px-2"
                >
                  <AttachmentTypeIcon
                    kind={classification.icon}
                    className={`size-6 @max-[28rem]:size-5 ${classification.accentClass}`}
                  />
                  {classification.badge && (
                    <span className="rounded bg-foreground/[0.07] px-1.5 py-0.5 text-[9px] font-semibold tracking-wide text-muted-foreground">
                      {classification.badge}
                    </span>
                  )}
                </div>
              )}
            </div>
            <div className="flex h-6 shrink-0 items-center gap-1 border-t border-border/60 bg-background/95 px-1.5">
              <AttachmentTypeIcon
                kind={classification.icon}
                className={`size-3 shrink-0 ${classification.accentClass}`}
              />
              <AttachmentFilename name={item.name} />
            </div>
          </div>
        )}
        {item.uploading && !item.failed && (
          <AttachmentUploadOverlay label={copy.uploading} percent={item.percent ?? 0} />
        )}
      </div>
      <span className="absolute -top-1.5 -right-1.5 z-10 opacity-0 transition-opacity duration-150 group-hover/attachment:opacity-100 group-focus-within/attachment:opacity-100 pointer-coarse:opacity-100">
        <button
          type="button"
          data-slot="composer-attachment-remove"
          aria-label={copy.remove(item.name)}
          disabled={removeDisabled}
          onClick={(event) => {
            event.stopPropagation();
            onRemove(item);
          }}
          className="relative grid size-5 place-items-center rounded-full bg-zinc-900 text-white shadow-sm ring-2 ring-sidebar transition-colors before:absolute before:-inset-2 before:content-[''] hover:bg-zinc-700 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:cursor-default disabled:bg-muted disabled:text-muted-foreground disabled:opacity-55 disabled:hover:bg-muted dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-zinc-300 dark:disabled:bg-muted dark:disabled:text-muted-foreground pointer-coarse:before:-inset-3"
        >
          <X className="size-3" strokeWidth={2.5} aria-hidden="true" />
        </button>
      </span>
    </li>
  );
}

export function ComposerAttachmentStrip({
  items,
  copy,
  removeDisabled = false,
  retryDisabled = false,
  onPreview,
  onPreviewError,
  onRetry,
  onRemove,
}: {
  items: readonly ComposerAttachmentCardItem[];
  copy: ComposerAttachmentStripCopy;
  removeDisabled?: boolean;
  retryDisabled?: boolean;
  onPreview?: (item: ComposerAttachmentCardItem) => void;
  onPreviewError?: (item: ComposerAttachmentCardItem) => void;
  onRetry?: (item: ComposerAttachmentCardItem) => void;
  onRemove: (item: ComposerAttachmentCardItem) => void;
}) {
  if (!items.length) return null;
  return (
    <div className="@container px-1.5 pt-0.5">
      <ul
        aria-label={copy.listLabel}
        data-slot="composer-attachment-strip"
        className="flex flex-nowrap gap-2.5 overflow-x-auto px-1.5 pt-2 pb-1"
      >
        {items.map((item) => (
          <ComposerAttachmentCard
            key={item.key}
            item={item}
            copy={copy}
            removeDisabled={removeDisabled}
            retryDisabled={retryDisabled}
            onPreview={onPreview}
            onPreviewError={onPreviewError}
            onRetry={onRetry}
            onRemove={onRemove}
          />
        ))}
      </ul>
    </div>
  );
}

const localFileIds = new WeakMap<File, string>();

function localFileId(file: File): string {
  const existing = localFileIds.get(file);
  if (existing) return existing;
  const created = crypto.randomUUID();
  localFileIds.set(file, created);
  return created;
}

/**
 * Projects a plain `File[]` list (used by new-session composers before upload) into
 * `ComposerAttachmentCardItem[]` with managed local raster preview URLs.
 */
export function useLocalComposerAttachments(files: readonly File[]) {
  const urlsRef = useRef(new Map<string, string>());
  const [previewUrls, setPreviewUrls] = useState<Readonly<Record<string, string>>>({});
  const [brokenKeys, setBrokenKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [previewKey, setPreviewKey] = useState<string>();

  const keyedFiles = useMemo(() => {
    const counts = new Map<File, number>();
    return files.map((file) => {
      const seen = counts.get(file) ?? 0;
      counts.set(file, seen + 1);
      const id = localFileId(file);
      return {
        key: seen === 0 ? id : `${id}:${seen}`,
        file,
      };
    });
  }, [files]);

  useLayoutEffect(() => {
    const activeKeys = new Set(keyedFiles.map((entry) => entry.key));
    let changed = false;
    for (const [key, url] of urlsRef.current) {
      if (!activeKeys.has(key)) {
        URL.revokeObjectURL(url);
        urlsRef.current.delete(key);
        changed = true;
      }
    }
    for (const { key, file } of keyedFiles) {
      if (
        !urlsRef.current.has(key) &&
        !brokenKeys.has(key) &&
        isPreviewableRasterImage(file) &&
        typeof URL.createObjectURL === "function"
      ) {
        urlsRef.current.set(key, URL.createObjectURL(file));
        changed = true;
      }
    }
    if (changed) {
      setPreviewUrls(Object.fromEntries(urlsRef.current));
    }
  }, [keyedFiles, brokenKeys]);

  useEffect(() => {
    const urls = urlsRef.current;
    return () => {
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);

  const items: ComposerAttachmentCardItem[] = useMemo(
    () =>
      keyedFiles.map(({ key, file }) => ({
        key,
        name: file.name,
        file,
        previewUrl: brokenKeys.has(key) ? undefined : previewUrls[key],
      })),
    [keyedFiles, previewUrls, brokenKeys],
  );

  const preview = items.find((item) => item.key === previewKey && item.previewUrl);

  const markPreviewUnavailable = (key: string) => {
    const existing = urlsRef.current.get(key);
    if (existing) {
      URL.revokeObjectURL(existing);
      urlsRef.current.delete(key);
      setPreviewUrls(Object.fromEntries(urlsRef.current));
    }
    setBrokenKeys((current) => {
      const next = new Set(current);
      next.add(key);
      return next;
    });
    setPreviewKey((current) => (current === key ? undefined : current));
  };

  return {
    items,
    preview,
    setPreviewKey,
    markPreviewUnavailable,
  };
}
