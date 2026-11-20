import { createElement, type ComponentType } from "react";
import type { ArtifactEntry, ArtifactPreviewKind, ArtifactTicket } from "@agentkib/web-client";
import { SafeMarkdown } from "./safe-markdown";

export interface ArtifactViewerProps {
  entry?: ArtifactEntry;
  ticket?: ArtifactTicket;
  text?: string;
  onMediaRef?: (node: HTMLMediaElement | null) => void;
  onLoadedMetadata?: () => void;
  onMediaError?: () => void;
  openLabel?: string;
}
export type ArtifactViewer = {
  id: string;
  component: ComponentType<ArtifactViewerProps>;
} & (
  | { kind: ArtifactPreviewKind; matchesMime?: never }
  | { kind?: never; matchesMime: (mime: string) => boolean }
);
export interface ArtifactViewerRegistry {
  register(viewer: ArtifactViewer): () => void;
  resolve(kind: ArtifactPreviewKind, mime: string): ComponentType<ArtifactViewerProps>;
}

const Download: ComponentType<ArtifactViewerProps> = ({ ticket, openLabel = "打开 / 下载" }) =>
  ticket ? (
    <a href={ticket.url} target="_blank" rel="noreferrer" className="underline">
      {openLabel}
    </a>
  ) : null;
const builtins: Record<ArtifactPreviewKind, ComponentType<ArtifactViewerProps>> = {
  text: ({ entry, text }) =>
    text === undefined ? null : /\.(?:md|markdown|mdown)$/i.test(entry?.name ?? "") ? (
      <div className="max-h-[50dvh] overflow-auto">
        <SafeMarkdown text={text} />
      </div>
    ) : (
      <pre className="max-h-[50dvh] overflow-auto whitespace-pre-wrap break-words rounded border p-3 text-xs">
        {text}
      </pre>
    ),
  image: ({ entry, ticket }) =>
    ticket ? (
      <img
        src={ticket.url}
        alt={entry?.name ?? ""}
        className="max-h-[60dvh] max-w-full object-contain"
        referrerPolicy="no-referrer"
      />
    ) : null,
  html: ({ entry, ticket }) =>
    ticket ? (
      <iframe
        title={entry?.name ?? "HTML"}
        src={ticket.url}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        className="h-[55dvh] w-full rounded border"
      />
    ) : null,
  video: ({ ticket, onMediaRef, onLoadedMetadata, onMediaError }) =>
    ticket ? (
      <video
        ref={onMediaRef}
        src={ticket.url}
        controls
        playsInline
        preload="metadata"
        onLoadedMetadata={onLoadedMetadata}
        onError={onMediaError}
        className="max-h-[55dvh] w-full"
      />
    ) : null,
  audio: ({ ticket, onMediaRef, onLoadedMetadata, onMediaError }) =>
    ticket ? (
      <audio
        ref={onMediaRef}
        src={ticket.url}
        controls
        preload="metadata"
        onLoadedMetadata={onLoadedMetadata}
        onError={onMediaError}
      />
    ) : null,
  pdf: Download,
  download: Download,
};

/** Register only trusted, bundled frontend components before rendering a preview.
 * Artifact bytes/metadata are never evaluated or used as an import/module URL.
 * Extensions match in registration order, followed by the built-in fallback.
 */
export function createArtifactViewerRegistry(
  extensions: readonly ArtifactViewer[] = [],
): ArtifactViewerRegistry {
  const viewers = new Map<string, ArtifactViewer>();
  const registry: ArtifactViewerRegistry = {
    register(viewer) {
      if (!viewer.id || viewers.has(viewer.id)) throw new Error("duplicate_artifact_viewer");
      const registered = { ...viewer };
      viewers.set(viewer.id, registered);
      return () => {
        if (viewers.get(viewer.id) === registered) viewers.delete(viewer.id);
      };
    },
    resolve(kind, mime) {
      for (const viewer of viewers.values()) {
        if (viewer.kind === kind || viewer.matchesMime?.(mime)) return viewer.component;
      }
      return builtins[kind] ?? Download;
    },
  };
  for (const viewer of extensions) registry.register(viewer);
  return registry;
}
export const artifactViewers = createArtifactViewerRegistry();

export function ArtifactPreview({
  registry = artifactViewers,
  ...props
}: ArtifactViewerProps & { registry?: ArtifactViewerRegistry }) {
  if (!props.entry || props.entry.kind !== "file") return null;
  const kind = props.ticket?.kind ?? props.entry.previewKind;
  return createElement(
    registry.resolve(kind, props.entry.mime.split(";")[0].trim().toLowerCase()),
    props,
  );
}
