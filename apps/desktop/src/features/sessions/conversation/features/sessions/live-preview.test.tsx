// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  localPreviewLabel,
  localPreviewTargets,
  localPreviewTexts,
  parseLocalPreviewTarget,
  type ConversationEvent,
} from "@agentkib/web-client";
import { api } from "@/core/api";
import { ArtifactBrowser } from "./artifact-browser";
import { artifactCopy } from "./artifact-copy";
import { LivePreview } from "./live-preview";
import { livePreviewCopy } from "./live-preview-copy";
import { useSession } from "./session-context";

vi.mock("./session-context", () => ({ useSession: vi.fn() }));
vi.mock("@/core/api", () => ({ api: { openExternal: vi.fn() } }));
const copy = livePreviewCopy("en-US");
const event = (content: string) => ({
  id: content,
  kind: "tool-summary" as const,
  content,
  attachment_count: 0,
  truncated: false,
});
let state: ReturnType<typeof useSession>;
function prepare(texts: string[], streamText?: string) {
  state = {
    locale: "en-US",
    selected: "s",
    current: { id: "s", workspace_id: "w" },
    access: { device: { files: true } },
    page: { events: texts.map(event) },
    live: { sessionId: "s", status: "running", streamText },
    client: {
      request: vi.fn(async (path: string) => {
        if (path === "files/workspaces") return { workspaces: [{ id: "w", name: "Project" }] };
        if (path.startsWith("artifacts?")) return { artifacts: [] };
        throw new Error(`unexpected ${path}`);
      }),
    },
  } as unknown as ReturnType<typeof useSession>;
  vi.mocked(useSession).mockImplementation(() => state);
}
beforeEach(() => {
  vi.mocked(api.openExternal).mockReset().mockResolvedValue(undefined);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("finding local pages in conversation text", () => {
  it("reads dev server output, newest first and one address per port", () => {
    const vite = "  ➜  Local:   \u001b[36mhttp://localhost:\u001b[1m5173\u001b[22m/\u001b[39m";
    const targets = localPreviewTargets([
      "Django: Starting development server at http://127.0.0.1:8000/.",
      "old page http://localhost:5173/old and [docs](http://0.0.0.0:4000/docs)",
      vite,
    ]);
    expect(targets.map((target) => target.url)).toEqual([
      "http://localhost:5173/",
      "http://localhost:4000/docs",
      "http://localhost:8000/",
    ]);
  });
  it("keeps HTTPS, drops a redacted query and ignores other hosts and bad ports", () => {
    expect(
      localPreviewTargets([
        "https://localhost:5174/app http://[::1]:8888/lab?token=[REDACTED] http://example.com:3000/ http://192.168.1.2:3001/ http://localhost:0/ http://localhost:70000/ http://localhost:123456/",
      ]),
    ).toEqual([
      { secure: false, port: 8888, path: "/lab", url: "http://localhost:8888/lab" },
      { secure: true, port: 5174, path: "/app", url: "https://localhost:5174/app" },
    ]);
  });
  it("reads a tool's command and output, which carry a dev server's address, but not diffs", () => {
    const tool = (detail: NonNullable<ConversationEvent["tool"]>): ConversationEvent => ({
      id: detail.title ?? detail.kind,
      kind: "tool-summary",
      content: "",
      attachment_count: 0,
      truncated: false,
      tool: detail,
    });
    const texts = localPreviewTexts([
      tool({
        kind: "execute",
        title: "npm run dev",
        content: [
          {
            type: "terminal",
            command: "npm run dev",
            output: "  VITE v7.0.0  ready in 312 ms\n  ➜  Local:   http://localhost:5173/\n",
          },
        ],
      }),
      tool({
        kind: "edit",
        title: ".env",
        content: [
          {
            type: "diff",
            path: ".env",
            change: "update",
            added: 1,
            removed: 0,
            preview: "+API=http://localhost:8080/",
          },
        ],
      }),
      tool({
        kind: "fetch",
        content: [{ type: "text", label: "output", text: "Serving at http://127.0.0.1:8000/docs" }],
      }),
      { ...event("Open http://localhost:3000/"), kind: "agent-message" },
    ]);
    expect(localPreviewTargets(texts).map((target) => target.url)).toEqual([
      "http://localhost:3000/",
      "http://localhost:8000/docs",
      "http://localhost:5173/",
    ]);
  });
  it("stops at the limit", () => {
    const text = Array.from({ length: 12 }, (_, index) => `http://localhost:${3000 + index}/`);
    expect(localPreviewTargets([text.join(" ")], 3).map((target) => target.port)).toEqual([
      3011, 3010, 3009,
    ]);
  });
  it("accepts a typed port or loopback address and refuses anything else", () => {
    expect(parseLocalPreviewTarget(" 5173 ")?.url).toBe("http://localhost:5173/");
    expect(parseLocalPreviewTarget("localhost:5173/app")?.url).toBe("http://localhost:5173/app");
    expect(parseLocalPreviewTarget("localhost:5173?debug=1")?.url).toBe(
      "http://localhost:5173/?debug=1",
    );
    expect(parseLocalPreviewTarget("http://[::1]:8080/x?y#z")?.url).toBe(
      "http://localhost:8080/x?y#z",
    );
    const secure = parseLocalPreviewTarget("HTTPS://127.0.0.1:8443/")!;
    expect(secure.url).toBe("https://localhost:8443/");
    expect(localPreviewLabel(secure)).toBe("https://localhost:8443/");
    expect(localPreviewLabel(parseLocalPreviewTarget("3000")!)).toBe("localhost:3000/");
    for (const refused of [
      "",
      "localhost",
      "example.com:5173",
      "localhost.example.com:5173",
      "http://localhost:99999",
      "0",
      "file:///etc/passwd",
      "javascript:alert(1)//localhost:1",
      "localhost:5173 extra",
      "ftp://localhost:21/",
    ])
      expect(parseLocalPreviewTarget(refused)).toBeNull();
  });
});

describe("the desktop web preview", () => {
  it("lists the conversation's addresses and frames the chosen page in a sandbox", () => {
    prepare(["Server: http://localhost:3000/"], "Ready on http://127.0.0.1:5173/app");
    render(<LivePreview />);
    expect(screen.getByText(copy.intro)).toBeVisible();
    const items = screen.getAllByRole("listitem").map((item) => item.textContent);
    expect(items).toEqual(["localhost:5173/app", "localhost:3000/"]);
    fireEvent.click(screen.getByRole("button", { name: "localhost:5173/app" }));
    const frame = screen.getByTitle(copy.frame);
    expect(frame).toHaveAttribute("src", "http://localhost:5173/app");
    expect(frame).toHaveAttribute(
      "sandbox",
      "allow-scripts allow-same-origin allow-forms allow-modals",
    );
    expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });
  it("reloads, opens in the browser and goes back to the list", async () => {
    prepare(["http://localhost:3000/"]);
    render(<LivePreview />);
    fireEvent.click(screen.getByRole("button", { name: "localhost:3000/" }));
    const first = screen.getByTitle(copy.frame);
    fireEvent.click(screen.getByRole("button", { name: copy.reload }));
    expect(screen.getByTitle(copy.frame)).not.toBe(first);
    fireEvent.click(screen.getByRole("button", { name: copy.external }));
    await waitFor(() =>
      expect(api.openExternal).toHaveBeenCalledExactlyOnceWith("http://localhost:3000/"),
    );
    fireEvent.click(screen.getByRole("button", { name: copy.back }));
    expect(screen.queryByTitle(copy.frame)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "localhost:3000/" })).toBeVisible();
  });
  it("opens a typed address and explains a refused one", () => {
    prepare([]);
    render(<LivePreview />);
    expect(screen.getByText(copy.none)).toBeVisible();
    const input = screen.getByLabelText(copy.address);
    const open = screen.getByRole("button", { name: copy.open });
    expect(open).toBeDisabled();
    fireEvent.change(input, { target: { value: "example.com:3000" } });
    fireEvent.click(open);
    expect(screen.getByRole("alert")).toHaveTextContent(copy.invalid);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription(copy.invalid);
    expect(screen.queryByTitle(copy.frame)).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: "8000/admin" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: "127.0.0.1:8000/admin" } });
    fireEvent.submit(input.closest("form")!);
    expect(screen.getByTitle(copy.frame)).toHaveAttribute("src", "http://localhost:8000/admin");
  });
  it("is a tab of the files panel that reads nothing from the authorized directories", async () => {
    prepare(["http://localhost:3000/"]);
    const files = artifactCopy("en-US");
    render(<ArtifactBrowser open showTrigger={false} />);
    await waitFor(() =>
      expect(state.client.request).toHaveBeenCalledWith(
        "artifacts?workspaceId=w&sessionId=s",
        undefined,
        expect.any(AbortSignal),
      ),
    );
    vi.mocked(state.client.request).mockClear();
    fireEvent.click(screen.getByRole("tab", { name: files.preview }));
    expect(await screen.findByRole("button", { name: "localhost:3000/" })).toBeVisible();
    expect(screen.queryByRole("button", { name: files.refresh })).not.toBeInTheDocument();
    expect(screen.queryByText(files.empty)).not.toBeInTheDocument();
    expect(state.client.request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: files.artifacts }));
    await waitFor(() => expect(state.client.request).toHaveBeenCalledOnce());
    expect(screen.queryByText(copy.intro)).not.toBeInTheDocument();
  });
});
