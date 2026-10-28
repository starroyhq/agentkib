import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@agentkib/web-client";
import { ArtifactBrowser } from "@/features/conversation/features/sessions/artifact-browser";
import { artifactCopy } from "@/features/conversation/features/sessions/artifact-copy";
import { LivePreview } from "@/features/conversation/features/sessions/live-preview";
import { livePreviewCopy } from "@/features/conversation/features/sessions/live-preview-copy";

let session: {
  client: { request: ReturnType<typeof vi.fn> };
  access: {
    experimentalEnabled: boolean;
    device: { files: boolean; accessMode?: "full"; advancedControl?: boolean };
  };
  current: { workspace_id: string };
  selected: string;
  locale: string;
  page?: { events: { id: string; kind: string; content: string }[] };
  live?: { streamText?: string };
};
vi.mock("@/features/conversation/features/sessions/session-context", () => ({
  useSession: () => session,
}));
const copy = livePreviewCopy("en-US", "web");
let tickets = 0;
beforeEach(() => {
  tickets = 0;
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
  session = {
    client: {
      request: vi.fn(async (path: string) => {
        if (path === "live-preview-tickets")
          return {
            url: `https://device.preview.example.net/live/${String(++tickets).repeat(32)}/app`,
            expiresAt: Date.now() + 60_000,
          };
        if (path === "files/workspaces") return { workspaces: [{ id: "w", name: "Project" }] };
        if (path.startsWith("artifacts?")) return { artifacts: [] };
        throw new Error(`unexpected ${path}`);
      }),
    },
    access: {
      experimentalEnabled: true,
      device: { files: true, accessMode: "full", advancedControl: true },
    },
    current: { workspace_id: "w" },
    selected: "s",
    locale: "en-US",
    page: {
      events: [{ id: "1", kind: "tool-summary", content: "VITE ready: http://localhost:5173/app" }],
    },
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the web preview in a browser", () => {
  it("asks the host for a ticket and frames only the preview origin", async () => {
    render(<LivePreview />);
    expect(screen.getByText(copy.intro)).toHaveTextContent(
      "Pages served on the computer running AgentKib",
    );
    fireEvent.click(screen.getByRole("button", { name: "localhost:5173/app" }));
    expect(await screen.findByRole("status")).toHaveTextContent(copy.opening);
    const frame = await screen.findByTitle(copy.frame);
    expect(session.client.request).toHaveBeenCalledExactlyOnceWith(
      "live-preview-tickets",
      { port: 5173, path: "/app", secure: false },
      expect.any(AbortSignal),
    );
    const url = `https://device.preview.example.net/live/${"1".repeat(32)}/app`;
    expect(frame).toHaveAttribute("src", url);
    expect(frame).toHaveAttribute(
      "sandbox",
      "allow-scripts allow-same-origin allow-forms allow-modals",
    );
    expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
    const tab = screen.getByRole("link", { name: copy.newTab });
    expect(tab).toHaveAttribute("href", url);
    expect(tab).toHaveAttribute("target", "_blank");
    expect(tab).toHaveAttribute("rel", "noreferrer");
    expect(screen.getByText(/Changes may not show up here on their own/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: copy.reload }));
    await waitFor(() =>
      expect(screen.getByTitle(copy.frame)).toHaveAttribute(
        "src",
        `https://device.preview.example.net/live/${"2".repeat(32)}/app`,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: copy.back }));
    expect(screen.queryByTitle(copy.frame)).not.toBeInTheDocument();
  });
  it.each([
    [
      new ApiError(409, "live_preview_unreachable"),
      "Nothing is answering on port 3000 on the computer running AgentKib.",
    ],
    [new ApiError(403, "live_preview_port_reserved"), copy.reserved],
    [new ApiError(403, "live_preview_port_blocked"), copy.blocked],
    [new ApiError(403, "permission_denied"), copy.denied],
    [new ApiError(503, "preview_unavailable"), copy.failed],
  ])("explains a refused ticket: %s", async (error, text) => {
    session.client.request.mockRejectedValueOnce(error);
    render(<LivePreview />);
    fireEvent.change(screen.getByLabelText(copy.address), {
      target: { value: "https://127.0.0.1:3000/x" },
    });
    fireEvent.click(screen.getByRole("button", { name: copy.open }));
    expect(await screen.findByRole("alert")).toHaveTextContent(text);
    expect(session.client.request).toHaveBeenCalledWith(
      "live-preview-tickets",
      { port: 3000, path: "/x", secure: true },
      expect.any(AbortSignal),
    );
    expect(screen.queryByTitle(copy.frame)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: copy.newTab })).not.toBeInTheDocument();
  });
  it("shows the page asked for last when an earlier ticket or failure arrives late", async () => {
    session.page!.events.push({ id: "2", kind: "tool-summary", content: "http://localhost:3000/" });
    const answers: { resolve: (value: unknown) => void; reject: (error: unknown) => void }[] = [];
    // This client answers even after its request was abandoned.
    session.client.request.mockImplementation(
      () => new Promise((resolve, reject) => answers.push({ resolve, reject })),
    );
    render(<LivePreview />);
    for (const name of ["localhost:5173/app", "localhost:3000/"]) {
      fireEvent.click(screen.getByRole("button", { name }));
      fireEvent.click(screen.getByRole("button", { name: copy.back }));
    }
    fireEvent.click(screen.getByRole("button", { name: "localhost:3000/" }));
    expect(answers).toHaveLength(3);
    answers[0]!.resolve({ url: "https://device.preview.example.net/live/old/app", expiresAt: 0 });
    answers[1]!.reject(new ApiError(409, "live_preview_unreachable"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByTitle(copy.frame)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(copy.opening);
    answers[2]!.resolve({ url: "https://device.preview.example.net/live/new/", expiresAt: 0 });
    expect(await screen.findByTitle(copy.frame)).toHaveAttribute(
      "src",
      "https://device.preview.example.net/live/new/",
    );
    expect(screen.getByTitle("http://localhost:3000/")).toHaveTextContent("localhost:3000/");
  });
  it("is a files panel tab only for a browser with full control", async () => {
    const files = artifactCopy("en-US", "web");
    const { unmount } = render(<ArtifactBrowser open showTrigger={false} />);
    const tabs = await screen.findByRole("tablist", { name: files.views });
    expect(
      within(tabs)
        .getAllByRole("tab")
        .map((tab) => tab.textContent),
    ).toEqual([files.artifacts, files.files, files.diff, files.preview]);
    fireEvent.click(within(tabs).getByRole("tab", { name: files.preview }));
    expect(await screen.findByRole("button", { name: "localhost:5173/app" })).toBeVisible();
    unmount();
    session.access.device = { files: true };
    render(<ArtifactBrowser open showTrigger={false} />);
    const limited = await screen.findByRole("tablist", { name: files.views });
    expect(within(limited).getAllByRole("tab")).toHaveLength(3);
    expect(screen.queryByText(copy.intro)).not.toBeInTheDocument();
  });
});
