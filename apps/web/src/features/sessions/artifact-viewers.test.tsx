import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArtifactEntry, ArtifactPreviewKind, ArtifactTicket } from "@agentkib/web-client";
import { ArtifactPreview, createArtifactViewerRegistry } from "@agentkib/session-ui";

const entry = (
  kind: ArtifactPreviewKind,
  name = "report.txt",
  mime = "text/plain",
): ArtifactEntry => ({
  id: "opaque",
  name,
  kind: "file",
  mime,
  previewKind: kind,
  revision: "version",
  size: 4,
  modifiedAt: "2026-01-01",
});
const ticket = (kind: ArtifactPreviewKind): ArtifactTicket => ({
  kind,
  url: "https://preview.example/p/opaque/content",
  revision: "version",
  expiresAt: Date.now() + 60_000,
});
afterEach(cleanup);
describe("ArtifactPreview registry", () => {
  it("supports trusted kind and MIME extensions with a built-in fallback and disposal", () => {
    const registry = createArtifactViewerRegistry([
      {
        id: "csv",
        matchesMime: (mime) => mime === "text/csv",
        component: ({ text }) => <output>CSV: {text}</output>,
      },
    ]);
    const view = render(
      <ArtifactPreview
        registry={registry}
        entry={entry("text", "table.csv", "Text/CSV; charset=utf-8")}
        text="one,two"
      />,
    );
    expect(screen.getByText("CSV: one,two")).toBeInTheDocument();
    const dispose = registry.register({
      id: "custom-text",
      kind: "text",
      component: ({ text }) => <output>Custom: {text}</output>,
    });
    view.rerender(<ArtifactPreview registry={registry} entry={entry("text")} text="plain text" />);
    expect(screen.getByText("Custom: plain text")).toBeInTheDocument();
    expect(() =>
      registry.register({ id: "custom-text", kind: "text", component: () => null }),
    ).toThrow("duplicate_artifact_viewer");
    dispose();
    view.rerender(<ArtifactPreview registry={registry} entry={entry("text")} text="plain text" />);
    expect(view.container.querySelector("pre")).toHaveTextContent("plain text");
  });
  it("loads HTML only as an opaque sandboxed ticket document", () => {
    const view = render(
      <ArtifactPreview
        entry={entry("html", "index.html", "text/html")}
        ticket={ticket("html")}
        text="<script>throw Error('must never evaluate')</script>"
      />,
    );
    const frame = view.container.querySelector("iframe")!;
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    expect(frame).toHaveAttribute("src", ticket("html").url);
    expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(frame).not.toHaveAttribute("srcdoc");
    expect(view.container.querySelector("script")).toBeNull();
  });
  it.each(["video", "audio"] as const)(
    "uses native %s URLs and forwards playback lifecycle callbacks",
    (kind) => {
      const ref = vi.fn(),
        loaded = vi.fn(),
        error = vi.fn();
      const view = render(
        <ArtifactPreview
          entry={entry(kind)}
          ticket={ticket(kind)}
          onMediaRef={ref}
          onLoadedMetadata={loaded}
          onMediaError={error}
        />,
      );
      const media = view.container.querySelector(kind)!;
      expect(media).toHaveAttribute("src", ticket(kind).url);
      expect(media).toHaveAttribute("controls");
      expect(media).toHaveAttribute("preload", "metadata");
      if (kind === "video") expect(media).toHaveAttribute("playsinline");
      expect(ref).toHaveBeenCalledWith(media);
      fireEvent.loadedMetadata(media);
      fireEvent.error(media);
      expect(loaded).toHaveBeenCalledOnce();
      expect(error).toHaveBeenCalledOnce();
      view.unmount();
      expect(ref.mock.calls.at(-1)?.[0]).toBeNull();
    },
  );
  it("renders safe Markdown and escapes ordinary text without interpreting HTML", () => {
    const view = render(
      <ArtifactPreview
        entry={entry("text", "readme.md")}
        text={"# Report\n<script>window.evil=true</script>\n[bad](javascript:alert(1))"}
      />,
    );
    expect(screen.getByRole("heading", { name: "Report" })).toBeInTheDocument();
    expect(view.container.querySelector("script")).toBeNull();
    expect(view.container.querySelector('a[href^="javascript:"]')).toBeNull();
    view.rerender(<ArtifactPreview entry={entry("text")} text="<img src=x onerror=evil()>" />);
    expect(view.container.querySelector("pre")).toHaveTextContent("<img src=x onerror=evil()>");
    expect(view.container.querySelector("img")).toBeNull();
  });
  it.each(["pdf", "download"] as const)("keeps %s as a link fallback", (kind) => {
    const view = render(
      <ArtifactPreview entry={entry(kind)} ticket={ticket(kind)} openLabel="Open / download" />,
    );
    expect(screen.getByRole("link", { name: "Open / download" })).toHaveAttribute(
      "href",
      ticket(kind).url,
    );
    expect(screen.getByRole("link")).toHaveAttribute("rel", "noreferrer");
    expect(view.container.querySelector("iframe,object,embed")).toBeNull();
  });
  it("renders nothing before a file or its preview content exists", () => {
    const view = render(<ArtifactPreview />);
    expect(view.container).toBeEmptyDOMElement();
    view.rerender(<ArtifactPreview entry={entry("html")} />);
    expect(view.container).toBeEmptyDOMElement();
  });
});
